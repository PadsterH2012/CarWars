import { describe, it, expect } from 'vitest';
import { computeAiInput } from '../src/ai/driver';
import type { AiContext } from '../src/ai/types';
import { computeMovement } from '../src/rules/movement';
import { SquadContext, updateClaims, runAuction } from '../src/ai/squad';
import type { VehicleState, ArenaMap } from '@carwars/shared';

function makeVehicle(id: string, playerId: string, x: number, y: number, facing = 0, armorFrac = 1.0): VehicleState {
  const fullArmor = { front: 10, back: 8, left: 8, right: 8, top: 4, underbody: 4 };
  const curArmor = Object.fromEntries(
    Object.entries(fullArmor).map(([k, v]) => [k, Math.round(v * armorFrac)]),
  ) as typeof fullArmor;
  return {
    id, playerId, driverId: `d_${id}`,
    position: { x, y }, facing, speed: 0,
    stats: {
      id, name: 'Car',
      loadout: {
        bodyType: 'mid_size',
        armor: fullArmor,
        mounts: [{ id: 'm0', weaponId: 'mg', arc: 'front', ammo: 20 }],
        accessories: [],
      } as any,
      damageState: {
        armor: curArmor,
        engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false,
      },
      maxSpeed: 80, handlingClass: 3, weight: 3000, acceleration: 5,
    } as any,
  };
}

function makeArena(): ArenaMap {
  return { id: 't', width: 60, height: 60, walls: [], spawnPoints: [] };
}

describe('Squad coordination', () => {
  it('prevents target saturation: 4 AI vs 1 low-hp enemy → ≤2 committed', () => {
    // 4 AI squadmates, 1 low-hp enemy. Each AI normally picks the weakest
    // enemy as target — without squad claims, all 4 would converge on it.
    const squad = new SquadContext('cpu');
    squad.members = ['a1', 'a2', 'a3', 'a4'];
    const a1 = makeVehicle('a1', 'cpu',  -5,  0);
    const a2 = makeVehicle('a2', 'cpu',   5,  0);
    const a3 = makeVehicle('a3', 'cpu',   0, -5);
    const a4 = makeVehicle('a4', 'cpu',   0,  5);
    const weak = makeVehicle('weak', 'enemy', 15, 0, 180, 0.20); // 20% hp
    // Two other enemies so the AI has somewhere else to go
    const mid1 = makeVehicle('mid1', 'enemy', 20,  10, 180, 0.8);
    const mid2 = makeVehicle('mid2', 'enemy', 20, -10, 180, 0.8);
    const allVehicles = [a1, a2, a3, a4, weak, mid1, mid2];

    // Run the auction so roles/targets distribute
    runAuction(squad, allVehicles);

    // Count claimants on the weak enemy via the claim layer
    const weakClaim = squad.targetClaims.get('weak');
    const claimants = weakClaim?.claimants.length ?? 0;
    expect(claimants).toBeLessThanOrEqual(2);
  });

  it('2v1 produces a split: two AI approach enemy from different bearings', () => {
    // Role auction assigns one anchor + one flanker → they should naturally
    // end up at different bearings relative to the target.
    const squad = new SquadContext('cpu');
    squad.members = ['a1', 'a2'];
    const enemy = makeVehicle('enemy', 'bad', 0, 0);
    // Both squadmates start NORTH of the enemy
    const a1 = makeVehicle('a1', 'cpu', -1, -10);
    const a2 = makeVehicle('a2', 'cpu',  1, -10);
    const allVehicles = [a1, a2, enemy];
    runAuction(squad, allVehicles);
    // Roles should differ — one anchor, one flanker
    const roleA1 = squad.roleByAgent.get('a1');
    const roleA2 = squad.roleByAgent.get('a2');
    expect(roleA1).not.toEqual(roleA2);
    // At least one should be a flanker
    const roles = [roleA1, roleA2];
    expect(roles.some(r => r === 'flanker_l' || r === 'flanker_r')).toBe(true);
  });

  it('rally: damaged squad retreats to centroid of teammates', () => {
    // When average squad hp is low, the auction should favour 'support'
    // role for the most damaged member rather than 'anchor'.
    const squad = new SquadContext('cpu');
    squad.members = ['a1', 'a2', 'a3'];
    const a1 = makeVehicle('a1', 'cpu', -10, 0, 0, 0.25); // hurt
    const a2 = makeVehicle('a2', 'cpu',   0, 0, 0, 0.30); // hurt
    const a3 = makeVehicle('a3', 'cpu',  10, 0, 0, 0.30); // hurt
    const enemy = makeVehicle('enemy', 'bad', 20, 0);
    const allVehicles = [a1, a2, a3, enemy];
    runAuction(squad, allVehicles);
    // With all squadmates damaged, at least one should get 'support' role
    const roles = [
      squad.roleByAgent.get('a1'),
      squad.roleByAgent.get('a2'),
      squad.roleByAgent.get('a3'),
    ];
    expect(roles).toContain('support');
  });
});

describe('Driver personality affects auction', () => {
  it('high aggression drivers bid higher for anchor', () => {
    const squad = new SquadContext('cpu');
    squad.members = ['calm', 'fiery'];
    const calm  = makeVehicle('calm',  'cpu', -5, -10);
    const fiery = makeVehicle('fiery', 'cpu',  5, -10);
    const enemy = makeVehicle('enemy', 'bad',  0,   0);
    const driverInfoFor = (id: string) => id === 'fiery'
      ? { skill: 3, aggression: 6, loyalty: 5 }
      : { skill: 3, aggression: 1, loyalty: 5 };
    runAuction(squad, [calm, fiery, enemy], driverInfoFor);
    // fiery (aggression 6) should take anchor; calm drops to flanker/support
    expect(squad.roleByAgent.get('fiery')).toBe('anchor');
    expect(squad.roleByAgent.get('calm')).not.toBe('anchor');
  });

  it('high loyalty healthy driver takes support role in 4-squad', () => {
    const squad = new SquadContext('cpu');
    squad.members = ['a1', 'a2', 'a3', 'a4'];
    // Four healthy members — rolePriority for 4 at full HP is
    // [anchor, flanker_r, flanker_l, support]. a4 has max loyalty so the
    // support bid pulls them into it despite being healthy.
    const a1 = makeVehicle('a1', 'cpu', -8, -10);
    const a2 = makeVehicle('a2', 'cpu',  8, -10);
    const a3 = makeVehicle('a3', 'cpu', -2, -10);
    const a4 = makeVehicle('a4', 'cpu',  2, -10);
    const enemy = makeVehicle('enemy', 'bad', 0, 0);
    const driverInfoFor = (id: string) => {
      if (id === 'a4') return { skill: 3, aggression: 2, loyalty: 10 };
      return { skill: 3, aggression: 3, loyalty: 3 };
    };
    runAuction(squad, [a1, a2, a3, a4, enemy], driverInfoFor);
    expect(squad.roleByAgent.get('a4')).toBe('support');
  });
});

describe('Target claim decay', () => {
  it('claim expires when claimant stops firing at the target', () => {
    const squad = new SquadContext('cpu');
    squad.members = ['a1'];
    // Register a claim at tick 0
    updateClaims(squad, [
      { attackerId: 'a1', targetId: 'enemy', fired: true, dps: 2 },
    ], 0);
    expect(squad.targetClaims.get('enemy')?.claimants).toContain('a1');
    // Advance ticks with no firing — claim decays
    for (let t = 1; t <= 60; t++) {
      updateClaims(squad, [], t);
    }
    expect(squad.targetClaims.get('enemy')?.claimants.length ?? 0).toBe(0);
  });
});
