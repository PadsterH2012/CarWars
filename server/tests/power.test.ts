import { describe, it, expect } from 'vitest';
import {
  skillFactor, sidePower, prizeGap, squadMultiplier, calcMatchPrize, threatLabel,
  GAP_MIN, GAP_MAX, PRIZE_MIN, PRIZE_MAX,
} from '../src/rules/power';
import { rivalSignatureLineup, rivalLineupForDivision, fieldedStockIds } from '../src/rules/rivals';
import type { RivalGang } from '../src/rules/rivals';

describe('power model', () => {
  it('skillFactor pivots at skill 3 and is floored', () => {
    expect(skillFactor(3)).toBeCloseTo(1.0);
    expect(skillFactor(6)).toBeCloseTo(1.45);
    expect(skillFactor(1)).toBeCloseTo(0.7);
    expect(skillFactor(-100)).toBe(0.4); // floored
  });

  it('sidePower folds fleet value and skill', () => {
    expect(sidePower(10000, 3)).toBeCloseTo(10000);
    expect(sidePower(10000, 6)).toBeCloseTo(14500);
    expect(sidePower(0, 3)).toBe(1); // floored to ≥1
  });

  it('prizeGap is clamped to the reward band', () => {
    expect(prizeGap(1000, 1000)).toBeCloseTo(1);
    expect(prizeGap(1000, 100)).toBe(GAP_MIN);   // farming a weakling → floor
    expect(prizeGap(1000, 100000)).toBe(GAP_MAX); // huge upset → cap
  });

  it('squadMultiplier rewards bigger fights', () => {
    expect(squadMultiplier(1)).toBe(1.0);
    expect(squadMultiplier(2)).toBe(1.5);
    expect(squadMultiplier(4)).toBe(2.5);
    expect(squadMultiplier(9)).toBe(2.5); // clamped at 4
  });

  it('calcMatchPrize pays more for punching up than farming down', () => {
    const even   = calcMatchPrize(10000, 10000, 1);
    const up     = calcMatchPrize(10000, 30000, 1); // rival 3× stronger
    const down   = calcMatchPrize(10000,  2000, 1); // rival much weaker
    expect(up).toBeGreaterThan(even);
    expect(even).toBeGreaterThan(down);
    expect(up / even).toBeCloseTo(GAP_MAX, 1);
  });

  it('calcMatchPrize clamps to [PRIZE_MIN, PRIZE_MAX]', () => {
    expect(calcMatchPrize(1, 1, 1)).toBe(PRIZE_MIN);
    expect(calcMatchPrize(1_000_000, 9_000_000, 4)).toBe(PRIZE_MAX);
  });

  it('threatLabel scales with the power ratio', () => {
    expect(threatLabel(1000, 500)).toBe('easy');
    expect(threatLabel(1000, 1000)).toBe('even');
    expect(threatLabel(1000, 1600)).toBe('tough');
    expect(threatLabel(1000, 5000)).toBe('deadly');
  });
});

describe('rival fleet selection', () => {
  const rival: RivalGang = {
    id: 'r', name: 'Test', description: '', base_skill: 3,
    primary_colour: 0, secondary_colour: 0, emblem_id: 'default', min_division: 20,
    boast_lines: [], defeat_lines: [],
    lineup: { '20': ['desperado'], '10': ['mg3', 'guardian'], '5': ['sprocket'] },
  };

  it('signature lineup is a stable characteristic tier from the rival lineup', () => {
    const picked = rivalSignatureLineup(rival);
    const allTiers = Object.values(rival.lineup);
    // Returns one of the rival's actual tiers...
    expect(allTiers).toContainEqual(picked);
    // ...and is deterministic for the same gang (stable identity).
    expect(rivalSignatureLineup(rival)).toEqual(picked);
    // Different gang id → may select a different tier (variety across the slate).
    expect(rivalSignatureLineup({ ...rival, id: 'other-gang-xyz' })).not.toBeUndefined();
  });

  it('division lineup matches the player tier', () => {
    expect(rivalLineupForDivision(rival, 10)).toEqual(['mg3', 'guardian']);
    expect(rivalLineupForDivision(rival, 99)).toEqual([]); // no entry
  });

  it('signature lineup is empty for a gang with no lineup', () => {
    expect(rivalSignatureLineup({ ...rival, lineup: {} })).toEqual([]);
  });

  it('fieldedStockIds round-robins out to squad size', () => {
    expect(fieldedStockIds(['a', 'b'], 4)).toEqual(['a', 'b', 'a', 'b']);
    expect(fieldedStockIds(['a'], 3)).toEqual(['a', 'a', 'a']);
    expect(fieldedStockIds([], 4)).toEqual([]);
  });
});
