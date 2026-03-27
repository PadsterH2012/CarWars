import { describe, it, expect } from 'vitest';
import { createTurnEngine } from '../src/rules/engine';
import type { VehicleState } from '@carwars/shared';

function makeVehicle(id: string, x: number, y: number): VehicleState {
  return {
    id, playerId: 'p1', driverId: 'd1',
    position: { x, y }, facing: 0, speed: 0,
    stats: {
      id, name: 'Car', loadout: {} as any,
      damageState: {
        armor: { front: 4, back: 2, left: 3, right: 3, top: 0, underbody: 0 },
        engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false
      },
      maxSpeed: 20, handlingClass: 3, weight: 3000
    }
  };
}

describe('TurnEngine', () => {
  it('advances tick on each resolution', () => {
    const engine = createTurnEngine({ id: 'z1', type: 'arena', tick: 0, vehicles: [makeVehicle('v1', 0, 0)], hazardObjects: [] });
    engine.queueInput('v1', { speed: 10, steer: 0, fireWeapon: null });
    const result = engine.resolveTick();
    expect(result.tick).toBe(1);
  });

  it('moves all vehicles with queued inputs', () => {
    const engine = createTurnEngine({ id: 'z1', type: 'arena', tick: 0, vehicles: [makeVehicle('v1', 0, 0)], hazardObjects: [] });
    engine.queueInput('v1', { speed: 10, steer: 0, fireWeapon: null });
    const result = engine.resolveTick();
    expect(result.vehicles[0].position.y).not.toBe(0);
  });

  it('maintains last input if no new input queued', () => {
    const engine = createTurnEngine({ id: 'z1', type: 'arena', tick: 0, vehicles: [makeVehicle('v1', 0, 0)], hazardObjects: [] });
    engine.queueInput('v1', { speed: 10, steer: 0, fireWeapon: null });
    engine.resolveTick();
    const result2 = engine.resolveTick();
    expect(result2.tick).toBe(2);
  });

  it('getState returns current zone state', () => {
    const engine = createTurnEngine({ id: 'z1', type: 'arena', tick: 0, vehicles: [makeVehicle('v1', 0, 0)], hazardObjects: [] });
    const state = engine.getState();
    expect(state.id).toBe('z1');
    expect(state.vehicles).toHaveLength(1);
  });
});
