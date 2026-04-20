// Driver request generator — reads current vehicle + driver state and decides
// whether the driver wants something. Pure function; the API layer persists.
//
// Generation priorities:
//   1. Repair   — if armor deficit ≥ 25% of original
//   2. Ammo     — if any mount dropped below 50% of starting ammo
//   3. Accessory — if driver is skilled but vehicle lacks a targeting computer
//   4. Armor-up — rare, when driver has high aggression + armor maxed out
//
// A driver can have at most one pending request at a time; callers should skip
// drivers with an existing pending request.

import type { VehicleLoadout, DamageState } from '@carwars/shared';
import { BODIES } from './data/bodies';
import { WEAPONS } from './data/weapons';
import { ACCESSORY_INDEX } from './data/accessories';
import { computeCapacity, isInvalid } from './capacity';

interface Driver {
  id: string;
  name: string;
  skill: number;
  aggression: number;
  loyalty: number;
}

interface VehicleRow {
  id: string;
  name: string;
  loadout: VehicleLoadout;
  original_loadout: VehicleLoadout;
  damage_state: DamageState;
}

export interface GeneratedRequest {
  kind: 'repair' | 'ammo' | 'armor_up' | 'accessory_add';
  description: string;
  payload: Record<string, unknown>;
  cost: number;
}

const ARMOR_MUL: Record<string, number> = {
  ablative: 1, metal: 1, fireproof: 2, laser_reflective: 2, lr_fireproof: 4, radarproof: 2,
};

export function generateRequestForDriver(driver: Driver, vehicle: VehicleRow | null): GeneratedRequest | null {
  if (!vehicle) return null;
  const loadout = vehicle.loadout;
  const orig = vehicle.original_loadout ?? loadout;
  const ds = vehicle.damage_state;

  // 1. Repair — sum deficits across all faces, propose a full patch-up
  const armorFaces = ['front', 'back', 'left', 'right', 'top', 'underbody'] as const;
  let armorDeficit = 0;
  for (const f of armorFaces) {
    const origV = (orig.armor as Record<string, number>)[f] ?? 0;
    const curV = (ds.armor as Record<string, number>)[f] ?? 0;
    if (curV < origV) armorDeficit += origV - curV;
  }
  const totalOrig = armorFaces.reduce((s, f) => s + ((orig.armor as Record<string, number>)[f] ?? 0), 0);
  if (totalOrig > 0 && armorDeficit / totalOrig >= 0.25) {
    const body = BODIES.find(b => b.id === orig.bodyType);
    const mul = ARMOR_MUL[orig.armorType ?? 'ablative'] ?? 1;
    const cost = armorDeficit * (body?.armorCostPerPt ?? 10) * mul;
    // Aggression dampens how often drivers ask for repair (a reckless driver
    // won't care until their armor's really gone); loyalty has the opposite
    // effect — loyal drivers maintain the kit.
    const chance = 0.25 + (driver.loyalty / 20) - (driver.aggression / 30);
    if (Math.random() < chance) {
      return {
        kind: 'repair',
        description: `${driver.name} wants their ${vehicle.name} patched up (${armorDeficit} armour pts lost)`,
        payload: { vehicleId: vehicle.id },
        cost,
      };
    }
  }

  // 2. Ammo — any mount that's below 50% of its original
  const origMounts = orig.mounts ?? [];
  const curMounts = loadout.mounts ?? [];
  const lowMounts = origMounts.filter(om => {
    const cm = curMounts.find(c => c.id === om.id);
    if (!cm) return false;
    return om.ammo > 0 && cm.ammo < om.ammo * 0.5;
  });
  if (lowMounts.length > 0 && Math.random() < 0.3) {
    const mount = lowMounts[0];
    const cur = curMounts.find(c => c.id === mount.id);
    const shortage = mount.ammo - (cur?.ammo ?? 0);
    const wep = WEAPONS.find(w => w.id === mount.weaponId);
    if (wep && shortage > 0) {
      return {
        kind: 'ammo',
        description: `${driver.name} wants the ${wep.name} reloaded (${shortage} rounds)`,
        payload: { vehicleId: vehicle.id, mountId: mount.id, shortage },
        cost: shortage * wep.ammoCost,
      };
    }
  }

  // 3. Accessory — skilled drivers without a targeting computer
  const accessories = loadout.accessories ?? [];
  const hasComputer = accessories.some(a => {
    const def = ACCESSORY_INDEX[a.id];
    return def?.category === 'computer';
  });
  if (!hasComputer && driver.skill >= 3 && Math.random() < 0.15 * (driver.skill / 6)) {
    // Pick computer scaled by skill: low-skill asks for SWC, high-skill asks for HRC
    const pickId = driver.skill >= 4 ? 'hrc' : 'swc';
    const def = ACCESSORY_INDEX[pickId];
    if (def) {
      // Only ask if it would actually fit — otherwise the approval would
      // reject and the request would just annoy the player.
      const boundMountId = def.bindable ? loadout.mounts?.[0]?.id : undefined;
      const proposed = {
        ...loadout,
        accessories: [...accessories, { id: pickId, ...(boundMountId ? { boundMountId } : {}) }],
      };
      if (!isInvalid(computeCapacity(proposed))) {
        return {
          kind: 'accessory_add',
          description: `${driver.name} is asking for a ${def.name} — '${def.description}'`,
          payload: { vehicleId: vehicle.id, accessoryId: pickId, bindToFirstMount: def.bindable },
          cost: def.cost,
        };
      }
    }
  }

  // 4. Armor-up — aggressive drivers with depleted armour want more, not less
  if (driver.aggression >= 4 && Math.random() < 0.05) {
    const body = BODIES.find(b => b.id === orig.bodyType);
    if (body) {
      const bumpPts = 5;
      const mul = ARMOR_MUL[orig.armorType ?? 'ablative'] ?? 1;
      const face = 'front';
      const proposedOrig = {
        ...orig,
        armor: { ...orig.armor, [face]: ((orig.armor as Record<string, number>)[face] ?? 0) + bumpPts },
      };
      if (!isInvalid(computeCapacity(proposedOrig))) {
        return {
          kind: 'armor_up',
          description: `${driver.name} wants +${bumpPts} front armour — 'I want more'`,
          payload: { vehicleId: vehicle.id, face, delta: bumpPts },
          cost: bumpPts * body.armorCostPerPt * mul,
        };
      }
    }
  }

  return null;
}
