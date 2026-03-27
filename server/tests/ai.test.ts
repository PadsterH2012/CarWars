import { describe, it, expect } from 'vitest';
import { computeAiInput } from '../src/ai/driver';
import type { VehicleState } from '@carwars/shared';

function makeVehicle(id: string, playerId: string, x: number, y: number, facing = 0): VehicleState {
  return {
    id, playerId, driverId: `d_${id}`,
    position: { x, y }, facing, speed: 0,
    stats: {
      id, name: 'Car', loadout: {} as any,
      damageState: {
        armor: { front: 4, back: 2, left: 3, right: 3, top: 0, underbody: 0 },
        engineDamaged: false, driverWounded: false, tiresBlown: []
      },
      maxSpeed: 20, handlingClass: 3, weight: 3000
    }
  };
}

const self = makeVehicle('ai1', 'cpu', 0, 0, 0);
const target = makeVehicle('t1', 'p1', 0, -20, 180);

describe('AI driver', () => {
  it('accelerates when target is far away', () => {
    const input = computeAiInput(self, [target], 3);
    expect(input.speed).toBeGreaterThan(0);
  });

  it('steers within maximum turn angle', () => {
    const input = computeAiInput(self, [target], 3);
    expect(Math.abs(input.steer)).toBeLessThanOrEqual(30);
  });

  it('fires when target is within weapon range', () => {
    const closeTarget = makeVehicle('t1', 'p1', 0, -6, 180);
    const input = computeAiInput(self, [closeTarget], 3);
    expect(input.fireWeapon).not.toBeNull();
  });

  it('does not fire at own team', () => {
    const teammate = makeVehicle('t2', 'cpu', 0, -6, 180);
    const input = computeAiInput(self, [teammate], 3);
    expect(input.fireWeapon).toBeNull();
  });

  it('returns zero input when no enemies present', () => {
    const input = computeAiInput(self, [], 3);
    expect(input.speed).toBe(0);
    expect(input.steer).toBe(0);
    expect(input.fireWeapon).toBeNull();
  });
});
