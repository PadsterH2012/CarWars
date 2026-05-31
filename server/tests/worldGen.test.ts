import { describe, it, expect } from 'vitest';
import { generateWorld } from '../src/rules/worldGen';

describe('generateWorld', () => {
  it('returns a GeneratedWorld with the correct seed', () => {
    const world = generateWorld(42);
    expect(world.seed).toBe(42);
  });

  it('is deterministic: same seed always produces the same output', () => {
    const a = generateWorld(12345);
    const b = generateWorld(12345);
    expect(a).toEqual(b);
  });

  it.todo('different seeds produce structurally different maps');

  it('produces 4–8 capitals', () => {
    for (const seed of [1, 2, 3, 99, 1000]) {
      const w = generateWorld(seed);
      expect(w.capitals.length).toBeGreaterThanOrEqual(4);
      expect(w.capitals.length).toBeLessThanOrEqual(8);
    }
  });

  it('capitals are at least 200px apart', () => {
    const w = generateWorld(42);
    const caps = w.settlements.filter(s => w.capitals.includes(s.id));
    for (let i = 0; i < caps.length; i++) {
      for (let j = i + 1; j < caps.length; j++) {
        const d = Math.hypot(caps[i].x - caps[j].x, caps[i].y - caps[j].y);
        expect(d).toBeGreaterThanOrEqual(200);
      }
    }
  });

  it('capitals have population >= 10000', () => {
    const w = generateWorld(7);
    const caps = w.settlements.filter(s => w.capitals.includes(s.id));
    caps.forEach(c => expect(c.population).toBeGreaterThanOrEqual(10000));
  });
});
