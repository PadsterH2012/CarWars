import type { Position, Rect } from '@carwars/shared';
import type { StandardSurface } from '@carwars/shared';

// Vehicle axis-aligned bounding box half-extents (world units)
const VEH_HW = 0.5;  // half-width  (vehicle is 1 unit wide)
const VEH_HH = 1.0;  // half-height (vehicle is 2 units long)

export interface WallHit {
  x: number;
  y: number;
  hit: boolean;
  facing: StandardSurface;  // armor panel that made contact
}

/**
 * Checks a vehicle position against a list of wall rects.
 * On overlap, pushes the vehicle out along the axis of minimum penetration
 * and records which facing panel was hit.
 *
 * Vehicle is treated as a 1×2 unit AABB centered at pos.
 */
export function resolveWallCollisions(pos: Position, walls: Rect[]): WallHit {
  let { x, y } = pos;
  let hit = false;
  let facing: StandardSurface = 'front';

  for (const wall of walls) {
    const overlapX = (VEH_HW + wall.w / 2) - Math.abs(x - wall.x);
    const overlapY = (VEH_HH + wall.h / 2) - Math.abs(y - wall.y);

    if (overlapX <= 0 || overlapY <= 0) continue;  // no collision

    hit = true;

    if (overlapX < overlapY) {
      // Push horizontally (thinner penetration axis)
      if (x < wall.x) { x -= overlapX; facing = 'right'; }
      else             { x += overlapX; facing = 'left'; }
    } else {
      // Push vertically
      if (y < wall.y) { y -= overlapY; facing = 'back'; }
      else             { y += overlapY; facing = 'front'; }
    }
  }

  return { x, y, hit, facing };
}
