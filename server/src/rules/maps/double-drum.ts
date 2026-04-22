import type { ArenaMap, Rect, SpawnPoint, FloorTile, Decoration } from '@carwars/shared';

/**
 * Double Drum Arena — inspired by the Car Wars 6E playmat of the same name.
 * Two circular "drums" joined by a central corridor. Mirror-symmetric about
 * both the vertical (x=0) and horizontal (y=0) axes, so every spawn point
 * has an exact geometric counterpart on the enemy side.
 *
 * This is carwars' first **symmetric combat arena** — Truck Stop and Town
 * Square keep their narrative asymmetry, but this map exists specifically
 * for balanced matches and AI regression testing where we need variance
 * in outcomes to reflect AI quality rather than terrain luck.
 *
 * Generated programmatically from three layers:
 *   1. Perimeter wall — polygonal approximation of each drum's circle
 *   2. Centre corridor — straight north & south walls linking the drums
 *   3. Spawn points — 4 per team, inside their drum, facing the corridor
 *
 * Scale: arena is 120 × 70 world units. Each drum has radius 25; centres
 * sit at (±30, 0). The 10-unit gap between drum edges is bridged by a
 * 16-unit-wide corridor (y=±8 wall lines). That corridor is the primary
 * combat lane — both teams rush toward it, the drums are safe "home"
 * areas to retreat into for flank manoeuvres.
 */

const ARENA_W = 120;
const ARENA_H = 70;
const DRUM_RADIUS = 25;
const DRUM_OFFSET = 30;       // x-distance from origin to each drum centre
const CORRIDOR_HALF_H = 8;    // corridor runs y = -8 to +8
const WALL_THICKNESS = 1;

// ─── Layer 1: perimeter wall generator ───────────────────────────────────

// Approximate a circle with short straight wall segments. Segments within
// `openArcDeg` of an "opening" bearing are skipped, leaving a gap that
// lines up with the corridor junction. Returns an array of Rects that can
// be merged into the final walls[] array.
function circlePerimeter(
  cx: number,
  cy: number,
  radius: number,
  opening: { bearing: number; width: number }, // bearing toward corridor + gap-width in degrees
  segCount = 48,
): Rect[] {
  const out: Rect[] = [];
  const segLen = (2 * Math.PI * radius) / segCount;
  for (let i = 0; i < segCount; i++) {
    const a = (i / segCount) * 360;
    const delta = Math.abs(((a - opening.bearing + 540) % 360) - 180);
    if (delta < opening.width / 2) continue; // skip = gate opening
    // Segment centre sits on the circle; segment runs tangent to the circle.
    const rad = (a - 90) * (Math.PI / 180);
    const px = cx + Math.cos(rad) * radius;
    const py = cy + Math.sin(rad) * radius;
    // Alternate segment orientation — at cardinal points segments are axis-aligned
    const horizontal = Math.abs(Math.cos(rad)) > Math.abs(Math.sin(rad));
    out.push({
      x: px, y: py,
      w: horizontal ? segLen : WALL_THICKNESS,
      h: horizontal ? WALL_THICKNESS : segLen,
      type: 'wall',
    });
  }
  return out;
}

// ─── Layer 2: corridor walls ────────────────────────────────────────────

const CORRIDOR_X_START = -DRUM_OFFSET + DRUM_RADIUS - 1; // slight overlap with drum exit
const CORRIDOR_X_END   =  DRUM_OFFSET - DRUM_RADIUS + 1;
const CORRIDOR_LEN = CORRIDOR_X_END - CORRIDOR_X_START;

const corridorWalls: Rect[] = [
  { x: 0, y: -CORRIDOR_HALF_H, w: CORRIDOR_LEN, h: WALL_THICKNESS, type: 'wall' }, // north wall
  { x: 0, y:  CORRIDOR_HALF_H, w: CORRIDOR_LEN, h: WALL_THICKNESS, type: 'wall' }, // south wall
  // Centre pillar — breaks the head-on collision pattern that made 1v1
  // matches 87% mutual destruction. Forces each vehicle to pick a side
  // (north or south around the pillar), naturally staggering encounters
  // and giving weapon-fire more time to resolve.
  { x: 0, y: 0, w: 3, h: 3, type: 'building' },
];

// ─── Layer 3: spawn points ──────────────────────────────────────────────

// 4 spawn points per team inside their drum. Placed on a small arc at the
// back (west for player / team_a, east for ai / team_b) facing toward the
// central corridor. The arc spread is wide enough that squadmates don't
// stack on each other at spawn.
function drumSpawns(
  centreX: number, centreY: number, backBearing: number,
  team: 'player' | 'ai',
): SpawnPoint[] {
  const spread = 30; // degrees on either side of the back bearing
  const angles = [backBearing - spread, backBearing, backBearing + spread, backBearing + 180];
  // One "rear guard" spawn at the far back plus three staggered toward the arc.
  const points: SpawnPoint[] = [];
  // Primary arc — 3 points
  for (const a of [backBearing - spread, backBearing, backBearing + spread]) {
    const rad = (a - 90) * (Math.PI / 180);
    const r = DRUM_RADIUS - 4;
    points.push({
      x: centreX + Math.cos(rad) * r,
      y: centreY + Math.sin(rad) * r,
      facing: (backBearing + 180 + 360) % 360, // face opposite of back = toward corridor
      team,
    });
  }
  // 4th spawn closer to centre for squad sizes of 4
  points.push({
    x: centreX + (team === 'player' ? -10 : +10),
    y: centreY,
    facing: (backBearing + 180 + 360) % 360,
    team,
  });
  void angles; // retained for future custom arcs
  return points;
}

const leftDrumSpawns  = drumSpawns(-DRUM_OFFSET, 0, 270, 'player'); // back = west, face east
const rightDrumSpawns = drumSpawns( DRUM_OFFSET, 0,  90, 'ai');      // back = east, face west

// ─── Floor + decorations (visual polish) ────────────────────────────────

const floor: FloorTile[] = [
  // Drum interiors — asphalt disks (square-approximation is fine for render)
  { x: -DRUM_OFFSET, y: 0, w: DRUM_RADIUS * 2, h: DRUM_RADIUS * 2, type: 'asphalt' },
  { x:  DRUM_OFFSET, y: 0, w: DRUM_RADIUS * 2, h: DRUM_RADIUS * 2, type: 'asphalt' },
  // Central corridor — concrete (visual distinction from drums)
  { x: 0, y: 0, w: CORRIDOR_LEN, h: CORRIDOR_HALF_H * 2, type: 'concrete' },
];

const decorations: Decoration[] = [
  // Corridor centre line (yellow dashed) — makes the lane structure obvious
  { x: 0, y: 0, w: CORRIDOR_LEN - 2, h: 0.3, type: 'lane_yellow', facing: 90 },
  // Arena-centre danger zone tire marks (expect pileups)
  { x: 0, y: -3, w: 3, h: 0.4, type: 'tire_marks', facing: 0 },
  { x: 0, y:  3, w: 3, h: 0.4, type: 'tire_marks', facing: 0 },
  // Drum centre circles — concentric decor matching Car Wars playmat aesthetic
  { x: -DRUM_OFFSET, y: 0, w: 2, h: 2, type: 'pothole' },
  { x:  DRUM_OFFSET, y: 0, w: 2, h: 2, type: 'pothole' },
  // Corridor-side neon strips (signature arena look)
  { x: 0, y: -CORRIDOR_HALF_H + 0.5, w: CORRIDOR_LEN - 4, h: 0.2, type: 'neon_strip', facing: 90 },
  { x: 0, y:  CORRIDOR_HALF_H - 0.5, w: CORRIDOR_LEN - 4, h: 0.2, type: 'neon_strip', facing: 90 },
];

// ─── Assemble ───────────────────────────────────────────────────────────

// Openings face toward the corridor (left drum opens east=90°, right drum
// opens west=270°). Width is in degrees.
const leftPerimeter  = circlePerimeter(-DRUM_OFFSET, 0, DRUM_RADIUS, { bearing:  90, width: 40 });
const rightPerimeter = circlePerimeter( DRUM_OFFSET, 0, DRUM_RADIUS, { bearing: 270, width: 40 });

export const doubleDrumMap: ArenaMap = {
  id: 'double-drum',
  width: ARENA_W,
  height: ARENA_H,
  palette: 'urban',
  walls: [...leftPerimeter, ...rightPerimeter, ...corridorWalls],
  spawnPoints: [...leftDrumSpawns, ...rightDrumSpawns],
  floor,
  decorations,
};
