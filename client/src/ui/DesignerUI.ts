import type { VehicleLoadout } from '@carwars/shared';

// Mirror cost data from server/src/rules/data
const CHASSIS_COSTS: Record<string, number> = { compact: 1000, mid: 1500, van: 3000, pickup: 2000 };
const ENGINE_COSTS: Record<string, number> = { small: 1000, medium: 2000, large: 4000, super: 8000 };
const SUSPENSION_COSTS: Record<string, number> = { standard: 500, performance: 1500 };
const TIRE_COST = 100;
const ARMOR_COST_PER_POINT = 100;
const WEAPON_COSTS: Record<string, number> = { mg: 500, hmg: 1000, rl: 1500, laser: 3000, oil: 200, mine: 300 };
const AMMO_COST_PER_SHOT = 5;

export function calculateLoadoutCost(loadout: VehicleLoadout): number {
  let cost = 0;
  cost += CHASSIS_COSTS[loadout.chassisId] ?? 0;
  cost += ENGINE_COSTS[loadout.engineId] ?? 0;
  cost += SUSPENSION_COSTS[loadout.suspensionId] ?? 0;
  cost += loadout.tires.length * TIRE_COST;
  for (const mount of loadout.mounts) {
    cost += WEAPON_COSTS[mount.weaponId ?? ''] ?? 0;
    cost += mount.ammo * AMMO_COST_PER_SHOT;
  }
  const armor = loadout.armor;
  cost += (armor.front + armor.back + armor.left + armor.right + armor.top + armor.underbody) * ARMOR_COST_PER_POINT;
  return cost;
}

export function validateLoadout(loadout: VehicleLoadout): string[] {
  const errors: string[] = [];
  if (loadout.tires.length < 4) errors.push('Vehicle needs 4 tires');
  if (!CHASSIS_COSTS[loadout.chassisId]) errors.push(`Unknown chassis: ${loadout.chassisId}`);
  if (!ENGINE_COSTS[loadout.engineId]) errors.push(`Unknown engine: ${loadout.engineId}`);
  return errors;
}
