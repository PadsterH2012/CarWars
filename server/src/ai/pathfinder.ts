// Arena pathfinder — A* on a derived grid of the static wall geometry, with
// wreckage treated as soft cost that biases the route without blocking it.
// Cached by from/to cell + wreckage hash so repeated lookups (e.g. a squad
// all heading to the same waypoint) stay under the per-tick budget.
//
// Phase 3 of the AI rewrite (see docs/plans/2026-04-21-ai-driver-rewrite-plan.md).
// Consumed by the context-steering ring via writePathInterest — the pathfinder
// supplies a first-waypoint bearing, the ring resolves local reactive
// avoidance around it.

import type { ArenaMap, Position, WreckageObject, Rect } from '@carwars/shared';
import { BinaryHeap } from './heap';

// Vehicle clearance for walkability probing — matches the driver's probe
// constants so the pathfinder respects the same safe margin the avoidance
// code does, avoiding routes where the vehicle would scrape a wall even if
// its centre cell is technically open.
const VEH_PROBE_W = 0.9;
const VEH_PROBE_H = 1.4;

// Cost multiplier added on cells within a wreck's footprint. Higher values
// push the route further around; never fully block (a burning wreck is still
// traversable if it's the only way, just very expensive).
const WRECK_STATE_COST: Record<WreckageObject['state'], number> = {
  burning:     5,
  smouldering: 3,
  debris:      1.5,
};
const WRECK_COST_RADIUS = 2; // cells

// Octile heuristic — admissible for 8-neighbour grids with diagonal cost √2.
const SQRT2 = Math.SQRT2;
function octileH(dx: number, dy: number): number {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  return (ax + ay) + (SQRT2 - 2) * Math.min(ax, ay);
}

interface CellCoord { cx: number; cy: number; }

export class Pathfinder {
  private readonly width: number;   // grid cells
  private readonly height: number;
  private readonly cellSize = 1;     // 1 world unit per cell
  private readonly offsetX: number;  // world-x of cell (0,0)
  private readonly offsetY: number;
  private readonly walkable: Uint8Array; // 1 = passable, 0 = wall
  private softCost: Float32Array;        // additional cost per cell (wreckage)

  // Cache: key `${fromIdx}-${toIdx}-${wreckageHash}` → path
  private cache = new Map<string, { path: Position[]; tick: number }>();
  private wreckageHash = '';

  constructor(private readonly map: ArenaMap) {
    this.width  = Math.max(1, Math.ceil(map.width));
    this.height = Math.max(1, Math.ceil(map.height));
    this.offsetX = -this.width  / 2;
    this.offsetY = -this.height / 2;
    this.walkable = new Uint8Array(this.width * this.height);
    this.softCost = new Float32Array(this.width * this.height);
    this.computeWalkable();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  // Find a path from world-position `from` to world-position `to`. Returns
  // null if unreachable, or a list of world-space waypoints (LOS-smoothed)
  // starting somewhere close to `from` and ending close to `to`.
  find(from: Position, to: Position): Position[] | null {
    const src = this.worldToCell(from);
    const dst = this.worldToCell(to);
    if (!this.inBounds(src) || !this.inBounds(dst)) return null;

    // Clamp src to a walkable cell (vehicle might be technically on a wall
    // edge due to physics — find a nearby walkable start rather than fail).
    const start = this.nearestWalkable(src);
    if (!start) return null;
    const goal = this.nearestWalkable(dst);
    if (!goal) return null;

    const key = `${start.cx},${start.cy}-${goal.cx},${goal.cy}-${this.wreckageHash}`;
    const hit = this.cache.get(key);
    if (hit) return hit.path;

    const raw = this.aStar(start, goal);
    if (!raw) {
      this.cache.set(key, { path: [], tick: 0 });
      return null;
    }

    const smoothed = this.smooth(raw);
    this.cache.set(key, { path: smoothed, tick: 0 });
    return smoothed;
  }

  // Update the wreckage obstacle layer. Call whenever the wreckage list
  // changes. Invalidates the path cache so stale routes don't outlive the
  // obstacles they were planned around.
  updateObstacles(wreckage: WreckageObject[]): void {
    const newHash = wreckage
      .map(w => `${w.id}:${w.state}:${w.position.x.toFixed(1)},${w.position.y.toFixed(1)}`)
      .sort()
      .join('|');
    if (newHash === this.wreckageHash) return;
    this.wreckageHash = newHash;
    this.cache.clear();

    this.softCost.fill(0);
    for (const w of wreckage) {
      const mul = WRECK_STATE_COST[w.state] ?? 1;
      const centre = this.worldToCell(w.position);
      for (let dy = -WRECK_COST_RADIUS; dy <= WRECK_COST_RADIUS; dy++) {
        for (let dx = -WRECK_COST_RADIUS; dx <= WRECK_COST_RADIUS; dx++) {
          const c = { cx: centre.cx + dx, cy: centre.cy + dy };
          if (!this.inBounds(c)) continue;
          const distSq = dx * dx + dy * dy;
          if (distSq > WRECK_COST_RADIUS * WRECK_COST_RADIUS) continue;
          const falloff = 1 - Math.sqrt(distSq) / (WRECK_COST_RADIUS + 0.1);
          const idx = c.cy * this.width + c.cx;
          this.softCost[idx] += mul * falloff;
        }
      }
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private computeWalkable(): void {
    for (let cy = 0; cy < this.height; cy++) {
      for (let cx = 0; cx < this.width; cx++) {
        const pos = this.cellToWorld({ cx, cy });
        this.walkable[cy * this.width + cx] = this.isClear(pos) ? 1 : 0;
      }
    }
  }

  private isClear(pos: Position): boolean {
    for (const wall of this.map.walls) {
      const ox = (VEH_PROBE_W + wall.w / 2) - Math.abs(pos.x - wall.x);
      const oy = (VEH_PROBE_H + wall.h / 2) - Math.abs(pos.y - wall.y);
      if (ox > 0 && oy > 0) return false;
    }
    return true;
  }

  private inBounds(c: CellCoord): boolean {
    return c.cx >= 0 && c.cx < this.width && c.cy >= 0 && c.cy < this.height;
  }

  private worldToCell(p: Position): CellCoord {
    return {
      cx: Math.max(0, Math.min(this.width  - 1, Math.floor(p.x - this.offsetX))),
      cy: Math.max(0, Math.min(this.height - 1, Math.floor(p.y - this.offsetY))),
    };
  }

  private cellToWorld(c: CellCoord): Position {
    return {
      x: c.cx + this.offsetX + 0.5,
      y: c.cy + this.offsetY + 0.5,
    };
  }

  // Find the nearest walkable cell via BFS outward from the given cell.
  // If the cell itself is clear, return it immediately.
  private nearestWalkable(c: CellCoord): CellCoord | null {
    if (this.walkable[c.cy * this.width + c.cx]) return c;
    const visited = new Uint8Array(this.width * this.height);
    const queue: CellCoord[] = [c];
    visited[c.cy * this.width + c.cx] = 1;
    const limit = Math.min(50, this.width + this.height);
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const n = { cx: cur.cx + dx, cy: cur.cy + dy };
          if (!this.inBounds(n)) continue;
          const nIdx = n.cy * this.width + n.cx;
          if (visited[nIdx]) continue;
          visited[nIdx] = 1;
          if (this.walkable[nIdx]) return n;
          if (queue.length < limit * limit) queue.push(n);
        }
      }
    }
    return null;
  }

  private aStar(start: CellCoord, goal: CellCoord): CellCoord[] | null {
    const nCells = this.width * this.height;
    const gScore = new Float32Array(nCells).fill(Infinity);
    const cameFrom = new Int32Array(nCells).fill(-1);
    const closed = new Uint8Array(nCells);
    const open = new BinaryHeap<number>();

    const startIdx = start.cy * this.width + start.cx;
    const goalIdx  = goal.cy * this.width + goal.cx;
    gScore[startIdx] = 0;
    open.push(startIdx, octileH(goal.cx - start.cx, goal.cy - start.cy));

    while (open.size > 0) {
      const cur = open.pop()!;
      const curIdx = cur.item;
      if (curIdx === goalIdx) {
        // Reconstruct
        const out: CellCoord[] = [];
        let i = curIdx;
        while (i !== -1) {
          const cx = i % this.width;
          const cy = Math.floor(i / this.width);
          out.unshift({ cx, cy });
          if (i === startIdx) break;
          i = cameFrom[i];
        }
        return out;
      }
      if (closed[curIdx]) continue;
      closed[curIdx] = 1;

      const cx = curIdx % this.width;
      const cy = Math.floor(curIdx / this.width);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) continue;
          const nIdx = ny * this.width + nx;
          if (!this.walkable[nIdx]) continue;
          // Don't cut diagonals through wall corners (both orthogonal neighbours must be open)
          if (dx !== 0 && dy !== 0) {
            if (!this.walkable[cy * this.width + nx]) continue;
            if (!this.walkable[ny * this.width + cx]) continue;
          }
          const step = (dx !== 0 && dy !== 0) ? SQRT2 : 1;
          const tentative = gScore[curIdx] + step + this.softCost[nIdx];
          if (tentative < gScore[nIdx]) {
            gScore[nIdx] = tentative;
            cameFrom[nIdx] = curIdx;
            const h = octileH(goal.cx - nx, goal.cy - ny);
            open.push(nIdx, tentative + h);
          }
        }
      }
    }
    return null;
  }

  // LOS smoothing — string-pull the path. Walk through waypoints and remove
  // any that's line-of-sight between its siblings. Emits a compact list of
  // world-space positions.
  private smooth(cells: CellCoord[]): Position[] {
    const worldPath = cells.map(c => this.cellToWorld(c));
    if (worldPath.length <= 2) return worldPath;
    const out: Position[] = [worldPath[0]];
    let anchor = 0;
    for (let i = 2; i < worldPath.length; i++) {
      if (!this.hasLos(worldPath[anchor], worldPath[i])) {
        out.push(worldPath[i - 1]);
        anchor = i - 1;
      }
    }
    out.push(worldPath[worldPath.length - 1]);
    return out;
  }

  // Line-of-sight check between two world-space positions — uses the same
  // AABB + probe clearance as the walkable grid so smoothing can't produce
  // a shortcut that would scrape a wall.
  private hasLos(a: Position, b: Position): boolean {
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(2, Math.ceil(dist / 0.5));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (!this.isClear(p)) return false;
      // Also respect soft cost — if the path would cross an expensive cell,
      // prefer keeping the detour waypoint so the A* shape survives.
      const c = this.worldToCell(p);
      if (this.inBounds(c) && this.softCost[c.cy * this.width + c.cx] > 1) return false;
    }
    return true;
  }
}

// Exported small helper — returns "" when no wreckage, otherwise a compact
// hash that zone-runner can pass to AiContext and the pathfinder can compare
// against its last-seen hash to decide whether to refresh obstacles.
export function hashWreckage(wreckage: WreckageObject[]): string {
  return wreckage
    .map(w => `${w.id}:${w.state}`)
    .sort()
    .join('|');
}

// Re-export Rect so callers don't need a second import just for the type
export type { ArenaMap, Rect };
