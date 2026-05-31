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

  it('different seeds produce structurally different maps', () => {
    const a = generateWorld(1);
    const b = generateWorld(2);
    expect(a.settlements.map(s => s.id)).not.toEqual(b.settlements.map(s => s.id));
  });
});
