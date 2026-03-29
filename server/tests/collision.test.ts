import { describe, it, expect } from 'vitest';
import { resolveWallCollisions } from '../src/rules/collision';
import type { Rect } from '@carwars/shared';

const wall: Rect = { x: 0, y: 0, w: 10, h: 4 };  // 10×4 block centered at origin

describe('resolveWallCollisions', () => {
  it('returns no hit when vehicle is clear', () => {
    const result = resolveWallCollisions({ x: 0, y: 10 }, [wall]);
    expect(result.hit).toBe(false);
    expect(result.x).toBe(0);
    expect(result.y).toBe(10);
  });

  it('pushes vehicle up when overlapping top of wall', () => {
    // Vehicle at (0, -1): vehicle half-height=1, wall half-height=2 → need 3 clearance
    // vehicle is above wall center (y < 0) → push up to y=-3
    const result = resolveWallCollisions({ x: 0, y: -1 }, [wall]);
    expect(result.hit).toBe(true);
    expect(result.y).toBeCloseTo(-3);
    expect(result.facing).toBe('back');
  });

  it('pushes vehicle down when overlapping bottom of wall', () => {
    const result = resolveWallCollisions({ x: 0, y: 1 }, [wall]);
    expect(result.hit).toBe(true);
    expect(result.y).toBeCloseTo(3);
    expect(result.facing).toBe('front');
  });

  it('pushes vehicle left when overlapping right side of wall', () => {
    // Vehicle at (-4, 0): VEH_HW=0.5, wall half-width=5 → need 5.5 clearance
    // overlapX = 5.5 - 4 = 1.5; overlapY = 3 - 0 = 3; overlapX < overlapY → push horizontal
    // x < wall.x (vehicle left of center) → push further left: x -= 1.5 → x = -5.5
    const result = resolveWallCollisions({ x: -4, y: 0 }, [wall]);
    expect(result.hit).toBe(true);
    expect(result.x).toBeCloseTo(-5.5);
    expect(result.facing).toBe('right');
  });

  it('no hit when vehicle is outside all walls', () => {
    const walls: Rect[] = [
      { x: -20, y: 0, w: 5, h: 5 },
      { x:  20, y: 0, w: 5, h: 5 },
    ];
    const result = resolveWallCollisions({ x: 0, y: 0 }, walls);
    expect(result.hit).toBe(false);
  });
});
