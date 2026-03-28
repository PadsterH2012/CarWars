import { describe, it, expect } from 'vitest';
import { resolveToHit, resolveDamage, getAttackLocation, isWeaponInArc, rollDamage } from '../src/rules/combat';
import type { VehicleState, WeaponMount } from '@carwars/shared';
import { WEAPONS } from '../src/rules/data/weapons';

describe('weapons catalog', () => {
  it('machine gun has correct Compendium stats', () => {
    const mg = WEAPONS.find(w => w.id === 'mg')!;
    expect(mg.toHit).toBe(7);
    expect(mg.damageDice).toBe(1);
    expect(mg.damageMod).toBe(0);
    expect(mg.spaces).toBe(1);
    expect(mg.shotsPerMag).toBe(20);
  });

  it('vulcan MG has 2d damage', () => {
    const vmg = WEAPONS.find(w => w.id === 'vmg')!;
    expect(vmg.toHit).toBe(6);
    expect(vmg.damageDice).toBe(2);
  });

  it('medium laser drains 2 power units', () => {
    const ml = WEAPONS.find(w => w.id === 'ml')!;
    expect(ml.powerDrain).toBe(2);
    expect(ml.damageDice).toBe(2);
  });

  it('heavy rocket has to-hit 9', () => {
    const hr = WEAPONS.find(w => w.id === 'hr')!;
    expect(hr.toHit).toBe(9);
    expect(hr.damageDice).toBe(3);
  });

  it('spikedropper is in the dropped category with back-arc restriction', () => {
    const sd = WEAPONS.find(w => w.id === 'sd')!;
    expect(sd.category).toBe('dropped');
    expect(sd.allowedArcs).toEqual(['back']);
  });

  it('all weapon IDs are unique', () => {
    const ids = WEAPONS.map(w => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

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

describe('to-hit modifiers', () => {
  it('adds +2 when driver is wounded', () => {
    const woundedAttacker = {
      ...attacker,
      stats: { ...attacker.stats, damageState: { ...attacker.stats.damageState, driverWounded: true } }
    };
    const mg = WEAPONS.find(w => w.id === 'mg')!;
    // Use a fixed-distance shot within short range — only driverWounded modifier applies
    // attacker speed=10, target speed=5 → diff=5 (<15), not wounded normally
    // wound adds +2, so modifier should be exactly 2
    const result = resolveToHit(woundedAttacker, target, mg, 4);
    expect(result.modifier).toBe(2);
  });

  it('out-of-range shot always misses', () => {
    const mg = WEAPONS.find(w => w.id === 'mg')!;
    const result = resolveToHit(attacker, target, mg, 999);
    expect(result.hit).toBe(false);
  });

  it('subcompact target adds +1 to target number', () => {
    const subcompactTarget = {
      ...target,
      stats: {
        ...target.stats,
        loadout: { ...target.stats.loadout, bodyType: 'subcompact' as const }
      }
    };
    const mg = WEAPONS.find(w => w.id === 'mg')!;
    // attacker not wounded, speeds: 10 vs 5 (diff<15), within short range → only +1 from size
    const result = resolveToHit(attacker, subcompactTarget, mg, 4);
    expect(result.modifier).toBe(1);
  });

  it('van target subtracts -1 from target number', () => {
    const vanTarget = {
      ...target,
      stats: {
        ...target.stats,
        loadout: { ...target.stats.loadout, bodyType: 'van' as const }
      }
    };
    const mg = WEAPONS.find(w => w.id === 'mg')!;
    // attacker not wounded, speeds: 10 vs 5 (diff<15), within short range → only -1 from size
    const result = resolveToHit(attacker, vanTarget, mg, 4);
    expect(result.modifier).toBe(-1);
  });

  it('fast target (>60 mph) adds +1', () => {
    const fastTarget = { ...target, speed: 65 };
    const mg = WEAPONS.find(w => w.id === 'mg')!;
    // attacker speed=10, target speed=65: diff=55 (>30 mph → +2), also target >60 (+1) → total +3
    // But attacker not wounded, within short range → modifier = 3
    const result = resolveToHit(attacker, fastTarget, mg, 4);
    expect(result.modifier).toBe(3);
  });
});

describe('dice-based damage', () => {
  it('rollDamage for 3d6 returns value between 3 and 18', () => {
    for (let i = 0; i < 50; i++) {
      const d = rollDamage(3, 0);
      expect(d).toBeGreaterThanOrEqual(3);
      expect(d).toBeLessThanOrEqual(18);
    }
  });

  it('rollDamage with negative modifier is clamped to minimum 1', () => {
    // 1d6 - 2: min 1 (clamped), max 4
    for (let i = 0; i < 50; i++) {
      const d = rollDamage(1, -2);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(4);
    }
  });

  it('rollDamage with zero dice returns at least 1', () => {
    // Zero-dice weapons use modifier only; clamp ensures minimum 1
    expect(rollDamage(0, 0)).toBe(1);
    expect(rollDamage(0, 5)).toBe(5);
  });
});

describe('vehicular fire on armor breach', () => {
  it('returns onFire effect when fire roll triggers', () => {
    const fragileTarget = {
      ...target,
      stats: {
        ...target.stats,
        damageState: {
          ...target.stats.damageState,
          armor: { front: 1, back: 0, left: 0, right: 0, top: 0, underbody: 0 }
        }
      }
    };
    // Fire 100 times with 5 damage — always breaches, fire triggers on 5-6 of d6 (~33%)
    let fireCount = 0;
    for (let i = 0; i < 100; i++) {
      const result = resolveDamage(fragileTarget, 'front', 5);
      if (result.effects.includes('on_fire')) fireCount++;
    }
    expect(fireCount).toBeGreaterThan(0);
  });

  it('fire effect is absent when armor is not breached', () => {
    const toughTarget = {
      ...target,
      stats: {
        ...target.stats,
        damageState: {
          ...target.stats.damageState,
          armor: { front: 100, back: 0, left: 0, right: 0, top: 0, underbody: 0 }
        }
      }
    };
    // 5 damage vs 100 armor: no breach, no fire
    const result = resolveDamage(toughTarget, 'front', 5);
    expect(result.penetrated).toBe(false);
    expect(result.effects).not.toContain('on_fire');
    expect(result.effects).not.toContain('explosion');
  });

  it('explosion effect co-occurs with on_fire on fire roll of 6', () => {
    // Run many times on a guaranteed breach — explosion should occur at least once
    const fragileTarget = {
      ...target,
      stats: {
        ...target.stats,
        damageState: {
          ...target.stats.damageState,
          armor: { front: 1, back: 0, left: 0, right: 0, top: 0, underbody: 0 }
        }
      }
    };
    let explosionCount = 0;
    for (let i = 0; i < 200; i++) {
      const result = resolveDamage(fragileTarget, 'front', 5);
      if (result.effects.includes('explosion')) {
        explosionCount++;
        // When explosion occurs, on_fire must also be present
        expect(result.effects).toContain('on_fire');
      }
    }
    // ~16.7% chance of explosion on each breach; expect at least some in 200 trials
    expect(explosionCount).toBeGreaterThan(0);
  });
});
