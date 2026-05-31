import { describe, expect, it } from 'vitest';
import { generateWorld } from '../src/rules/worldGen';

describe('generateWorld structural validity', () => {
  it('all road IDs are unique', () => {
    const w = generateWorld(100);
    const ids = w.roads.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('danger values are within 0..1', () => {
    const w = generateWorld(42);
    w.roads.forEach(r => {
      expect(r.danger).toBeGreaterThanOrEqual(0);
      expect(r.danger).toBeLessThanOrEqual(1);
    });
  });

  it('road distances are positive', () => {
    const w = generateWorld(42);
    w.roads.forEach(r => expect(r.distance).toBeGreaterThan(0));
  });

  it('capitals array IDs all exist in settlements', () => {
    const w = generateWorld(42);
    const ids = new Set(w.settlements.map(s => s.id));
    w.capitals.forEach(c => expect(ids.has(c)).toBe(true));
  });

  it('playerStartSettlementId exists in settlements', () => {
    const w = generateWorld(42);
    const ids = new Set(w.settlements.map(s => s.id));
    expect(ids.has(w.playerStartSettlementId)).toBe(true);
  });

  it('all settlements have at least one service', () => {
    const w = generateWorld(55);
    w.settlements.forEach(s =>
      expect(s.services.length, `${s.name} has no services`).toBeGreaterThan(0)
    );
  });
});
