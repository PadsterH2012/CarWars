import { describe, it, expect } from 'vitest';

// These types must exist in @carwars/shared after this task
import type { VehicleLoadout, DamageState } from '@carwars/shared';

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
