import { describe, it, expect } from 'vitest';
import { resolveSquadEngagement } from '../src/rules/squadEngagement';

// Deterministic rng yielding a fixed sequence, repeating the last value.
// Call order in resolveSquadEngagement: main roll first, then per driver
// (status roll, then kills roll), in squad order.
function seq(...values: number[]): () => number {
  let i = 0;
  return () => (i < values.length ? values[i++] : values[values.length - 1]);
}

const twoSkilledDrivers = [
  { id: 'd1', name: 'Rick', skill: 5 },
  { id: 'd2', name: 'Sally', skill: 5 },
];
const twoVehicles = [
  { id: 'v1', name: 'Sprocket', value: 8000 },
  { id: 'v2', name: 'Mauler', value: 8000 },
];

describe('resolveSquadEngagement', () => {
  it('computes successChance from avg skill, vehicle bonus, squad-size bonus and zone difficulty', () => {
    const r = resolveSquadEngagement(
      { squad: twoSkilledDrivers, vehicles: twoVehicles, zoneDifficulty: 4, assignment: 'patrol', basePayout: 1000 },
      seq(0.0),
    );
    // avgSkill 5 → base 0.8; +0.1 vehicle; +0.06 squad-size (2 drivers); -0.2 difficulty → 0.76
    expect(r.breakdown.successChance).toBeCloseTo(0.76, 5);
    expect(r.breakdown.squadSizeBonus).toBeCloseTo(0.06, 5);
    expect(r.breakdown.zoneDifficulty).toBe(4);
  });

  it('a larger squad has a higher success chance than a smaller one of equal skill', () => {
    const small = resolveSquadEngagement(
      { squad: twoSkilledDrivers, vehicles: twoVehicles, zoneDifficulty: 4, assignment: 'patrol', basePayout: 1000 },
      seq(0.0),
    );
    const big = resolveSquadEngagement(
      {
        squad: [...twoSkilledDrivers, { id: 'd3', name: 'Mo', skill: 5 }, { id: 'd4', name: 'Jo', skill: 5 }],
        vehicles: twoVehicles, zoneDifficulty: 4, assignment: 'patrol', basePayout: 1000,
      },
      seq(0.0),
    );
    expect(big.breakdown.successChance).toBeGreaterThan(small.breakdown.successChance);
  });

  it('low roll → SUCCESS with full income', () => {
    const r = resolveSquadEngagement(
      { squad: twoSkilledDrivers, vehicles: twoVehicles, zoneDifficulty: 4, assignment: 'patrol', basePayout: 1000 },
      seq(0.1, 0.9, 0.9, 0.9, 0.9),
    );
    expect(r.outcome).toBe('success');
    expect(r.income).toBe(1000);
    expect(r.perDriver.every(d => d.status !== 'dead')).toBe(true);
  });

  it('roll just above successChance → PARTIAL with halved income', () => {
    // successChance 0.76, partial band [0.76, 0.91)
    const r = resolveSquadEngagement(
      { squad: twoSkilledDrivers, vehicles: twoVehicles, zoneDifficulty: 4, assignment: 'patrol', basePayout: 1000 },
      seq(0.80, 0.9, 0.9, 0.9, 0.9),
    );
    expect(r.outcome).toBe('partial');
    expect(r.income).toBe(500);
  });

  it('roll in failure band → FAILURE, no income, a wounded driver, repair bill', () => {
    // failure band [0.91, 1.01); first driver status roll 0.1 < 0.3 → wounded
    const r = resolveSquadEngagement(
      { squad: twoSkilledDrivers, vehicles: twoVehicles, zoneDifficulty: 4, assignment: 'patrol', basePayout: 1000 },
      seq(0.95, 0.1, 0.0, 0.9, 0.0),
    );
    expect(r.outcome).toBe('failure');
    expect(r.income).toBe(0);
    expect(r.perDriver.some(d => d.status === 'wounded')).toBe(true);
    expect(r.repairCost).toBeGreaterThan(0);
  });

  it('hopeless odds → ROUTED, a vehicle wrecked and a driver dead', () => {
    // Weak solo driver, hard zone → low successChance so routed band is reached.
    const r = resolveSquadEngagement(
      { squad: [{ id: 'd1', name: 'Greenhorn', skill: 1 }], vehicles: [{ id: 'v1', name: 'Junker', value: 4000 }], zoneDifficulty: 9, assignment: 'raid', basePayout: 800 },
      seq(0.9, 0.1, 0.0),
    );
    expect(r.outcome).toBe('routed');
    expect(r.income).toBe(0);
    expect(r.vehicles.some(v => v.damage === 'wrecked')).toBe(true);
    expect(r.perDriver.some(d => d.status === 'dead')).toBe(true);
  });

  it('ROUTED wrecks only the most valuable vehicle; the rest take heavy damage', () => {
    const r = resolveSquadEngagement(
      {
        squad: [{ id: 'd1', name: 'A', skill: 1 }],
        vehicles: [{ id: 'v1', name: 'Cheap', value: 4000 }, { id: 'v2', name: 'Pricey', value: 12000 }],
        zoneDifficulty: 9, assignment: 'raid', basePayout: 800,
      },
      seq(0.99, 0.9, 0.0), // main roll → routed; driver survives
    );
    expect(r.outcome).toBe('routed');
    const wrecked = r.vehicles.filter(v => v.damage === 'wrecked');
    const heavy = r.vehicles.filter(v => v.damage === 'heavy');
    expect(wrecked).toHaveLength(1);
    expect(wrecked[0].name).toBe('Pricey'); // most valuable is the one lost
    expect(heavy).toHaveLength(1);
    expect(heavy[0].name).toBe('Cheap');
  });

  it('an EASY job never kills a driver, even when routed', () => {
    const r = resolveSquadEngagement(
      {
        squad: [{ id: 'd1', name: 'A', skill: 2 }, { id: 'd2', name: 'B', skill: 2 }],
        vehicles: twoVehicles, zoneDifficulty: 2, assignment: 'job', basePayout: 500,
      },
      seq(0.99, 0.0, 0.0, 0.0, 0.0), // routed; both drivers roll the worst status
    );
    expect(r.outcome).toBe('routed');
    // deathChance at difficulty 2 is 0 → the worst that happens is wounded
    expect(r.perDriver.every(d => d.status !== 'dead')).toBe(true);
  });

  it('a HARD job can kill a driver when routed', () => {
    const r = resolveSquadEngagement(
      {
        squad: [{ id: 'd1', name: 'A', skill: 1 }],
        vehicles: [{ id: 'v1', name: 'J', value: 4000 }], zoneDifficulty: 9, assignment: 'raid', basePayout: 800,
      },
      seq(0.99, 0.0, 0.0), // routed; statusRoll 0 < deathChance 0.6 → dead
    );
    expect(r.outcome).toBe('routed');
    expect(r.perDriver[0].status).toBe('dead');
  });

  it('net is income minus repair cost', () => {
    const r = resolveSquadEngagement(
      { squad: twoSkilledDrivers, vehicles: twoVehicles, zoneDifficulty: 4, assignment: 'patrol', basePayout: 1000 },
      seq(0.1, 0.9, 0.9, 0.9, 0.9),
    );
    expect(r.net).toBe(r.income - r.repairCost);
  });

  it('includes a rival rep change only when a rival is engaged', () => {
    const withRival = resolveSquadEngagement(
      { squad: twoSkilledDrivers, vehicles: twoVehicles, zoneDifficulty: 4, assignment: 'raid', basePayout: 1000, rival: { id: 'rust_raiders', name: 'The Rust Raiders' } },
      seq(0.1, 0.9, 0.9, 0.9, 0.9),
    );
    expect(withRival.rivalRepChange).toBeDefined();
    expect(withRival.rivalRepChange!.rivalId).toBe('rust_raiders');
    expect(withRival.rivalRepChange!.delta).toBe(10); // player prevailed → grudge up

    const noRival = resolveSquadEngagement(
      { squad: twoSkilledDrivers, vehicles: twoVehicles, zoneDifficulty: 4, assignment: 'patrol', basePayout: 1000 },
      seq(0.1, 0.9, 0.9, 0.9, 0.9),
    );
    expect(noRival.rivalRepChange).toBeUndefined();
  });

  it('clamps successChance into [0.05, 0.95]', () => {
    const elite = resolveSquadEngagement(
      { squad: [{ id: 'd1', name: 'Ace', skill: 6 }, { id: 'd2', name: 'Pro', skill: 6 }, { id: 'd3', name: 'Top', skill: 6 }, { id: 'd4', name: 'Gun', skill: 6 }], vehicles: twoVehicles, zoneDifficulty: 1, assignment: 'patrol', basePayout: 100 },
      seq(0.0),
    );
    expect(elite.breakdown.successChance).toBeLessThanOrEqual(0.95);

    const doomed = resolveSquadEngagement(
      { squad: [{ id: 'd1', name: 'Greenhorn', skill: 1 }], vehicles: [], zoneDifficulty: 10, assignment: 'raid', basePayout: 100 },
      seq(0.0),
    );
    expect(doomed.breakdown.successChance).toBeGreaterThanOrEqual(0.05);
  });
});
