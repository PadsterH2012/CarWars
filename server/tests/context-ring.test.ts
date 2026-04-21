import { describe, it, expect } from 'vitest';
import { ContextRing, SLOT_COUNT, SLOT_DEG } from '../src/ai/context-ring';

describe('ContextRing', () => {
  it('reset() clears both interest and danger buffers', () => {
    const r = new ContextRing();
    r.writeInterest(0, 0.8);
    r.writeDanger(180, 0.8);
    r.reset();
    expect(Array.from(r.interest).every(v => v === 0)).toBe(true);
    expect(Array.from(r.danger).every(v => v === 0)).toBe(true);
  });

  it('writeInterest applies falloff to both neighbour slots', () => {
    const r = new ContextRing();
    r.writeInterest(0, 1.0, 0.5);  // slot 0 = bearing 0..22.5°
    expect(r.interest[0]).toBeCloseTo(1.0);
    expect(r.interest[1]).toBeCloseTo(0.5);
    expect(r.interest[SLOT_COUNT - 1]).toBeCloseTo(0.5);
    // Non-neighbour stays zero
    expect(r.interest[5]).toBe(0);
  });

  it('uses max not sum for overlapping writes', () => {
    const r = new ContextRing();
    r.writeInterest(0, 0.5);
    r.writeInterest(0, 0.8);
    expect(r.interest[0]).toBeCloseTo(0.8);
    // The smaller write does not add to the bigger one
    r.writeInterest(0, 0.3);
    expect(r.interest[0]).toBeCloseTo(0.8);
  });

  it('bearings outside [0, 360) are normalised', () => {
    const r = new ContextRing();
    r.writeInterest(360, 1.0, 0);   // same as 0
    r.writeInterest(-22.5, 0.5, 0); // same as 337.5 → slot 15
    expect(r.interest[0]).toBeCloseTo(1.0);
    expect(r.interest[SLOT_COUNT - 1]).toBeCloseTo(0.5);
  });

  it('pick() prefers lowest-danger slot when interests are equal', () => {
    const r = new ContextRing();
    // Uniform interest everywhere
    for (let i = 0; i < SLOT_COUNT; i++) {
      r.writeInterest(i * SLOT_DEG, 0.3, 0);
    }
    // Danger only on the south half (slot ~8)
    r.writeDanger(180, 1.0, 0);
    const { bearing } = r.pick(0);
    // Should pick something NOT near slot 8 (bearing ~180°)
    const angularDist = Math.abs(((bearing - 180 + 540) % 360) - 180);
    expect(angularDist).toBeGreaterThan(45);
  });

  it('pick() prefers highest-interest slot among equal-danger candidates', () => {
    const r = new ContextRing();
    // All slots zero danger
    r.writeInterest(90, 0.9, 0);   // strong interest east
    r.writeInterest(270, 0.3, 0);  // weak interest west
    const { bearing } = r.pick(0);
    // Should pick the east (90°) slot — strongest interest
    expect(Math.abs(((bearing - 90 + 540) % 360) - 180)).toBeLessThan(SLOT_DEG);
  });

  it('pick() applies facing hysteresis for perfect ties', () => {
    const r = new ContextRing();
    // Two slots with identical interest (and zero danger everywhere)
    r.writeInterest(45, 0.5, 0);
    r.writeInterest(315, 0.5, 0);
    const pickFromEast = r.pick(90);   // currently facing east → should pick 45°
    const pickFromWest = r.pick(270);  // currently facing west → should pick 315°
    expect(Math.abs(((pickFromEast.bearing - 45 + 540) % 360) - 180)).toBeLessThan(SLOT_DEG);
    expect(Math.abs(((pickFromWest.bearing - 315 + 540) % 360) - 180)).toBeLessThan(SLOT_DEG);
  });

  it('pick() tolerance keeps roughly-equal-danger slots in play', () => {
    const r = new ContextRing();
    // Slot A: danger 0.0, interest 0.2
    // Slot B: danger 0.1 (within 0.15 tolerance), interest 0.9
    r.writeInterest(90,  0.2, 0);
    r.writeInterest(180, 0.9, 0);
    r.writeDanger(180,   0.1, 0);
    const { bearing } = r.pick(0);
    // Slot B's higher interest should win despite slightly higher danger
    expect(Math.abs(((bearing - 180 + 540) % 360) - 180)).toBeLessThan(SLOT_DEG);
  });

  it('pick() returns a slot-centre bearing, not an arbitrary value', () => {
    const r = new ContextRing();
    r.writeInterest(100, 1.0, 0);
    const { bearing } = r.pick(0);
    // Slot centres are at k * SLOT_DEG → 0°, 22.5°, 45°, 67.5°, 90°, 112.5°...
    // 100° rounds into slot 4 (covers 78.75..101.25) → centre 90°.
    expect(bearing).toBeCloseTo(90);
  });
});
