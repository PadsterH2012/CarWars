import type { WeaponDef } from '@carwars/shared';

export const WEAPONS: WeaponDef[] = [
  // ── Small-bore projectile ──────────────────────────────────────────────
  {
    id: 'mg', name: 'Machine Gun', category: 'small_bore',
    toHit: 7, damageDice: 1, damageMod: 0, damage: 1,
    dp: 3, spaces: 1, weight: 150, cost: 1000, shotsPerMag: 20, ammoWeight: 2.5, ammoCost: 25,
    shortRange: 6, longRange: 12, burstEffect: false, areaEffect: true, powerDrain: 0, allowedArcs: [],
  },
  {
    id: 'vmg', name: 'Vulcan Machine Gun', category: 'small_bore',
    toHit: 6, damageDice: 2, damageMod: 0, damage: 2,
    dp: 3, spaces: 2, weight: 300, cost: 2000, shotsPerMag: 20, ammoWeight: 5, ammoCost: 35,
    shortRange: 6, longRange: 12, burstEffect: false, areaEffect: true, powerDrain: 0, allowedArcs: [],
  },
  {
    id: 'ac', name: 'Autocannon', category: 'small_bore',
    toHit: 6, damageDice: 3, damageMod: 0, damage: 3,
    dp: 4, spaces: 3, weight: 500, cost: 6500, shotsPerMag: 10, ammoWeight: 10, ammoCost: 75,
    shortRange: 8, longRange: 16, burstEffect: true, areaEffect: false, powerDrain: 0, allowedArcs: [],
  },
  {
    id: 'rr', name: 'Recoilless Rifle', category: 'small_bore',
    toHit: 7, damageDice: 2, damageMod: 0, damage: 2,
    dp: 4, spaces: 2, weight: 300, cost: 1500, shotsPerMag: 10, ammoWeight: 5, ammoCost: 35,
    shortRange: 8, longRange: 16, burstEffect: true, areaEffect: false, powerDrain: 0, allowedArcs: [],
  },
  // ── Large-bore projectile ──────────────────────────────────────────────
  {
    id: 'gl', name: 'Grenade Launcher', category: 'large_bore',
    toHit: 7, damageDice: 1, damageMod: 2, damage: 2,
    dp: 2, spaces: 2, weight: 200, cost: 1000, shotsPerMag: 10, ammoWeight: 4, ammoCost: 0,  // grenades: cost included in weapon base price
    shortRange: 4, longRange: 8, burstEffect: false, areaEffect: false, powerDrain: 0, allowedArcs: [],
  },
  {
    id: 'atg', name: 'Anti-Tank Gun', category: 'large_bore',
    toHit: 8, damageDice: 3, damageMod: 0, damage: 3,
    dp: 5, spaces: 3, weight: 600, cost: 2000, shotsPerMag: 10, ammoWeight: 10, ammoCost: 50,
    shortRange: 10, longRange: 20, burstEffect: true, areaEffect: false, powerDrain: 0,
    allowedArcs: ['front', 'back'],
  },
  {
    id: 'bc', name: 'Blast Cannon', category: 'large_bore',
    toHit: 7, damageDice: 4, damageMod: 0, damage: 4,
    dp: 5, spaces: 4, weight: 500, cost: 4500, shotsPerMag: 10, ammoWeight: 10, ammoCost: 100,
    shortRange: 8, longRange: 16, burstEffect: true, areaEffect: false, powerDrain: 0, allowedArcs: [],
  },
  // ── Rockets ───────────────────────────────────────────────────────────
  {
    id: 'ltr', name: 'Light Rocket', category: 'rocket',
    toHit: 9, damageDice: 1, damageMod: 0, damage: 1,
    dp: 1, spaces: 1, weight: 25, cost: 75, shotsPerMag: 1, ammoWeight: 0, ammoCost: 75,
    shortRange: 4, longRange: 8, burstEffect: true, areaEffect: false, powerDrain: 0, allowedArcs: [],
  },
  {
    id: 'mr', name: 'Medium Rocket', category: 'rocket',
    toHit: 9, damageDice: 2, damageMod: 0, damage: 2,
    dp: 2, spaces: 1, weight: 50, cost: 140, shotsPerMag: 1, ammoWeight: 0, ammoCost: 140,
    shortRange: 6, longRange: 12, burstEffect: true, areaEffect: false, powerDrain: 0, allowedArcs: [],
  },
  {
    id: 'hr', name: 'Heavy Rocket', category: 'rocket',
    toHit: 9, damageDice: 3, damageMod: 0, damage: 3,
    dp: 2, spaces: 1, weight: 100, cost: 200, shotsPerMag: 1, ammoWeight: 0, ammoCost: 200,
    shortRange: 8, longRange: 16, burstEffect: true, areaEffect: false, powerDrain: 0, allowedArcs: [],
  },
  {
    id: 'rl', name: 'Rocket Launcher', category: 'rocket',
    toHit: 8, damageDice: 2, damageMod: 0, damage: 2,
    dp: 2, spaces: 2, weight: 200, cost: 1000, shotsPerMag: 10, ammoWeight: 5, ammoCost: 35,
    shortRange: 8, longRange: 16, burstEffect: true, areaEffect: false, powerDrain: 0, allowedArcs: [],
  },
  {
    id: 'mml', name: 'Micromissile Launcher', category: 'rocket',
    toHit: 8, damageDice: 1, damageMod: 0, damage: 1,
    dp: 2, spaces: 1, weight: 100, cost: 750, shotsPerMag: 10, ammoWeight: 2.5, ammoCost: 20,
    shortRange: 6, longRange: 12, burstEffect: true, areaEffect: false, powerDrain: 0, allowedArcs: [],
  },
  // ── Lasers ────────────────────────────────────────────────────────────
  {
    id: 'll', name: 'Light Laser', category: 'laser',
    toHit: 6, damageDice: 1, damageMod: 0, damage: 1,
    dp: 2, spaces: 1, weight: 200, cost: 3000, shotsPerMag: 999,  // sentinel: power-limited, not ammo-limited
    ammoWeight: 0, ammoCost: 0,
    shortRange: 8, longRange: 16, burstEffect: false, areaEffect: true, powerDrain: 1, allowedArcs: [],
  },
  {
    id: 'ml', name: 'Medium Laser', category: 'laser',
    toHit: 6, damageDice: 2, damageMod: 0, damage: 2,
    dp: 2, spaces: 2, weight: 350, cost: 5500, shotsPerMag: 999,  // sentinel: power-limited, not ammo-limited
    ammoWeight: 0, ammoCost: 0,
    shortRange: 10, longRange: 20, burstEffect: false, areaEffect: true, powerDrain: 2, allowedArcs: [],
  },
  {
    id: 'l', name: 'Laser', category: 'laser',
    toHit: 6, damageDice: 3, damageMod: 0, damage: 3,
    dp: 2, spaces: 2, weight: 500, cost: 8000, shotsPerMag: 999,  // sentinel: power-limited, not ammo-limited
    ammoWeight: 0, ammoCost: 0,
    shortRange: 10, longRange: 20, burstEffect: false, areaEffect: true, powerDrain: 2, allowedArcs: [],
  },
  {
    id: 'hl', name: 'Heavy Laser', category: 'laser',
    toHit: 6, damageDice: 4, damageMod: 0, damage: 4,
    dp: 2, spaces: 3, weight: 1000, cost: 12000, shotsPerMag: 999,  // sentinel: power-limited, not ammo-limited
    ammoWeight: 0, ammoCost: 0,
    shortRange: 12, longRange: 24, burstEffect: false, areaEffect: true, powerDrain: 3, allowedArcs: [],
  },
  // ── Flamers ───────────────────────────────────────────────────────────
  {
    id: 'lft', name: 'Light Flamethrower', category: 'flamer',
    toHit: 6, damageDice: 1, damageMod: -2, damage: 1,
    dp: 1, spaces: 1, weight: 250, cost: 350, shotsPerMag: 10, ammoWeight: 3, ammoCost: 15,
    shortRange: 3, longRange: 5, burstEffect: false, areaEffect: true, powerDrain: 0, allowedArcs: [],
  },
  {
    id: 'ft', name: 'Flamethrower', category: 'flamer',
    toHit: 6, damageDice: 1, damageMod: 0, damage: 1,
    dp: 2, spaces: 2, weight: 450, cost: 500, shotsPerMag: 10, ammoWeight: 5, ammoCost: 25,
    shortRange: 5, longRange: 10, burstEffect: false, areaEffect: true, powerDrain: 0, allowedArcs: [],
    special: 'fire',
  },
  // ── Dropped ───────────────────────────────────────────────────────────
  {
    id: 'sd', name: 'Spikedropper', category: 'dropped',
    toHit: 0, damageDice: 1, damageMod: 0, damage: 1,
    dp: 4, spaces: 1, weight: 25, cost: 100, shotsPerMag: 10, ammoWeight: 5, ammoCost: 20,
    shortRange: 1, longRange: 1, burstEffect: false, areaEffect: false, powerDrain: 0,
    allowedArcs: ['back'], special: 'dropped',
  },
  {
    id: 'oj', name: 'Oil Jet', category: 'dropped',
    toHit: 0, damageDice: 0, damageMod: 0, damage: 0,
    dp: 3, spaces: 2, weight: 25, cost: 250, shotsPerMag: 25, ammoWeight: 2, ammoCost: 10,
    shortRange: 1, longRange: 1, burstEffect: false, areaEffect: false, powerDrain: 0,
    allowedArcs: ['back'], special: 'dropped',
  },
  // Legacy aliases (keep old IDs working in existing test vehicles)
  {
    id: 'hmg', name: 'Heavy MG', category: 'small_bore',
    toHit: 6, damageDice: 2, damageMod: 0, damage: 2,
    dp: 3, spaces: 2, weight: 400, cost: 3000, shotsPerMag: 20, ammoWeight: 5, ammoCost: 35,
    shortRange: 6, longRange: 12, burstEffect: false, areaEffect: true, powerDrain: 0, allowedArcs: [],
  },
  {
    id: 'laser', name: 'Laser (legacy)', category: 'laser',
    toHit: 6, damageDice: 2, damageMod: 0, damage: 2,
    dp: 2, spaces: 2, weight: 400, cost: 6000, shotsPerMag: 999, ammoWeight: 0, ammoCost: 0,
    shortRange: 10, longRange: 25, burstEffect: false, areaEffect: true, powerDrain: 2, allowedArcs: [],
  },
  {
    id: 'oil', name: 'Oil Slick', category: 'dropped',
    toHit: 0, damageDice: 0, damageMod: 0, damage: 0,
    dp: 1, spaces: 1, weight: 100, cost: 500, shotsPerMag: 1, ammoWeight: 0, ammoCost: 0,
    shortRange: 1, longRange: 1, burstEffect: false, areaEffect: false, powerDrain: 0,
    allowedArcs: ['back'], special: 'dropped',
  },
  {
    id: 'mine', name: 'Mine', category: 'dropped',
    toHit: 0, damageDice: 3, damageMod: 0, damage: 3,
    dp: 1, spaces: 1, weight: 100, cost: 750, shotsPerMag: 1, ammoWeight: 0, ammoCost: 0,
    shortRange: 1, longRange: 1, burstEffect: false, areaEffect: false, powerDrain: 0,
    allowedArcs: ['back'], special: 'dropped',
  },
];
