import type { ArmorLocation } from './vehicle';

export interface WeaponDef {
  id: string;
  name: string;
  damage: number;
  rof: number;
  shortRange: number;
  longRange: number;
  space: number;
  weight: number;
  cost: number;
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
