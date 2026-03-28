export type ArcType = 'front' | 'back' | 'left' | 'right' | 'turret';

export interface MountConfig {
  id: string;
  arc: ArcType;
  weaponId: string | null;
  ammo: number;
}

export const BODY_TYPES = [
  { id: 'subcompact',    label: 'Subcompact' },
  { id: 'compact',       label: 'Compact' },
  { id: 'mid_sized',     label: 'Mid-Sized' },
  { id: 'sedan',         label: 'Sedan' },
  { id: 'luxury',        label: 'Luxury' },
  { id: 'station_wagon', label: 'Stn Wagon' },
  { id: 'pickup',        label: 'Pickup' },
  { id: 'camper',        label: 'Camper' },
  { id: 'van',           label: 'Van' },
  { id: 'light_cycle',   label: 'Lt Cycle' },
  { id: 'med_cycle',     label: 'Md Cycle' },
  { id: 'hvy_cycle',     label: 'Hvy Cycle' },
] as const;

export const POWER_PLANTS = [
  { id: 'small',      label: 'Small' },
  { id: 'medium',     label: 'Medium' },
  { id: 'large',      label: 'Large' },
  { id: 'super',      label: 'Super' },
  { id: 'sport',      label: 'Sport' },
  { id: 'thundercat', label: 'Thundercat' },
] as const;

export const SUSPENSIONS = [
  { id: 'light',     label: 'Light' },
  { id: 'standard',  label: 'Standard' },
  { id: 'improved',  label: 'Improved' },
  { id: 'heavy',     label: 'Heavy' },
  { id: 'off_road',  label: 'Off-Road' },
] as const;

export const TIRE_TYPES = [
  { id: 'standard',            label: 'Standard' },
  { id: 'heavy_duty',          label: 'Heavy Duty' },
  { id: 'puncture_resistant',  label: 'PR' },
  { id: 'solid',               label: 'Solid' },
  { id: 'plasticore',          label: 'Plasticore' },
] as const;

export const ARMOR_TYPES = [
  { id: 'ablative',         label: 'Ablative' },
  { id: 'fireproof',        label: 'Fireproof' },
  { id: 'laser_reflective', label: 'Laser Refl.' },
  { id: 'lr_fireproof',     label: 'LR+FP' },
  { id: 'metal',            label: 'Metal' },
  { id: 'radarproof',       label: 'Radarproof' },
] as const;

export const WEAPONS = [
  { id: 'mg',  label: 'MG',           category: 'small_bore' },
  { id: 'vmg', label: 'VMG',          category: 'small_bore' },
  { id: 'ac',  label: 'Autocannon',   category: 'small_bore' },
  { id: 'rr',  label: 'RR',           category: 'small_bore' },
  { id: 'gl',  label: 'GL',           category: 'large_bore' },
  { id: 'atg', label: 'ATG',          category: 'large_bore' },
  { id: 'bc',  label: 'Blast Cannon', category: 'large_bore' },
  { id: 'ltr', label: 'Lt Rocket',    category: 'rocket' },
  { id: 'mr',  label: 'Md Rocket',    category: 'rocket' },
  { id: 'hr',  label: 'Hvy Rocket',   category: 'rocket' },
  { id: 'rl',  label: 'Rocket Lnchr', category: 'rocket' },
  { id: 'mml', label: 'Micromissile', category: 'rocket' },
  { id: 'll',  label: 'Lt Laser',     category: 'laser' },
  { id: 'ml',  label: 'Md Laser',     category: 'laser' },
  { id: 'l',   label: 'Laser',        category: 'laser' },
  { id: 'hl',  label: 'Hvy Laser',    category: 'laser' },
  { id: 'lft', label: 'Lt Flamer',    category: 'flamer' },
  { id: 'ft',  label: 'Flamer',       category: 'flamer' },
  { id: 'sd',  label: 'Spikedropper', category: 'dropped' },
  { id: 'oj',  label: 'Oil Jet',      category: 'dropped' },
] as const;

export const ARCS: ArcType[] = ['front', 'back', 'left', 'right', 'turret'];
