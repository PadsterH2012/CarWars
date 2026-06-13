// Match power scoring + reward model.
//
// A "side" (the player's squad or a rival's fielded fleet) gets a power score
// that folds in BOTH the money invested in the vehicles AND the crew skill —
// the two levers matchmaking should respect. Duels are free-pick: the player
// can take on anyone, and the prize scales with the power gap, so punching up
// against a richer / more-skilled gang pays more, and farming a weakling pays
// a floor.
//
// ── Tuning ──────────────────────────────────────────────────────────────────
// These constants set the economy's feel. Defaults are calibrated so an even
// 1v1 against a ~5,000-credit gang pays ~2,000; beating a gang 3× your power
// pays ~3× that. Adjust freely.

// Crew skill (1–6, 3 = baseline) nudges power. Skill 6 ≈ +45%, skill 1 ≈ −30%.
export const SKILL_PIVOT = 3;
export const SKILL_SLOPE = 0.15;

// prize = clamp(playerPower × BASE_COEFF × squadMul × gap, PRIZE_MIN, PRIZE_MAX)
// gap = clamp(rivalPower / playerPower, GAP_MIN, GAP_MAX). Because base scales
// with playerPower and gap = rival/player, the product tracks the strength of
// the gang you beat.
export const BASE_COEFF = 0.4;
export const GAP_MIN = 0.5;
export const GAP_MAX = 3.0;
export const PRIZE_MIN = 800;
export const PRIZE_MAX = 30000;

// Fallback per-vehicle value when a rival fields the generic AI rig (no stock
// lineup, e.g. some defense/travel encounters) so its power is still defined.
export const NOMINAL_RIVAL_VEHICLE_VALUE = 5000;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Skill multiplier applied to a side's fleet value. Floored so a rookie crew
// never drops a side's power to near-zero.
export function skillFactor(avgSkill: number): number {
  return Math.max(0.4, 1 + (avgSkill - SKILL_PIVOT) * SKILL_SLOPE);
}

// fleetValue = Σ vehicle cost across the side; avgSkill = mean driver skill.
export function sidePower(fleetValue: number, avgSkill: number): number {
  return Math.max(1, fleetValue * skillFactor(avgSkill));
}

// How much tougher the rival is than the player, clamped to the reward band.
export function prizeGap(playerPower: number, rivalPower: number): number {
  return clamp(rivalPower / Math.max(1, playerPower), GAP_MIN, GAP_MAX);
}

// Bigger fights pay more: 1v1 → 1.0×, 2v2 → 1.5×, 3v3 → 2.0×, 4v4 → 2.5×.
export function squadMultiplier(squadSize: number): number {
  return 1 + (clamp(squadSize, 1, 4) - 1) * 0.5;
}

export function calcMatchPrize(playerPower: number, rivalPower: number, squadSize: number): number {
  const prize = playerPower * BASE_COEFF * squadMultiplier(squadSize) * prizeGap(playerPower, rivalPower);
  return clamp(Math.round(prize), PRIZE_MIN, PRIZE_MAX);
}

export type ThreatLevel = 'easy' | 'even' | 'tough' | 'deadly';

// Threat label for the opponent-select slate — how the rival's power compares
// to the player's. Mirrors the reward bands so "deadly" is also where the
// prize multiplier is capped out.
export function threatLabel(playerPower: number, rivalPower: number): ThreatLevel {
  const r = rivalPower / Math.max(1, playerPower);
  if (r < 0.7) return 'easy';
  if (r < 1.3) return 'even';
  if (r < 2.0) return 'tough';
  return 'deadly';
}
