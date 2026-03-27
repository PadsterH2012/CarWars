import type { VehicleState } from '@carwars/shared';

export interface MovementInput {
  speed: number;
  steer: number;
}

export interface HazardCheck {
  required: boolean;
  difficulty: number;
}

export function computeMovement(vehicle: VehicleState, input: MovementInput): VehicleState {
  const distancePerPhase = input.speed / 5;
  const newFacing = (vehicle.facing + input.steer + 360) % 360;

  const radians = (vehicle.facing - 90) * (Math.PI / 180);
  const dx = Math.cos(radians) * distancePerPhase;
  const dy = Math.sin(radians) * distancePerPhase;

  return {
    ...vehicle,
    position: {
      x: vehicle.position.x + dx,
      y: vehicle.position.y + dy
    },
    facing: newFacing,
    speed: input.speed
  };
}

export function applyHazardCheck(vehicle: VehicleState, input: MovementInput): HazardCheck {
  const absTurn = Math.abs(input.steer);
  const required = (input.speed > 10 && absTurn > 30) || absTurn > 60;
  const difficulty = required
    ? Math.max(2, 7 - vehicle.stats.handlingClass + Math.floor(input.speed / 10))
    : 0;
  return { required, difficulty };
}
