// Helpers that apply installed-accessory effects at runtime — kept separate
// from the static catalog so engine / movement code can read effects with a
// stable signature.

import type { VehicleLoadout, WeaponMount } from '@carwars/shared';
import { ACCESSORY_INDEX } from './data/accessories';

// Sum of every accessory's to-hit bonus that applies to firing the given
// mount. Negative numbers mean "easier to hit" (lower target number).
//   - HRC (toHitBonusAll): applies to every weapon
//   - SWC / HRSWC / Targeting Laser (toHitBonusBound): only when bound to
//     this specific mount
export function accessoryToHitBonus(loadout: VehicleLoadout | undefined, mount: WeaponMount): number {
  if (!loadout?.accessories) return 0;
  let total = 0;
  for (const a of loadout.accessories) {
    const def = ACCESSORY_INDEX[a.id];
    if (!def) continue;
    if (def.effects.toHitBonusAll) total += def.effects.toHitBonusAll;
    if (def.effects.toHitBonusBound && a.boundMountId === mount.id) {
      total += def.effects.toHitBonusBound;
    }
  }
  return total;
}

// Driver-skill bonus from accessories (Cyberlink etc.). Folds into whatever
// the driver entity's base skill is.
export function accessorySkillBonus(loadout: VehicleLoadout | undefined): number {
  if (!loadout?.accessories) return 0;
  let total = 0;
  for (const a of loadout.accessories) {
    const def = ACCESSORY_INDEX[a.id];
    if (def?.effects.driverSkillBonus) total += def.effects.driverSkillBonus;
  }
  return total;
}

// HC modifier from accessories (Spoiler, Active Suspension, ...). Applied
// after suspension HC + tire HC mod, before the 1..6 clamp.
export function accessoryHcBonus(loadout: VehicleLoadout | undefined): number {
  if (!loadout?.accessories) return 0;
  let total = 0;
  for (const a of loadout.accessories) {
    const def = ACCESSORY_INDEX[a.id];
    if (def?.effects.hcBonus) total += def.effects.hcBonus;
  }
  return total;
}

// Top-speed multiplier (Streamlining +5% etc.). Returns 1.0 when no
// accessory affects top speed.
export function accessoryTopSpeedMul(loadout: VehicleLoadout | undefined): number {
  if (!loadout?.accessories) return 1;
  let mul = 1;
  for (const a of loadout.accessories) {
    const def = ACCESSORY_INDEX[a.id];
    if (def?.effects.topSpeedMul) mul *= def.effects.topSpeedMul;
  }
  return mul;
}

// Best autopilot tier installed (0 if none) — engine consults this when the
// player toggles autopilot or when no driver is at the wheel.
export function autopilotSkillTier(loadout: VehicleLoadout | undefined): number {
  if (!loadout?.accessories) return 0;
  let best = 0;
  for (const a of loadout.accessories) {
    const def = ACCESSORY_INDEX[a.id];
    const tier = def?.effects.autopilotSkill ?? 0;
    if (tier > best) best = tier;
  }
  return best;
}

export function hasFireExtinguisher(loadout: VehicleLoadout | undefined): boolean {
  return !!loadout?.accessories?.some(a => ACCESSORY_INDEX[a.id]?.effects.clearOnFire);
}
