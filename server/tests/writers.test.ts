import { describe, it, expect } from 'vitest';
import { ContextRing, SLOT_DEG } from '../src/ai/context-ring';
import { writeVehicleDanger } from '../src/ai/writers';
import type { VehicleState } from '@carwars/shared';

// Slot index a bearing falls into (mirrors context-ring's slotOf).
function slotOf(bearing: number): number {
  const n = ((bearing % 360) + 360) % 360;
  return Math.floor((n + SLOT_DEG / 2) / SLOT_DEG) % 16;
}

function makeVehicle(
  id: string,
  playerId: string,
  x: number,
  y: number,
  opts: { hasRamplate?: boolean; armorFrac?: number } = {},
): VehicleState {
  const full = { front: 10, back: 10, left: 10, right: 10, top: 4, underbody: 4 };
  const frac = opts.armorFrac ?? 1;
  const cur = Object.fromEntries(Object.entries(full).map(([k, v]) => [k, Math.round(v * frac)]));
  return {
    id, playerId, driverId: `d_${id}`,
    position: { x, y }, facing: 0, speed: 0,
    stats: {
      id, name: 'Car',
      loadout: { bodyType: 'mid_size', armor: full, mounts: [], accessories: [], hasRamplate: !!opts.hasRamplate } as any,
      damageState: { armor: cur, engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false } as any,
      maxSpeed: 80, handlingClass: 3, weight: 3000, acceleration: 5,
    } as any,
  };
}

describe('writeVehicleDanger — enemy collision avoidance', () => {
  it('writes danger toward a healthy enemy inside the collision bubble', () => {
    const ring = new ContextRing();
    const self  = makeVehicle('ai', 'a', 0, 0);
    const enemy = makeVehicle('en', 'b', 3, 0); // 3 units east, inside ENEMY_AVOID_RANGE (4)
    writeVehicleDanger(ring, self, [self, enemy]);
    const eastSlot = slotOf(90); // bearing east = toward the enemy
    expect(ring.danger[eastSlot]).toBeGreaterThan(0);
  });

  it('writes no enemy danger when WE have a ramplate and full health (ramming allowed)', () => {
    const ring = new ContextRing();
    const self  = makeVehicle('ai', 'a', 0, 0, { hasRamplate: true });
    const enemy = makeVehicle('en', 'b', 3, 0);
    writeVehicleDanger(ring, self, [self, enemy]);
    const eastSlot = slotOf(90);
    expect(ring.danger[eastSlot]).toBe(0);
  });

  it('resumes avoidance when the ramplate vehicle is badly damaged', () => {
    const ring = new ContextRing();
    const self  = makeVehicle('ai', 'a', 0, 0, { hasRamplate: true, armorFrac: 0.2 });
    const enemy = makeVehicle('en', 'b', 3, 0);
    writeVehicleDanger(ring, self, [self, enemy]);
    const eastSlot = slotOf(90);
    expect(ring.danger[eastSlot]).toBeGreaterThan(0);
  });

  it('ignores enemies beyond the collision bubble', () => {
    const ring = new ContextRing();
    const self  = makeVehicle('ai', 'a', 0, 0);
    const enemy = makeVehicle('en', 'b', 8, 0); // well outside ENEMY_AVOID_RANGE
    writeVehicleDanger(ring, self, [self, enemy]);
    const eastSlot = slotOf(90);
    expect(ring.danger[eastSlot]).toBe(0);
  });
});
