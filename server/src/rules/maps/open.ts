import type { ArenaMap } from '@carwars/shared';

/**
 * Open arena — 40×23 world units. The training / free-for-all map.
 *
 * Stays deliberately sparse (no buildings, no cover) but uses the WASTELAND
 * palette with a cracked sand + rust-plate surface so it reads as an
 * abandoned parking lot rather than a black void.
 */
export const openArenaMap: ArenaMap = {
  id: 'open',
  width: 40,
  height: 23,
  palette: 'wasteland',
  walls: [
    { x:   0, y: -13, w: 44, h: 1, type: 'wall' as const },  // north boundary
    { x:   0, y:  13, w: 44, h: 1, type: 'wall' as const },  // south boundary
    { x: -21, y:   0, w:  1, h: 28, type: 'wall' as const }, // west boundary
    { x:  21, y:   0, w:  1, h: 28, type: 'wall' as const }, // east boundary
  ],
  floor: [
    // Cracked concrete base
    { x: 0, y: 0, w: 42, h: 26, type: 'concrete' },
    // Sand drifts in the corners — the wasteland has reclaimed the edges
    { x: -18, y: -10, w: 8, h: 6, type: 'sand' },
    { x:  18, y: -10, w: 8, h: 6, type: 'sand' },
    { x: -18, y:  10, w: 8, h: 6, type: 'sand' },
    { x:  18, y:  10, w: 8, h: 6, type: 'sand' },
    // Rust plate patch in the middle — old manhole / service cover
    { x: 0, y: 0, w: 3, h: 3, type: 'rust_plate' },
  ],
  decorations: [
    // Cracks radiating from the centre rust plate
    { x: -4, y:  0.8, w: 3, h: 0.2, type: 'crack' },
    { x:  4, y: -0.8, w: 3, h: 0.2, type: 'crack' },
    { x: -2, y:  3,   w: 2, h: 0.2, type: 'crack' },
    // Rubble scattered among the sand drifts
    { x: -16, y: -9, w: 1.2, h: 1.2, type: 'rubble' },
    { x:  16, y:  9, w: 1.2, h: 1.2, type: 'rubble' },
    { x:  17, y: -8, w: 1.0, h: 1.0, type: 'rubble' },
    // Dried blood splat telling us someone lost here before
    { x: -10, y: 6, w: 1, h: 0.8, type: 'blood_splat' },
    // Old potholes
    { x:  8, y:  3, w: 0.8, h: 0.8, type: 'pothole' },
    { x: -7, y: -5, w: 0.7, h: 0.7, type: 'pothole' },
    // A lone barrel and a collapsed crate near the centre
    { x: -6, y:  0, w: 0.6, h: 0.6, type: 'barrel' },
    { x:  6, y:  2, w: 0.8, h: 0.8, type: 'crate' },
  ],
  spawnPoints: [
    { x: 0,   y:  8, facing:   0, team: 'player' },
    { x: -14, y: -8, facing: 135, team: 'ai' },
    { x:  14, y: -8, facing: 225, team: 'ai' },
  ],
};
