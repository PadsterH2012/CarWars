import type { ArenaMap } from '@carwars/shared';
import { composeMap } from './compose';
import { roadCross, cornerTurret } from './snippets';

/**
 * Crossroads Blockade — 40×40 urban road encounter.
 *
 * A four-way intersection (roadCross) sits at the centre. Two of the four
 * corners (NW and SE) carry defensive turret emplacements with crate cover.
 * The remaining two corners (SW and NE) are the spawn lay-bys — paved with
 * gravel so the lot reads as a parking apron rather than open dirt.
 *
 * Approach barricades just off each cardinal arm force traffic to weave
 * around them before entering the intersection.
 */
export const crossroadsBlockadeMap: ArenaMap = composeMap('crossroads-blockade', 40, 40, [
  { snippet: roadCross,    x:   0, y:   0, rotation: 0 },
  { snippet: cornerTurret, x: -15, y: -15, rotation: 0 }, // NW
  { snippet: cornerTurret, x:  15, y:  15, rotation: 0 }, // SE
]);

crossroadsBlockadeMap.palette = 'urban';

crossroadsBlockadeMap.floor = [
  ...(crossroadsBlockadeMap.floor ?? []),
  // Gravel parking aprons at the un-emplaced corners (SW & NE) where the
  // teams spawn — paints over the underlying palette background.
  { x: -15, y:  15, w: 8, h: 8, type: 'gravel' },
  { x:  15, y: -15, w: 8, h: 8, type: 'gravel' },
];

// Barricades and overturned vehicles flanking each approach — small block
// walls placed just outside the cross's kerbs so vehicles must veer around.
crossroadsBlockadeMap.walls = [
  ...crossroadsBlockadeMap.walls,
  { x: -10, y: -3.5, w: 2.5, h: 1,   type: 'building' as const }, // west approach
  { x:  10, y:  3.5, w: 2.5, h: 1,   type: 'building' as const }, // east approach
  { x:  -3.5, y: -10, w: 1, h: 2.5, type: 'building' as const }, // north approach
  { x:   3.5, y:  10, w: 1, h: 2.5, type: 'building' as const }, // south approach
];

crossroadsBlockadeMap.decorations = [
  ...(crossroadsBlockadeMap.decorations ?? []),
  // Barrels stacked behind each approach barricade
  { x: -10, y: -2, w: 0.6, h: 0.6, type: 'barrel' },
  { x:  10, y:  2, w: 0.6, h: 0.6, type: 'barrel' },
  { x:  -2, y: -10, w: 0.6, h: 0.6, type: 'barrel' },
  { x:   2, y:  10, w: 0.6, h: 0.6, type: 'barrel' },
  // Combat wear in the intersection
  { x:  0,  y:  0,  w: 1.4, h: 1.0, type: 'oil_stain' },
  { x:  1.5, y: -1, w: 0.7, h: 0.6, type: 'pothole' },
  // Approach warning signs at the lot perimeter
  { x: -18, y: -18, w: 0.6, h: 0.6, type: 'sign' },
  { x:  18, y:  18, w: 0.6, h: 0.6, type: 'sign' },
];

// Opposite corners — SW player faces NE (45°); NE AI faces SW (225°).
crossroadsBlockadeMap.spawnPoints = [
  { x: -10, y:  10, facing:  45, team: "player" },
  { x:  10, y: -10, facing: 225, team: "ai" },
];
