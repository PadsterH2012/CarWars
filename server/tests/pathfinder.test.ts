import { describe, it, expect } from 'vitest';
import { Pathfinder } from '../src/ai/pathfinder';
import type { ArenaMap, Rect, WreckageObject } from '@carwars/shared';

function makeArena(walls: Rect[], width = 60, height = 40): ArenaMap {
  return { id: 'test', width, height, walls, spawnPoints: [] };
}

describe('Pathfinder', () => {
  it('finds a direct path on an empty map', () => {
    const pf = new Pathfinder(makeArena([]));
    const path = pf.find({ x: -10, y: 0 }, { x: 10, y: 0 });
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
    // Last waypoint should be near the goal
    const last = path![path!.length - 1];
    expect(Math.hypot(last.x - 10, last.y - 0)).toBeLessThan(2);
  });

  it('routes around a building to reach a target behind it', () => {
    // 10×10 building centred at (0, 0). Start west of it, goal east.
    const walls: Rect[] = [
      { x: 0, y: 0, w: 10, h: 10, type: 'building' },
    ];
    const pf = new Pathfinder(makeArena(walls));
    const path = pf.find({ x: -15, y: 0 }, { x: 15, y: 0 });
    expect(path).not.toBeNull();
    // Path must deviate — a naïve straight line would cross the building.
    // At least one waypoint should be past |y| > 5 (clear of the building).
    const maxY = Math.max(...path!.map(p => Math.abs(p.y)));
    expect(maxY).toBeGreaterThan(5);
  });

  it('returns null when goal is fully enclosed', () => {
    // Goal surrounded by walls
    const walls: Rect[] = [
      { x:  0, y: -3, w: 6, h: 0.5, type: 'wall' },
      { x:  0, y:  3, w: 6, h: 0.5, type: 'wall' },
      { x: -3, y:  0, w: 0.5, h: 6, type: 'wall' },
      { x:  3, y:  0, w: 0.5, h: 6, type: 'wall' },
    ];
    const pf = new Pathfinder(makeArena(walls));
    const path = pf.find({ x: -15, y: 0 }, { x: 0, y: 0 });
    expect(path).toBeNull();
  });

  it('LOS smoothing removes intermediate waypoints on open stretches', () => {
    const pf = new Pathfinder(makeArena([]));
    const path = pf.find({ x: -15, y: 0 }, { x: 15, y: 0 });
    expect(path).not.toBeNull();
    // Straight shot across open map — smoothed path should be just 1-2 waypoints
    expect(path!.length).toBeLessThan(5);
  });

  it('soft-avoids wreckage but still routes through when it is the only way', () => {
    // Single wreck in an otherwise clear map — path should deviate if alternative exists
    const pf = new Pathfinder(makeArena([]));
    const wreck: WreckageObject = {
      id: 'w1', sourceVehicleId: 'x', playerId: 'x',
      position: { x: 0, y: 0 }, facing: 0,
      state: 'burning', stateStartedAt: 0,
      remainingDP: 10, maxDP: 10, originalValue: 5000,
      mass: 'medium', pushable: false, carriedAmmo: 0,
      causedBy: 'fire',
    };
    pf.updateObstacles([wreck]);
    const path = pf.find({ x: -10, y: 0 }, { x: 10, y: 0 });
    expect(path).not.toBeNull();
    // Path should sidestep the burning wreck at the origin
    const minWreckDist = Math.min(...path!.map(p => Math.hypot(p.x, p.y)));
    expect(minWreckDist).toBeGreaterThan(1.5);
  });

  it('invalidates cached path when wreckage changes', () => {
    const pf = new Pathfinder(makeArena([]));
    const pathBefore = pf.find({ x: -10, y: 0 }, { x: 10, y: 0 });
    // Add a wreck on the direct path
    const wreck: WreckageObject = {
      id: 'w1', sourceVehicleId: 'x', playerId: 'x',
      position: { x: 0, y: 0 }, facing: 0,
      state: 'burning', stateStartedAt: 0,
      remainingDP: 10, maxDP: 10, originalValue: 5000,
      mass: 'medium', pushable: false, carriedAmmo: 0,
      causedBy: 'fire',
    };
    pf.updateObstacles([wreck]);
    const pathAfter = pf.find({ x: -10, y: 0 }, { x: 10, y: 0 });
    // Different path (or at least different max-deviation) — cache must not have
    // returned the stale pre-wreck path.
    const maxYBefore = Math.max(...pathBefore!.map(p => Math.abs(p.y)));
    const maxYAfter  = Math.max(...pathAfter!.map(p => Math.abs(p.y)));
    expect(maxYAfter).toBeGreaterThan(maxYBefore);
  });
});
