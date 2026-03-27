export type ArmorLocation = 'front' | 'back' | 'left' | 'right' | 'top' | 'underbody';

export interface ArmorDistribution {
  front: number;
  back: number;
  left: number;
  right: number;
  top: number;
  underbody: number;
}

export interface WeaponMount {
  id: string;
  arc: 'front' | 'back' | 'left' | 'right' | 'turret';
  weaponId: string | null;
  ammo: number;
}

export interface VehicleLoadout {
  chassisId: string;
  engineId: string;
  suspensionId: string;
  tires: { id: string; blown: boolean }[];
  mounts: WeaponMount[];
  armor: ArmorDistribution;
  totalCost: number;
}

export interface DamageState {
  armor: Partial<ArmorDistribution>;
  engineDamaged: boolean;
  driverWounded: boolean;
  tiresBlown: number[];
}

export interface VehicleStats {
  id: string;
  name: string;
  loadout: VehicleLoadout;
  damageState: DamageState;
  maxSpeed: number;
  handlingClass: number;
  weight: number;
}
