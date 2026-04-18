import type { ArenaMap } from '@carwars/shared';
import { openArenaMap } from './open';
import { truckStopMap } from './truck-stop';
import { townSquareMap } from './town-square';

export const MAPS: Record<string, ArenaMap> = {
  'open':         openArenaMap,
  'truck-stop':   truckStopMap,
  'town-square':  townSquareMap,
};

export function getMap(mapId: string): ArenaMap {
  return MAPS[mapId] ?? openArenaMap;
}
