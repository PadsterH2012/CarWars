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
  kind: 'repair' | 'ammo' | 'armor_up' | 'accessory_add' | 'compound_swap';
  description: string;
  payload: Record<string, unknown>;
  cost: number;  // net cost (install minus trade-in refund for compound)
}

// 50% trade-in rate — matches the workshop's WORKSHOP_TRADE_IN constant
const TRADE_IN = 0.5;

// Find the cheapest removable weapon mount that, when dropped, would let the
// proposed accessory fit within the body's spaces/weight budget. Returns the
// mount or null if no single removal works.
function findRemovableForFit(
  loadout: VehicleLoadout,
  accessoryToAdd: string,
): { mountId: string; weaponId: string; refund: number } | null {
  const accDef = ACCESSORY_INDEX[accessoryToAdd];
  if (!accDef) return null;
  const mounts = loadout.mounts ?? [];
  // Sort cheapest-weapon-first so drivers prefer dropping the least valuable rig
  const candidates = mounts
    .filter(m => m.weaponId)
    .map(m => ({ mount: m, weapon: WEAPONS.find(w => w.id === m.weaponId) }))
    .filter(c => c.weapon)
    .sort((a, b) => (a.weapon!.cost ?? 0) - (b.weapon!.cost ?? 0));
  for (const c of candidates) {
    const trimmedMounts = mounts.filter(mm => mm.id !== c.mount.id);
    const trimmedAccessories = [...(loadout.accessories ?? [])];
    const boundMountId = accDef.bindable ? trimmedMounts[0]?.id : undefined;
    trimmedAccessories.push({ id: accessoryToAdd, ...(boundMountId ? { boundMountId } : {}) });
    const proposed = { ...loadout, mounts: trimmedMounts, accessories: trimmedAccessories };
    if (!isInvalid(computeCapacity(proposed))) {
      const refund = Math.floor((c.weapon!.cost + (c.weapon!.ammoCost ?? 0) * c.mount.ammo) * TRADE_IN);
      return { mountId: c.mount.id, weaponId: c.weapon!.id, refund };
    }
  }
  return null;
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

  // 3. Accessory — skilled drivers without a targeting computer. If the
  // straight install won't fit, try to find a weapon to drop and propose a
  // compound swap instead. Drivers with high loyalty suggest the cheapest
  // tradeoff; low loyalty doesn't offer alternatives.
  const accessories = loadout.accessories ?? [];
  const hasComputer = accessories.some(a => {
    const def = ACCESSORY_INDEX[a.id];
    return def?.category === 'computer';
  });
  if (!hasComputer && driver.skill >= 3 && Math.random() < 0.15 * (driver.skill / 6)) {
    const pickId = driver.skill >= 4 ? 'hrc' : 'swc';
    const def = ACCESSORY_INDEX[pickId];
    if (def) {
      const boundMountId = def.bindable ? loadout.mounts?.[0]?.id : undefined;
      const straightProposed = {
        ...loadout,
        accessories: [...accessories, { id: pickId, ...(boundMountId ? { boundMountId } : {}) }],
      };
      if (!isInvalid(computeCapacity(straightProposed))) {
        return {
          kind: 'accessory_add',
          description: `${driver.name} is asking for a ${def.name} — '${def.description}'`,
          payload: { vehicleId: vehicle.id, accessoryId: pickId, bindToFirstMount: def.bindable },
          cost: def.cost,
        };
      }
      // Straight install busts capacity — see if trading in a weapon would help
      if (driver.loyalty >= 4) {
        const tradeIn = findRemovableForFit(loadout, pickId);
        if (tradeIn) {
          const net = def.cost - tradeIn.refund;
          const wepName = WEAPONS.find(w => w.id === tradeIn.weaponId)?.name ?? tradeIn.weaponId;
          return {
            kind: 'compound_swap',
            description: `${driver.name} wants a ${def.name} — offers to drop the ${wepName} to make room (trade-in $${tradeIn.refund.toLocaleString()}, net $${net.toLocaleString()})`,
            payload: {
              vehicleId: vehicle.id,
              remove: { type: 'weapon', mountId: tradeIn.mountId, refund: tradeIn.refund },
              add: { type: 'accessory', accessoryId: pickId, bindToFirstMount: def.bindable, cost: def.cost },
            },
            cost: net,
          };
        }
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
