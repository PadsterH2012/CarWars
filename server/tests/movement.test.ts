import { describe, it, expect } from 'vitest';
import { computeMovement, applyHazardCheck } from '../src/rules/movement';
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
