import type { ArmorLocation } from './vehicle';

export type WeaponCategory = 'small_bore' | 'large_bore' | 'rocket' | 'laser' | 'flamer' | 'dropped';
export type ArcType = 'front' | 'back' | 'left' | 'right' | 'turret';

export interface WeaponDef {
  id: string;
  name: string;
  category: WeaponCategory;
  toHit: number;           // base target number (2d6 must meet or beat)
  damageDice: number;      // number of d6 to roll
  damageMod: number;       // flat modifier added to damage roll
  // Legacy flat damage field — kept for backward compat; for most weapons equals damageDice, for weapons with damageMod it equals damageDice + damageMod
  damage: number;
  dp: number;              // weapon DP before destroyed
  spaces: number;
  weight: number;          // lbs
  cost: number;
  shotsPerMag: number;
  ammoWeight: number;      // lbs per shot
  ammoCost: number;        // $ per shot
  shortRange: number;      // inches — no range modifier within this
  longRange: number;       // inches — +2 modifier beyond shortRange; impossible beyond
  burstEffect: boolean;
  areaEffect: boolean;
  powerDrain: number;      // power units per shot (0 for non-lasers)
  allowedArcs: ArcType[];  // arcs this weapon may be mounted in; empty array = unrestricted (any arc)
  special?: 'dropped' | 'area' | 'fire';
}

export interface ToHitResult {
  roll: number;
  modifier: number;
  hit: boolean;
  location: ArmorLocation;
}

export interface DamageResult {
  vehicleId: string;
  location: ArmorLocation;
  damageDealt: number;
  penetrated: boolean;
  effects: string[];
}
