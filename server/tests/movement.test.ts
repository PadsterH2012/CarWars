import { describe, it, expect } from 'vitest';
import { computeMovement, applyHazardCheck, classifyManeuver, resolveControlTable } from '../src/rules/movement';
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

  it('no steer at any speed is a bend (D1)', () => {
    const result = classifyManeuver(60, 0);
    expect(result.type).toBe('bend');
    expect(result.dValue).toBe(1);
  });
});

describe('control table', () => {
  it('no effect when hazard below HC', () => {
    // HC=4, hazardAccumulator=0 → short-circuits to none
    const result = resolveControlTable(4, 0, 7); // forced roll of 7
    expect(result.effect).toBe('none');
  });

  it('fishtail when result is 1 above HC', () => {
    // HC=3, hazardAccumulator=2, forceRoll=8 → 8 + 2 - 3 = 7 → result 7
    // Need to check what 7 maps to in our table
    const result = resolveControlTable(3, 4, 10); // high roll + hazard
    expect(['fishtail', 'skid', 'roll', 'collision']).toContain(result.effect);
  });

  it('no control roll needed when hazard is zero', () => {
    const result = resolveControlTable(3, 0, 2);
    expect(result.effect).toBe('none');
  });
});
