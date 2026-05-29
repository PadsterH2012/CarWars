import { describe, it, expect } from 'vitest';
import { generateTieredPool } from '../src/rules/driverGenerator';

describe('generateTieredPool', () => {
  it('rookie candidates have skill 1-2 and tier "rookie"', () => {
    const pool = generateTieredPool(5, [], { premiumUnlocked: false });
    const rookies = pool.filter(c => c.tier === 'rookie');
    expect(rookies.length).toBeGreaterThan(0);
    for (const r of rookies) {
      expect(r.skill).toBeGreaterThanOrEqual(1);
      expect(r.skill).toBeLessThanOrEqual(2);
    }
  });

  it('standard candidates have tier "standard" and skill 1-6', () => {
    const pool = generateTieredPool(5, [], { premiumUnlocked: false });
    const standard = pool.filter(c => c.tier === 'standard');
    expect(standard.length).toBeGreaterThan(0);
    for (const s of standard) {
      expect(s.skill).toBeGreaterThanOrEqual(1);
      expect(s.skill).toBeLessThanOrEqual(6);
    }
  });

  it('omits premium candidates when premium is locked', () => {
    const pool = generateTieredPool(5, [], { premiumUnlocked: false });
    expect(pool.some(c => c.tier === 'premium')).toBe(false);
  });

  it('includes premium candidates with skill 4-6 when unlocked', () => {
    const pool = generateTieredPool(5, [], { premiumUnlocked: true });
    const premium = pool.filter(c => c.tier === 'premium');
    expect(premium.length).toBeGreaterThan(0);
    for (const p of premium) {
      expect(p.skill).toBeGreaterThanOrEqual(4);
      expect(p.skill).toBeLessThanOrEqual(6);
    }
  });

  it('every candidate carries a hire cost matching its skill tier ordering', () => {
    const pool = generateTieredPool(5, [], { premiumUnlocked: true });
    for (const c of pool) {
      expect(c.hireCost).toBeGreaterThan(0);
      expect(['rookie', 'standard', 'premium']).toContain(c.tier);
    }
  });
});
