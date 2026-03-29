import type { Position, Rect } from '@carwars/shared';
import type { StandardSurface } from '@carwars/shared';

// Vehicle axis-aligned bounding box half-extents (world units)
const VEH_HW = 0.5;  // half-width  (vehicle is 1 unit wide)
const VEH_HH = 1.0;  // half-height (vehicle is 2 units long)

export interface WallHit {
  x: number;
  y: number;
  hit: boolean;
  facing: StandardSurface;  // armor panel that took the primary impact
}

/**
 * Checks a vehicle position against a list of wall rects and resolves collisions.
 *
 * NOTE: wall.x and wall.y are the CENTER of the rectangle, not the top-left corner.
 *
 * On overlap, pushes the vehicle out along the axis of minimum penetration.
 * When multiple walls are hit, `facing` reflects the wall with the largest push-out
 * magnitude (the primary impact). Position corrections are applied cumulatively.
 *
 * Vehicle is modelled as a 1×2 unit AABB centered at pos.
 */
export function resolveWallCollisions(pos: Position, walls: Rect[]): WallHit {
  let { x, y } = pos;
  let hit = false;
  let primaryFacing: StandardSurface | null = null;
  let maxPush = 0;

  for (const wall of walls) {
    const overlapX = (VEH_HW + wall.w / 2) - Math.abs(x - wall.x);
    const overlapY = (VEH_HH + wall.h / 2) - Math.abs(y - wall.y);

    if (overlapX <= 0 || overlapY <= 0) continue;  // no collision

    hit = true;

    let thisFacing: StandardSurface;
    if (overlapX < overlapY) {
      // Push horizontally (thinner penetration axis)
      if (x < wall.x) { x -= overlapX; thisFacing = 'right'; }
      else             { x += overlapX; thisFacing = 'left'; }
      if (overlapX > maxPush) { maxPush = overlapX; primaryFacing = thisFacing; }
    } else {
      // Push vertically
      if (y < wall.y) { y -= overlapY; thisFacing = 'back'; }
      else             { y += overlapY; thisFacing = 'front'; }
      if (overlapY > maxPush) { maxPush = overlapY; primaryFacing = thisFacing; }
    }
  }

  return { x, y, hit, facing: primaryFacing ?? 'front' };
}
