import { describe, it, expect } from 'vitest';
import { BODIES } from '../src/rules/data/bodies';

describe('bodies catalog', () => {
  it('has 9 car body types, 3 cycle frames, trike, truck, and trailer', () => {
    expect(BODIES.length).toBe(15);
  });

  it('mid_sized has correct spaces and max load', () => {
    const mid = BODIES.find(b => b.id === 'mid_sized')!;
    expect(mid.spaces).toBe(13);
    expect(mid.maxLoad).toBe(4800);
    expect(mid.baseHC).toBe(3);
  });

  it('cars have 6 armor surfaces', () => {
    const mid = BODIES.find(b => b.id === 'mid_sized')!;
    expect(mid.surfaces).toHaveLength(6);
    expect(mid.surfaces).toContain('top');
    expect(mid.surfaces).toContain('underbody');
  });

  it('cycles have 4 armor surfaces (no top/underbody)', () => {
    const cycle = BODIES.find(b => b.id === 'med_cycle')!;
    expect(cycle.surfaces).toHaveLength(4);
    expect(cycle.surfaces).not.toContain('top');
    expect(cycle.surfaces).not.toContain('underbody');
  });

  it('trike has 3 tires and 4 surfaces', () => {
    const trike = BODIES.find(b => b.id === 'trike')!;
    expect(trike.tireCount).toBe(3);
    expect(trike.isCycle).toBe(true);
    expect(trike.surfaces).toHaveLength(4);
  });

  it('trailer has 10 armor positions', () => {
    const trailer = BODIES.find(b => b.id === 'trailer')!;
    expect(trailer.surfaces).toHaveLength(10);
    expect(trailer.surfaces).toContain('right_front');
    expect(trailer.surfaces).toContain('underbody_back');
  });

  it('van has correct spaces and cargo area', () => {
    const van = BODIES.find(b => b.id === 'van')!;
    expect(van.spaces).toBe(24);
    expect(van.maxLoad).toBe(6000);
  });
});
