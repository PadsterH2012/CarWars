import { test, expect } from 'vitest';
import { calculateLoadoutCost, validateLoadout } from '../src/ui/DesignerUI';

test('calculateLoadoutCost sums chassis + engine + armor + weapons', () => {
  const loadout = {
    chassisId: 'mid',
    engineId: 'medium',
    suspensionId: 'standard',
    tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
            { id: 't2', blown: false }, { id: 't3', blown: false }],
    mounts: [{ id: 'm0', arc: 'front' as const, weaponId: 'mg', ammo: 50 }],
    armor: { front: 6, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
    totalCost: 0
  };
  const cost = calculateLoadoutCost(loadout);
  expect(cost).toBeGreaterThan(0);
  expect(cost).toBeLessThan(50000);
});

test('validateLoadout returns errors for invalid loadout', () => {
  const errors = validateLoadout({
    chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
    tires: [], mounts: [], armor: { front: 0, back: 0, left: 0, right: 0, top: 0, underbody: 0 }, totalCost: 0
  });
  expect(errors.length).toBeGreaterThan(0);
});

test('validateLoadout returns empty for valid loadout', () => {
  const errors = validateLoadout({
    chassisId: 'mid', engineId: 'medium', suspensionId: 'standard',
    tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
            { id: 't2', blown: false }, { id: 't3', blown: false }],
    mounts: [{ id: 'm0', arc: 'front', weaponId: 'mg', ammo: 50 }],
    armor: { front: 4, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
    totalCost: 0
  });
  expect(errors).toHaveLength(0);
});
