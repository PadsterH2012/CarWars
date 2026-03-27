import type { VehicleStats } from './vehicle';

export type ZoneType = 'highway' | 'town' | 'arena';

export interface Position {
  x: number;
  y: number;
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

export interface ZoneState {
  id: string;
  type: ZoneType;
  tick: number;
  vehicles: VehicleState[];
}
