import { describe, it, expect } from 'vitest';
import { resolveToHit, resolveDamage, getAttackLocation, isWeaponInArc } from '../src/rules/combat';
import type { VehicleState, WeaponMount } from '@carwars/shared';
import { WEAPONS } from '../src/rules/data/weapons';

const attacker: VehicleState = {
  id: 'a1', playerId: 'p1', driverId: 'd1',
  position: { x: 0, y: 0 }, facing: 0, speed: 10,
  stats: { id: 'a1', name: 'Attacker', loadout: {} as any,
    damageState: { armor: {}, engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false },
    maxSpeed: 20, handlingClass: 3, acceleration: 5, weight: 3000 }
};

const target: VehicleState = {
  id: 't1', playerId: 'p2', driverId: 'd2',
  position: { x: 0, y: -8 }, facing: 180, speed: 5,
  stats: { id: 't1', name: 'Target', loadout: {} as any,
    damageState: {
      armor: { front: 4, back: 2, left: 3, right: 3, top: 0, underbody: 0 },
      engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false
    },
    maxSpeed: 15, handlingClass: 2, acceleration: 5, weight: 2500 }
};

// Helper to build a minimal WeaponMount
function makeMount(arc: WeaponMount['arc']): WeaponMount {
  return { id: 'm1', weaponId: 'mg', arc, ammo: 10 };
}

// Helper to build a vehicle at position with the given compass facing (degrees, 0=north)
function makeVehicleAt(id: string, x: number, y: number, facing = 0): VehicleState {
  return {
    id, playerId: 'p1', driverId: 'd1',
    position: { x, y }, facing, speed: 0,
    stats: { id, name: 'Car', loadout: {} as any,
      damageState: { armor: {}, engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false },
      maxSpeed: 20, handlingClass: 3, acceleration: 5, weight: 3000 }
  };
}

// Coordinate system: facing=0 is north. In math coords, north = +Y.
// gameAngleToTarget = 0° means target is due north of attacker.
// relAngle = gameAngleToTarget - attacker.facing (normalised to -180..+180)
// front arc: relAngle in [-45, +45]  → target north of attacker when facing=0
// back arc:  relAngle <= -135 or >= 135 → target south of attacker when facing=0
describe('isWeaponInArc', () => {
  it('front arc: target directly in front is in arc', () => {
    // Attacker at (0,0) facing 0 (north). Target due north at (0,10).
    const a = makeVehicleAt('a', 0, 0, 0);
    const t = makeVehicleAt('t', 0, 10, 0);
    expect(isWeaponInArc(a, t, makeMount('front'))).toBe(true);
  });

  it('front arc: target directly to the side (90°) is NOT in arc', () => {
    // Attacker facing north. Target due east at (10,0) = 90° off front.
    const a = makeVehicleAt('a', 0, 0, 0);
    const t = makeVehicleAt('t', 10, 0, 0);
    expect(isWeaponInArc(a, t, makeMount('front'))).toBe(false);
  });

  it('back arc: target directly behind is in arc', () => {
    // Attacker facing north. Target due south at (0,-10) = 180° relative.
    const a = makeVehicleAt('a', 0, 0, 0);
    const t = makeVehicleAt('t', 0, -10, 0);
    expect(isWeaponInArc(a, t, makeMount('back'))).toBe(true);
  });

  it('turret: any target is in arc', () => {
    const a = makeVehicleAt('a', 0, 0, 0);
    const t = makeVehicleAt('t', 10, 10, 0);
    expect(isWeaponInArc(a, t, makeMount('turret'))).toBe(true);
  });

  it('front arc: target at exactly 45° is in arc (boundary inclusive)', () => {
    // 45° clockwise from north = northeast direction.
    // In math coords: x = sin(45°) * r, y = cos(45°) * r
    const a = makeVehicleAt('a', 0, 0, 0);
    const r = 10;
    const t = makeVehicleAt('t', Math.sin(Math.PI / 4) * r, Math.cos(Math.PI / 4) * r, 0);
    expect(isWeaponInArc(a, t, makeMount('front'))).toBe(true);
  });

  it('default arc: unknown arc value returns false', () => {
    const a = makeVehicleAt('a', 0, 0, 0);
    const t = makeVehicleAt('t', 0, 10, 0);
    const badMount = { id: 'm1', weaponId: 'mg', arc: 'unknown' as any, ammo: 10 };
    expect(isWeaponInArc(a, t, badMount)).toBe(false);
  });
});

describe('combat', () => {
  it('determines attack hits target facing based on relative angle', () => {
    // Attacker at (0,0) facing north, target at (0,-8) facing south (180°)
    // Attack comes from south relative to target → hits target's BACK
    const location = getAttackLocation(attacker, target);
    expect(location).toBe('back');
  });

  it('resolves to-hit with distance modifier', () => {
    const mg = WEAPONS.find(w => w.id === 'mg')!;
    const result = resolveToHit(attacker, target, mg, 8);
    expect(result).toHaveProperty('roll');
    expect(result).toHaveProperty('hit');
    expect(result).toHaveProperty('location');
  });

  it('does not penetrate when damage does not exceed armor', () => {
    const mg = WEAPONS.find(w => w.id === 'mg')!;
    // Back armor = 2, MG damage = 1 — does not penetrate
    const result = resolveDamage(target, 'back', mg.damage);
    expect(result.penetrated).toBe(false);
    expect(result.damageDealt).toBe(1);
  });

  it('penetrates when damage exceeds armor', () => {
    const weakTarget = {
      ...target,
      stats: {
        ...target.stats,
        damageState: { ...target.stats.damageState, armor: { front: 1 } }
      }
    };
    const hmg = WEAPONS.find(w => w.id === 'hmg')!;
    // HMG damage = 2, front armor = 1 → penetrates
    const result = resolveDamage(weakTarget, 'front', hmg.damage);
    expect(result.penetrated).toBe(true);
  });
});
