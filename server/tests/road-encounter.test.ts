import { describe, it, expect } from 'vitest';
import type { ArenaMap, Rect, SpawnPoint } from '@carwars/shared';
import { MAPS } from '../src/rules/maps';
import { highwayAmbushMap } from '../src/rules/maps/highway-ambush';
import { crossroadsBlockadeMap } from '../src/rules/maps/crossroads-blockade';
import { truckStopForecourtMap } from '../src/rules/maps/truck-stop-forecourt';
import { Pathfinder } from '../src/ai/pathfinder';

// Spawn validation helper — true if the spawn point sits inside any wall
// rect's footprint (walls are centred at (x, y) with width/height).
function spawnInWall(sp: SpawnPoint, walls: Rect[]): boolean {
  return walls.some(w =>
    Math.abs(sp.x - w.x) < w.w / 2 &&
    Math.abs(sp.y - w.y) < w.h / 2
  );
}

function spawnInsideBounds(sp: SpawnPoint, map: ArenaMap): boolean {
  const halfW = map.width / 2;
  const halfH = map.height / 2;
  return Math.abs(sp.x) <= halfW && Math.abs(sp.y) <= halfH;
}

function hasClearPath(map: ArenaMap, from: SpawnPoint, to: SpawnPoint): boolean {
  const pf = new Pathfinder(map);
  const path = pf.find({ x: from.x, y: from.y }, { x: to.x, y: to.y });
  return path !== null && path.length > 0;
}

const ROAD_ENCOUNTER_MAPS: { name: string; map: ArenaMap; w: number; h: number }[] = [
  { name: 'highway-ambush',       map: highwayAmbushMap,       w: 60, h: 20 },
  { name: 'crossroads-blockade',  map: crossroadsBlockadeMap,  w: 40, h: 40 },
  { name: 'truck-stop-forecourt', map: truckStopForecourtMap,  w: 50, h: 40 },
];

describe('road encounter maps', () => {
  for (const { name, map, w, h } of ROAD_ENCOUNTER_MAPS) {
    describe(name, () => {
      it('has the expected id and dimensions', () => {
        expect(map.id).toBe(name);
        expect(map.width).toBe(w);
        expect(map.height).toBe(h);
      });

      it('has at least one player spawn and one ai spawn', () => {
        const players = map.spawnPoints.filter(s => s.team === 'player');
        const ais    = map.spawnPoints.filter(s => s.team === 'ai');
        expect(players.length).toBeGreaterThan(0);
        expect(ais.length).toBeGreaterThan(0);
      });

      it('no spawn point is inside a wall', () => {
        for (const sp of map.spawnPoints) {
          expect(spawnInWall(sp, map.walls)).toBe(false);
        }
      });

      it('every spawn point is inside the map bounds', () => {
        for (const sp of map.spawnPoints) {
          expect(spawnInsideBounds(sp, map)).toBe(true);
        }
      });

      it('there is a pathfindable route from every player spawn to every ai spawn', () => {
        const players = map.spawnPoints.filter(s => s.team === 'player');
        const ais    = map.spawnPoints.filter(s => s.team === 'ai');
        for (const p of players) {
          for (const a of ais) {
            expect(hasClearPath(map, p, a)).toBe(true);
          }
        }
      });
    });
  }

  it('all three road-encounter maps are registered in the index', () => {
    expect(MAPS['highway-ambush']).toBeDefined();
    expect(MAPS['crossroads-blockade']).toBeDefined();
    expect(MAPS['truck-stop-forecourt']).toBeDefined();
  });
});
