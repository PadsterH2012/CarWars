import type { ArenaMap } from '@carwars/shared';

/** Original featureless arena — 40×23 world units, no obstacles */
export const openArenaMap: ArenaMap = {
  id: 'open',
  width: 40,
  height: 23,
  walls: [
    { x:   0, y: -13, w: 44, h: 1, type: 'wall' as const },  // north boundary
    { x:   0, y:  13, w: 44, h: 1, type: 'wall' as const },  // south boundary
    { x: -21, y:   0, w:  1, h: 28, type: 'wall' as const }, // west boundary
    { x:  21, y:   0, w:  1, h: 28, type: 'wall' as const }, // east boundary
  ],
  spawnPoints: [
    { x: 0,   y:  8, facing:   0, team: 'player' },
    { x: -14, y: -8, facing: 135, team: 'ai' },
    { x:  14, y: -8, facing: 225, team: 'ai' },
  ],
};
