import type { VehicleState } from '@carwars/shared';

export interface MovementInput {
  speed: number;
  steer: number;
}

export interface HazardCheck {
  required: boolean;
  difficulty: number;
}

// Acceleration model: `input.speed` is the TARGET (throttle/AI desired). The
// vehicle eases its actual speed toward it each tick rather than teleporting,
// so braking and acceleration are gradual and the speedo reads a real ramp.
// Rates are tuned per tick (not literal mph/turn, which would be far too slow
// for match length) and scale with the vehicle's acceleration stat; braking is
// stronger than acceleration. Tunable.
const MIN_ACCEL_PER_TICK = 3;  // mph/tick floor when accelerating
const BRAKE_MULTIPLIER   = 2;  // brakes are ~2× engine accel
const MIN_BRAKE_PER_TICK = 8;  // mph/tick floor when slowing

function approachSpeed(current: number, target: number, accelStat: number): number {
  if (target > current) {
    return Math.min(target, current + Math.max(MIN_ACCEL_PER_TICK, accelStat));
  }
  return Math.max(target, current - Math.max(MIN_BRAKE_PER_TICK, accelStat * BRAKE_MULTIPLIER));
}

// Cornering speed limit: tyres can only hold so much speed through a turn, so
// turning lowers the speed the car can actually sustain. We model this as a CAP
// on the commanded target (not a per-tick nibble) — the car brakes INTO a
// corner and accelerates back OUT of it, which is both realistic and clearly
// visible on the speedo. Loss scales quadratically with how hard you turn
// (steer / max); better handling (higher HC) mitigates it. At full lock a
// poor-handling car is held to ~55% of its commanded speed; gentle turns barely
// cost anything. Because it's a bounded cap (not compounding), a constantly-
// correcting AI is slowed but never trapped. Tunable.
const MAX_STEER = 30;
const CORNER_LIMIT = 0.45; // fraction of speed shed at full lock, HC1
function corneringSpeedCap(target: number, steer: number, handlingClass: number): number {
  const turnFrac = Math.min(1, Math.abs(steer) / MAX_STEER);
  if (turnFrac <= 0 || target <= 0) return target;
  const penalty = turnFrac * turnFrac;
  const hcMitigation = 1 - Math.min(0.5, Math.max(0, (handlingClass - 1)) * 0.1); // HC1=1.0 … HC6=0.5
  return target * (1 - CORNER_LIMIT * penalty * hcMitigation);
}

export function computeMovement(vehicle: VehicleState, input: MovementInput): VehicleState {
  // Turning caps the achievable speed, then the actual speed eases toward that
  // cap — so cornering visibly brakes the car and exiting visibly accelerates it.
  const turnTarget = corneringSpeedCap(input.speed, input.steer, vehicle.stats.handlingClass ?? 3);
  const speed = approachSpeed(vehicle.speed, turnTarget, vehicle.stats.acceleration ?? MIN_ACCEL_PER_TICK);

  // Car Wars: speed (mph) ÷ 5 = inches per phase over 5 phases/turn.
  // We run 10 ticks/turn, so divide by 10 to get the correct inches per tick.
  // Additional /3 scale-down for visual pacing, then /8 for current tuning = /360 total.
  const distancePerPhase = speed / 360;
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
    speed
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
 * Speed compounds the hazard: fast cornering is more dangerous than slow cornering.
 */
export function classifyManeuver(speed: number, absSteering: number): ManeuverResult {
  if (absSteering === 0) return { type: 'bend', dValue: 0 };

  let type: ManeuverType;
  let d: number;
  if (absSteering <= 15)      { type = 'bend';            d = 1; }
  else if (absSteering <= 30) { type = 'drift';           d = 2; }
  else if (absSteering <= 45) { type = 'swerve';          d = 3; }
  else                        { type = 'controlled_skid'; d = 3; }

  // Speed penalty: high-speed cornering raises effective D.
  // Thresholds chosen so normal combat speeds (45–70 mph) don't compound routine manoeuvres;
  // only genuinely fast cornering (>70 mph) adds hazard.
  if (speed > 90)      d += 2;
  else if (speed > 70) d += 1;

  return { type, dValue: Math.min(d, 6) };
}

const LIGHT_BODIES = new Set([
  'light_cycle', 'med_cycle', 'hvy_cycle', 'subcompact', 'trike',
]);
const HEAVY_BODIES = new Set([
  'van', 'truck', 'trailer', 'camper', 'pickup',
]);

/**
 * Computes the signed spin angle (degrees) for a loss-of-control event.
 *
 * Physics model:
 *  - Light bodies (cycles, subcompact) → oversteer: rear snaps in the steer direction, larger angle
 *  - Heavy bodies (van, truck, camper) → understeer: front pushes wide, smaller angle, may snap opposite
 *  - Weight scales magnitude: lighter = more spin, heavier = less spin (baseline ~3000 lbs)
 *  - Speed scales magnitude: faster = more spin (factor 0.5 at rest → 1.5 at 100 mph)
 *
 * @param effect    'fishtail' (small) or 'skid'/'roll' (large)
 * @param speed     Vehicle speed in mph at time of control loss
 * @param weight    Vehicle weight in lbs
 * @param bodyType  Optional BodyType string from loadout
 * @param steerSign +1 right turn, -1 left turn, 0 unknown — used to bias spin direction
 */
export function computeSpinAngle(
  effect: 'fishtail' | 'skid' | 'roll',
  speed: number,
  weight: number,
  bodyType: string | undefined,
  steerSign: number,
): number {
  const isLight = LIGHT_BODIES.has(bodyType ?? '');
  const isHeavy = HEAVY_BODIES.has(bodyType ?? '');

  // Weight factor: lighter spins more, heavier spins less.
  // At 500 lbs (cycle): ~2.2×  |  At 3000 lbs (midsize): 1.0×  |  At 6000 lbs (van): ~0.45×
  const weightFactor = Math.max(0.4, Math.min(2.2, 3000 / Math.max(400, weight)));

  // Speed factor: 0.5 at 0 mph → 1.5 at 100 mph
  const speedFactor = 0.5 + Math.min(speed, 100) / 100;

  // Base angle before scaling — light bodies spin more, heavy less
  let base: number;
  if (effect === 'fishtail') {
    base = isLight ? 14 : isHeavy ? 7 : 10;
  } else {
    base = (isLight ? 80 : isHeavy ? 40 : 60) + Math.random() * 30;
  }

  const magnitude = Math.round(base * speedFactor * weightFactor);
  const clamped = effect === 'fishtail'
    ? Math.max(4, Math.min(35, magnitude))
    : Math.max(15, Math.min(175, magnitude));

  // Spin direction:
  //   Oversteer (light/neutral): rear swings out in steer direction → same sign as steer
  //   Understeer (heavy): front pushes wide → tends to snap opposite, or random
  let dir: number;
  if (steerSign !== 0) {
    dir = isHeavy && Math.random() < 0.6 ? -steerSign : steerSign;
  } else {
    dir = Math.random() < 0.5 ? 1 : -1;
  }

  return dir * clamped;
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
 * @param hcBonus Optional driving skill HC bonus (does not modify stored vehicle stats)
 */
export function resolveControlTable(hc: number, hazardAccumulator: number, forcedRoll?: number, hcBonus?: number): ControlResult {
  if (hazardAccumulator === 0) return { effect: 'none', severity: 0 };

  const roll = forcedRoll ?? (Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1);
  const effectiveHc = hc + (hcBonus ?? 0);
  // Baseline offset of 7 so HC=3/D=2 (normal AI steering) passes ~72% of turns.
  // Without it, HC - D ≤ 1 always, meaning every turn causes at least a fishtail.
  const result = roll + hazardAccumulator - effectiveHc - 7;

  if (result <= 0)  return { effect: 'none', severity: 0 };
  if (result === 1) return { effect: 'fishtail', severity: 1 };
  if (result === 2) return { effect: 'skid', severity: 2 };
  if (result === 3) return { effect: 'skid', severity: 3 };
  if (result === 4) return { effect: 'roll', severity: 4 };
  return                  { effect: 'collision', severity: result };
}

export interface CollisionResult {
  damageA: number;   // damage to vehicle A (attacker / rear-ender)
  damageB: number;   // damage to vehicle B (target / front vehicle)
  closingSpeed: number;
}

/**
 * Calculates collision damage for two vehicles.
 * @param speedA Speed of vehicle A (attacker / rear-ender) in mph
 * @param speedB Speed of vehicle B (target / front vehicle) in mph
 * @param type Collision type: head_on sums speeds; same_dir and t_bone use the absolute difference
 * @param attackerHasRamplate If true, vehicle A takes half damage (floor)
 */
export function resolveCollision(
  speedA: number,
  speedB: number,
  type: 'head_on' | 'same_dir' | 't_bone',
  attackerHasRamplate = false
): CollisionResult {
  const closingSpeed = type === 'head_on'
    ? speedA + speedB
    : Math.abs(speedA - speedB);

  const baseDamage = Math.floor(closingSpeed / 5);
  const damageB = baseDamage;
  const damageA = attackerHasRamplate ? Math.floor(baseDamage / 2) : baseDamage;

  return { damageA, damageB, closingSpeed };
}
