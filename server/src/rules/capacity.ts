import type { VehicleLoadout } from '@carwars/shared';
import { BODIES } from './data/bodies';
import { POWER_PLANTS } from './data/power-plants';
import { TIRES } from './data/tires';
import { WEAPONS } from './data/weapons';

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

  // Spaces: power plant + weapons. Armor/tires don't consume spaces.
  let spacesUsed = plant?.spaces ?? 0;
  for (const m of loadout.mounts ?? []) {
    const w = WEAPONS.find(ww => ww.id === m.weaponId);
    if (w) spacesUsed += w.spaces;
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
  }

  const errors: string[] = [];
  const overSpaces = spacesUsed > body.spaces;
  const overWeight = loadWeight > body.maxLoad;
  if (overSpaces) errors.push(`Over spaces: ${spacesUsed} / ${body.spaces}`);
  if (overWeight) errors.push(`Over weight: ${Math.round(loadWeight)} / ${body.maxLoad} lbs`);

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
