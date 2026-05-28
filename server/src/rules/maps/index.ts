import type { ArenaMap } from '@carwars/shared';
import { openArenaMap } from './open';
import { truckStopMap } from './truck-stop';
import { townSquareMap } from './town-square';
import { doubleDrumMap } from './double-drum';
import { highwayAmbushMap } from './highway-ambush';
import { crossroadsBlockadeMap } from './crossroads-blockade';
import { truckStopForecourtMap } from './truck-stop-forecourt';

export const MAPS: Record<string, ArenaMap> = {
  'open':                  openArenaMap,
  'truck-stop':            truckStopMap,
  'town-square':           townSquareMap,
  'double-drum':           doubleDrumMap,
  'highway-ambush':        highwayAmbushMap,
  'crossroads-blockade':   crossroadsBlockadeMap,
  'truck-stop-forecourt':  truckStopForecourtMap,
};

export function getMap(mapId: string): ArenaMap {
  return MAPS[mapId] ?? openArenaMap;
}
