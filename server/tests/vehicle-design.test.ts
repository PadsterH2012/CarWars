import { describe, it, expect } from 'vitest';

// These types must exist in @carwars/shared after this task
import type { VehicleLoadout, DamageState } from '@carwars/shared';
import { BODIES } from '../src/rules/data/bodies';

describe('shared type additions', () => {
  it('VehicleLoadout accepts bodyType field', () => {
    const loadout: VehicleLoadout = {
      chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
      tires: [], mounts: [],
      armor: { front: 4, back: 2, left: 2, right: 2, top: 1, underbody: 1 },
      totalCost: 5000,
      bodyType: 'mid_sized',
      chassisType: 'standard',
      suspensionType: 'standard',
      tireType: 'standard',
      armorType: 'ablative',
      powerPlantType: 'medium',
    };
    expect(loadout.bodyType).toBe('mid_sized');
  });

  it('DamageState accepts onFire and engineDP fields', () => {
    const ds: DamageState = {
      armor: { front: 4, back: 2, left: 2, right: 2, top: 1, underbody: 1 },
      engineDamaged: false,
      driverWounded: false,
      tiresBlown: [],
      destroyed: false,
      onFire: false,
      engineDP: 8,
      internalDamage: [],
    };
    expect(ds.onFire).toBe(false);
    expect(ds.engineDP).toBe(8);
  });
});

describe('bodies catalog', () => {
  it('has 9 car body types plus 3 cycle frames', () => {
    expect(BODIES.length).toBe(12);
  });

  it('mid_sized has correct spaces and max load', () => {
    const mid = BODIES.find(b => b.id === 'mid_sized')!;
    expect(mid.spaces).toBe(13);
    expect(mid.maxLoad).toBe(4800);
    expect(mid.baseHC).toBe(3);
  });

  it('van has correct spaces and cargo area', () => {
    const van = BODIES.find(b => b.id === 'van')!;
    expect(van.spaces).toBe(24);
    expect(van.maxLoad).toBe(6000);
  });
});
