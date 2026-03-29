import type { ArenaMap } from '@carwars/shared';

/**
 * Fortified Truck Stop arena — 80×50 world units (±40x, ±25y).
 * Inspired by the Car Wars Truck Stop supplement map (Steve Jackson Games, 1983).
 *
 * Layout (landscape):
 *   - Perimeter wall with main gate (top, x=-3..+3) and secondary gate (bottom-right, x=+25..+31)
 *   - 4 corner turrets
 *   - Gatehouse top-center
 *   - Security/living quarters building center-left (L-shaped)
 *   - Power building center-right (U-shaped)
 *   - Main building bottom half (L-shaped: garage bays left + main building right)
 *   - Open courtyard = primary combat space
 */
export const truckStopMap: ArenaMap = {
  id: 'truck-stop',
  width: 80,
  height: 50,
  walls: [
    // ── Perimeter walls ──────────────────────────────────────────────────────
    // North wall — gap at x=-3..+3 (main gate, 6 units wide)
    { x: -21.5, y: -24.5, w: 37, h: 1, type: 'wall' },
    { x:  21.5, y: -24.5, w: 37, h: 1, type: 'wall' },
    // South wall — gap at x=+25..+31 (secondary gate, 6 units wide)
    { x:  -7.5, y:  24.5, w: 65, h: 1, type: 'wall' },
    { x:  35.5, y:  24.5, w:  9, h: 1, type: 'wall' },
    // West wall (full height between north/south walls)
    { x: -39.5, y: 0, w: 1, h: 49, type: 'wall' },
    // East wall
    { x:  39.5, y: 0, w: 1, h: 49, type: 'wall' },

    // ── Corner turrets ───────────────────────────────────────────────────────
    { x: -38, y: -23, w: 3, h: 3, type: 'turret' },  // NW
    { x:  38, y: -23, w: 3, h: 3, type: 'turret' },  // NE
    { x: -38, y:  23, w: 3, h: 3, type: 'turret' },  // SW
    { x:  38, y:  23, w: 3, h: 3, type: 'turret' },  // SE

    // ── Gatehouse (top-center, near main gate) ───────────────────────────────
    { x: 0, y: -19, w: 6, h: 4, type: 'building' },

    // ── Security / living quarters (center-left, L-shaped) ───────────────────
    { x: -20, y: -2, w:  8, h: 12, type: 'building' },  // main vertical block
    { x: -15, y:  3, w:  6, h:  6, type: 'building' },  // horizontal wing

    // ── Power building (center-right, U-shaped) ──────────────────────────────
    { x:  10, y: -5, w: 3, h:  8, type: 'building' },  // left arm
    { x:  16, y: -5, w: 3, h:  8, type: 'building' },  // right arm
    { x:  13, y: -8, w: 9, h:  2, type: 'building' },  // top crossbar

    // ── Main building (bottom half, L-shaped) ────────────────────────────────
    { x: -22, y: 14, w: 14, h: 10, type: 'building' },  // garage wing (9 bays)
    { x:  -4, y: 11, w: 24, h: 12, type: 'building' },  // main wing (bar, restaurant, offices)
  ],
  spawnPoints: [
    { x:   0, y:  2, facing:   0, team: 'player' },  // center courtyard, facing north
    { x: -14, y: -10, facing: 135, team: 'ai' },     // NW area, facing SE
    { x:  14, y: -10, facing: 225, team: 'ai' },     // NE area, facing SW
  ],
};
