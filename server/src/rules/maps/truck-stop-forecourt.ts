import type { ArenaMap } from '@carwars/shared';
import { composeMap } from './compose';
import { gasStation, diner } from './snippets';

/**
 * Truck-Stop Forecourt — 50×40 industrial road encounter.
 *
 * A scaled-down truck-stop for road encounters: a single gas-station
 * canopy on the west, a diner on the east, and a wide open asphalt
 * forecourt between them — the killing ground. Player parks at the
 * pumps; AI is dug in behind the diner waiting for the engine to start.
 */
export const truckStopForecourtMap: ArenaMap = composeMap('truck-stop-forecourt', 50, 40, [
  { snippet: gasStation, x: -10, y: 0, rotation: 0 },
  { snippet: diner,      x:  12, y: 5, rotation: 0 },
]);

truckStopForecourtMap.palette = 'industrial';

// Asphalt base across the whole lot, with a gravel buffer at the
// perimeter. Snippet floor tiles (gas-station concrete, diner pad)
// overpaint on top.
truckStopForecourtMap.floor = [
  { x: 0, y:   0, w: 48, h: 38, type: 'asphalt' },
  { x: 0, y: -18, w: 48, h: 3,  type: 'gravel' },
  { x: 0, y:  18, w: 48, h: 3,  type: 'gravel' },
  ...(truckStopForecourtMap.floor ?? []),
];

// Cover blocks behind the diner — concrete dumpster pads the AI can
// sidle out from.
truckStopForecourtMap.walls = [
  ...truckStopForecourtMap.walls,
  { x:  8, y: -3, w: 1.5, h: 1.5, type: 'building' as const },
  { x: 16, y: -3, w: 1.5, h: 1.5, type: 'building' as const },
];

truckStopForecourtMap.decorations = [
  ...(truckStopForecourtMap.decorations ?? []),
  // Parking stalls in the open forecourt
  { x: -3, y:  10, w: 1.8, h: 2.5, type: 'parking_stall' },
  { x:  0, y:  10, w: 1.8, h: 2.5, type: 'parking_stall' },
  { x:  3, y:  10, w: 1.8, h: 2.5, type: 'parking_stall' },
  // Cones at the lot entrance (west side)
  { x: -22, y: 0, w: 0.4, h: 0.4, type: 'cone' },
  { x: -22, y: 2, w: 0.4, h: 0.4, type: 'cone' },
  // Approach signs at the east perimeter
  { x: 22, y: -10, w: 0.6, h: 0.6, type: 'sign' },
  { x: 22, y:  10, w: 0.6, h: 0.6, type: 'sign' },
  // Combat wear scattered across the forecourt
  { x:  0,  y:  0,   w: 1.2, h: 1.0, type: 'oil_stain' },
  { x:  5,  y: -8,   w: 0.8, h: 0.8, type: 'pothole' },
  { x: -5,  y: 12,   w: 1.6, h: 0.5, type: 'crack' },
  { x: 12,  y: -10,  w: 1,   h: 0.8, type: 'blood_splat' },
];

// Player at the pumps facing east into the lot; AI #1 behind the diner
// (north), AI #2 east of the diner.
truckStopForecourtMap.spawnPoints = [
  { x: -10, y:  0, facing:  90, team: 'player' },
  { x:  12, y: -8, facing: 180, team: 'ai' },
  { x:  20, y:  5, facing: 270, team: 'ai' },
];
