import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

// These types must exist in @carwars/shared after this task
import type { VehicleLoadout, DamageState } from '@carwars/shared';
import { deriveStats } from '../src/rules/vehicle';
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
  it('has 9 car body types plus 3 cycle frames plus trike, truck, trailer', () => {
    expect(BODIES.length).toBe(15);
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

function makeMidSizedLoadout(): VehicleLoadout {
  return {
    // Legacy fields kept for compat
    chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
    tires: [
      { id: 't0', blown: false }, { id: 't1', blown: false },
      { id: 't2', blown: false }, { id: 't3', blown: false },
    ],
    mounts: [],
    armor: { front: 4, back: 2, left: 2, right: 2, top: 1, underbody: 1 },
    totalCost: 5000,
    // New Compendium fields
    bodyType: 'mid_sized',
    chassisType: 'standard',
    suspensionType: 'standard',
    tireType: 'standard',
    armorType: 'ablative',
    powerPlantType: 'medium',
  };
}

describe('deriveStats with Compendium fields', () => {
  it('computes maxSpeed using power factor formula', () => {
    const stats = deriveStats('v1', 'TestCar', makeMidSizedLoadout());
    expect(stats.maxSpeed).toBe(127.5);
  });

  it('derives HC from suspension type', () => {
    // standard suspension for mid-sized car = HC 2
    const stats = deriveStats('v1', 'TestCar', makeMidSizedLoadout());
    expect(stats.handlingClass).toBe(2);
  });

  it('computes acceleration from power factors vs weight', () => {
    const stats = deriveStats('v1', 'TestCar', makeMidSizedLoadout());
    // mid_sized body(1600) + medium plant(700) + 4 standard tires(30*4=120) + armor weight
    // armor: front(4)+back(2)+left(2)+right(2)+top(1)+underbody(1)=12 pts × 8 lbs/pt = 96
    // total ≈ 2516 lbs
    // PF=1400, weight≈2516 → PF(1400) >= weight/2(1258) but PF < weight → acceleration=10
    expect(stats.acceleration).toBe(10);
  });

  it('uses subHC for cycle bodies', () => {
    const cycleLoadout: VehicleLoadout = {
      chassisId: 'light', engineId: 'small', suspensionId: 'standard',
      tires: [{ id: 't0', blown: false }, { id: 't1', blown: false }],
      mounts: [],
      armor: { front: 2, back: 1, left: 1, right: 1, top: 0, underbody: 0 },
      totalCost: 2000,
      bodyType: 'light_cycle',
      chassisType: 'standard',
      suspensionType: 'standard',
      tireType: 'standard',
      armorType: 'ablative',
      powerPlantType: 'small',
    };
    // standard suspension: subHC = 3, carHC = 2
    const stats = deriveStats('c1', 'TestCycle', cycleLoadout);
    expect(stats.handlingClass).toBe(3);
  });

  it('falls back to legacy engine lookup when bodyType is absent', () => {
    const legacyLoadout: VehicleLoadout = {
      chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
      tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
               { id: 't2', blown: false }, { id: 't3', blown: false }],
      mounts: [],
      armor: { front: 4, back: 2, left: 2, right: 2, top: 1, underbody: 1 },
      totalCost: 5000,
    };
    // Should not throw — uses legacy path
    const stats = deriveStats('v1', 'LegacyCar', legacyLoadout);
    expect(stats.maxSpeed).toBeGreaterThan(0);
    expect(stats.acceleration).toBe(5); // legacy default
  });

  it('returns acceleration 0 when severely underpowered (PF < weight/3)', () => {
    // Use a van (2000) + small plant (500) → 2000+500+4×30+12pts×14lbs = 2000+500+120+168 = 2788
    // weight/3 = 929. PF=800 < 929 → acceleration = 0
    const underpoweredLoadout: VehicleLoadout = {
      chassisId: 'mid', engineId: 'small', suspensionId: 'standard',
      tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
               { id: 't2', blown: false }, { id: 't3', blown: false }],
      mounts: [],
      armor: { front: 4, back: 2, left: 2, right: 2, top: 1, underbody: 1 },
      totalCost: 2000,
      bodyType: 'van',
      chassisType: 'standard',
      suspensionType: 'standard',
      tireType: 'standard',
      armorType: 'ablative',
      powerPlantType: 'small',
    };
    const stats = deriveStats('v1', 'Underpowered', underpoweredLoadout);
    expect(stats.acceleration).toBe(0);
  });

  it('returns acceleration 15 when PF >= total weight', () => {
    // subcompact + thundercat: 1000+2000+4×30+12pts×5lbs = 1000+2000+120+60 = 3180
    // PF=6700 >= 3180 → acceleration = 15
    const overpoweredLoadout: VehicleLoadout = {
      chassisId: 'sub', engineId: 'thundercat', suspensionId: 'standard',
      tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
               { id: 't2', blown: false }, { id: 't3', blown: false }],
      mounts: [],
      armor: { front: 4, back: 2, left: 2, right: 2, top: 1, underbody: 1 },
      totalCost: 20000,
      bodyType: 'subcompact',
      chassisType: 'standard',
      suspensionType: 'standard',
      tireType: 'standard',
      armorType: 'ablative',
      powerPlantType: 'thundercat',
    };
    const stats = deriveStats('v1', 'Rocket', overpoweredLoadout);
    expect(stats.acceleration).toBe(15);
  });
});

describe('POST /api/vehicles/design', () => {
  const app = createApp();

  it('returns derived stats for a valid loadout spec', async () => {
    const res = await request(app).post('/api/vehicles/design').send({
      bodyType: 'mid_sized',
      chassisType: 'standard',
      suspensionType: 'standard',
      powerPlantType: 'medium',
      tireType: 'standard',
      armorType: 'ablative',
      armor: { front: 4, back: 2, left: 2, right: 2, top: 1, underbody: 1 },
    });
    expect(res.status).toBe(200);
    expect(res.body.maxSpeed).toBe(127.5);       // deterministic PF formula
    expect(res.body.acceleration).toBe(10);
    expect(res.body.handlingClass).toBe(2);
    expect(res.body.totalWeight).toBeGreaterThan(0);
    expect(res.body.totalCost).toBeGreaterThan(0);
  });

  it('returns 400 if bodyType is missing', async () => {
    const res = await request(app).post('/api/vehicles/design').send({
      powerPlantType: 'medium',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for unknown bodyType', async () => {
    const res = await request(app).post('/api/vehicles/design').send({
      bodyType: 'tank',
      powerPlantType: 'medium',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown bodyType/);
  });

  it('returns 400 when armor contains non-numeric value', async () => {
    const res = await request(app).post('/api/vehicles/design').send({
      bodyType: 'mid_sized',
      powerPlantType: 'medium',
      armor: { front: 'lots', back: 0, left: 0, right: 0, top: 0, underbody: 0 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/armor\.front/);
  });
});
