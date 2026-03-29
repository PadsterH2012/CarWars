export type ArcType = 'front' | 'back' | 'left' | 'right' | 'turret';

export interface MountConfig {
  id: string;
  arc: ArcType;
  weaponId: string | null;
  ammo: number;
}

export const BODY_TYPES = [
  { id: 'subcompact',    label: 'Subcompact', isCycle: false },
  { id: 'compact',       label: 'Compact',    isCycle: false },
  { id: 'mid_sized',     label: 'Mid-Sized',  isCycle: false },
  { id: 'sedan',         label: 'Sedan',      isCycle: false },
  { id: 'luxury',        label: 'Luxury',     isCycle: false },
  { id: 'station_wagon', label: 'Stn Wagon',  isCycle: false },
  { id: 'pickup',        label: 'Pickup',     isCycle: false },
  { id: 'camper',        label: 'Camper',     isCycle: false },
  { id: 'van',           label: 'Van',        isCycle: false },
  { id: 'light_cycle',   label: 'Lt Cycle',   isCycle: true  },
  { id: 'med_cycle',     label: 'Md Cycle',   isCycle: true  },
  { id: 'hvy_cycle',     label: 'Hvy Cycle',  isCycle: true  },
  { id: 'trike',         label: 'Trike',      isCycle: true  },
  { id: 'truck',         label: 'Truck',      isCycle: false },
  { id: 'trailer',       label: 'Trailer',    isCycle: false },
] as const;

export const POWER_PLANTS = [
  // Electric — cars/vans/trucks
  { id: 'elec_small',      label: 'Elec Sm',      cycleOnly: false },
  { id: 'elec_medium',     label: 'Elec Md',      cycleOnly: false },
  { id: 'elec_large',      label: 'Elec Lg',      cycleOnly: false },
  { id: 'elec_super',      label: 'Elec Super',   cycleOnly: false },
  { id: 'elec_sport',      label: 'Elec Sport',   cycleOnly: false },
  { id: 'elec_thundercat', label: 'Thundercat',   cycleOnly: false },
  // Gas — cars/vans/trucks
  { id: 'gas_small',       label: 'Gas Sm',       cycleOnly: false },
  { id: 'gas_medium',      label: 'Gas Md',       cycleOnly: false },
  { id: 'gas_large',       label: 'Gas Lg',       cycleOnly: false },
  { id: 'gas_super',       label: 'Gas Super',    cycleOnly: false },
  // Electric — cycles/trikes
  { id: 'cyc_elec_small',  label: 'Cyc Elec Sm', cycleOnly: true },
  { id: 'cyc_elec_medium', label: 'Cyc Elec Md', cycleOnly: true },
  { id: 'cyc_elec_large',  label: 'Cyc Elec Lg', cycleOnly: true },
  // Gas — cycles/trikes
  { id: 'cyc_gas_small',   label: 'Cyc Gas Sm',  cycleOnly: true },
  { id: 'cyc_gas_medium',  label: 'Cyc Gas Md',  cycleOnly: true },
  { id: 'cyc_gas_large',   label: 'Cyc Gas Lg',  cycleOnly: true },
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
