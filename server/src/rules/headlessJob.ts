// Headless job resolver — a simplified combat roll, NOT the full tick engine
// (Phase 2 anti-rabbit-hole rule 3). A driver runs a job solo; their skill,
// whether they have a vehicle, and the job difficulty decide the outcome.
//
// Outcome bands (after computing successChance):
//   roll < successChance              → SUCCESS     (full payout, light wear)
//   roll < successChance + 0.15       → PARTIAL     (half payout, moderate wear)
//   roll < successChance + 0.25       → FAILURE     (no payout, repair bill, maybe wounded)
//   else                              → CATASTROPHE (vehicle wrecked, maybe dead)
//
// The breakdown is returned so the after-action report can "show its working"
// (anti-rabbit-hole rule 5).

export interface HeadlessDriver {
  skill: number;
  hasVehicle: boolean;
}

export interface HeadlessJob {
  payout: number;
  difficulty: number; // 1-10
}

export type OutcomeTier = 'success' | 'partial' | 'failure' | 'catastrophe';

export interface JobOutcome {
  tier: OutcomeTier;
  success: boolean;
  payout: number;
  wear: number;
  driverWounded: boolean;
  vehicleWrecked: boolean;
  driverDead: boolean;
  breakdown: {
    baseChance: number;
    vehicleBonus: number;
    difficulty: number;
    successChance: number;
    roll: number;
  };
}

// `rng` is injectable for deterministic testing; it is called in a fixed order
// (main roll first, then wear, then fate). Defaults to Math.random.
export function resolveHeadlessJob(
  driver: HeadlessDriver,
  job: HeadlessJob,
  rng: () => number = Math.random,
): JobOutcome {
  const baseChance = 0.4 + driver.skill * 0.08;
  const vehicleBonus = driver.hasVehicle ? 0.1 : 0;
  const difficulty = job.difficulty;
  const successChance = Math.min(0.95, baseChance + vehicleBonus - difficulty * 0.05);

  const roll = rng();
  const breakdown = { baseChance, vehicleBonus, difficulty, successChance, roll };

  if (roll < successChance) {
    // Success: full payout, minor wear
    return base('success', true, job.payout, Math.floor(rng() * 3), breakdown);
  } else if (roll < successChance + 0.15) {
    // Partial: reduced payout, moderate damage
    return base('partial', true, Math.floor(job.payout * 0.5), 1 + Math.floor(rng() * 3), breakdown);
  } else if (roll < successChance + 0.25) {
    // Failure: no payout, repair bill, chance of injury
    return { ...base('failure', false, 0, 2 + Math.floor(rng() * 4), breakdown), driverWounded: rng() < 0.2 };
  } else {
    // Catastrophe: vehicle wrecked, driver possibly dead
    return { ...base('catastrophe', false, 0, 0, breakdown), vehicleWrecked: true, driverDead: rng() < 0.3 };
  }
}

function base(
  tier: OutcomeTier,
  success: boolean,
  payout: number,
  wear: number,
  breakdown: JobOutcome['breakdown'],
): JobOutcome {
  return { tier, success, payout, wear, driverWounded: false, vehicleWrecked: false, driverDead: false, breakdown };
}
