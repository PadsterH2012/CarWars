import { describe, it, expect } from 'vitest';
import { computeMovement, applyHazardCheck, classifyManeuver, resolveControlTable, resolveCollision } from '../src/rules/movement';
import type { ManeuverType, ControlResult } from '../src/rules/movement';
import type { VehicleState } from '@carwars/shared';

const baseVehicle: VehicleState = {
  id: 'v1',
  playerId: 'p1',
  driverId: 'd1',
  position: { x: 0, y: 0 },
  facing: 0,
  speed: 10,
  stats: {
    id: 'v1',
    name: 'Test Car',
    loadout: {} as any,
    damageState: { armor: {}, engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false },
    maxSpeed: 20,
    handlingClass: 3,
    acceleration: 5,
    weight: 3000
  }
};

describe('movement', () => {
  it('moves vehicle forward by speed/5 per phase', () => {
    const input = { speed: 10, steer: 0 };
    const result = computeMovement(baseVehicle, input);
    expect(result.position.y).toBeCloseTo(-2);
  });

  it('applies steering to facing', () => {
    const input = { speed: 10, steer: 15 };
    const result = computeMovement(baseVehicle, input);
    expect(result.facing).toBe(15);
  });

  it('requires hazard check when turning at high speed', () => {
    const fastVehicle = { ...baseVehicle, speed: 20 };
    const input = { speed: 20, steer: 60 };
    const hazard = applyHazardCheck(fastVehicle, input);
    expect(hazard.required).toBe(true);
  });

  it('no hazard check for gentle turns at low speed', () => {
    const input = { speed: 5, steer: 15 };
    const hazard = applyHazardCheck(baseVehicle, input);
    expect(hazard.required).toBe(false);
  });
});

describe('maneuver classifier', () => {
  it('gentle steer is a bend (D1)', () => {
    const result = classifyManeuver(10, 15);
    expect(result.type).toBe('bend');
    expect(result.dValue).toBe(1);
  });

  it('moderate steer is a drift (D2)', () => {
    const result = classifyManeuver(20, 25);
    expect(result.type).toBe('drift');
    expect(result.dValue).toBe(2);
  });

  it('sharp steer is a swerve (D3)', () => {
    const result = classifyManeuver(30, 40);
    expect(result.type).toBe('swerve');
    expect(result.dValue).toBe(3);
  });

  it('maximum steer is a controlled skid (D3)', () => {
    const result = classifyManeuver(40, 55);
    expect(result.type).toBe('controlled_skid');
    expect(result.dValue).toBe(3);
  });

  it('no steer is D0 — straight driving has no hazard', () => {
    const result = classifyManeuver(60, 0);
    expect(result.type).toBe('bend');
    expect(result.dValue).toBe(0);
  });
});

describe('control table', () => {
  it('no effect when hazard below HC', () => {
    // HC=4, hazardAccumulator=0 → short-circuits to none
    const result = resolveControlTable(4, 0, 7); // forced roll of 7
    expect(result.effect).toBe('none');
  });

  it('fishtail when control result equals 1', () => {
    // roll=3, hazard=2, hc=4 → 3+2-4=1 → fishtail
    const result = resolveControlTable(4, 2, 3);
    expect(result.effect).toBe('fishtail');
    expect(result.severity).toBe(1);
  });

  it('no control roll needed when hazard is zero', () => {
    const result = resolveControlTable(3, 0, 2);
    expect(result.effect).toBe('none');
  });
});

describe('collision resolver', () => {
  it('head-on collision uses sum of speeds', () => {
    const result = resolveCollision(30, 20, 'head_on');
    // closing speed = 50 → damage = floor(50 / 5) = 10 per vehicle
    expect(result.damageA).toBe(10);
    expect(result.damageB).toBe(10);
  });

  it('same-direction collision uses speed difference', () => {
    const result = resolveCollision(30, 20, 'same_dir');
    // closing speed = 10 → damage = floor(10 / 5) = 2
    expect(result.damageA).toBe(2);
    expect(result.damageB).toBe(2);
  });

  it('ramplate halves damage for attacker', () => {
    const result = resolveCollision(30, 0, 'head_on', true);
    // closing speed = 30 → base = 6; ramplate → attacker takes 3
    expect(result.damageA).toBe(3);
    expect(result.damageB).toBe(6);
  });
});
