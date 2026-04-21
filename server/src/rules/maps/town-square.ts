import type { ArenaMap } from '@carwars/shared';
import { composeMap } from './compose';
import { roadStraight20, roadT, cornerTurret, diner, gasStation } from './snippets';

// Demo map assembled from snippets: a small town square with a T-junction
// in the middle, a diner to the north, a gas station to the south, and
// corner turrets at the arena extremities. This exercises:
//  - rotations (road extensions, mirrored fixtures)
//  - spawn point collection from multiple placements
//  - the connector system (hand-aligned here; composer keeps them sync'd)
//
// Uses the URBAN palette — darker base tint, inviting neon-strip accents and
// asphalt-dominant feel.
export const townSquareMap: ArenaMap = composeMap('town-square', 60, 40, [
  // Central T-junction — east branch opens into the main plaza
  { snippet: roadT, x: 0, y: 0, rotation: 0 },
  // Eastbound road extension from the T
  { snippet: roadStraight20, x: 16, y: 0, rotation: 0 },
  // Diner 8 units north of the T
  { snippet: diner, x: -12, y: -12, rotation: 0 },
  // Gas station canopy south-west
  { snippet: gasStation, x: -14, y: 10, rotation: 0 },
  // Corner turrets at the four corners
  { snippet: cornerTurret, x: -28, y: -18, rotation: 0 },
  { snippet: cornerTurret, x:  28, y: -18, rotation: 0 },
  { snippet: cornerTurret, x: -28, y:  18, rotation: 0 },
  { snippet: cornerTurret, x:  28, y:  18, rotation: 0 },
]);

townSquareMap.palette = 'urban';

// Plaza centrepiece — a concrete square with neon trim so the middle of the
// arena reads as "open plaza" rather than bare road junction.
townSquareMap.floor = [
  ...(townSquareMap.floor ?? []),
  { x: 18, y: 12, w: 10, h: 6, type: 'concrete' },   // south-east plaza
  { x: 20, y: -12, w: 12, h: 8, type: 'concrete' },  // north-east loading bay
];
townSquareMap.decorations = [
  ...(townSquareMap.decorations ?? []),
  // Neon accent strips framing the east plaza — signature urban look
  { x: 18, y: 9,  w: 9, h: 0.15, type: 'neon_strip', facing: 90 },
  { x: 18, y: 15, w: 9, h: 0.15, type: 'neon_strip', facing: 90 },
  // Crates in the loading bay
  { x: 18, y: -12, w: 1, h: 1, type: 'crate' },
  { x: 20, y: -12, w: 1, h: 1, type: 'crate' },
  { x: 22, y: -12, w: 1, h: 1, type: 'crate' },
  // Barrel hazards in the plaza
  { x: 16, y: 13, w: 0.6, h: 0.6, type: 'barrel' },
  { x: 20, y: 11, w: 0.6, h: 0.6, type: 'barrel' },
];

// Manually add spawn points (snippets for this map don't carry them)
townSquareMap.spawnPoints = [
  { x: -20, y: -5, facing:  90, team: 'player' },
  { x:  20, y: -5, facing: 270, team: 'ai' },
  { x:  20, y:  5, facing: 270, team: 'ai' },
];
