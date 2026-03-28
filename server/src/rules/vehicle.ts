import type { VehicleLoadout, VehicleStats, DamageState } from '@carwars/shared';
import { CHASSIS } from './data/chassis';
import { ENGINES } from './data/engines';
import { BODIES } from './data/bodies';
import { POWER_PLANTS } from './data/power-plants';
import { SUSPENSIONS } from './data/suspensions';
import { TIRES } from './data/tires';

function computeAcceleration(powerFactors: number, totalWeight: number): number {
  if (powerFactors < totalWeight / 3) return 0;
  if (powerFactors < totalWeight / 2) return 5;
  if (powerFactors < totalWeight)     return 10;
  return 15;
}

function computeTopSpeed(powerFactors: number, totalWeight: number): number {
  const raw = (360 * powerFactors) / (powerFactors + totalWeight);
  // Round to nearest 2.5
  return Math.round(raw / 2.5) * 2.5;
}

export function deriveStats(id: string, name: string, loadout: VehicleLoadout): VehicleStats {
  let maxSpeed: number;
  let handlingClass: number;
  let totalWeight: number;
  let acceleration: number;
  let engineDP = 8;

  if (loadout.bodyType && loadout.powerPlantType) {
    // === Compendium path ===
    const body = BODIES.find(b => b.id === loadout.bodyType);
    if (!body) throw new Error(`Unknown bodyType: ${loadout.bodyType}`);

    const plant = POWER_PLANTS.find(p => p.id === loadout.powerPlantType);
    if (!plant) throw new Error(`Unknown powerPlantType: ${loadout.powerPlantType}`);

    const suspType = loadout.suspensionType ?? 'standard';
    const suspension = SUSPENSIONS.find(s => s.id === suspType);
    if (!suspension) throw new Error(`Unknown suspensionType: ${suspType}`);

    const tireTypeName = loadout.tireType ?? 'standard';
    const tire = TIRES.find(t => t.id === tireTypeName);
    if (!tire) throw new Error(`Unknown tireType: ${tireTypeName}`);

    // Weight = body + plant + tires (cycles have 2, cars have 4)
    const tireCount = body.isCycle ? 2 : 4;
    totalWeight = body.baseWeight + plant.weight + tire.weightPerTire * tireCount;

    // Add armor weight
    const armorPts = Object.values(loadout.armor).reduce((s, v) => s + v, 0);
    totalWeight += armorPts * body.armorWtPerPt;

    engineDP = plant.dp;
    acceleration = computeAcceleration(plant.powerFactors, totalWeight);
    maxSpeed = computeTopSpeed(plant.powerFactors, totalWeight);

    // HC from suspension, adjusted by body category
    const isVanSize = ['van', 'pickup', 'camper'].includes(loadout.bodyType as string);
    const isSub = body.isCycle || loadout.bodyType === 'subcompact';
    handlingClass = isSub ? suspension.subHC : isVanSize ? suspension.vanHC : suspension.carHC;
    handlingClass += tire.hcModifier;
    handlingClass = Math.max(1, Math.min(6, handlingClass));

  } else {
    // === Legacy path (existing test vehicles without bodyType) ===
    const engine = ENGINES.find(e => e.id === loadout.engineId);
    if (!engine) throw new Error(`Unknown engine: ${loadout.engineId}`);
    const chassis = CHASSIS.find(c => c.id === loadout.chassisId);
    if (!chassis) throw new Error(`Unknown chassis: ${loadout.chassisId}`);

    totalWeight = engine.weight + 100 * loadout.tires.length;
    maxSpeed = engine.maxSpeed;
    acceleration = 5; // legacy default
    handlingClass = Math.min(6, Math.max(1, Math.round(totalWeight / 1000)));
  }

  const damageState: DamageState = {
    armor: { ...loadout.armor },
    engineDamaged: false,
    driverWounded: false,
    tiresBlown: [],
    destroyed: false,
    onFire: false,
    engineDP,
    internalDamage: [],
  };

  return {
    id,
    name,
    loadout,
    damageState,
    maxSpeed,
    handlingClass,
    acceleration,
    weight: totalWeight
  };
}
