import type { ArenaMap } from '@carwars/shared';

/**
 * Fortified Truck Stop arena — 120×75 world units (±60x, ±37.5y).
 * Inspired by the Car Wars Truck Stop supplement map (Steve Jackson Games, 1983).
 *
 * Layout (landscape):
 *   - Perimeter wall with main gate (top) and secondary gate (bottom-right)
 *   - 4 corner turrets
 *   - Gatehouse top-center
 *   - Security/living quarters building center-left (L-shaped)
 *   - Power building center-right (U-shaped)
 *   - Main building bottom half (L-shaped: garage bays left + main building right)
 *   - Open courtyard = primary combat space
 *
 * Visual theming — INDUSTRIAL palette:
 *   - Asphalt courtyard across the playable area
 *   - Concrete slabs ring every building
 *   - Gravel buffer strip along perimeter walls
 *   - Fuel pumps at the power building, crates at turrets, signage at gates
 */
export const truckStopMap: ArenaMap = {
  id: 'truck-stop',
  width: 120,
  height: 75,
  palette: 'industrial',
  walls: [
    // ── Perimeter walls ──────────────────────────────────────────────────────
    { x: -32.25, y: -36.75, w: 55.5, h: 1.5, type: 'wall' },
    { x:  32.25, y: -36.75, w: 55.5, h: 1.5, type: 'wall' },
    { x: -11.25, y:  36.75, w: 97.5, h: 1.5, type: 'wall' },
    { x:  53.25, y:  36.75, w: 13.5, h: 1.5, type: 'wall' },
    { x: -59.25, y: 0, w: 1.5, h: 73.5, type: 'wall' },
    { x:  59.25, y: 0, w: 1.5, h: 73.5, type: 'wall' },

    // ── Corner turrets ───────────────────────────────────────────────────────
    { x: -57, y: -34.5, w: 4.5, h: 4.5, type: 'turret' },
    { x:  57, y: -34.5, w: 4.5, h: 4.5, type: 'turret' },
    { x: -57, y:  34.5, w: 4.5, h: 4.5, type: 'turret' },
    { x:  57, y:  34.5, w: 4.5, h: 4.5, type: 'turret' },

    // ── Gatehouse (top-center, near main gate) ───────────────────────────────
    { x: 0, y: -28.5, w: 9, h: 6, type: 'building' },

    // ── Security / living quarters (center-left, L-shaped) ───────────────────
    { x: -30,   y: -3, w: 12, h: 18, type: 'building' },
    { x: -22.5, y:  4.5, w:  9, h:  9, type: 'building' },

    // ── Power building (center-right, U-shaped) ──────────────────────────────
    { x:  15,   y: -7.5, w:  4.5, h: 12, type: 'building' },
    { x:  24,   y: -7.5, w:  4.5, h: 12, type: 'building' },
    { x:  19.5, y: -12, w: 13.5, h:  3, type: 'building' },

    // ── Main building (bottom half, L-shaped) ────────────────────────────────
    { x: -33, y: 21,   w: 21, h: 15, type: 'building' },
    { x:  -6, y: 16.5, w: 36, h: 18, type: 'building' },
  ],
  // Floor layers are drawn in order — later tiles overpaint earlier ones, so
  // the arrangement goes: asphalt base → gravel buffer → concrete pads.
  floor: [
    // Asphalt courtyard across the full interior
    { x: 0, y: 0, w: 116, h: 71, type: 'asphalt' },

    // Gravel buffer strips just inside the perimeter
    { x: 0,   y: -34.5, w: 110, h: 3, type: 'gravel' },
    { x: 0,   y:  34.5, w: 110, h: 3, type: 'gravel' },
    { x: -56, y:   0,   w:   3, h: 64, type: 'gravel' },
    { x:  56, y:   0,   w:   3, h: 64, type: 'gravel' },

    // Concrete pads around each building (slightly larger than footprint)
    { x: 0,     y: -28.5, w: 11,   h:  8, type: 'concrete' },  // gatehouse
    { x: -30,   y: -3,    w: 14,   h: 20, type: 'concrete' },  // security main
    { x: -22.5, y:  4.5,  w: 11,   h: 11, type: 'concrete' },  // security wing
    { x: 19.5,  y: -9,    w: 16,   h: 18, type: 'concrete' },  // power building
    { x: -33,   y: 21,    w: 23,   h: 17, type: 'concrete' },  // garage bays
    { x: -6,    y: 16.5,  w: 38,   h: 20, type: 'concrete' },  // main building

    // Concrete pads under the corner turrets for a "fortified emplacement" look
    { x: -57, y: -34.5, w: 7, h: 7, type: 'concrete' },
    { x:  57, y: -34.5, w: 7, h: 7, type: 'concrete' },
    { x: -57, y:  34.5, w: 7, h: 7, type: 'concrete' },
    { x:  57, y:  34.5, w: 7, h: 7, type: 'concrete' },
  ],
  decorations: [
    // ── Main gate (top-center) ──────────────────────────────────────────────
    { x: -6,  y: -36, w: 0.7, h: 0.7, type: 'sign' },
    { x:  6,  y: -36, w: 0.7, h: 0.7, type: 'sign' },
    { x:  0,  y: -33, w: 1.4, h: 1.4, type: 'arrow', facing: 180 },
    { x: -1.5, y: -32, w: 3, h: 0.6, type: 'tire_marks', facing: 90 },
    { x:  1.5, y: -32, w: 3, h: 0.6, type: 'tire_marks', facing: 90 },

    // ── Secondary gate (south-east) ─────────────────────────────────────────
    { x: 37.5, y: 36, w: 0.7, h: 0.7, type: 'sign' },
    { x: 46.5, y: 36, w: 0.7, h: 0.7, type: 'sign' },
    { x: 42, y: 33, w: 1.4, h: 1.4, type: 'arrow', facing: 0 },
    { x: 42, y: 30, w: 3, h: 0.6, type: 'tire_marks', facing: 90 },

    // ── Fuel pumps at the power building (inside the U) ─────────────────────
    { x: 19.5, y: -6, w: 0.8, h: 1.2, type: 'fuel_pump' },
    { x: 19.5, y: -3, w: 0.8, h: 1.2, type: 'fuel_pump' },
    { x: 19.5, y: -4.5, w: 2.5, h: 1.4, type: 'oil_stain' },

    // ── Parking stalls along the front of the main building ────────────────
    { x: -18, y: 9.5, w: 2, h: 3, type: 'parking_stall' },
    { x: -15, y: 9.5, w: 2, h: 3, type: 'parking_stall' },
    { x: -12, y: 9.5, w: 2, h: 3, type: 'parking_stall' },
    { x:  -6, y: 9.5, w: 2, h: 3, type: 'parking_stall' },
    { x:  -3, y: 9.5, w: 2, h: 3, type: 'parking_stall' },
    { x:   0, y: 9.5, w: 2, h: 3, type: 'parking_stall' },

    // ── Crates / sandbag fortifications at each corner turret ──────────────
    { x: -54,   y: -32, w: 1, h: 0.7, type: 'crate' },
    { x: -54,   y: -30.5, w: 1, h: 0.7, type: 'crate' },
    { x:  54,   y: -32, w: 1, h: 0.7, type: 'crate' },
    { x:  54,   y: -30.5, w: 1, h: 0.7, type: 'crate' },
    { x: -54,   y:  32, w: 1, h: 0.7, type: 'crate' },
    { x:  54,   y:  32, w: 1, h: 0.7, type: 'crate' },
    { x: -50,   y: -34.5, w: 0.6, h: 0.6, type: 'barrel' },
    { x: -49,   y: -34.5, w: 0.6, h: 0.6, type: 'barrel' },
    { x:  49,   y:  34.5, w: 0.6, h: 0.6, type: 'barrel' },
    { x:  50,   y:  34.5, w: 0.6, h: 0.6, type: 'barrel' },

    // ── Combat wear in the open courtyard ───────────────────────────────────
    { x:   5, y: -5, w: 0.8, h: 0.8, type: 'pothole' },
    { x:  -8, y: 12, w: 0.6, h: 0.6, type: 'pothole' },
    { x:  12, y:  8, w: 1.4, h: 1.0, type: 'oil_stain' },
    { x: -15, y: -8, w: 1.2, h: 0.9, type: 'oil_stain' },
    { x:   0, y:  0, w: 2.2, h: 0.6, type: 'tire_marks', facing: 45 },
    { x:   0, y:  0, w: 2.2, h: 0.6, type: 'tire_marks', facing: 135 },
    { x:  30, y:  0, w: 1.8, h: 0.5, type: 'crack' },
    { x: -10, y: 20, w: 1.6, h: 0.5, type: 'crack' },

    // ── Dumpster round the back of the main building ────────────────────────
    { x: 12, y: 27, w: 1.4, h: 0.8, type: 'dumpster' },

    // ── Rubble / abandoned debris in the NW — story beat ────────────────────
    { x: -45, y: -25, w: 1.5, h: 1.5, type: 'rubble' },
    { x: -42, y: -22, w: 1.2, h: 1.2, type: 'rubble' },
    { x: -48, y: -28, w: 0.8, h: 0.8, type: 'blood_splat' },
  ],
  // Spawn points re-laid-out 2026-04-21 — the original geometry put player
  // and AI on a direct y-axis collision lane with no obstacle between, so
  // the bench harness reported 100% mutual destruction across 100 matches.
  // New layout: player team in opposite south corners (SE + SW), AI stays
  // north. The main building (-6, 16.5, 36×18) now sits between the two
  // sides, forcing squads to manoeuvre around instead of charging head-on.
  spawnPoints: [
    { x:  30, y:  30, facing: 315, team: 'player' },  // SE corner, facing NW toward arena
    { x: -30, y:  30, facing:  45, team: 'player' },  // SW corner, facing NE toward arena
    { x:  40, y:  25, facing: 315, team: 'player' },
    { x: -40, y:  25, facing:  45, team: 'player' },
    { x: -21, y: -18, facing: 135, team: 'ai' },
    { x:   0, y: -21, facing: 180, team: 'ai' },
    { x:  45, y:   7.5, facing: 270, team: 'ai' },
    { x:  45, y:  18, facing: 270, team: 'ai' },
  ],
};
