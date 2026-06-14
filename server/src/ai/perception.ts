// AI perception — what an AI-driven vehicle can actually SEE this tick.
//
// Until now every AI got the full vehicle list with exact positions every tick
// (omniscient — "they always know where I am"). This module gates that: an
// enemy is only perceived if it's within sensor range AND in line of sight
// (walls block vision). When nothing is visible the driver drops into a SEARCH
// state (pursue last-known → scout enemy spawns/hotspots → hold and ambush).

import type { VehicleState, Rect, Position, ArenaMap } from '@carwars/shared';

// ── Detection ────────────────────────────────────────────────────────────────
// Detection is LINE OF SIGHT within a skill-scaled SIGHT RANGE — you need both
// a clear line (walls break it) AND to be close enough to make the vehicle out.
// The only ways to know an enemy's position otherwise:
//   - an ASSUMPTION (scout known spawn points / last-known), or
//   - dedicated EQUIPMENT — the 'radar' accessory detects through obstacles
//     within radar range (infrared is night-vision, a separate concern).
export const RADAR_ID = 'radar';
export const RADAR_RANGE = 60; // radar detects vehicles (even through walls) within this

// Eye sight range, scaled by crew skill. KEEP IN SYNC with the duplicate
// constants in client src/game/visibility.ts so AI and player vision match.
export const SIGHT_BASE = 25;
export const SIGHT_PER_SKILL = 2.8; // skill 1 ≈ 28, skill 3 ≈ 33, skill 6 ≈ 42
export function sightRange(skill: number): number {
  return SIGHT_BASE + Math.max(0, skill) * SIGHT_PER_SKILL;
}

function hasRadar(v: VehicleState): boolean {
  return !!v.stats.loadout?.accessories?.some(a => a.id === RADAR_ID);
}

// How long (ticks) a last-known sighting stays useful before it goes stale.
// Skilled crews hold the trail longer.
export const MEMORY_TTL_BASE = 90;
export const MEMORY_TTL_PER_SKILL = 30;

export function memoryTtl(skill: number): number {
  return MEMORY_TTL_BASE + Math.max(0, skill) * MEMORY_TTL_PER_SKILL;
}

// How long a vehicle will sit in ambush before giving up and scouting — stops
// two cautious vehicles from both holding forever (permanent stalemate).
// Patient veterans wait longer.
export const AMBUSH_PATIENCE_BASE = 240;
export const AMBUSH_PATIENCE_PER_SKILL = 40;

export function ambushPatience(skill: number): number {
  return AMBUSH_PATIENCE_BASE + Math.max(0, skill) * AMBUSH_PATIENCE_PER_SKILL;
}

function dist2d(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Clear line of sight from `from` to `to` — sample the segment and fail if any
// point lands inside a wall rectangle. 0.5u step matches the wall-probe
// resolution used elsewhere in the AI.
export function hasLineOfSight(from: Position, to: Position, walls: Rect[]): boolean {
  if (!walls.length) return true;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist / 0.5));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const px = from.x + dx * t;
    const py = from.y + dy * t;
    for (const wall of walls) {
      const ox = wall.w / 2 - Math.abs(px - wall.x);
      const oy = wall.h / 2 - Math.abs(py - wall.y);
      if (ox > 0 && oy > 0) return false;
    }
  }
  return true;
}

// The enemies this vehicle can actually detect right now: anything in clear
// line of sight within sight range, plus — if fitted with radar — anything
// within radar range even through walls.
export function computeVisibleEnemies(
  self: VehicleState,
  enemies: VehicleState[],
  walls: Rect[],
  skill: number,
): VehicleState[] {
  const radar = hasRadar(self);
  const sight = sightRange(skill);
  return enemies.filter(e => {
    const d = dist2d(self.position, e.position);
    if (d <= sight && hasLineOfSight(self.position, e.position, walls)) return true;
    if (radar && d <= RADAR_RANGE) return true;
    return false;
  });
}

// ── Last-known memory ──────────────────────────────────────────────────────
export interface Sighting { x: number; y: number; facing: number; tick: number }

// Record/refresh sightings for the enemies currently visible.
export function rememberSightings(
  memory: Map<string, Sighting>,
  visible: VehicleState[],
  tick: number,
): void {
  for (const e of visible) {
    memory.set(e.id, { x: e.position.x, y: e.position.y, facing: e.facing, tick });
  }
}

// The freshest non-stale sighting, or null. Negative age (tick reset between
// matches) is treated as stale so memory never leaks across matches.
export function freshestSighting(
  memory: Map<string, Sighting>,
  tick: number,
  ttl: number,
): Sighting | null {
  let best: Sighting | null = null;
  for (const s of memory.values()) {
    const age = tick - s.tick;
    if (age < 0 || age > ttl) continue;
    if (!best || s.tick > best.tick) best = s;
  }
  return best;
}

// ── Search planning ──────────────────────────────────────────────────────────
export type SearchMode = 'pursue' | 'scout' | 'ambush';

export interface SearchPlan {
  mode: SearchMode;
  goal: Position;   // where to go / face toward
  hold: boolean;    // true = hold position and wait (ambush); false = move to goal
}

// Candidate scout points: spawn points + arena centre, farthest-from-self first
// (the enemy most likely sits away from our own corner). Falls back to centre
// when a map has no spawns (e.g. unit-test maps).
export function scoutPoints(self: VehicleState, map: ArenaMap | undefined): Position[] {
  const pts: Position[] = (map?.spawnPoints ?? []).map(s => ({ x: s.x, y: s.y }));
  pts.push({ x: 0, y: 0 }); // arena centre is always a sensible sweep target
  return pts.sort((a, b) => dist2d(self.position, b) - dist2d(self.position, a));
}

// Decide what to do when no enemy is visible.
//   - fresh last-known sighting  → pursue it
//   - cautious / hurt / sniper   → hold and ambush (let them come)
//   - otherwise                  → scout toward enemy spawns / hotspots
// `proactive` (the player's autopilot) never ambushes — the player engaged
// autopilot to go FIND the fight, not camp spawn — so it always scouts/pursues.
export function planSearch(opts: {
  self: VehicleState;
  memory: Map<string, Sighting>;
  map: ArenaMap | undefined;
  tick: number;
  skill: number;
  aggression: number;
  healthFrac: number;
  ambusher: boolean;          // long-range / sniper loadout prefers to wait
  scoutTarget: Position | null; // current rotating scout target from driver state
  proactive?: boolean;        // true = always hunt (player autopilot), never camp
}): SearchPlan {
  const fresh = freshestSighting(opts.memory, opts.tick, memoryTtl(opts.skill));
  if (fresh) {
    return { mode: 'pursue', goal: { x: fresh.x, y: fresh.y }, hold: false };
  }

  // Ambush when timid, hurt, or built for range — sit tight and wait for a
  // target to walk into view rather than chasing blind. Proactive (autopilot)
  // drivers skip this and always go looking.
  const wantsAmbush = !opts.proactive && (opts.aggression <= 2 || opts.healthFrac < 0.4 || opts.ambusher);
  if (wantsAmbush) {
    // Face toward the likeliest approach (current scout target / centre).
    const face = opts.scoutTarget ?? scoutPoints(opts.self, opts.map)[0] ?? { x: 0, y: 0 };
    return { mode: 'ambush', goal: face, hold: true };
  }

  const goal = opts.scoutTarget ?? scoutPoints(opts.self, opts.map)[0] ?? { x: 0, y: 0 };
  return { mode: 'scout', goal, hold: false };
}
