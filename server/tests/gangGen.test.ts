import { describe, it, expect } from 'vitest';
import { generateGangs } from '../src/rules/gangGen';
import { generateWorld } from '../src/rules/worldGen';

describe('generateGangs', () => {
  it('is deterministic: same world + seed → same gangs', () => {
    const world = generateWorld(42);
    const a = generateGangs(world, 42);
    const b = generateGangs(world, 42);
    expect(a).toEqual(b);
  });

  it('produces between 4 and 20 gangs', () => {
    for (const seed of [1, 42, 999]) {
      const world = generateWorld(seed);
      const gangs = generateGangs(world, seed);
      expect(gangs.length).toBeGreaterThanOrEqual(4);
      expect(gangs.length).toBeLessThanOrEqual(20);
    }
  });

  it('all gang IDs are unique', () => {
    const world = generateWorld(42);
    const gangs = generateGangs(world, 42);
    const ids = gangs.map(g => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all gang names are unique', () => {
    const world = generateWorld(42);
    const gangs = generateGangs(world, 42);
    const names = gangs.map(g => g.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all home_settlement_id values reference valid settlements', () => {
    const world = generateWorld(42);
    const gangs = generateGangs(world, 42);
    const ids = new Set(world.settlements.map(s => s.id));
    gangs.forEach(g =>
      expect(ids.has(g.home_settlement_id), `${g.name} home ${g.home_settlement_id} not found`).toBe(true)
    );
  });

  it('starting_influence is a small home foothold (3–8)', () => {
    // Big territory must be earned via the economy sim, not seeded free — see
    // docs/territory-economy.md. Kept ≥1 so a gang always has somewhere to act.
    const world = generateWorld(42);
    const gangs = generateGangs(world, 42);
    gangs.forEach(g => {
      expect(g.starting_influence).toBeGreaterThanOrEqual(3);
      expect(g.starting_influence).toBeLessThanOrEqual(8);
    });
  });

  it('treasury is between 5000 and 15000', () => {
    const world = generateWorld(42);
    const gangs = generateGangs(world, 42);
    gangs.forEach(g => {
      expect(g.treasury).toBeGreaterThanOrEqual(5000);
      expect(g.treasury).toBeLessThanOrEqual(15000);
    });
  });
});
