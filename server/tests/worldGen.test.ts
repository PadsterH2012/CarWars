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

  it('settlement count is between 5 and 200', () => {
    for (const seed of [1, 42, 999, 8888]) {
      const w = generateWorld(seed);
      expect(w.settlements.length).toBeGreaterThanOrEqual(5);
      expect(w.settlements.length).toBeLessThanOrEqual(200);
    }
  });

  it('all settlement IDs are unique', () => {
    const w = generateWorld(55);
    const ids = w.settlements.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all settlement names are unique', () => {
    const w = generateWorld(55);
    const names = w.settlements.map(s => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all road endpoints reference valid settlement IDs', () => {
    const w = generateWorld(42);
    const ids = new Set(w.settlements.map(s => s.id));
    w.roads.forEach(r => {
      expect(ids.has(r.from), `road ${r.id} from=${r.from} not found`).toBe(true);
      expect(ids.has(r.to),   `road ${r.id} to=${r.to} not found`).toBe(true);
    });
  });

  it('every capital is connected to every other capital by a road', () => {
    const w = generateWorld(7);
    for (let i = 0; i < w.capitals.length; i++) {
      for (let j = i + 1; j < w.capitals.length; j++) {
        const a = w.capitals[i], b = w.capitals[j];
        const has = w.roads.some(
          r => (r.from === a && r.to === b) || (r.from === b && r.to === a)
        );
        expect(has, `no road between capitals ${a} and ${b}`).toBe(true);
      }
    }
  });

  it('player start settlement has population < 5000', () => {
    for (const seed of [1, 42, 999]) {
      const w = generateWorld(seed);
      const s = w.settlements.find(s => s.id === w.playerStartSettlementId);
      expect(s).toBeDefined();
      expect(s!.population).toBeLessThan(5000);
    }
  });

  it('every settlement is reachable from player start', () => {
    const w = generateWorld(42);
    const adj = new Map<string, string[]>();
    w.settlements.forEach(s => adj.set(s.id, []));
    w.roads.forEach(r => {
      adj.get(r.from)!.push(r.to);
      adj.get(r.to)!.push(r.from);
    });
    const visited = new Set<string>();
    const q = [w.playerStartSettlementId];
    while (q.length) {
      const cur = q.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      adj.get(cur)?.forEach(n => q.push(n));
    }
    w.settlements.forEach(s =>
      expect(visited.has(s.id), `${s.id} not reachable from player start`).toBe(true)
    );
  });
});
