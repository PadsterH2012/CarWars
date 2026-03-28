import { describe, it, expect } from 'vitest';

// These types must exist in @carwars/shared after this task
import type { VehicleLoadout, DamageState } from '@carwars/shared';
import { BODIES } from '../src/rules/data/bodies';
import { POWER_PLANTS } from '../src/rules/data/power-plants';
import { SUSPENSIONS } from '../src/rules/data/suspensions';
import { TIRES } from '../src/rules/data/tires';

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

describe('power plants catalog', () => {
  it('medium plant has correct power factors and DP', () => {
    const med = POWER_PLANTS.find(p => p.id === 'medium')!;
    expect(med.powerFactors).toBe(1400);
    expect(med.dp).toBe(8);
    expect(med.spaces).toBe(4);
  });

  it('thundercat has highest power factors', () => {
    const tc = POWER_PLANTS.find(p => p.id === 'thundercat')!;
    expect(tc.powerFactors).toBe(6700);
  });
});

describe('suspensions catalog', () => {
  it('heavy suspension gives HC 3 for cars', () => {
    const heavy = SUSPENSIONS.find(s => s.id === 'heavy')!;
    expect(heavy.carHC).toBe(3);
  });

  it('off_road suspension does not give highway benefit', () => {
    const or = SUSPENSIONS.find(s => s.id === 'off_road')!;
    expect(or.carHC).toBe(2);
  });
});

describe('tires catalog', () => {
  it('plasticore has highest DP', () => {
    const pt = TIRES.find(t => t.id === 'plasticore')!;
    expect(pt.dp).toBe(25);
  });

  it('standard tire has 4 DP', () => {
    const std = TIRES.find(t => t.id === 'standard')!;
    expect(std.dp).toBe(4);
  });
});
