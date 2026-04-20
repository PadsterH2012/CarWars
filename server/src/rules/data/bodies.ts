import type { ArmorLocation, TurretSize } from '@carwars/shared';

const CAR_SURFACES: ArmorLocation[] = ['front', 'back', 'left', 'right', 'top', 'underbody'];
const CYCLE_SURFACES: ArmorLocation[] = ['front', 'back', 'left', 'right'];
const TRAILER_SURFACES: ArmorLocation[] = [
  'front_front', 'front_back',
  'right_front', 'right_back',
  'left_front', 'left_back',
  'top_front', 'top_back',
  'underbody_front', 'underbody_back',
];

export interface BodyDef {
  id: string;
  name: string;
  price: number;
  baseWeight: number;
  maxLoad: number;
  spaces: number;
  armorCostPerPt: number;
  armorWtPerPt: number;
  baseHC: number;
  isCycle: boolean;
  tireCount?: number; // overrides default (2 for cycles, 4 for others) when set
  // Largest turret this chassis can physically accommodate. null = no turret
  // at all (cycles); 'small' for trikes / subcompacts; 'standard' for normal
  // cars; 'heavy' for vans, pickups, campers, trucks, trailers.
  maxTurretSize: TurretSize | null;
  surfaces: ArmorLocation[];
}

export const BODIES: BodyDef[] = [
  // Cars
  { id: 'subcompact',    name: 'Subcompact',    price: 300,  baseWeight: 1000, maxLoad: 2300,  spaces: 7,  armorCostPerPt: 11, armorWtPerPt: 5,  baseHC: 4, isCycle: false, maxTurretSize: 'small',    surfaces: CAR_SURFACES },
  { id: 'compact',       name: 'Compact',       price: 400,  baseWeight: 1300, maxLoad: 3700,  spaces: 10, armorCostPerPt: 13, armorWtPerPt: 6,  baseHC: 3, isCycle: false, maxTurretSize: 'standard', surfaces: CAR_SURFACES },
  { id: 'mid_sized',     name: 'Mid-Sized',     price: 600,  baseWeight: 1600, maxLoad: 4800,  spaces: 13, armorCostPerPt: 16, armorWtPerPt: 8,  baseHC: 3, isCycle: false, maxTurretSize: 'standard', surfaces: CAR_SURFACES },
  { id: 'sedan',         name: 'Sedan',         price: 700,  baseWeight: 1700, maxLoad: 5100,  spaces: 16, armorCostPerPt: 18, armorWtPerPt: 9,  baseHC: 3, isCycle: false, maxTurretSize: 'standard', surfaces: CAR_SURFACES },
  { id: 'luxury',        name: 'Luxury',        price: 800,  baseWeight: 1800, maxLoad: 5500,  spaces: 19, armorCostPerPt: 20, armorWtPerPt: 10, baseHC: 3, isCycle: false, maxTurretSize: 'standard', surfaces: CAR_SURFACES },
  { id: 'station_wagon', name: 'Station Wagon', price: 800,  baseWeight: 1800, maxLoad: 5500,  spaces: 14, armorCostPerPt: 20, armorWtPerPt: 10, baseHC: 3, isCycle: false, maxTurretSize: 'standard', surfaces: CAR_SURFACES },
  { id: 'pickup',        name: 'Pickup',        price: 900,  baseWeight: 2100, maxLoad: 6500,  spaces: 13, armorCostPerPt: 22, armorWtPerPt: 11, baseHC: 2, isCycle: false, maxTurretSize: 'heavy',    surfaces: CAR_SURFACES },
  { id: 'camper',        name: 'Camper',        price: 1400, baseWeight: 2300, maxLoad: 6500,  spaces: 17, armorCostPerPt: 30, armorWtPerPt: 14, baseHC: 2, isCycle: false, maxTurretSize: 'heavy',    surfaces: CAR_SURFACES },
  { id: 'van',           name: 'Van',           price: 1000, baseWeight: 2000, maxLoad: 6000,  spaces: 24, armorCostPerPt: 30, armorWtPerPt: 14, baseHC: 2, isCycle: false, maxTurretSize: 'heavy',    surfaces: CAR_SURFACES },
  // Cycles — no turret at all
  { id: 'light_cycle',   name: 'Light Cycle',   price: 200,  baseWeight: 250,  maxLoad: 800,   spaces: 4,  armorCostPerPt: 10, armorWtPerPt: 4,  baseHC: 4, isCycle: true,  maxTurretSize: null, surfaces: CYCLE_SURFACES },
  { id: 'med_cycle',     name: 'Med. Cycle',    price: 300,  baseWeight: 300,  maxLoad: 1100,  spaces: 5,  armorCostPerPt: 11, armorWtPerPt: 5,  baseHC: 4, isCycle: true,  maxTurretSize: null, surfaces: CYCLE_SURFACES },
  { id: 'hvy_cycle',     name: 'Hvy. Cycle',    price: 400,  baseWeight: 350,  maxLoad: 1300,  spaces: 7,  armorCostPerPt: 12, armorWtPerPt: 6,  baseHC: 4, isCycle: true,  maxTurretSize: null, surfaces: CYCLE_SURFACES },
  // Trike (3-wheeled cycle — uses subHC but has 3 tires) — small turret only
  { id: 'trike',         name: 'Trike',         price: 350,  baseWeight: 500,  maxLoad: 1600,  spaces: 6,  armorCostPerPt: 11, armorWtPerPt: 5,  baseHC: 3, isCycle: true,  tireCount: 3, maxTurretSize: 'small', surfaces: CYCLE_SURFACES },
  // Heavy vehicles
  // Truck — bumped from the strict tractor-cab numbers (10 spaces / 8000 lb)
  // so it can actually build the Compendium sample trucks (Wolverine, Economy)
  // and so it's visibly bigger than a pickup/van at a glance. If we later
  // want a tight tractor for trailer-towing we can split this into Tractor +
  // Heavy Truck variants.
  { id: 'truck',         name: 'Truck',         price: 1500, baseWeight: 3000, maxLoad: 12000, spaces: 20, armorCostPerPt: 35, armorWtPerPt: 16, baseHC: 1, isCycle: false, maxTurretSize: 'heavy',    surfaces: CAR_SURFACES },
  { id: 'trailer',       name: 'Trailer',       price: 500,  baseWeight: 1500, maxLoad: 14000, spaces: 30, armorCostPerPt: 25, armorWtPerPt: 12, baseHC: 1, isCycle: false, maxTurretSize: 'heavy',    surfaces: TRAILER_SURFACES },
  // Bus — 40' passenger coach (Busnought reference): 10 tires, heavy turrets,
  // tonnes of space and load for passengers + gunners.
  { id: 'bus',           name: 'Bus',           price: 3000, baseWeight: 5000, maxLoad: 18000, spaces: 25, armorCostPerPt: 35, armorWtPerPt: 18, baseHC: 1, isCycle: false, tireCount: 10, maxTurretSize: 'heavy', surfaces: CAR_SURFACES },
];
