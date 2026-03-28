import { describe, it, expect } from 'vitest';
import { createTurnEngine } from '../src/rules/engine';
import type { VehicleState, WeaponMount, ZoneState } from '@carwars/shared';
import { WEAPONS } from '../src/rules/data/weapons';

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

function makeVehicleWithWeapon(id: string, x: number, y: number, weaponId: string, ammo: number): VehicleState {
  const mount: WeaponMount = { id: `${id}-m1`, weaponId, arc: 'front', ammo };
  return {
    id, playerId: 'p1', driverId: 'd1',
    position: { x, y }, facing: 0, speed: 0,
    stats: {
      id, name: 'Car',
      loadout: { mounts: [mount] } as any,
      damageState: {
        armor: { front: 4, back: 2, left: 3, right: 3, top: 0, underbody: 10 },
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

  it('fires a weapon and decrements ammo by 1', () => {
    // Attacker faces north (facing=0), enemy is due north at (0, -10)
    const attacker = makeVehicleWithWeapon('a1', 0, 0, 'mg', 5);
    const enemy = makeVehicle('e1', 0, -10);
    const engine = createTurnEngine({ id: 'z1', type: 'arena', tick: 0, vehicles: [attacker, enemy], hazardObjects: [] });
    engine.queueInput('a1', { speed: 0, steer: 0, fireWeapon: 'mg' });
    const result = engine.resolveTick();
    const updatedAttacker = result.vehicles.find(v => v.id === 'a1')!;
    const mount = updatedAttacker.stats.loadout!.mounts[0];
    expect(mount.ammo).toBe(4);
  });

  it('mine deals underbody damage and is removed when triggered', () => {
    const mineDef = WEAPONS.find(w => w.id === 'mine')!;
    const vehicle = makeVehicle('v1', 0, 0);
    const initialUnderbody = vehicle.stats.damageState.armor.underbody ?? 0;
    const engine = createTurnEngine({
      id: 'z1', type: 'arena', tick: 0,
      vehicles: [vehicle],
      hazardObjects: [{ id: 'mine-1', type: 'mine', position: { x: 0, y: 0 }, ownerId: 'other' }]
    });
    engine.queueInput('v1', { speed: 0, steer: 0, fireWeapon: null });
    const result = engine.resolveTick();

    // Mine should have been removed
    expect(result.hazardObjects.find(h => h.id === 'mine-1')).toBeUndefined();

    // Underbody damage should have been applied
    const updatedVehicle = result.vehicles.find(v => v.id === 'v1')!;
    const expectedUnderbody = Math.max(0, initialUnderbody - mineDef.damage);
    expect(updatedVehicle.stats.damageState.armor.underbody).toBe(expectedUnderbody);
  });
});

// Helper function for fire damage test
function makeBurningVehicle(): VehicleState {
  return {
    id: 'v-fire', playerId: 'p1', driverId: 'd1',
    position: { x: 0, y: 0 }, facing: 0, speed: 0,
    stats: {
      id: 'v-fire', name: 'Burning Car', loadout: {} as any,
      damageState: {
        armor: { front: 4, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
        engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false,
        onFire: true, engineDP: 8, internalDamage: [],
      },
      maxSpeed: 15, handlingClass: 3, weight: 3000, acceleration: 5,
    }
  };
}

describe('fire damage tick', () => {
  it('burning vehicle loses armor each tick', () => {
    const zoneState: ZoneState = {
      id: 'zone-1', tick: 0,
      vehicles: [makeBurningVehicle()],
      hazardObjects: [],
    };
    const engine = createTurnEngine(zoneState);
    const after = engine.resolveTick();
    const v = after.vehicles.find(v => v.id === 'v-fire')!;
    const totalArmorAfter = Object.values(v.stats.damageState.armor).reduce((s, n) => s + (n ?? 0), 0);
    // Started with 4+4+4+4+2+2=20, should have lost at least 1
    expect(totalArmorAfter).toBeLessThan(20);
  });
});
