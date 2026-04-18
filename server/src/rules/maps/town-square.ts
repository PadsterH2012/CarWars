import type { ArenaMap } from '@carwars/shared';
import { composeMap } from './compose';
import { roadStraight20, roadT, cornerTurret, diner, gasStation } from './snippets';

// Demo map assembled from snippets: a small town square with a T-junction
// in the middle, a diner to the north, a gas station to the south, and
// corner turrets at the arena extremities. This exercises:
//  - rotations (road extensions, mirrored fixtures)
//  - spawn point collection from multiple placements
//  - the connector system (hand-aligned here; composer keeps them sync'd)
export const townSquareMap: ArenaMap = composeMap('town-square', 60, 40, [
  // Central T-junction — east branch opens into the main plaza
  { snippet: roadT, x: 0, y: 0, rotation: 0 },

  // Eastbound road extension from the T
  { snippet: roadStraight20, x: 16, y: 0, rotation: 0 },

  // Diner 8 units north of the T
  { snippet: diner, x: -12, y: -12, rotation: 0 },

  // Gas station canopy south-west
  { snippet: gasStation, x: -14, y: 10, rotation: 0 },

  // Corner turrets at the four corners (28, 18) = (width/2 - 2, height/2 - 2)
  { snippet: cornerTurret, x: -28, y: -18, rotation: 0 },
  { snippet: cornerTurret, x:  28, y: -18, rotation: 0 },
  { snippet: cornerTurret, x: -28, y:  18, rotation: 0 },
  { snippet: cornerTurret, x:  28, y:  18, rotation: 0 },
]);

// Manually add spawn points (snippets for this map don't carry them)
townSquareMap.spawnPoints = [
  { x: -20, y: -5, facing:  90, team: 'player' },
  { x:  20, y: -5, facing: 270, team: 'ai' },
  { x:  20, y:  5, facing: 270, team: 'ai' },
];
