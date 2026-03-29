import type { VehicleStats } from './vehicle';

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

export interface ZoneState {
  id: string;
  type: ZoneType;
  tick: number;
  vehicles: VehicleState[];
  hazardObjects: HazardObject[];
  mapId?: string;   // which arena map is loaded
  walls?: Rect[];   // only present in the initial join state, not every tick
}
