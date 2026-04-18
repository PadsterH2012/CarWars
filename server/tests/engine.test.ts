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
    // Give the fixture real underbody armor so the hit damages rather than destroys
    vehicle.stats.damageState.armor.underbody = 8;
    const initialUnderbody = 8;
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
    // Started with 4+4+4+4+2+2=20, exactly 1 armor point lost per tick
    expect(totalArmorAfter).toBe(19);
    expect(v.stats.damageState.onFire).toBe(true);
  });

  it('vehicle with no armor is destroyed by fire', () => {
    const burnedOutVehicle: VehicleState = {
      id: 'v-burnout', playerId: 'p1', driverId: 'd1',
      position: { x: 0, y: 0 }, facing: 0, speed: 0,
      stats: {
        id: 'v-burnout', name: 'Burned Out', loadout: {} as any,
        damageState: {
          armor: { front: 0, back: 0, left: 0, right: 0, top: 0, underbody: 0 },
          engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false,
          onFire: true, engineDP: 8, internalDamage: [],
        },
        maxSpeed: 15, handlingClass: 3, weight: 3000, acceleration: 5,
      }
    };
    const zoneState: ZoneState = {
      id: 'zone-1', tick: 0,
      vehicles: [burnedOutVehicle],
      hazardObjects: [],
    };
    const engine = createTurnEngine(zoneState);
    const after = engine.resolveTick();
    // Destroyed by fire → promoted to burning wreckage, removed from vehicles[]
    expect(after.vehicles.find(v => v.id === 'v-burnout')).toBeUndefined();
    const wreck = after.wreckage?.find(w => w.sourceVehicleId === 'v-burnout');
    expect(wreck).toBeDefined();
    expect(wreck!.state).toBe('burning');
  });
});

function makeDoomedVehicle(id: string, opts: { onFire?: boolean; ammoCount?: number; bodyType?: string }): VehicleState {
  return {
    id, playerId: 'p1', driverId: 'd1',
    position: { x: 10, y: 5 }, facing: 45, speed: 0,
    stats: {
      id, name: 'Doomed',
      loadout: {
        bodyType: opts.bodyType ?? 'mid_sized',
        mounts: opts.ammoCount
          ? [{ id: 'm0', weaponId: 'mg', arc: 'front', ammo: opts.ammoCount }]
          : [],
      } as any,
      damageState: {
        armor: { front: 0, back: 0, left: 0, right: 0, top: 0, underbody: 0 },
        engineDamaged: true, driverWounded: false, tiresBlown: [], destroyed: false,
        onFire: !!opts.onFire, engineDP: 0, internalDamage: [],
      },
      maxSpeed: 20, handlingClass: 3, weight: 3000, acceleration: 5,
    }
  };
}

describe('wreckage promotion', () => {
  it('destroyed vehicle moves from vehicles[] to wreckage[]', () => {
    const v = makeDoomedVehicle('v-die', { onFire: true });
    v.stats.damageState.destroyed = true;
    const engine = createTurnEngine({
      id: 'z', type: 'arena', tick: 0, vehicles: [v], hazardObjects: [],
    });
    const after = engine.resolveTick();
    expect(after.vehicles.find(x => x.id === 'v-die')).toBeUndefined();
    expect(after.wreckage).toBeDefined();
    expect(after.wreckage!.length).toBe(1);
    const w = after.wreckage![0];
    expect(w.sourceVehicleId).toBe('v-die');
    expect(w.position).toEqual({ x: 10, y: 5 });
    expect(w.facing).toBe(45);
    expect(w.bodyType).toBe('mid_sized');
  });

  it('fire-destroyed vehicle creates a burning wreck', () => {
    const v = makeDoomedVehicle('v-fire', { onFire: true });
    v.stats.damageState.destroyed = true;
    const engine = createTurnEngine({
      id: 'z', type: 'arena', tick: 0, vehicles: [v], hazardObjects: [],
    });
    const after = engine.resolveTick();
    const w = after.wreckage![0];
    expect(w.state).toBe('burning');
    expect(w.causedBy).toBe('fire');
  });

  it('non-fire destruction without ammo creates a smouldering wreck', () => {
    const v = makeDoomedVehicle('v-kill', { onFire: false, ammoCount: 0 });
    v.stats.damageState.destroyed = true;
    const engine = createTurnEngine({
      id: 'z', type: 'arena', tick: 0, vehicles: [v], hazardObjects: [],
    });
    const after = engine.resolveTick();
    expect(after.wreckage![0].state).toBe('smouldering');
  });

  it('records carriedAmmo and mass class from the vehicle', () => {
    const v = makeDoomedVehicle('v-ammo', { ammoCount: 12, bodyType: 'van' });
    v.stats.damageState.destroyed = true;
    const engine = createTurnEngine({
      id: 'z', type: 'arena', tick: 0, vehicles: [v], hazardObjects: [],
    });
    const after = engine.resolveTick();
    const w = after.wreckage![0];
    expect(w.carriedAmmo).toBe(12);
    expect(w.mass).toBe('heavy');   // van → heavy
    expect(w.pushable).toBe(false); // heavy wrecks not pushable initially
  });

  it('cycle produces a light, pushable wreck', () => {
    const v = makeDoomedVehicle('v-bike', { bodyType: 'light_cycle' });
    v.stats.damageState.destroyed = true;
    const engine = createTurnEngine({
      id: 'z', type: 'arena', tick: 0, vehicles: [v], hazardObjects: [],
    });
    const after = engine.resolveTick();
    const w = after.wreckage![0];
    expect(w.mass).toBe('light');
    expect(w.pushable).toBe(true);
  });
});

describe('wreckage state transitions', () => {
  function tickN(engine: ReturnType<typeof createTurnEngine>, n: number) {
    for (let i = 0; i < n; i++) engine.resolveTick();
    return engine.getState();
  }

  it('burning → smouldering after 30 ticks', () => {
    const v = makeDoomedVehicle('v', { onFire: true });
    v.stats.damageState.destroyed = true;
    const engine = createTurnEngine({
      id: 'z', type: 'arena', tick: 0, vehicles: [v], hazardObjects: [],
    });
    engine.resolveTick();   // t=1 — vehicle becomes wreck (burning)
    expect(engine.getState().wreckage![0].state).toBe('burning');
    tickN(engine, 30);
    expect(engine.getState().wreckage![0].state).toBe('smouldering');
  });

  it('smouldering → debris after another 60 ticks', () => {
    const v = makeDoomedVehicle('v', { onFire: true });
    v.stats.damageState.destroyed = true;
    const engine = createTurnEngine({
      id: 'z', type: 'arena', tick: 0, vehicles: [v], hazardObjects: [],
    });
    tickN(engine, 31); // past burning
    expect(engine.getState().wreckage![0].state).toBe('smouldering');
    tickN(engine, 61); // past smouldering
    expect(engine.getState().wreckage![0].state).toBe('debris');
  });

  it('debris persists indefinitely (no removal)', () => {
    const v = makeDoomedVehicle('v', { onFire: true });
    v.stats.damageState.destroyed = true;
    const engine = createTurnEngine({
      id: 'z', type: 'arena', tick: 0, vehicles: [v], hazardObjects: [],
    });
    tickN(engine, 200);
    expect(engine.getState().wreckage!.length).toBe(1);
    expect(engine.getState().wreckage![0].state).toBe('debris');
  });
});

describe('wreckage collision', () => {
  function makeMobileVehicle(id: string, x: number, y: number, facing: number, speed: number, hasRamplate = false): VehicleState {
    return {
      id, playerId: 'p1', driverId: 'd1',
      position: { x, y }, facing, speed,
      stats: {
        id, name: 'Ram',
        loadout: {
          bodyType: 'mid_sized', mounts: [], hasRamplate,
          armor: { front: 10, back: 10, left: 10, right: 10, top: 5, underbody: 5 },
        } as any,
        damageState: {
          armor: { front: 10, back: 10, left: 10, right: 10, top: 5, underbody: 5 },
          engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false,
        },
        maxSpeed: 60, handlingClass: 3, weight: 3000, acceleration: 5,
      }
    };
  }

  function seedWreck(overrides: Partial<import('@carwars/shared').WreckageObject> = {}): import('@carwars/shared').WreckageObject {
    return {
      id: 'w1', sourceVehicleId: 'old-v',
      position: { x: 4.5, y: 0 }, facing: 0, bodyType: 'mid_sized',
      state: 'debris', stateStartedAt: 0, remainingDP: 10,
      mass: 'medium', pushable: false, carriedAmmo: 0, causedBy: 'kinetic',
      ...overrides,
    };
  }

  it('vehicle colliding with wreckage takes damage on impact face', () => {
    const v = makeMobileVehicle('v1', 4, 0, 90, 40);  // facing east, overlapping wreck at 4.5
    const engine = createTurnEngine({
      id: 'z', type: 'arena', tick: 0, vehicles: [v], hazardObjects: [],
      wreckage: [seedWreck()],
    });
    engine.queueInput('v1', { speed: 40, steer: 0, fireWeapon: null });
    const after = engine.resolveTick();
    const updated = after.vehicles.find(x => x.id === 'v1')!;
    const total = Object.values(updated.stats.damageState.armor).reduce((s, n) => s + (n ?? 0), 0);
    // Started 50, should have taken damage (collision at speed 40 ≈ 8pts)
    expect(total).toBeLessThan(50);
  });

  it('wreckage remainingDP is reduced by the collision', () => {
    const v = makeMobileVehicle('v1', 4, 0, 90, 50);
    const engine = createTurnEngine({
      id: 'z', type: 'arena', tick: 0, vehicles: [v], hazardObjects: [],
      wreckage: [seedWreck({ remainingDP: 10 })],
    });
    engine.queueInput('v1', { speed: 50, steer: 0, fireWeapon: null });
    const after = engine.resolveTick();
    expect(after.wreckage![0].remainingDP).toBeLessThan(10);
  });

  it('ramplate vehicle pushes pushable wreck along its velocity', () => {
    const v = makeMobileVehicle('v1', 4, 0, 90, 40, true);  // has ramplate, facing east
    const engine = createTurnEngine({
      id: 'z', type: 'arena', tick: 0, vehicles: [v], hazardObjects: [],
      wreckage: [seedWreck({ mass: 'light', pushable: true, position: { x: 4.5, y: 0 } })],
    });
    engine.queueInput('v1', { speed: 40, steer: 0, fireWeapon: null });
    const after = engine.resolveTick();
    const wx = after.wreckage![0].position.x;
    expect(wx).toBeGreaterThan(4.5);  // pushed east from 4.5
  });

  it('non-ramplate vehicle bounces — wreck stays, vehicle speed zeroed', () => {
    const v = makeMobileVehicle('v1', 4, 0, 90, 40, false);  // no ramplate
    const engine = createTurnEngine({
      id: 'z', type: 'arena', tick: 0, vehicles: [v], hazardObjects: [],
      wreckage: [seedWreck({ mass: 'light', pushable: true, position: { x: 4.5, y: 0 } })],
    });
    engine.queueInput('v1', { speed: 40, steer: 0, fireWeapon: null });
    const after = engine.resolveTick();
    expect(after.wreckage![0].position.x).toBe(4.5);  // wreck didn't move
    expect(after.vehicles[0].speed).toBe(0);         // vehicle stopped
  });

  it('heavy wreck is not pushable even with ramplate — vehicle bounces', () => {
    const v = makeMobileVehicle('v1', 4, 0, 90, 40, true);
    const engine = createTurnEngine({
      id: 'z', type: 'arena', tick: 0, vehicles: [v], hazardObjects: [],
      wreckage: [seedWreck({ mass: 'heavy', pushable: false, position: { x: 4.5, y: 0 } })],
    });
    engine.queueInput('v1', { speed: 40, steer: 0, fireWeapon: null });
    const after = engine.resolveTick();
    expect(after.wreckage![0].position.x).toBe(4.5);
  });
});

describe('ammo cook-off blast', () => {
  it('destroyed vehicle with ammo and explosion cause damages nearby vehicle', () => {
    const exploding = makeDoomedVehicle('v-boom', { ammoCount: 10, bodyType: 'mid_sized' });
    exploding.stats.damageState.destroyed = true;
    // Mark cause as explosion via residual internalDamage marker
    exploding.stats.damageState.internalDamage = ['explosion_kill'];
    const bystander: VehicleState = {
      id: 'v-near', playerId: 'p2', driverId: 'd2',
      position: { x: 10.5, y: 5.5 }, facing: 0, speed: 0, // within 2 inch radius
      stats: {
        id: 'v-near', name: 'Bystander', loadout: { bodyType: 'mid_sized' } as any,
        damageState: {
          armor: { front: 10, back: 10, left: 10, right: 10, top: 5, underbody: 5 },
          engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false,
        },
        maxSpeed: 20, handlingClass: 3, weight: 3000, acceleration: 5,
      }
    };
    const engine = createTurnEngine({
      id: 'z', type: 'arena', tick: 0, vehicles: [exploding, bystander], hazardObjects: [],
    });
    const after = engine.resolveTick();
    const near = after.vehicles.find(v => v.id === 'v-near')!;
    const totalArmor = Object.values(near.stats.damageState.armor).reduce((s, n) => s + (n ?? 0), 0);
    // Started 10+10+10+10+5+5=50. Blast should have reduced it.
    expect(totalArmor).toBeLessThan(50);
  });
});
