import type { VehicleLoadout, VehicleStats, DamageState } from '@carwars/shared';
import { CHASSIS } from './data/chassis';
import { ENGINES } from './data/engines';

export function deriveStats(id: string, name: string, loadout: VehicleLoadout): VehicleStats {
  const engine = ENGINES.find(e => e.id === loadout.engineId);
  if (!engine) throw new Error(`Unknown engine: ${loadout.engineId}`);

  const chassis = CHASSIS.find(c => c.id === loadout.chassisId);
  if (!chassis) throw new Error(`Unknown chassis: ${loadout.chassisId}`);

  const totalWeight = engine.weight + 100 * loadout.tires.length;
  const handlingClass = Math.min(6, Math.max(1, Math.round(totalWeight / 1000)));

  const damageState: DamageState = {
    armor: { ...loadout.armor },
    engineDamaged: false,
    driverWounded: false,
    tiresBlown: [],
    destroyed: false
  };

  return {
    id,
    name,
    loadout,
    damageState,
    maxSpeed: engine.maxSpeed,
    handlingClass,
    weight: totalWeight
  };
}
