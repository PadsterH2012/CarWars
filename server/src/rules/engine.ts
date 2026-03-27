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
      // Snapshot current vehicles for combat resolution (use pre-move positions)
      const preMoveVehicles = [...state.vehicles];

      // Move all vehicles
      const newVehicles = state.vehicles.map(vehicle => {
        const input = pendingInputs.get(vehicle.id) ?? lastInputs.get(vehicle.id) ?? { speed: 0, steer: 0, fireWeapon: null };
        lastInputs.set(vehicle.id, input);
        return computeMovement(vehicle, input);
      });

      // Resolve combat using pre-move positions for hit detection
      preMoveVehicles.forEach((attacker) => {
        const input = pendingInputs.get(attacker.id) ?? lastInputs.get(attacker.id);
        if (!input?.fireWeapon) return;

        const weapon = WEAPONS.find(w => w.id === input.fireWeapon);
        if (!weapon) return;

        preMoveVehicles.forEach((target) => {
          if (attacker.id === target.id) return;
          const dx = target.position.x - attacker.position.x;
          const dy = target.position.y - attacker.position.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          const toHit = resolveToHit(attacker, target, weapon, distance);
          if (toHit.hit) {
            resolveDamage(target, toHit.location, weapon.damage);
          }
        });
      });

      pendingInputs.clear();
      state = { ...state, tick: state.tick + 1, vehicles: newVehicles };
      return state;
    },

    getState() {
      return state;
    }
  };
}
