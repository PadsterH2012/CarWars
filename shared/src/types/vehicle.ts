// Standard 6-surface armor locations (cars, trucks, vans)
export type StandardSurface = 'front' | 'back' | 'left' | 'right' | 'top' | 'underbody';

// Trailer/bus 10-position armor — sides, top, underbody each split front/back half
export type TrailerSurface =
  | 'front_front' | 'front_back'
  | 'right_front' | 'right_back'
  | 'left_front' | 'left_back'
  | 'top_front' | 'top_back'
  | 'underbody_front' | 'underbody_back';

// Combined type — cycles/trikes only use the first 4 StandardSurface values
export type ArmorLocation = StandardSurface | TrailerSurface;

export interface ArmorDistribution {
  front?: number;
  back?: number;
  left?: number;
  right?: number;
  top?: number;
  underbody?: number;
  front_front?: number;
  front_back?: number;
  right_front?: number;
  right_back?: number;
  left_front?: number;
  left_back?: number;
  top_front?: number;
  top_back?: number;
  underbody_front?: number;
  underbody_back?: number;
}

// New union types for vehicle design
export type BodyType =
  | 'subcompact' | 'compact' | 'mid_sized' | 'sedan' | 'luxury'
  | 'station_wagon' | 'pickup' | 'camper' | 'van'
  | 'light_cycle' | 'med_cycle' | 'hvy_cycle'
  | 'trike' | 'truck' | 'trailer' | 'bus';

export type ChassisType = 'light' | 'standard' | 'heavy' | 'extra_heavy';

export type SuspensionType = 'light' | 'standard' | 'improved' | 'heavy' | 'off_road';

export type TireType = 'standard' | 'heavy_duty' | 'puncture_resistant' | 'solid' | 'plasticore';

export type ArmorType = 'ablative' | 'fireproof' | 'laser_reflective' | 'lr_fireproof' | 'metal' | 'radarproof';

export type PowerPlantType = 'small' | 'medium' | 'large' | 'super' | 'sport' | 'thundercat';

export type TurretSize = 'small' | 'standard' | 'heavy';

export interface WeaponMount {
  id: string;
  arc: 'front' | 'back' | 'left' | 'right' | 'turret';
  weaponId: string | null;
  ammo: number;
  // Required when arc === 'turret' — absent/undefined for fixed-arc mounts.
  // Determines the turret structure's own cost, weight, and space footprint
  // as well as the maximum weapon size it can hold.
  turretSize?: TurretSize;
  // Optional weapon-link tag. Mounts sharing the same linkGroup id fire as
  // one action with one to-hit roll (Compendium "linked weapons" rule).
  linkGroup?: string;
}

// One installed accessory on a vehicle. The id references a static catalog
// entry (server/src/rules/data/accessories.ts) where cost / spaces / weight /
// effects live. Optional `boundMountId` lets per-weapon accessories (Single
// Weapon Computer, Targeting Laser) bind to a specific mount.
export interface AccessoryConfig {
  id: string;
  boundMountId?: string;
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
  hasRamplate?: boolean;  // when true, vehicle can push pushable wreckage aside on collision
  // Rigid sidecar attachment — only valid on medium/heavy cycles per the
  // Compendium. Adds bonus spaces + load + a third wheel, and lets the cycle
  // host side-mounted weapons at the cost of some maneuverability.
  hasSidecar?: boolean;
  // Installed accessories (computers, brakes, autopilot, etc.).
  accessories?: AccessoryConfig[];
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
