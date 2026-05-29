import { describe, it, expect } from 'vitest';
import { resolveHeadlessJob } from '../src/rules/headlessJob';

// Deterministic rng that yields a fixed sequence of values, repeating the last.
function seq(...values: number[]): () => number {
  let i = 0;
  return () => (i < values.length ? values[i++] : values[values.length - 1]);
}

const driver = { skill: 5, hasVehicle: true };   // baseChance 0.8, +0.1 vehicle
const job = { payout: 400, difficulty: 2 };       // -0.1 → successChance 0.8

describe('resolveHeadlessJob', () => {
  it('computes successChance from skill, vehicle bonus and difficulty', () => {
    const o = resolveHeadlessJob(driver, job, seq(0.0, 0.0));
    expect(o.breakdown.successChance).toBeCloseTo(0.8, 5);
    expect(o.breakdown.vehicleBonus).toBe(0.1);
    expect(o.breakdown.difficulty).toBe(2);
  });

  it('low roll → SUCCESS with full payout', () => {
    const o = resolveHeadlessJob(driver, job, seq(0.1, 0.0));
    expect(o.tier).toBe('success');
    expect(o.success).toBe(true);
    expect(o.payout).toBe(400);
    expect(o.vehicleWrecked).toBe(false);
    expect(o.driverDead).toBe(false);
  });

  it('roll just above successChance → PARTIAL with reduced payout', () => {
    // successChance 0.8, partial band [0.8, 0.95)
    const o = resolveHeadlessJob(driver, job, seq(0.85, 0.0));
    expect(o.tier).toBe('partial');
    expect(o.success).toBe(true);
    expect(o.payout).toBe(200); // floor(400 * 0.5)
    expect(o.wear).toBeGreaterThanOrEqual(1);
  });

  it('roll in failure band → FAILURE, no payout, possible wound', () => {
    // failure band [0.95, 1.05); wound roll second value < 0.2 → wounded
    const o = resolveHeadlessJob(driver, job, seq(0.97, 0.5, 0.1));
    expect(o.tier).toBe('failure');
    expect(o.success).toBe(false);
    expect(o.payout).toBe(0);
    expect(o.driverWounded).toBe(true);
  });

  it('high roll on a long-shot job → CATASTROPHE, vehicle wrecked, possible death', () => {
    // Weak driver, no vehicle, hard job → low successChance so the catastrophe
    // band (roll >= successChance + 0.25) is reachable.
    const longShot = { skill: 1, hasVehicle: false };  // baseChance 0.48
    const hardJob = { payout: 600, difficulty: 8 };     // -0.4 → successChance 0.08
    // bands: success <0.08, partial <0.23, failure <0.33, catastrophe >=0.33
    const o = resolveHeadlessJob(longShot, hardJob, seq(0.5, 0.1));
    expect(o.tier).toBe('catastrophe');
    expect(o.success).toBe(false);
    expect(o.vehicleWrecked).toBe(true);
    expect(o.driverDead).toBe(true); // death roll 0.1 < 0.3
  });

  it('caps successChance at 0.95 for an elite driver vs trivial job', () => {
    const o = resolveHeadlessJob({ skill: 6, hasVehicle: true }, { payout: 100, difficulty: 1 }, seq(0));
    expect(o.breakdown.successChance).toBeLessThanOrEqual(0.95);
  });
});
