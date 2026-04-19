import type { TurretSize } from '@carwars/shared';

export interface TurretDef {
  id: TurretSize;
  name: string;
  cost: number;
  weight: number;          // lbs — chassis structure weight, excl. weapon
  spaces: number;          // spaces consumed by the turret ring itself
  maxWeaponSpaces: number; // largest weapon the turret can hold
}

// Compendium-inspired turret tiers. One weapon per turret; weapon must fit in
// maxWeaponSpaces. Cycles can't mount any turret; trikes only small; cars
// standard; vans and larger up to heavy.
export const TURRETS: TurretDef[] = [
  { id: 'small',    name: 'Small Turret',    cost: 500,  weight: 100, spaces: 1, maxWeaponSpaces: 2 },
  { id: 'standard', name: 'Standard Turret', cost: 1000, weight: 200, spaces: 2, maxWeaponSpaces: 3 },
  { id: 'heavy',    name: 'Heavy Turret',    cost: 2000, weight: 400, spaces: 3, maxWeaponSpaces: 4 },
];

// How big a turret each body type can physically support. 0 means no turret
// at all.
export const TURRET_TIER_RANK: Record<TurretSize, number> = {
  small: 1, standard: 2, heavy: 3,
};
