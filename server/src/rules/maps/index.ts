import type { ArenaMap } from '@carwars/shared';
import { openArenaMap } from './open';
import { truckStopMap } from './truck-stop';

export const MAPS: Record<string, ArenaMap> = {
  'open':        openArenaMap,
  'truck-stop':  truckStopMap,
};

export function getMap(mapId: string): ArenaMap {
  return MAPS[mapId] ?? openArenaMap;
}
