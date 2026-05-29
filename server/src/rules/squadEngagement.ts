// Headless squad engagement resolver — a simplified squad-vs-NPC/rival fight,
// NOT the full tick engine (Phase 4 anti-rabbit-hole rule 3). It extends the
// Phase 2 headless job roll (see rules/headlessJob.ts) to multiple vehicles:
//
//   - successChance is driven by the squad's AVERAGE driver skill, a flat
//     vehicle bonus, a squad-SIZE bonus (more guns = better odds), minus the
//     zone difficulty.
//   - One main roll picks the engagement outcome tier; then each driver and
//     vehicle takes consequences scaled to that tier.
//
// Outcome bands (after computing successChance):
//   roll < successChance              → SUCCESS  (full income, light damage)
//   roll < successChance + 0.15       → PARTIAL  (half income, moderate damage)
//   roll < successChance + 0.25       → FAILURE  (no income, heavy damage, wounds)
//   else                              → ROUTED   (no income, a wreck, a death)
//
// The breakdown is returned so the after-action report can "show its working".

export interface SquadDriver {
  id: string;
  name: string;
  skill: number;
}

export interface SquadVehicle {
  id: string;
  name: string;
  value: number; // loadout.totalCost — drives repair cost
}

export type EngagementOutcome = 'success' | 'partial' | 'failure' | 'routed';
export type DriverStatus = 'unharmed' | 'wounded' | 'dead';
export type VehicleDamageTier = 'none' | 'light' | 'moderate' | 'heavy' | 'wrecked';

export interface SquadEngagementInput {
  squad: SquadDriver[];
  vehicles: SquadVehicle[];
  zoneDifficulty: number; // 1-10
  assignment: 'patrol' | 'job' | 'raid';
  basePayout: number;
  rival?: { id: string; name: string };
}

export interface PerDriverResult {
  driverId: string;
  driverName: string;
  status: DriverStatus;
  kills: number;
}

export interface PerVehicleResult {
  vehicleId: string;
  name: string;
  damage: VehicleDamageTier;
  repairCost: number;
}

export interface SquadEngagementResult {
  outcome: EngagementOutcome;
  perDriver: PerDriverResult[];
  vehicles: PerVehicleResult[];
  income: number;
  repairCost: number;
  net: number;
  rivalRepChange?: { rivalId: string; rivalName: string; delta: number };
  breakdown: {
    squadPower: number;
    vehiclePower: number;
    avgSkill: number;
    zoneDifficulty: number;
    squadSizeBonus: number;
    vehicleBonus: number;
    successChance: number;
    roll: number;
  };
}

// Fraction of a vehicle's value spent on repairs at each damage tier.
const REPAIR_FRACTION: Record<VehicleDamageTier, number> = {
  none: 0,
  light: 0.04,
  moderate: 0.12,
  heavy: 0.3,
  wrecked: 1.0,
};

// Damage tier each vehicle takes for a given engagement outcome.
const DAMAGE_BY_OUTCOME: Record<EngagementOutcome, VehicleDamageTier> = {
  success: 'light',
  partial: 'moderate',
  failure: 'heavy',
  routed: 'wrecked',
};

// `rng` is injectable for deterministic testing; it is called in a fixed order:
// the main roll first, then for each driver in squad order a status roll
// followed by a kills roll. Defaults to Math.random.
export function resolveSquadEngagement(
  input: SquadEngagementInput,
  rng: () => number = Math.random,
): SquadEngagementResult {
  const { squad, vehicles, zoneDifficulty, basePayout, rival } = input;

  const squadPower = squad.reduce((sum, d) => sum + d.skill, 0);
  const vehiclePower = vehicles.reduce((sum, v) => sum + v.value, 0);
  const n = Math.max(1, squad.length);
  const avgSkill = squadPower / n;

  const baseChance = 0.4 + avgSkill * 0.08;
  const vehicleBonus = vehicles.length > 0 ? 0.1 : 0;
  const squadSizeBonus = (n - 1) * 0.06;
  const successChance = clamp(
    0.05,
    0.95,
    baseChance + vehicleBonus + squadSizeBonus - zoneDifficulty * 0.05,
  );

  const roll = rng();
  const outcome = pickOutcome(roll, successChance);

  const perDriver = squad.map(d => resolveDriver(d, outcome, rng));

  const vehicleDamage = DAMAGE_BY_OUTCOME[outcome];
  const perVehicle: PerVehicleResult[] = vehicles.map(v => ({
    vehicleId: v.id,
    name: v.name,
    damage: vehicleDamage,
    repairCost: Math.round(v.value * REPAIR_FRACTION[vehicleDamage]),
  }));

  // ROUTED is a catastrophe — the first vehicle is wrecked outright even if the
  // tier table already says so; a squad with no vehicles simply takes no hit.
  const income =
    outcome === 'success' ? basePayout : outcome === 'partial' ? Math.floor(basePayout * 0.5) : 0;
  const repairCost = perVehicle.reduce((sum, v) => sum + v.repairCost, 0);
  const net = income - repairCost;

  const playerPrevailed = outcome === 'success' || outcome === 'partial';
  const rivalRepChange = rival
    ? { rivalId: rival.id, rivalName: rival.name, delta: playerPrevailed ? 10 : -5 }
    : undefined;

  return {
    outcome,
    perDriver,
    vehicles: perVehicle,
    income,
    repairCost,
    net,
    rivalRepChange,
    breakdown: {
      squadPower,
      vehiclePower,
      avgSkill,
      zoneDifficulty,
      squadSizeBonus,
      vehicleBonus,
      successChance,
      roll,
    },
  };
}

function pickOutcome(roll: number, successChance: number): EngagementOutcome {
  if (roll < successChance) return 'success';
  if (roll < successChance + 0.15) return 'partial';
  if (roll < successChance + 0.25) return 'failure';
  return 'routed';
}

// Per-driver consequences scaled to the engagement tier. Two rng draws per
// driver: a status roll (injury severity) then a kills roll.
function resolveDriver(d: SquadDriver, outcome: EngagementOutcome, rng: () => number): PerDriverResult {
  const statusRoll = rng();
  const killsRoll = rng();

  let status: DriverStatus = 'unharmed';
  let kills = 0;

  switch (outcome) {
    case 'success':
      kills = Math.floor(killsRoll * 3);
      break;
    case 'partial':
      status = statusRoll < 0.15 ? 'wounded' : 'unharmed';
      kills = Math.floor(killsRoll * 2);
      break;
    case 'failure':
      status = statusRoll < 0.3 ? 'wounded' : 'unharmed';
      kills = Math.floor(killsRoll * 1);
      break;
    case 'routed':
      status = statusRoll < 0.4 ? 'dead' : statusRoll < 0.7 ? 'wounded' : 'unharmed';
      kills = 0;
      break;
  }

  return { driverId: d.id, driverName: d.name, status, kills };
}

function clamp(lo: number, hi: number, x: number): number {
  return Math.max(lo, Math.min(hi, x));
}
