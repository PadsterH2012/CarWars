import { describe, it, expect } from 'vitest';
import {
  sensorRange, hasLineOfSight, computeVisibleEnemies, planSearch,
  freshestSighting, rememberSightings, type Sighting,
} from '../src/ai/perception';
import type { VehicleState, Rect } from '@carwars/shared';

function veh(id: string, x: number, y: number): VehicleState {
  return {
    id, playerId: id[0], driverId: 'd', position: { x, y }, facing: 0, speed: 0,
    stats: {
      id, name: 'c', loadout: { armor: {} } as any,
      damageState: { armor: {}, destroyed: false } as any,
      maxSpeed: 80, handlingClass: 3, weight: 3000, acceleration: 5,
    } as any,
  };
}

describe('perception — sight + memory', () => {
  it('sensor range scales with skill', () => {
    expect(sensorRange(1)).toBeLessThan(sensorRange(6));
  });

  it('a wall between two points blocks line of sight', () => {
    const wall: Rect = { x: 0, y: 0, w: 1, h: 10, type: 'wall' } as any;
    expect(hasLineOfSight({ x: -5, y: 0 }, { x: 5, y: 0 }, [wall])).toBe(false);
    expect(hasLineOfSight({ x: -5, y: 0 }, { x: 5, y: 0 }, [])).toBe(true);
  });

  it('enemy beyond sensor range is not visible', () => {
    expect(computeVisibleEnemies(veh('a', 0, 0), [veh('b', 100, 0)], [], 3)).toHaveLength(0);
  });

  it('enemy behind a wall is not visible even within range', () => {
    const self = veh('a', -3, 0);
    const enemy = veh('b', 3, 0);
    const wall: Rect = { x: 0, y: 0, w: 1, h: 10, type: 'wall' } as any;
    expect(computeVisibleEnemies(self, [enemy], [wall], 3)).toHaveLength(0);
    expect(computeVisibleEnemies(self, [enemy], [], 3)).toHaveLength(1);
  });

  it('memory is stale across a match restart (negative age)', () => {
    const mem = new Map<string, Sighting>();
    rememberSightings(mem, [veh('b', 1, 1)], 1000);
    expect(freshestSighting(mem, 5, 90)).toBeNull(); // tick reset → age < 0 → stale
  });
});

describe('perception — search planning', () => {
  const self = veh('a', 0, 0);

  it('pursues a fresh last-known sighting', () => {
    const mem = new Map<string, Sighting>();
    rememberSightings(mem, [veh('b', 10, 10)], 5);
    const p = planSearch({ self, memory: mem, map: undefined, tick: 6, skill: 3, aggression: 4, healthFrac: 1, ambusher: false, scoutTarget: null });
    expect(p.mode).toBe('pursue');
    expect(p.goal).toEqual({ x: 10, y: 10 });
  });

  it('ambushes (holds) when timid or hurt', () => {
    const timid = planSearch({ self, memory: new Map(), map: undefined, tick: 0, skill: 3, aggression: 1, healthFrac: 1, ambusher: false, scoutTarget: null });
    expect(timid.mode).toBe('ambush');
    expect(timid.hold).toBe(true);
    const hurt = planSearch({ self, memory: new Map(), map: undefined, tick: 0, skill: 3, aggression: 5, healthFrac: 0.3, ambusher: false, scoutTarget: null });
    expect(hurt.mode).toBe('ambush');
  });

  it('scouts when aggressive with no information', () => {
    const p = planSearch({ self, memory: new Map(), map: undefined, tick: 0, skill: 3, aggression: 5, healthFrac: 1, ambusher: false, scoutTarget: null });
    expect(p.mode).toBe('scout');
    expect(p.hold).toBe(false);
  });
});
