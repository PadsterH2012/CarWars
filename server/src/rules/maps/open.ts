import type { ArenaMap } from '@carwars/shared';

/** Original featureless arena — 40×23 world units, no obstacles */
export const openArenaMap: ArenaMap = {
  id: 'open',
  width: 40,
  height: 23,
  walls: [],
  spawnPoints: [
    { x: 0,   y:  8, facing:   0, team: 'player' },
    { x: -14, y: -8, facing: 135, team: 'ai' },
    { x:  14, y: -8, facing: 225, team: 'ai' },
  ],
};
