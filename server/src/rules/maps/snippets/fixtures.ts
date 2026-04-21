import type { MapSnippet } from '../compose';

// Each fixture carries a concrete (or appropriate-surface) pad and a few
// narrative decorations so buildings read as lived-in places rather than
// unexplained silhouettes.

// Corner turret — 3×3 armoured block with its own collision profile ('turret' type
// so the client renders it distinctly). Sits on a concrete slab.
export const cornerTurret: MapSnippet = {
  id: 'corner_turret',
  size: { w: 3, h: 3 },
  walls: [
    { x: 0, y: 0, w: 3, h: 3, type: 'turret' },
  ],
  floor: [
    { x: 0, y: 0, w: 5, h: 5, type: 'concrete' },
  ],
  decorations: [
    // Sandbag feel — row of small crates along the nearest exposed face.
    { x: -2.2, y: -1.3, w: 0.7, h: 0.6, type: 'crate' },
    { x: -2.2, y:  0,   w: 0.7, h: 0.6, type: 'crate' },
    { x: -2.2, y:  1.3, w: 0.7, h: 0.6, type: 'crate' },
    // Warning sign
    { x: -2.2, y: 2.3, w: 0.6, h: 0.6, type: 'sign' },
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
  floor: [
    // Concrete platform extending past the walls on all sides
    { x: 0, y: 0, w: 8, h: 6, type: 'concrete' },
    // Asphalt apron through the gate so arriving cars don't hit concrete abruptly
    { x: 0, y: 3.5, w: 2, h: 2, type: 'asphalt' },
  ],
  decorations: [
    // Yellow warning signs either side of the gate
    { x: -1.6, y: 2.8, w: 0.6, h: 0.6, type: 'sign' },
    { x:  1.6, y: 2.8, w: 0.6, h: 0.6, type: 'sign' },
    // Approach arrow pointing into the gate
    { x: 0, y: 3.8, w: 1, h: 1, type: 'arrow', facing: 0 },
    // Tire streaks on the apron
    { x: 0, y: 3.2, w: 2, h: 0.5, type: 'tire_marks', facing: 0 },
  ],
  connectors: [
    { id: 'gate', x: 0, y: 2, facing: 90 },
  ],
};

// Straight perimeter wall, 20 units long — useful for arena boundaries.
// Thin concrete footing reads as "this wall was poured" not "this line is drawn".
export const wallStraight20: MapSnippet = {
  id: 'wall_straight_20',
  size: { w: 20, h: 1 },
  walls: [
    { x: 0, y: 0, w: 20, h: 1, type: 'wall' },
  ],
  floor: [
    { x: 0, y: 0, w: 20, h: 1.5, type: 'concrete' },
  ],
};

// Short diner — 8×6 rectangular building with door on the long front (south edge).
// Has a concrete pad + parking stalls out front and a dumpster round the back.
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
  floor: [
    // Concrete pad extending past the building
    { x: 0, y: 0, w: 10, h: 8, type: 'concrete' },
    // Asphalt forecourt for parking
    { x: 0, y: 4.5, w: 10, h: 3, type: 'asphalt' },
  ],
  decorations: [
    // Three parking stalls in front
    { x: -3, y: 4.5, w: 1.8, h: 2.5, type: 'parking_stall' },
    { x:  0, y: 4.5, w: 1.8, h: 2.5, type: 'parking_stall' },
    { x:  3, y: 4.5, w: 1.8, h: 2.5, type: 'parking_stall' },
    // Cone guiding toward the door
    { x: 0, y: 3.6, w: 0.4, h: 0.4, type: 'cone' },
    // Dumpster behind the building (north side)
    { x: -3, y: -3.6, w: 1.2, h: 0.7, type: 'dumpster' },
    // Oil stain in the parking lot
    { x: -3, y: 5, w: 1, h: 0.8, type: 'oil_stain' },
  ],
  connectors: [
    { id: 'door', x: 0, y: 3, facing: 90 },
  ],
};

// Gas station — a small canopy structure with supporting pillars (rendered as turrets
// for a distinct look). Fuel pumps under the canopy + oil staining around them.
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
  floor: [
    // Concrete pad under the whole canopy
    { x: 0, y: 0, w: 11, h: 7, type: 'concrete' },
  ],
  decorations: [
    // Two fuel pumps centred between the pillars
    { x: -2, y: 0, w: 0.6, h: 1, type: 'fuel_pump' },
    { x:  2, y: 0, w: 0.6, h: 1, type: 'fuel_pump' },
    // Heavy oil staining around each pump
    { x: -2, y: 1.2, w: 1.4, h: 0.8, type: 'oil_stain' },
    { x:  2, y: 1.2, w: 1.4, h: 0.8, type: 'oil_stain' },
    // Warning signs near the canopy edges
    { x: -4.5, y: 0, w: 0.5, h: 0.5, type: 'sign' },
    { x:  4.5, y: 0, w: 0.5, h: 0.5, type: 'sign' },
    // Barrel stash off to one side
    { x: 3, y: -2.3, w: 0.5, h: 0.5, type: 'barrel' },
    { x: 3.5, y: -2.3, w: 0.5, h: 0.5, type: 'barrel' },
  ],
};
