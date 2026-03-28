export type ArmorLocation = 'front' | 'back' | 'left' | 'right' | 'top' | 'underbody';

export interface ArmorDistribution {
  front: number;
  back: number;
  left: number;
  right: number;
  top: number;
  underbody: number;
}

// New union types for vehicle design
export type BodyType =
  | 'subcompact' | 'compact' | 'mid_sized' | 'sedan' | 'luxury'
  | 'station_wagon' | 'pickup' | 'camper' | 'van'
  | 'light_cycle' | 'med_cycle' | 'hvy_cycle';

export type ChassisType = 'light' | 'standard' | 'heavy' | 'extra_heavy';

export type SuspensionType = 'light' | 'standard' | 'improved' | 'heavy' | 'off_road';

export type TireType = 'standard' | 'heavy_duty' | 'puncture_resistant' | 'solid' | 'plasticore';

export type ArmorType = 'ablative' | 'fireproof' | 'laser_reflective' | 'lr_fireproof' | 'metal' | 'radarproof';

export type PowerPlantType = 'small' | 'medium' | 'large' | 'super' | 'sport' | 'thundercat';

export interface WeaponMount {
  id: string;
  arc: 'front' | 'back' | 'left' | 'right' | 'turret';
  weaponId: string | null;
  ammo: number;
}

export interface VehicleLoadout {
  // Legacy fields — kept for backward compat with existing test vehicles
  chassisId: string;
  engineId: string;
  suspensionId: string;
  tires: { id: string; blown: boolean }[];
  mounts: WeaponMount[];
  armor: ArmorDistribution;
  totalCost: number;
  // New Compendium fields — all optional, deriveStats() uses defaults when absent
  bodyType?: BodyType;
  chassisType?: ChassisType;
  suspensionType?: SuspensionType;
  tireType?: TireType;
  armorType?: ArmorType;
  powerPlantType?: PowerPlantType;
}

export interface DamageState {
  armor: Partial<ArmorDistribution>;
  engineDamaged: boolean;
  driverWounded: boolean;
  tiresBlown: number[];
  destroyed: boolean;
  // New fields — optional with defaults in code
  onFire?: boolean;
  engineDP?: number;
  internalDamage?: string[];
}

export interface VehicleStats {
  id: string;
  name: string;
  loadout: VehicleLoadout;
  damageState: DamageState;
  maxSpeed: number;
  handlingClass: number;
  acceleration: number;   // mph per turn
  weight: number;
}
