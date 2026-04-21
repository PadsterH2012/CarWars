import type { ArenaMap, Rect, SpawnPoint, WallType, FloorTile, Decoration } from '@carwars/shared';

// A Connector declares a typed exit on a snippet — the composer uses it so roads
// auto-align when two snippets with matching connector ids are placed adjacent.
// Facing is the outward direction in degrees (game convention: 0 = up/north, 90 = right/east).
export type ConnectorId =
  | 'road_n' | 'road_s' | 'road_e' | 'road_w'
  | 'gate' | 'door' | 'alley';

export interface Connector {
  id: ConnectorId;
  x: number;
  y: number;
  facing: number;
}

export interface MapSnippet {
  id: string;
  size: { w: number; h: number };
  walls: Rect[];
  spawnPoints?: SpawnPoint[];
  connectors?: Connector[];
  floor?: FloorTile[];       // surface tiles — rotated with the snippet
  decorations?: Decoration[]; // props — rotated with the snippet
}

export type Rotation = 0 | 90 | 180 | 270;

export interface Placement {
  snippet: MapSnippet;
  x: number;
  y: number;
  rotation: Rotation;
}

// Rotate a point (px, py) around the origin by `rotation` degrees (clockwise in game coords).
// Game coords: +x east, +y south; rotation clockwise makes east→south→west→north→east.
function rotatePoint(px: number, py: number, rotation: Rotation): { x: number; y: number } {
  switch (rotation) {
    case 0:   return { x:  px, y:  py };
    case 90:  return { x: -py, y:  px };
    case 180: return { x: -px, y: -py };
    case 270: return { x:  py, y: -px };
  }
}

function rotateFacing(facing: number, rotation: Rotation): number {
  return (facing + rotation + 360) % 360;
}

function rotateWall(wall: Rect, rotation: Rotation): Rect {
  const rotated = rotatePoint(wall.x, wall.y, rotation);
  // 90 and 270 swap width/height; 0 and 180 keep them
  const swap = rotation === 90 || rotation === 270;
  return {
    x: rotated.x,
    y: rotated.y,
    w: swap ? wall.h : wall.w,
    h: swap ? wall.w : wall.h,
    type: wall.type,
  };
}

function rotateFloor(tile: FloorTile, rotation: Rotation): FloorTile {
  const rotated = rotatePoint(tile.x, tile.y, rotation);
  const swap = rotation === 90 || rotation === 270;
  return {
    x: rotated.x,
    y: rotated.y,
    w: swap ? tile.h : tile.w,
    h: swap ? tile.w : tile.h,
    type: tile.type,
  };
}

function rotateDecoration(d: Decoration, rotation: Rotation): Decoration {
  const rotated = rotatePoint(d.x, d.y, rotation);
  const swap = rotation === 90 || rotation === 270;
  return {
    ...d,
    x: rotated.x,
    y: rotated.y,
    w: d.w !== undefined && swap ? d.h : d.w,
    h: d.h !== undefined && swap ? d.w : d.h,
    facing: d.facing !== undefined ? rotateFacing(d.facing, rotation) : undefined,
  };
}

// Exposed for tests: resolves a snippet's connectors to world-space coords under a placement.
export function snippetConnectorsOf(
  snippet: MapSnippet,
  placeX: number,
  placeY: number,
  rotation: Rotation,
): Connector[] {
  return (snippet.connectors ?? []).map(c => {
    const rotated = rotatePoint(c.x, c.y, rotation);
    return {
      id: c.id,
      x: rotated.x + placeX,
      y: rotated.y + placeY,
      facing: rotateFacing(c.facing, rotation),
    };
  });
}

export function composeMap(
  mapId: string,
  width: number,
  height: number,
  placements: Placement[],
): ArenaMap {
  const walls: Rect[] = [];
  const spawnPoints: SpawnPoint[] = [];
  const floor: FloorTile[] = [];
  const decorations: Decoration[] = [];

  for (const p of placements) {
    for (const w of p.snippet.walls) {
      const rw = rotateWall(w, p.rotation);
      walls.push({ ...rw, x: rw.x + p.x, y: rw.y + p.y });
    }
    for (const sp of p.snippet.spawnPoints ?? []) {
      const rotated = rotatePoint(sp.x, sp.y, p.rotation);
      spawnPoints.push({
        x: rotated.x + p.x,
        y: rotated.y + p.y,
        facing: rotateFacing(sp.facing, p.rotation),
        team: sp.team,
      });
    }
    for (const f of p.snippet.floor ?? []) {
      const rf = rotateFloor(f, p.rotation);
      floor.push({ ...rf, x: rf.x + p.x, y: rf.y + p.y });
    }
    for (const d of p.snippet.decorations ?? []) {
      const rd = rotateDecoration(d, p.rotation);
      decorations.push({ ...rd, x: rd.x + p.x, y: rd.y + p.y });
    }
  }

  return { id: mapId, width, height, walls, spawnPoints, floor, decorations };
}
