import type { VehicleLoadout, TurretSize } from '@carwars/shared';
import { BODIES } from './data/bodies';
import { POWER_PLANTS } from './data/power-plants';
import { TIRES } from './data/tires';
import { WEAPONS } from './data/weapons';
import { TURRETS, TURRET_TIER_RANK } from './data/turrets';

export interface CapacityReport {
  spacesUsed: number;
  spacesMax: number;
  loadWeight: number;
  loadMax: number;
  overSpaces: boolean;
  overWeight: boolean;
  errors: string[];
}

const ARMOR_WT_MUL: Record<string, number> = {
  ablative: 1, metal: 2, fireproof: 1, laser_reflective: 1, lr_fireproof: 1, radarproof: 1,
};

// Computes spaces + weight-load consumption for a loadout against its body's
// maxLoad / spaces budget. Legacy vehicles (no bodyType) get an unlimited
// budget so they never appear over-capacity — grandfathering by design.
export function computeCapacity(loadout: VehicleLoadout): CapacityReport {
  const bodyType = loadout.bodyType;
  if (!bodyType) {
    return {
      spacesUsed: 0, spacesMax: 99,
      loadWeight: 0, loadMax: 99999,
      overSpaces: false, overWeight: false, errors: [],
    };
  }
  const body = BODIES.find(b => b.id === bodyType);
  if (!body) {
    return {
      spacesUsed: 0, spacesMax: 0,
      loadWeight: 0, loadMax: 0,
      overSpaces: true, overWeight: true,
      errors: [`Unknown body type ${bodyType}`],
    };
  }
  const plant = POWER_PLANTS.find(p => p.id === loadout.powerPlantType);
  const tire = TIRES.find(t => t.id === (loadout.tireType ?? 'standard'));

  // Spaces: power plant + weapons + turret rings. Armor/tires don't consume spaces.
  let spacesUsed = plant?.spaces ?? 0;
  for (const m of loadout.mounts ?? []) {
    const w = WEAPONS.find(ww => ww.id === m.weaponId);
    if (w) spacesUsed += w.spaces;
    if (m.arc === 'turret' && m.turretSize) {
      const t = TURRETS.find(tt => tt.id === m.turretSize);
      if (t) spacesUsed += t.spaces;
    }
  }

  // Load weight: everything on top of the body's bare baseWeight.
  const tireCount = body.tireCount ?? (body.isCycle ? 2 : 4);
  let loadWeight = (plant?.weight ?? 0) + (tire?.weightPerTire ?? 0) * tireCount;
  const armorPts = Object.values(loadout.armor ?? {}).reduce((s, v) => s + (v as number), 0);
  const armorWtMul = ARMOR_WT_MUL[loadout.armorType ?? 'ablative'] ?? 1;
  loadWeight += armorPts * body.armorWtPerPt * armorWtMul;
  for (const m of loadout.mounts ?? []) {
    const w = WEAPONS.find(ww => ww.id === m.weaponId);
    if (w) loadWeight += w.weight + w.ammoWeight * m.ammo;
    if (m.arc === 'turret' && m.turretSize) {
      const t = TURRETS.find(tt => tt.id === m.turretSize);
      if (t) loadWeight += t.weight;
    }
  }

  const errors: string[] = [];
  const overSpaces = spacesUsed > body.spaces;
  const overWeight = loadWeight > body.maxLoad;
  if (overSpaces) errors.push(`Over spaces: ${spacesUsed} / ${body.spaces}`);
  if (overWeight) errors.push(`Over weight: ${Math.round(loadWeight)} / ${body.maxLoad} lbs`);

  // Turret-specific validation. A turret mount must declare its size; the
  // chosen turret must fit the body (bodies.maxTurretSize); and the weapon
  // must fit in the turret's maxWeaponSpaces.
  for (const m of loadout.mounts ?? []) {
    if (m.arc !== 'turret') continue;
    if (!m.turretSize) {
      errors.push(`Mount ${m.id}: turret arc requires a turret size`);
      continue;
    }
    if (body.maxTurretSize == null) {
      errors.push(`${body.name} cannot mount a turret`);
      continue;
    }
    const sizeRank = TURRET_TIER_RANK[m.turretSize as TurretSize] ?? 0;
    const maxRank  = TURRET_TIER_RANK[body.maxTurretSize] ?? 0;
    if (sizeRank > maxRank) {
      errors.push(`${body.name} only supports up to a ${body.maxTurretSize} turret (got ${m.turretSize})`);
      continue;
    }
    const turret = TURRETS.find(tt => tt.id === m.turretSize);
    const wep = WEAPONS.find(ww => ww.id === m.weaponId);
    if (turret && wep && wep.spaces > turret.maxWeaponSpaces) {
      errors.push(`${wep.name} is too big for a ${turret.name} (needs ${wep.spaces} spc, turret holds ${turret.maxWeaponSpaces})`);
    }
  }

  return {
    spacesUsed: Math.round(spacesUsed),
    spacesMax: body.spaces,
    loadWeight: Math.round(loadWeight),
    loadMax: body.maxLoad,
    overSpaces,
    overWeight,
    errors,
  };
}

// Does the capacity report indicate the loadout is invalid for any reason
// (over budget or turret/compatibility problems)?
export function isInvalid(cap: CapacityReport): boolean {
  return cap.overSpaces || cap.overWeight || cap.errors.length > 0;
}
