import type { ZoneState } from './world';
import type { DamageResult } from './combat';

// Rival gang info delivered to the client for in-arena and post-match display.
export interface RivalInfo {
  id: string;
  name: string;
  description: string;
  primary_colour: number;
  secondary_colour: number;
  emblem_id: string;
}

// Commander-mode order for a squad vehicle (only applied to AI-driven squadmates).
// 'attack': focus-fire a specific enemy; 'move': drive to a waypoint ignoring combat;
// 'follow': stay in formation behind the leader; 'retreat': maximise distance from all enemies.
export type SquadOrder =
  | { type: 'attack'; targetId: string }
  | { type: 'move'; x: number; y: number }
  | { type: 'follow'; leaderId: string }
  | { type: 'retreat' }
  | { type: 'clear' };

export type ClientMessage =
  | { type: 'join_zone'; zoneId: string; vehicleId: string; token?: string; jobId?: string; squadVehicleIds?: string[]; mapId?: string }
  | { type: 'input'; tick: number; speed: number; steer: number; fireWeapon: string | null }
  | { type: 'autopilot'; enabled: boolean }
  | { type: 'leave_zone' }
  | { type: 'pause' }
  | { type: 'unpause' }
  | { type: 'squad_order'; vehicleId: string; order: SquadOrder };

export type ServerMessage =
  | { type: 'zone_state'; state: ZoneState }
  | { type: 'damage'; result: DamageResult }
  | { type: 'error'; message: string }
  | { type: 'zone_join_error'; error: string }
  | { type: 'zone_change'; destinationZoneId: string; reason: string }
  | { type: 'zone_end'; winnerId: string | null; reason: string; prize: number; jobPayout: number; salvage: number; wages: number; maintenance: number; rival?: RivalInfo; rivalQuote?: string; replayId?: string; spawnAt?: 'garage' | 'town' }
  | { type: 'rival_info'; rival: RivalInfo }
  | { type: 'driver_info'; vehicleId: string; skill: number; maxSteer: number };
