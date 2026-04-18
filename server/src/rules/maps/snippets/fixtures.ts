import type { MapSnippet } from '../compose';

// Corner turret — 3×3 armoured block with its own collision profile ('turret' type
// so the client renders it distinctly).
export const cornerTurret: MapSnippet = {
  id: 'corner_turret',
  size: { w: 3, h: 3 },
  walls: [
    { x: 0, y: 0, w: 3, h: 3, type: 'turret' },
  ],
};

// Gatehouse — 6×4 building with a gap on the south edge facing outward.
// The gate connector sits at the south edge so a road snippet can dock here.
export const gatehouse: MapSnippet = {
  id: 'gatehouse',
  size: { w: 6, h: 4 },
  walls: [
    { x: 0,    y: -2, w: 6,   h: 0.5, type: 'building' },  // north wall
    { x: -2.5, y:  0, w: 0.5, h: 4,   type: 'building' },  // west
    { x:  2.5, y:  0, w: 0.5, h: 4,   type: 'building' },  // east
    // South wall split around a 2-unit gate opening
    { x: -2,   y:  2, w: 2,   h: 0.5, type: 'building' },
    { x:  2,   y:  2, w: 2,   h: 0.5, type: 'building' },
  ],
  connectors: [
    { id: 'gate', x: 0, y: 2, facing: 90 },
  ],
};

// Straight perimeter wall, 20 units long — useful for arena boundaries.
export const wallStraight20: MapSnippet = {
  id: 'wall_straight_20',
  size: { w: 20, h: 1 },
  walls: [
    { x: 0, y: 0, w: 20, h: 1, type: 'wall' },
  ],
};

// Short diner — 8×6 rectangular building with door on the long front (south edge).
export const diner: MapSnippet = {
  id: 'diner',
  size: { w: 8, h: 6 },
  walls: [
    { x: 0,   y: -3, w: 8,   h: 0.5, type: 'building' },  // back wall
    { x: -4, y:  0, w: 0.5, h: 6,   type: 'building' },  // west wall
    { x:  4, y:  0, w: 0.5, h: 6,   type: 'building' },  // east wall
    { x: -2.5, y: 3, w: 3, h: 0.5, type: 'building' },   // front wall left of door
    { x:  2.5, y: 3, w: 3, h: 0.5, type: 'building' },   // front wall right of door
  ],
  connectors: [
    { id: 'door', x: 0, y: 3, facing: 90 },
  ],
};

// Gas station — a small canopy structure with supporting pillars (rendered as turrets
// for a distinct look). The pumps sit under the canopy but this MVP version omits
// non-blocking decor so the canopy is just the 4 pillars.
export const gasStation: MapSnippet = {
  id: 'gas_station',
  size: { w: 10, h: 6 },
  walls: [
    // 4 corner pillars
    { x: -4, y: -2, w: 1, h: 1, type: 'turret' },
    { x:  4, y: -2, w: 1, h: 1, type: 'turret' },
    { x: -4, y:  2, w: 1, h: 1, type: 'turret' },
    { x:  4, y:  2, w: 1, h: 1, type: 'turret' },
  ],
};
