import { describe, it, expect } from 'vitest';
import { composeMap, snippetConnectorsOf } from '../src/rules/maps/compose';
import type { MapSnippet } from '../src/rules/maps/compose';

// A minimal snippet with a single wall at the centre and a connector at each long edge
const testSnippet: MapSnippet = {
  id: 'test',
  size: { w: 20, h: 4 },
  walls: [
    { x: 0, y: 0, w: 20, h: 1, type: 'wall' },
  ],
  connectors: [
    { id: 'road_w', x: -10, y: 0, facing: 180 },
    { id: 'road_e', x:  10, y: 0, facing: 0 },
  ],
  spawnPoints: [
    { x: 0, y: 0, facing: 0, team: 'player' },
  ],
};

describe('composeMap', () => {
  it('placing a snippet at origin produces walls at snippet-local coords', () => {
    const map = composeMap('m', 40, 20, [
      { snippet: testSnippet, x: 0, y: 0, rotation: 0 },
    ]);
    expect(map.walls.length).toBe(1);
    expect(map.walls[0].x).toBe(0);
    expect(map.walls[0].y).toBe(0);
    expect(map.walls[0].w).toBe(20);
    expect(map.walls[0].h).toBe(1);
  });

  it('translating a snippet moves its walls by the placement offset', () => {
    const map = composeMap('m', 80, 40, [
      { snippet: testSnippet, x: 15, y: -5, rotation: 0 },
    ]);
    expect(map.walls[0].x).toBe(15);
    expect(map.walls[0].y).toBe(-5);
  });

  it('rotating 90° swaps wall dimensions and rotates position', () => {
    const map = composeMap('m', 40, 40, [
      { snippet: testSnippet, x: 0, y: 0, rotation: 90 },
    ]);
    // Wall at (0,0) size 20x1 becomes size 1x20 (vertical)
    expect(map.walls[0].w).toBe(1);
    expect(map.walls[0].h).toBe(20);
    expect(map.walls[0].x).toBe(0);
    expect(map.walls[0].y).toBe(0);
  });

  it('rotating 90° rotates non-centre walls to rotated positions', () => {
    const offsetSnippet: MapSnippet = {
      id: 'off', size: { w: 20, h: 20 },
      walls: [{ x: 5, y: 0, w: 2, h: 2, type: 'wall' }],
    };
    const map = composeMap('m', 40, 40, [
      { snippet: offsetSnippet, x: 0, y: 0, rotation: 90 },
    ]);
    // (x=5, y=0) rotated 90° clockwise → (x=0, y=5)
    expect(map.walls[0].x).toBe(0);
    expect(map.walls[0].y).toBe(5);
  });

  it('combines walls from multiple placements', () => {
    const map = composeMap('m', 80, 40, [
      { snippet: testSnippet, x: -20, y: 0, rotation: 0 },
      { snippet: testSnippet, x:  20, y: 0, rotation: 0 },
    ]);
    expect(map.walls.length).toBe(2);
    expect(map.walls[0].x).toBe(-20);
    expect(map.walls[1].x).toBe(20);
  });

  it('collects spawn points from all placements', () => {
    const map = composeMap('m', 80, 40, [
      { snippet: testSnippet, x: 0, y:  10, rotation: 0 },
      { snippet: testSnippet, x: 0, y: -10, rotation: 0 },
    ]);
    expect(map.spawnPoints.length).toBe(2);
    expect(map.spawnPoints[0].y).toBe(10);
    expect(map.spawnPoints[1].y).toBe(-10);
  });

  it('town-square demo map composes without errors', async () => {
    const { townSquareMap } = await import('../src/rules/maps/town-square');
    expect(townSquareMap.id).toBe('town-square');
    expect(townSquareMap.width).toBe(60);
    expect(townSquareMap.walls.length).toBeGreaterThan(0);
    // 4 corner turrets + fixture walls + road kerbs
    expect(townSquareMap.walls.some(w => w.type === 'turret')).toBe(true);
    expect(townSquareMap.walls.some(w => w.type === 'building')).toBe(true);
    expect(townSquareMap.walls.some(w => w.type === 'wall')).toBe(true);
    expect(townSquareMap.spawnPoints.length).toBe(3);
  });

  it('rotation 180° inverts a non-centre point', () => {
    const sn: MapSnippet = {
      id: 'x', size: { w: 4, h: 4 }, walls: [],
      connectors: [{ id: 'gate', x: 3, y: 2, facing: 0 }],
    };
    const c = snippetConnectorsOf(sn, 0, 0, 180)[0];
    expect(c.x).toBe(-3);
    expect(c.y).toBe(-2);
    expect(c.facing).toBe(180);
  });

  it('matching connector positions align when snippets are abutted', () => {
    // Place two test snippets so road_e of first matches road_w of second
    // First snippet at x=0: road_e is at (10, 0) world-local
    // Second snippet should have road_w at (10, 0) as well
    // If the second snippet is placed at x=20, its road_w (at -10 locally) lands at world x=10 ✓
    const firstConnectors = snippetConnectorsOf(testSnippet, 0, 0, 0);
    const secondConnectors = snippetConnectorsOf(testSnippet, 20, 0, 0);
    const e1 = firstConnectors.find(c => c.id === 'road_e')!;
    const w2 = secondConnectors.find(c => c.id === 'road_w')!;
    expect(e1.x).toBeCloseTo(w2.x, 5);
    expect(e1.y).toBeCloseTo(w2.y, 5);
  });

  it('floor tiles rotate and translate with the snippet', () => {
    const sn: MapSnippet = {
      id: 'f', size: { w: 20, h: 10 }, walls: [],
      floor: [{ x: 5, y: 0, w: 10, h: 4, type: 'asphalt' }],
    };
    // 90° rotation: (5, 0) → (0, 5); 10×4 → 4×10
    const mapRot = composeMap('m', 40, 40, [{ snippet: sn, x: 0, y: 0, rotation: 90 }]);
    expect(mapRot.floor?.length).toBe(1);
    expect(mapRot.floor![0].x).toBe(0);
    expect(mapRot.floor![0].y).toBe(5);
    expect(mapRot.floor![0].w).toBe(4);
    expect(mapRot.floor![0].h).toBe(10);
    expect(mapRot.floor![0].type).toBe('asphalt');
    // Translation: same tile at (10, 5) placed rotation 0
    const mapTr = composeMap('m', 40, 40, [{ snippet: sn, x: 10, y: 5, rotation: 0 }]);
    expect(mapTr.floor![0].x).toBe(15);
    expect(mapTr.floor![0].y).toBe(5);
  });

  it('decorations rotate with facing and translate with the snippet', () => {
    const sn: MapSnippet = {
      id: 'd', size: { w: 10, h: 10 }, walls: [],
      decorations: [
        { x: 3, y: 0, type: 'arrow', facing: 0 },
        { x: 0, y: 0, type: 'oil_stain' },
      ],
    };
    // 90° rotation: arrow at (3, 0) facing 0 → (0, 3) facing 90
    const map = composeMap('m', 40, 40, [{ snippet: sn, x: 0, y: 0, rotation: 90 }]);
    const arrow = map.decorations!.find(d => d.type === 'arrow')!;
    expect(arrow.x).toBe(0);
    expect(arrow.y).toBe(3);
    expect(arrow.facing).toBe(90);
    const stain = map.decorations!.find(d => d.type === 'oil_stain')!;
    expect(stain.x).toBe(0);
    expect(stain.y).toBe(0);
    expect(stain.facing).toBeUndefined();
  });

  it('composed maps emit empty floor/decoration arrays when snippets have none', () => {
    const bare: MapSnippet = {
      id: 'b', size: { w: 4, h: 4 },
      walls: [{ x: 0, y: 0, w: 4, h: 4, type: 'wall' }],
    };
    const map = composeMap('m', 10, 10, [{ snippet: bare, x: 0, y: 0, rotation: 0 }]);
    expect(map.floor).toEqual([]);
    expect(map.decorations).toEqual([]);
  });
});
