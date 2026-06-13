import { describe, it, expect } from 'vitest';
import { computeAiInput } from '../src/ai/driver';
import type { AiContext } from '../src/ai/types';
import { computeMovement } from '../src/rules/movement';
import type { VehicleState, ArenaMap, Rect, WreckageObject } from '@carwars/shared';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeVehicle(id: string, playerId: string, x: number, y: number, facing = 0): VehicleState {
  return {
    id, playerId, driverId: `d_${id}`,
    position: { x, y }, facing, speed: 0,
    stats: {
      id, name: 'Car',
      loadout: {
        bodyType: 'mid_size',
        armor: { front: 6, back: 4, left: 5, right: 5, top: 2, underbody: 2 },
        mounts: [{ id: 'm0', weaponId: 'mg', arc: 'front', ammo: 20 }],
        accessories: [],
      } as any,
      damageState: {
        armor: { front: 6, back: 4, left: 5, right: 5, top: 2, underbody: 2 },
        engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false,
      },
      maxSpeed: 80, handlingClass: 3, weight: 3000, acceleration: 5,
    } as any,
  };
}

function makeArena(walls: Rect[], width = 100, height = 100): ArenaMap {
  return {
    id: 'test', width, height, walls,
    spawnPoints: [],
  };
}

// Minimal tick simulator — computes AI input, then applies movement. No
// collision resolution; tests must stop short of walls or the deltas get
// weird. That's fine — the thing we're testing is the AI's *intent*, not
// the physics engine.
function runTicks(
  self: VehicleState,
  enemies: VehicleState[],
  ticks: number,
  map: ArenaMap | undefined,
  wreckage: WreckageObject[] = [],
): { finalSelf: VehicleState; steerHistory: number[]; positions: { x: number; y: number }[] } {
  const steerHistory: number[] = [];
  const positions: { x: number; y: number }[] = [{ x: self.position.x, y: self.position.y }];
  let current = self;
  for (let t = 0; t < ticks; t++) {
    const ctx: AiContext = {
      skill: 3,
      map,
      allVehicles: [current, ...enemies],
      wreckage,
      tick: t,
    };
    const input = computeAiInput(current, ctx);
    steerHistory.push(input.steer);
    current = computeMovement(current, { speed: input.speed, steer: input.steer });
    positions.push({ x: current.position.x, y: current.position.y });
  }
  return { finalSelf: current, steerHistory, positions };
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ── Scenarios ────────────────────────────────────────────────────────────────

describe('AI steering — scenario tests', () => {
  // These are the Phase 2 regression tests. Current `main` (context-ring NOT
  // yet wired into steer source — T2.9) should fail at least one of them.
  // Once T2.9 flips the switch, all three must pass.

  it('does not pin in a concave corner', () => {
    // Two walls forming a 90° inner corner. Horizontal arm runs east from
    // (0, 0) to (10, 0); vertical arm runs south from (10, 0) to (10, 10).
    // The inner corner is at (10, 0). Vehicle spawns south-east of the corner
    // and the enemy is north-west past the corner, so the AI must steer
    // around the corner to engage.
    const walls: Rect[] = [
      { x: 5,  y: 0,  w: 10, h: 0.5, type: 'wall' }, // horizontal arm
      { x: 10, y: 5,  w: 0.5, h: 10, type: 'wall' }, // vertical arm
    ];
    const map = makeArena(walls, 40, 40);
    const self = makeVehicle('ai1', 'a', 15, 5, 270); // facing west
    const enemy = makeVehicle('t1', 'b', 0, -5, 0);   // north-west

    const { positions } = runTicks(self, [enemy], 60, map);
    const travelled = dist(positions[0], positions[positions.length - 1]);
    expect(travelled).toBeGreaterThan(8);
  });

  it('traverses a narrow corridor without oscillating', () => {
    // Two parallel walls 4 units apart (centreline ±2), 30 units long.
    // Vehicle starts at the west entrance, enemy at the east exit.
    const walls: Rect[] = [
      { x: 0, y: -2, w: 30, h: 0.5, type: 'wall' }, // north kerb
      { x: 0, y:  2, w: 30, h: 0.5, type: 'wall' }, // south kerb
    ];
    const map = makeArena(walls, 50, 50);
    const self  = makeVehicle('ai1', 'a', -14, 0, 90); // facing east
    const enemy = makeVehicle('t1', 'b',  14, 0, 270);

    const { steerHistory } = runTicks(self, [enemy], 40, map);
    const avgAbs = steerHistory.reduce((s, v) => s + Math.abs(v), 0) / steerHistory.length;
    expect(avgAbs).toBeLessThan(12);
  });

  it('brakes near an enemy even when survival urgency is high (low-armour vehicle)', () => {
    // A vehicle with a zero-armour face triggers survival urgency 0.85, whose
    // "flee fast when hurt" boost used to floor speed to ~0.94×max and ram the
    // enemy head-on. The final speed brake must win when an enemy is inside the
    // collision zone, regardless of survival urgency.
    const self  = makeVehicle('ai1', 'a', 0, 0);
    self.stats.loadout.armor      = { front: 6, back: 0, left: 5, right: 5, top: 2, underbody: 2 } as any;
    self.stats.damageState.armor  = { front: 6, back: 0, left: 5, right: 5, top: 2, underbody: 2 } as any;
    const enemy = makeVehicle('t1', 'b', 0, -2.5, 180); // 2.5 units away → inside the brake range
    const ctx: AiContext = { skill: 3, allVehicles: [self, enemy], wreckage: [], tick: 10 };
    const input = computeAiInput(self, ctx);
    expect(input.speed).toBeLessThanOrEqual(15);
  });

  it('autopilot brakes earlier than enemy AI near a foe', () => {
    const self  = makeVehicle('ai1', 'a', 0, 0);
    const enemy = makeVehicle('t1', 'b', 0, -3.5, 180); // 3.5 units: inside autopilot hardRange(4), outside default(3)
    const auto = computeAiInput(self, { skill: 3, allVehicles: [self, enemy], wreckage: [], tick: 10, autopilot: true });
    expect(auto.speed).toBeLessThanOrEqual(10);
  });

  it('sidesteps a wreck placed directly between self and enemy', () => {
    // Empty map, wreckage at (0, -10), vehicle at (0, 0) facing north (0°),
    // enemy at (0, -20). Straight-line pursuit would drive through the wreck.
    const map = makeArena([], 40, 40);
    const self  = makeVehicle('ai1', 'a', 0,   0, 0);
    const enemy = makeVehicle('t1', 'b', 0, -20, 180);
    const wreck: WreckageObject = {
      id: 'w1', sourceVehicleId: 'x', playerId: 'x',
      position: { x: 0, y: -10 }, facing: 0,
      state: 'smouldering', stateStartedAt: 0,
      remainingDP: 10, maxDP: 10, originalValue: 5000,
      mass: 'medium', pushable: false, carriedAmmo: 0,
      causedBy: 'kinetic',
    };

    const { positions } = runTicks(self, [enemy], 30, map, [wreck]);
    const maxDeviation = Math.max(...positions.map(p => Math.abs(p.x)));
    const closestWreckApproach = Math.min(...positions.map(p => dist(p, wreck.position)));
    expect(maxDeviation).toBeGreaterThan(1.5);      // did sidestep
    expect(closestWreckApproach).toBeGreaterThan(1.0); // did not run over the wreck
  });
});
