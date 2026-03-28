import { describe, it, expect } from 'vitest';
import { POWER_PLANTS } from '../src/rules/data/power-plants';
import { SUSPENSIONS } from '../src/rules/data/suspensions';
import { TIRES } from '../src/rules/data/tires';

describe('power plants catalog', () => {
  it('elec_medium plant has correct power factors and DP', () => {
    const med = POWER_PLANTS.find(p => p.id === 'elec_medium')!;
    expect(med.powerFactors).toBe(1400);
    expect(med.dp).toBe(8);
    expect(med.spaces).toBe(4);
    expect(med.fuelType).toBe('electric');
    expect(med.cycleOnly).toBe(false);
  });

  it('elec_thundercat has highest power factors', () => {
    const tc = POWER_PLANTS.find(p => p.id === 'elec_thundercat')!;
    expect(tc.powerFactors).toBe(6700);
  });

  it('gas_300 exists with correct stats', () => {
    const gas = POWER_PLANTS.find(p => p.id === 'gas_300')!;
    expect(gas.fuelType).toBe('gas');
    expect(gas.powerFactors).toBe(1700);
    expect(gas.cycleOnly).toBe(false);
  });

  it('cycle power plants are marked cycleOnly', () => {
    const cycPlants = POWER_PLANTS.filter(p => p.cycleOnly);
    expect(cycPlants.length).toBe(6);
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
