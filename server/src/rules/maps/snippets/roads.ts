import type { MapSnippet } from '../compose';

// Road snippets use kerb walls on the long edges with a 4-unit-wide driving lane.
// Connectors align with the short ends so two segments can abut cleanly.

// Straight road, 20 units long, 4 units wide (2 lanes).
// Kerbs are 1-wide walls along the long edges.
export const roadStraight20: MapSnippet = {
  id: 'road_straight_20',
  size: { w: 20, h: 4 },
  walls: [
    { x: 0, y: -2, w: 20, h: 0.5, type: 'wall' },  // north kerb
    { x: 0, y:  2, w: 20, h: 0.5, type: 'wall' },  // south kerb
  ],
  connectors: [
    { id: 'road_w', x: -10, y: 0, facing: 180 },
    { id: 'road_e', x:  10, y: 0, facing: 0   },
  ],
};

// 90° bend joining a west exit to a south exit (roads arriving from west, leaving south).
// Corner wall ring forms an outer curve; inner edge opens onto the turn.
export const roadBendWS: MapSnippet = {
  id: 'road_bend_ws',
  size: { w: 12, h: 12 },
  walls: [
    // Outer corner (NE) — two walls forming an L
    { x: -3, y: -5, w: 6, h: 0.5, type: 'wall' },  // north kerb, west half
    { x:  5, y: -3, w: 0.5, h: 6, type: 'wall' },  // east kerb, north half
    // Inner corner is open (the turn itself)
    // Far edges of road
    { x: -5, y:  3, w: 2, h: 0.5, type: 'wall' },  // south-west stub
    { x:  3, y:  5, w: 0.5, h: 2, type: 'wall' },  // south-east stub
  ],
  connectors: [
    { id: 'road_w', x: -6, y: 0, facing: 180 },
    { id: 'road_s', x:  0, y: 6, facing:  90 },
  ],
};

// T-junction: east road enters from east; north and south branches from the midpoint.
export const roadT: MapSnippet = {
  id: 'road_t',
  size: { w: 12, h: 12 },
  walls: [
    // North branch kerbs
    { x: -2, y: -4, w: 0.5, h: 4, type: 'wall' },
    { x:  2, y: -4, w: 0.5, h: 4, type: 'wall' },
    // South branch kerbs
    { x: -2, y:  4, w: 0.5, h: 4, type: 'wall' },
    { x:  2, y:  4, w: 0.5, h: 4, type: 'wall' },
    // West wall of the junction (east side is the T opening)
    { x: -4, y: -2, w: 4, h: 0.5, type: 'wall' },
    { x: -4, y:  2, w: 4, h: 0.5, type: 'wall' },
  ],
  connectors: [
    { id: 'road_n', x: 0, y: -6, facing: 270 },
    { id: 'road_s', x: 0, y:  6, facing:  90 },
    { id: 'road_e', x: 6, y:  0, facing:   0 },
  ],
};

// 4-way crossroads.
export const roadCross: MapSnippet = {
  id: 'road_cross',
  size: { w: 12, h: 12 },
  walls: [
    // North branch kerbs
    { x: -2, y: -4, w: 0.5, h: 4, type: 'wall' },
    { x:  2, y: -4, w: 0.5, h: 4, type: 'wall' },
    // South branch kerbs
    { x: -2, y:  4, w: 0.5, h: 4, type: 'wall' },
    { x:  2, y:  4, w: 0.5, h: 4, type: 'wall' },
    // East branch kerbs
    { x:  4, y: -2, w: 4, h: 0.5, type: 'wall' },
    { x:  4, y:  2, w: 4, h: 0.5, type: 'wall' },
    // West branch kerbs
    { x: -4, y: -2, w: 4, h: 0.5, type: 'wall' },
    { x: -4, y:  2, w: 4, h: 0.5, type: 'wall' },
  ],
  connectors: [
    { id: 'road_n', x: 0, y: -6, facing: 270 },
    { id: 'road_s', x: 0, y:  6, facing:  90 },
    { id: 'road_e', x: 6, y:  0, facing:   0 },
    { id: 'road_w', x:-6, y:  0, facing: 180 },
  ],
};
