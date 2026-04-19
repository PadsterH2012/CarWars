import type { VehicleStats, BodyType } from './vehicle';

export type ZoneType = 'highway' | 'town' | 'arena';

export interface ZoneMetadata {
  id: string;
  type: 'arena' | 'town' | 'highway';
  name: string;
  exits: { direction: 'north' | 'south' | 'east' | 'west'; destinationZoneId: string }[];
}

export interface Position {
  x: number;
  y: number;
}

export type WallType = 'wall' | 'building' | 'turret';

export interface Rect {
  x: number;       // center x in world units
  y: number;       // center y in world units
  w: number;       // width
  h: number;       // height
  type?: WallType; // for client rendering colour
}

export interface SpawnPoint {
  x: number;
  y: number;
  facing: number;
  team: 'player' | 'ai';
}

export interface ArenaMap {
  id: string;
  width: number;        // total world units (arena spans ±width/2)
  height: number;       // total world units (arena spans ±height/2)
  walls: Rect[];
  spawnPoints: SpawnPoint[];
}

export interface VehicleState {
  id: string;
  playerId: string;
  driverId: string;
  position: Position;
  facing: number;
  speed: number;
  stats: VehicleStats;
}

export interface HazardObject {
  id: string;
  type: 'oil' | 'mine';
  position: Position;
  ownerId: string;
}

export interface CombatEvent {
  attackerId: string;
  targetId: string;
  hit: boolean;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  weapon: string;
}

// A destroyed vehicle persists as wreckage — a collidable, optionally burning obstacle.
// State progresses over time (burning → smouldering → debris) but the object itself
// is never removed during gameplay.
export type WreckageState = 'burning' | 'smouldering' | 'debris';
export type WreckageCause = 'fire' | 'explosion' | 'kinetic' | 'energy' | 'collision';

export interface WreckageObject {
  id: string;
  sourceVehicleId: string;
  playerId: string;          // team identifier for salvage eligibility (winner doesn't salvage own wrecks)
  killedByVehicleId?: string; // which vehicle landed the killing blow — for per-driver XP attribution
  position: Position;
  facing: number;
  bodyType?: BodyType;
  state: WreckageState;
  stateStartedAt: number;    // tick at which the current state began
  remainingDP: number;       // damage wreck can absorb before disintegrating to debris
  maxDP: number;             // starting DP, for salvage-intactness ratio
  originalValue: number;     // loadout.totalCost at moment of destruction
  mass: 'light' | 'medium' | 'heavy';
  pushable: boolean;         // true if a ramplate vehicle can shove it aside
  carriedAmmo: number;       // ammo remaining across all mounts at moment of destruction
  causedBy: WreckageCause;
}

export interface ZoneState {
  id: string;
  type: ZoneType;
  tick: number;
  vehicles: VehicleState[];
  hazardObjects: HazardObject[];
  wreckage?: WreckageObject[];
  combatEvents?: CombatEvent[];
  mapId?: string;   // which arena map is loaded
  walls?: Rect[];   // only present in the initial join state, not every tick
}
