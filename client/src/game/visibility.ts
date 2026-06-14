// Client-side visibility / fog-of-war geometry. All coordinates are world
// INCHES (the same units as vehicle positions and wall rects), matching the
// server perception model in rules/perception.ts.

import type { Rect, VehicleState } from '@carwars/shared';

export interface Pt { x: number; y: number }

export const RADAR_ID = 'radar';
export const RADAR_RANGE = 60; // matches server rules/perception.ts

function hasRadar(v: VehicleState): boolean {
  return !!v.stats.loadout?.accessories?.some(a => a.id === RADAR_ID);
}

// ── Line of sight (point-to-point) ──────────────────────────────────────────
// Clear if no wall lies on the segment. 0.5-unit sampling, same as the server.
export function lineOfSight(from: Pt, to: Pt, walls: Rect[]): boolean {
  if (!walls.length) return true;
  const dx = to.x - from.x, dy = to.y - from.y;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.5));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const px = from.x + dx * t, py = from.y + dy * t;
    for (const w of walls) {
      if (w.w / 2 - Math.abs(px - w.x) > 0 && w.h / 2 - Math.abs(py - w.y) > 0) return false;
    }
  }
  return true;
}

// Is `target` perceived by any of the `viewers` — clear LOS, or within radar
// range (through walls) if any viewer carries radar.
export function isPerceived(target: Pt, viewers: VehicleState[], walls: Rect[]): boolean {
  const radar = viewers.some(hasRadar);
  for (const v of viewers) {
    if (lineOfSight(v.position, target, walls)) return true;
    if (radar && Math.hypot(v.position.x - target.x, v.position.y - target.y) <= RADAR_RANGE) return true;
  }
  return false;
}

// ── Visibility polygon (shadowcasting) ───────────────────────────────────────
// Cast rays from `origin` to every wall/bounds corner (± a sliver) and keep the
// nearest hit, producing the polygon of area visible from that point. Walls are
// axis-aligned rects; `bounds` is the map rectangle (inches, centred on 0,0).

interface Seg { ax: number; ay: number; bx: number; by: number }

function rectSegments(r: { x: number; y: number; w: number; h: number }): Seg[] {
  const l = r.x - r.w / 2, rt = r.x + r.w / 2, t = r.y - r.h / 2, b = r.y + r.h / 2;
  return [
    { ax: l, ay: t, bx: rt, by: t },
    { ax: rt, ay: t, bx: rt, by: b },
    { ax: rt, ay: b, bx: l, by: b },
    { ax: l, ay: b, bx: l, by: t },
  ];
}

// Nearest intersection distance (t along the ray, in units) of a ray from
// `o` in direction (dx,dy) with segment s, or Infinity.
function raySeg(o: Pt, dx: number, dy: number, s: Seg): number {
  const sdx = s.bx - s.ax, sdy = s.by - s.ay;
  const denom = dx * sdy - dy * sdx;
  if (Math.abs(denom) < 1e-9) return Infinity; // parallel
  const t2 = ((s.ax - o.x) * dy - (s.ay - o.y) * dx) / denom;
  if (t2 < 0 || t2 > 1) return Infinity;
  const t1 = ((s.ax - o.x) * sdy - (s.ay - o.y) * sdx) / denom;
  return t1 > 0 ? t1 : Infinity;
}

export function visibilityPolygon(
  origin: Pt,
  walls: Rect[],
  bounds: { x: number; y: number; w: number; h: number },
): Pt[] {
  const segs: Seg[] = [...rectSegments(bounds)];
  for (const w of walls) segs.push(...rectSegments(w));

  // Candidate angles: toward every segment endpoint, ± a sliver so rays slip
  // past corners and reach what's behind them.
  const corners: Pt[] = [];
  for (const s of segs) { corners.push({ x: s.ax, y: s.ay }, { x: s.bx, y: s.by }); }
  const angles: number[] = [];
  for (const c of corners) {
    const a = Math.atan2(c.y - origin.y, c.x - origin.x);
    angles.push(a - 0.0002, a, a + 0.0002);
  }
  angles.sort((p, q) => p - q);

  const hits: { ang: number; x: number; y: number }[] = [];
  for (const a of angles) {
    const dx = Math.cos(a), dy = Math.sin(a);
    let best = Infinity;
    for (const s of segs) {
      const t = raySeg(origin, dx, dy, s);
      if (t < best) best = t;
    }
    if (best !== Infinity) hits.push({ ang: a, x: origin.x + dx * best, y: origin.y + dy * best });
  }
  return hits.map(h => ({ x: h.x, y: h.y }));
}
