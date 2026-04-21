import type { MapSnippet } from '../compose';

// Road snippets use kerb walls on the long edges with a 4-unit-wide driving lane.
// Connectors align with the short ends so two segments can abut cleanly.
// Each carries an asphalt floor tile and appropriate lane markings so the
// composed map reads as an actual road network rather than painted boxes.

// Straight road, 20 units long, 4 units wide (2 lanes).
// Kerbs are 1-wide walls along the long edges.
export const roadStraight20: MapSnippet = {
  id: 'road_straight_20',
  size: { w: 20, h: 4 },
  walls: [
    { x: 0, y: -2, w: 20, h: 0.5, type: 'wall' },  // north kerb
    { x: 0, y:  2, w: 20, h: 0.5, type: 'wall' },  // south kerb
  ],
  floor: [
    { x: 0, y: 0, w: 20, h: 3.5, type: 'asphalt' },
  ],
  decorations: [
    // Dashed yellow centerline down the middle
    { x: 0, y: 0, w: 19, h: 0.15, type: 'lane_yellow', facing: 90 },
    // A sprinkle of wear — pothole off-centre and a skid mark approaching it
    { x: 4, y:  0.8, w: 0.6, h: 0.6, type: 'pothole' },
    { x: -2, y: -0.7, w: 3, h: 0.6, type: 'tire_marks', facing: 90 },
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
  floor: [
    // Two overlapping strips form the L — cheap approximation of a curved surface
    { x: -1, y: -3, w: 10, h: 3.5, type: 'asphalt' }, // east-west leg
    { x:  3, y:  1, w: 3.5, h: 10, type: 'asphalt' }, // north-south leg
  ],
  decorations: [
    // Directional arrow hinting at the turn — points south (down) at the inside of the bend
    { x: 3, y: -2, type: 'arrow', w: 1.2, h: 1.2, facing: 180 },
    // Tire marks sweeping through the apex — cars cut this corner
    { x: 0, y: -2, w: 4, h: 0.5, type: 'tire_marks', facing: 90 },
    { x: 3, y:  1, w: 4, h: 0.5, type: 'tire_marks', facing: 0 },
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
  floor: [
    // Vertical trunk of the T
    { x: 0, y: 0, w: 3.5, h: 12, type: 'asphalt' },
    // Eastern branch
    { x: 4, y: 0, w: 8, h: 3.5, type: 'asphalt' },
  ],
  decorations: [
    // Dashed centerlines for each leg
    { x: 0, y: -4, w: 3, h: 0.15, type: 'lane_yellow', facing: 0  },
    { x: 0, y:  4, w: 3, h: 0.15, type: 'lane_yellow', facing: 0  },
    { x: 4, y:  0, w: 7, h: 0.15, type: 'lane_yellow', facing: 90 },
    // Oil stain in the middle of the junction
    { x: 0, y: 0, w: 1.2, h: 1, type: 'oil_stain' },
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
  floor: [
    // Cross-shape floor built from two perpendicular strips
    { x: 0, y: 0, w: 3.5, h: 12, type: 'asphalt' },
    { x: 0, y: 0, w: 12,  h: 3.5, type: 'asphalt' },
  ],
  decorations: [
    // Dashed centerlines on all four approaches
    { x: 0, y: -4, w: 3, h: 0.15, type: 'lane_yellow', facing: 0  },
    { x: 0, y:  4, w: 3, h: 0.15, type: 'lane_yellow', facing: 0  },
    { x: -4, y: 0, w: 3, h: 0.15, type: 'lane_yellow', facing: 90 },
    { x:  4, y: 0, w: 3, h: 0.15, type: 'lane_yellow', facing: 90 },
    // Tire marks — someone was doing donuts
    { x: 0, y: 0, w: 3, h: 0.4, type: 'tire_marks', facing: 45 },
    { x: 0, y: 0, w: 3, h: 0.4, type: 'tire_marks', facing: 135 },
  ],
  connectors: [
    { id: 'road_n', x: 0, y: -6, facing: 270 },
    { id: 'road_s', x: 0, y:  6, facing:  90 },
    { id: 'road_e', x: 6, y:  0, facing:   0 },
    { id: 'road_w', x:-6, y:  0, facing: 180 },
  ],
};
