import type { ZoneState } from './world';
import type { DamageResult } from './combat';

export type ClientMessage =
  | { type: 'join_zone'; zoneId: string; vehicleId: string }
  | { type: 'input'; tick: number; speed: number; steer: number; fireWeapon: string | null }
  | { type: 'leave_zone' };

export type ServerMessage =
  | { type: 'zone_state'; state: ZoneState }
  | { type: 'damage'; result: DamageResult }
  | { type: 'error'; message: string };
