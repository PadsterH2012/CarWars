import { describe, it, expect } from 'vitest';
import { resolveToHit, resolveDamage, getAttackLocation } from '../src/rules/combat';
import type { VehicleState } from '@carwars/shared';
import { WEAPONS } from '../src/rules/data/weapons';

const attacker: VehicleState = {
  id: 'a1', playerId: 'p1', driverId: 'd1',
  position: { x: 0, y: 0 }, facing: 0, speed: 10,
  stats: { id: 'a1', name: 'Attacker', loadout: {} as any,
    damageState: { armor: {}, engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false },
    maxSpeed: 20, handlingClass: 3, weight: 3000 }
};

const target: VehicleState = {
  id: 't1', playerId: 'p2', driverId: 'd2',
  position: { x: 0, y: -8 }, facing: 180, speed: 5,
  stats: { id: 't1', name: 'Target', loadout: {} as any,
    damageState: {
      armor: { front: 4, back: 2, left: 3, right: 3, top: 0, underbody: 0 },
      engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false
    },
    maxSpeed: 15, handlingClass: 2, weight: 2500 }
};

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
