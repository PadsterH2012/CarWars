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

export type ManeuverType = 'bend' | 'drift' | 'swerve' | 'controlled_skid' | 'bootlegger' | 'pivot' | 't_stop';

export interface ManeuverResult {
  type: ManeuverType;
  dValue: number;  // hazard D-value added to hazard accumulator
}

/**
 * Classifies a steering input into a maneuver type with its Compendium D-value.
 * @param speed Vehicle speed (mph) — reserved for future speed-dependent maneuvers
 * @param absSteering Absolute value of steering input (0-60 degrees)
 */
export function classifyManeuver(speed: number, absSteering: number): ManeuverResult {
  if (absSteering === 0) return { type: 'bend', dValue: 1 };
  if (absSteering <= 15) return { type: 'bend', dValue: 1 };
  if (absSteering <= 30) return { type: 'drift', dValue: 2 };
  if (absSteering <= 45) return { type: 'swerve', dValue: 3 };
  return { type: 'controlled_skid', dValue: 3 };
}

export interface ControlResult {
  effect: 'none' | 'fishtail' | 'skid' | 'roll' | 'collision';
  severity: number;
}

/**
 * Resolves the Compendium control table.
 * @param hc Current handling class
 * @param hazardAccumulator D-points accumulated this turn
 * @param forcedRoll Optional forced 2d6 roll (for testing); uses random if omitted
 */
export function resolveControlTable(hc: number, hazardAccumulator: number, forcedRoll?: number): ControlResult {
  if (hazardAccumulator === 0) return { effect: 'none', severity: 0 };

  const roll = forcedRoll ?? (Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1);
  const result = roll + hazardAccumulator - hc;

  if (result <= 0)  return { effect: 'none', severity: 0 };
  if (result === 1) return { effect: 'fishtail', severity: 1 };
  if (result === 2) return { effect: 'skid', severity: 2 };
  if (result === 3) return { effect: 'skid', severity: 3 };
  if (result === 4) return { effect: 'roll', severity: 4 };
  return                  { effect: 'collision', severity: result };
}
