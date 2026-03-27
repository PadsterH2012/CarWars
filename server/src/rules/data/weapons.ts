import type { WeaponDef } from '@carwars/shared';

export const WEAPONS: WeaponDef[] = [
  { id: 'mg',    name: 'Machine Gun',  damage: 1, rof: 5, shortRange: 6,  longRange: 12, space: 1, weight: 200, cost: 1000 },
  { id: 'hmg',   name: 'Heavy MG',    damage: 2, rof: 3, shortRange: 6,  longRange: 12, space: 2, weight: 400, cost: 3000 },
  { id: 'rl',    name: 'Rocket Laser',damage: 3, rof: 1, shortRange: 8,  longRange: 16, space: 2, weight: 300, cost: 4000 },
  { id: 'laser', name: 'Laser',       damage: 2, rof: 1, shortRange: 10, longRange: 25, space: 2, weight: 400, cost: 6000 },
  { id: 'oil',   name: 'Oil Slick',   damage: 0, rof: 1, shortRange: 1,  longRange: 1,  space: 1, weight: 100, cost: 500,  special: 'dropped' },
  { id: 'mine',  name: 'Mine',        damage: 3, rof: 1, shortRange: 1,  longRange: 1,  space: 1, weight: 100, cost: 750,  special: 'dropped' },
];
