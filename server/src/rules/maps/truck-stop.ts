import type { ArenaMap } from '@carwars/shared';

/**
 * Fortified Truck Stop arena — 120×75 world units (±60x, ±37.5y).
 * Inspired by the Car Wars Truck Stop supplement map (Steve Jackson Games, 1983).
 *
 * Uniformly scaled 1.5× from the original 80×50 layout (2026-04-19) to give
 * more open combat space between buildings.
 *
 * Layout (landscape):
 *   - Perimeter wall with main gate (top) and secondary gate (bottom-right)
 *   - 4 corner turrets
 *   - Gatehouse top-center
 *   - Security/living quarters building center-left (L-shaped)
 *   - Power building center-right (U-shaped)
 *   - Main building bottom half (L-shaped: garage bays left + main building right)
 *   - Open courtyard = primary combat space
 */
export const truckStopMap: ArenaMap = {
  id: 'truck-stop',
  width: 120,
  height: 75,
  walls: [
    // ── Perimeter walls ──────────────────────────────────────────────────────
    // North wall — gap at x=-4.5..+4.5 (main gate, 9 units wide)
    { x: -32.25, y: -36.75, w: 55.5, h: 1.5, type: 'wall' },
    { x:  32.25, y: -36.75, w: 55.5, h: 1.5, type: 'wall' },
    // South wall — gap at x=+37.5..+46.5 (secondary gate, 9 units wide)
    { x: -11.25, y:  36.75, w: 97.5, h: 1.5, type: 'wall' },
    { x:  53.25, y:  36.75, w: 13.5, h: 1.5, type: 'wall' },
    // West wall (full height between north/south walls)
    { x: -59.25, y: 0, w: 1.5, h: 73.5, type: 'wall' },
    // East wall
    { x:  59.25, y: 0, w: 1.5, h: 73.5, type: 'wall' },

    // ── Corner turrets ───────────────────────────────────────────────────────
    { x: -57, y: -34.5, w: 4.5, h: 4.5, type: 'turret' },  // NW
    { x:  57, y: -34.5, w: 4.5, h: 4.5, type: 'turret' },  // NE
    { x: -57, y:  34.5, w: 4.5, h: 4.5, type: 'turret' },  // SW
    { x:  57, y:  34.5, w: 4.5, h: 4.5, type: 'turret' },  // SE

    // ── Gatehouse (top-center, near main gate) ───────────────────────────────
    { x: 0, y: -28.5, w: 9, h: 6, type: 'building' },

    // ── Security / living quarters (center-left, L-shaped) ───────────────────
    { x: -30,   y: -3, w: 12, h: 18, type: 'building' },  // main vertical block
    { x: -22.5, y:  4.5, w:  9, h:  9, type: 'building' },  // horizontal wing

    // ── Power building (center-right, U-shaped) ──────────────────────────────
    { x:  15,   y: -7.5, w:  4.5, h: 12, type: 'building' },  // left arm
    { x:  24,   y: -7.5, w:  4.5, h: 12, type: 'building' },  // right arm
    { x:  19.5, y: -12, w: 13.5, h:  3, type: 'building' },   // top crossbar

    // ── Main building (bottom half, L-shaped) ────────────────────────────────
    { x: -33, y: 21,   w: 21, h: 15, type: 'building' },  // garage wing (9 bays)
    { x:  -6, y: 16.5, w: 36, h: 18, type: 'building' },  // main wing
  ],
  spawnPoints: [
    { x:   0, y:   3, facing:   0, team: 'player' },  // center courtyard, facing north
    { x: -21, y: -18, facing: 135, team: 'ai' },      // NW area, facing SE
    { x:  45, y:   7.5, facing: 270, team: 'ai' },    // east side, facing west
  ],
};
