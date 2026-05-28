import type { ArenaMap } from '@carwars/shared';
import { composeMap } from './compose';
import { roadStraight20 } from './snippets';

/**
 * Highway Ambush — 60×20 wasteland road encounter.
 *
 * Three roadStraight20 segments end-to-end form a continuous strip of
 * tarmac across the map. Two staggered wrecks force a serpentine path
 * down the middle; shoulder emplacements give the AI ambushers something
 * to hide behind. Player rolls in from the west, AI is already dug into
 * the eastern lay-by.
 */
export const highwayAmbushMap: ArenaMap = composeMap('highway-ambush', 60, 20, [
  { snippet: roadStraight20, x: -20, y: 0, rotation: 0 },
  { snippet: roadStraight20, x:   0, y: 0, rotation: 0 },
  { snippet: roadStraight20, x:  20, y: 0, rotation: 0 },
]);

highwayAmbushMap.palette = 'wasteland';

// Dirt shoulders flank the tarmac on both sides — the road floor from the
// snippets already paints the central asphalt strip.
highwayAmbushMap.floor = [
  { x: 0, y: -6.5, w: 60, h: 7, type: 'dirt' },
  { x: 0, y:  6.5, w: 60, h: 7, type: 'dirt' },
  ...(highwayAmbushMap.floor ?? []),
];

// Two burnt-out wrecks staggered down the road — drivers weave through.
// Heights kept under 0.7 so the vehicle-probe corridor between each wreck
// and the opposite kerb remains pathfindable. Plus turret blocks on the
// shoulders as terrain cover (visual only — kerbs make the shoulders
// unreachable, AI spawns stay on the tarmac).
highwayAmbushMap.walls = [
  ...highwayAmbushMap.walls,
  { x: -8, y: -0.7, w: 2.4, h: 0.6, type: 'building' as const },
  { x:  8, y:  0.7, w: 2.4, h: 0.6, type: 'building' as const },
  { x: -18, y: -6, w: 1.5, h: 1.5, type: 'turret' as const },
  { x:  18, y:  6, w: 1.5, h: 1.5, type: 'turret' as const },
];

highwayAmbushMap.decorations = [
  ...(highwayAmbushMap.decorations ?? []),
  { x: -8,  y:  1,   w: 1,   h: 0.6, type: 'oil_stain' },
  { x:  8,  y: -1,   w: 1,   h: 0.6, type: 'oil_stain' },
  { x: -10, y: -0.5, w: 0.5, h: 0.5, type: 'barrel' },
  { x:  10, y:  0.5, w: 0.5, h: 0.5, type: 'barrel' },
  { x: -16, y: -6,   w: 0.7, h: 0.7, type: 'crate' },
  { x: -16, y: -7,   w: 0.7, h: 0.7, type: 'crate' },
  { x:  16, y:  6,   w: 0.7, h: 0.7, type: 'crate' },
  { x:  16, y:  7,   w: 0.7, h: 0.7, type: 'crate' },
  { x: -25, y: -5,   w: 0.6, h: 0.6, type: 'sign' },
  { x:  25, y:  5,   w: 0.6, h: 0.6, type: 'sign' },
  { x:   0, y:  0,   w: 1,   h: 0.8, type: 'blood_splat' },
  { x:   0, y: -1,   w: 2,   h: 0.5, type: 'tire_marks', facing: 90 },
];

highwayAmbushMap.spawnPoints = [
  { x: -8,  y:  0, facing:  90, team: "player" },
  { x:  6,  y:  0, facing: 270, team: "ai" },
  { x:  10, y:  0, facing: 270, team: "ai" },
];
