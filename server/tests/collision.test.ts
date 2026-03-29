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

  it('pushes vehicle right when overlapping left side of wall', () => {
    // Vehicle at (+4, 0), to the right of wall center
    // overlapX = 5.5 - 4 = 1.5; overlapY = 3; push right: x += 1.5 → 5.5
    const result = resolveWallCollisions({ x: 4, y: 0 }, [wall]);
    expect(result.hit).toBe(true);
    expect(result.x).toBeCloseTo(5.5);
    expect(result.facing).toBe('left');
  });

  it('resolves corner collision — facing reflects larger push', () => {
    // Two walls forming an L-corner
    const hWall: Rect = { x: 0, y: -2, w: 20, h: 2 };   // horizontal wall, center at y=-2
    const vWall: Rect = { x: -8, y: 0, w: 2, h: 20 };   // vertical wall, center at x=-8
    // Vehicle at (-7, -1): inside both walls
    // vs hWall: overlapX = (0.5+10)-7=3.5, overlapY = (1+1)-|-1-(-2)|=2-1=1
    //   overlapY(1) < overlapX(3.5) → push vertically; y(-1) > wall.y(-2) → y += 1 → 0, facing='front', maxPush=1
    // vs vWall (updated pos x=-7, y=0): overlapX = (0.5+1)-|-7-(-8)|=1.5-1=0.5, overlapY = (1+10)-|0-0|=11
    //   overlapX(0.5) < overlapY(11) → push horizontally; x(-7) > wall.x(-8) → x += 0.5, thisFacing='left'
    //   overlapX(0.5) < maxPush(1) → primaryFacing unchanged
    const result = resolveWallCollisions({ x: -7, y: -1 }, [hWall, vWall]);
    expect(result.hit).toBe(true);
    // Primary push from hWall (overlapY=1) is larger than vWall's horizontal push (overlapX=0.5)
    expect(result.facing).toBe('front');  // hWall pushed vehicle down (vehicle was below hWall center)
  });
});
