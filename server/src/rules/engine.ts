import type { ZoneState, VehicleState } from '@carwars/shared';
import { computeMovement } from './movement';
import { resolveToHit, resolveDamage, getAttackLocation } from './combat';
import { WEAPONS } from './data/weapons';

interface VehicleInput {
  speed: number;
  steer: number;
  fireWeapon: string | null;
}

export interface TurnEngine {
  queueInput(vehicleId: string, input: VehicleInput): void;
  resolveTick(): ZoneState;
  getState(): ZoneState;
}

export function createTurnEngine(initialState: ZoneState): TurnEngine {
  let state: ZoneState = { ...initialState, vehicles: [...initialState.vehicles] };
  const pendingInputs = new Map<string, VehicleInput>();
  const lastInputs = new Map<string, VehicleInput>();

  return {
    queueInput(vehicleId, input) {
      pendingInputs.set(vehicleId, input);
    },

    resolveTick() {
      const activeVehicles = state.vehicles.filter(v => !v.stats.damageState.destroyed);
      const destroyedVehicles = state.vehicles.filter(v => v.stats.damageState.destroyed);
      const preMoveVehicles = [...activeVehicles];

      // Move all active vehicles
      const newVehicles = activeVehicles.map(vehicle => {
        const input = pendingInputs.get(vehicle.id) ?? lastInputs.get(vehicle.id) ?? { speed: 0, steer: 0, fireWeapon: null };
        // Persist speed/steer but NOT fireWeapon — weapons must be declared each tick
        lastInputs.set(vehicle.id, { speed: input.speed, steer: input.steer, fireWeapon: null });
        return computeMovement(vehicle, input);
      });

      // Build a mutable damage map: vehicleId -> updated DamageState
      const damageUpdates = new Map<string, import('@carwars/shared').DamageState>();

      // Resolve combat using pre-move positions
      preMoveVehicles.forEach((attacker) => {
        const input = pendingInputs.get(attacker.id) ?? { speed: 0, steer: 0, fireWeapon: null };
        if (!input.fireWeapon) return;

        const weapon = WEAPONS.find(w => w.id === input.fireWeapon);
        if (!weapon) return;

        preMoveVehicles.forEach((target) => {
          if (attacker.id === target.id) return;
          const dx = target.position.x - attacker.position.x;
          const dy = target.position.y - attacker.position.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          const toHit = resolveToHit(attacker, target, weapon, distance);
          if (!toHit.hit) return;

          const damageResult = resolveDamage(target, toHit.location, weapon.damage);

          // Apply damage to the vehicle's DamageState
          const currentDamage = damageUpdates.get(target.id) ?? { ...target.stats.damageState };
          const newArmor = { ...currentDamage.armor };
          const existing = newArmor[toHit.location] ?? 0;
          newArmor[toHit.location] = Math.max(0, existing - damageResult.damageDealt);

          // Map hit location to a tire index (0=front-left, 1=front-right, 2=rear-left, 3=rear-right)
          const tireIndex = (toHit.location === 'front' || toHit.location === 'left') ? 0
            : (toHit.location === 'right') ? 1
            : 2;

          damageUpdates.set(target.id, {
            ...currentDamage,
            armor: newArmor,
            engineDamaged: currentDamage.engineDamaged || damageResult.effects.includes('engine_hit'),
            driverWounded: currentDamage.driverWounded || damageResult.effects.includes('driver_wounded'),
            destroyed: currentDamage.destroyed || damageResult.effects.includes('destroyed'),
            tiresBlown: damageResult.effects.includes('tire_blown') && !currentDamage.tiresBlown.includes(tireIndex)
              ? [...currentDamage.tiresBlown, tireIndex]
              : currentDamage.tiresBlown
          });
        });
      });

      // Apply damage updates to newVehicles and re-add destroyed vehicles unchanged
      const finalVehicles = [
        ...newVehicles.map(v => {
          const dmg = damageUpdates.get(v.id);
          if (!dmg) return v;
          return {
            ...v,
            stats: { ...v.stats, damageState: dmg }
          };
        }),
        ...destroyedVehicles
      ];

      pendingInputs.clear();
      state = { ...state, tick: state.tick + 1, vehicles: finalVehicles };
      return state;
    },

    getState() {
      return state;
    }
  };
}
