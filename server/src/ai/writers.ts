// Writers — each function deposits interest or danger into a ContextRing.
// The ring's max-not-sum rule means writers can be layered freely without
// silently clobbering each other, which is the structural protection the
// previous "gate later stages on a flag" hot-patches were faking.
//
// Convention: bearings are compass degrees (0 = north), same as driver.ts
// throughout. All geometry helpers are duplicated here intentionally — the
// writer module is meant to be importable without pulling driver.ts along.

import type { Rect, VehicleState, WreckageObject, Position } from '@carwars/shared';
import { ContextRing } from './context-ring';
import { WEAPONS } from '../rules/data/weapons';

// ── Geometry helpers (local so writers are self-contained) ──────────────────

function bearingTo(from: Position, to: Position): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const mathAngle = Math.atan2(-dy, dx) * 180 / Math.PI;
  return (90 - mathAngle + 360) % 360;
}

function pointAt(p: Position, bearing: number, d: number): Position {
  return {
    x: p.x + Math.sin(bearing * Math.PI / 180) * d,
    y: p.y - Math.cos(bearing * Math.PI / 180) * d,
  };
}

function dist2d(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ── Wall danger writer ──────────────────────────────────────────────────────

// Vehicle probe half-size — matches the existing constants in driver.ts so the
// ring writer and the legacy avoidance path agree on clearance.
const VEH_PROBE_W = 0.9;
const VEH_PROBE_H = 1.4;

// Single-ray probe along `bearing` up to `maxDist`. Returns the hit distance,
// or null if no wall lies on the ray within range.
function probeWallHit(pos: Position, bearing: number, walls: Rect[], maxDist: number): number | null {
  for (let d = 1.0; d <= maxDist; d += 0.5) {
    const probe = pointAt(pos, bearing, d);
    for (const wall of walls) {
      const ox = (VEH_PROBE_W + wall.w / 2) - Math.abs(probe.x - wall.x);
      const oy = (VEH_PROBE_H + wall.h / 2) - Math.abs(probe.y - wall.y);
      if (ox > 0 && oy > 0) return d;
    }
  }
  return null;
}

// One ray per slot (16 rays, every 22.5°) — full 360° coverage at the same
// angular resolution as the ring itself. Coarser 8-ray fans missed walls
// that sat between two rays and let the AI steer confidently into them
// (the concave-corner scenario test caught this). No falloff needed: each
// ray lands in its own slot, so neighbours only light up when a wall is
// genuinely close across multiple rays.
const WALL_FALLOFF = 0;

export function writeWallDanger(
  ring: ContextRing,
  pos: Position,
  _facing: number,
  walls: Rect[],
  speed: number,
): void {
  if (walls.length === 0) return;
  const maxDist = Math.max(5, Math.min(12, speed / 8));
  for (let i = 0; i < 16; i++) {
    const rayBearing = i * 22.5;
    const hit = probeWallHit(pos, rayBearing, walls, maxDist);
    if (hit === null) continue;
    // Danger: 1 when hit is right in front (d=1), fading to 0 at maxDist
    const danger = 1 - (hit - 1) / Math.max(0.1, maxDist - 1);
    ring.writeDanger(rayBearing, Math.max(0.1, Math.min(1, danger)), WALL_FALLOFF);
  }
}

// ── Vehicle proximity + blast-hazard writer ─────────────────────────────────

const FRIEND_AVOID_RANGE = 5;
const BLAST_HAZARD_RANGE = 5;
const LOW_HP_FRACTION   = 0.30;
// Healthy-enemy collision avoidance. Without this, no danger is written around
// an enemy at full health, so the tactic's goal-interest steers the AI dead
// into its target — both cars take 20+ collision damage and mutually destroy.
// A modest bubble (collisions happen inside ~2 units) lets the AI still close
// to weapon range while the ring veers it to pass ALONGSIDE rather than ram.
const ENEMY_AVOID_RANGE    = 4;
const ENEMY_AVOID_STRENGTH = 0.9;
// A ramplate vehicle that's still healthy is allowed to ram — that's its job —
// so it skips enemy avoidance. Below this health it stops suiciding too.
const RAM_HEALTH_FLOOR     = 0.4;

function vehicleHealthFrac(v: VehicleState): number {
  const ds = v.stats.damageState;
  const orig = v.stats.loadout?.armor ?? {};
  const faces = ['front', 'back', 'left', 'right', 'top', 'underbody'] as const;
  let origTotal = 0, curTotal = 0;
  for (const f of faces) {
    origTotal += (orig as Record<string, number>)[f] ?? 0;
    curTotal  += (ds.armor as Record<string, number>)[f] ?? 0;
  }
  return origTotal > 0 ? curTotal / origTotal : 1;
}

// Write danger around any nearby vehicle that's either a squadmate in the
// avoidance bubble OR any vehicle looking ready to cook off. Danger is
// strongest at the bearing TO the hazard — the ring will then naturally
// steer to the lowest-danger direction (usually away from it).
// Cautious-profile overrides (used by the player's autopilot) — wider blast
// avoidance, earlier reaction to vehicles that might pop, bigger enemy standoff.
export interface VehicleDangerOpts {
  friendRange?: number;
  blastRange?: number;
  lowHpFrac?: number;
  enemyAvoidRange?: number;
}

export function writeVehicleDanger(
  ring: ContextRing,
  self: VehicleState,
  allVehicles: VehicleState[],
  opts: VehicleDangerOpts = {},
): void {
  const friendRange = opts.friendRange     ?? FRIEND_AVOID_RANGE;
  const blastRange  = opts.blastRange      ?? BLAST_HAZARD_RANGE;
  const lowHpFrac   = opts.lowHpFrac       ?? LOW_HP_FRACTION;
  const enemyRange  = opts.enemyAvoidRange ?? ENEMY_AVOID_RANGE;
  // A healthy ramplate vehicle is on a ramming tactic — it should NOT avoid
  // enemies. Everyone else (and a wrecked rammer) steers clear of collisions.
  const ramming = !!self.stats.loadout?.hasRamplate && vehicleHealthFrac(self) > RAM_HEALTH_FLOOR;
  for (const v of allVehicles) {
    if (v.id === self.id) continue;
    if (v.stats.damageState.destroyed) continue;
    const d = dist2d(self.position, v.position);
    let urgency = 0;
    if (v.playerId === self.playerId && d < friendRange) {
      urgency = 1 - d / friendRange;
    }
    const hp = vehicleHealthFrac(v);
    if (hp < lowHpFrac && d < blastRange) {
      const blastUrgency = 1 - d / blastRange;
      urgency = Math.max(urgency, blastUrgency * 1.2); // blast trumps squad spacing
    }
    // Healthy enemy — avoid the collision. sqrt ramp so danger rises sharply
    // as the gap closes, giving the ring time to pick a tangential heading
    // before the cars overlap. Skipped when WE are ramming on purpose.
    if (!ramming && v.playerId !== self.playerId && d < enemyRange) {
      const proximity = Math.sqrt(Math.max(0, 1 - d / enemyRange));
      urgency = Math.max(urgency, proximity * ENEMY_AVOID_STRENGTH);
    }
    if (urgency <= 0) continue;
    const bearing = bearingTo(self.position, v.position);
    ring.writeDanger(bearing, urgency, 0.7); // wider falloff — don't just dodge the slot
  }
}

// ── Wreckage writer ─────────────────────────────────────────────────────────

const WRECK_RANGE = 8;
const WRECK_STATE_MUL: Record<WreckageObject['state'], number> = {
  burning:     1.3,
  smouldering: 1.0,
  debris:      0.7,
};

// Wreckage closes the pre-ring blind spot — previously the AI had no clue
// there was a smouldering hulk between it and its target. Writes danger
// at the bearing to the wreck with a sqrt ramp so even a wreck 2+ units
// further than the outer range edge still registers enough to out-compete
// the tactic's interest at that bearing.
export function writeWreckageDanger(
  ring: ContextRing,
  self: VehicleState,
  wreckage: WreckageObject[],
): void {
  for (const w of wreckage) {
    const d = dist2d(self.position, w.position);
    if (d >= WRECK_RANGE) continue;
    // sqrt ramp so danger rises fast as the wreck enters range — gives the
    // AI time to pick a new bearing before it's committed to the collision
    const proximity = Math.sqrt(1 - d / WRECK_RANGE);
    const strength = Math.min(1, proximity * (WRECK_STATE_MUL[w.state] ?? 1.0));
    if (strength <= 0) continue;
    const bearing = bearingTo(self.position, w.position);
    ring.writeDanger(bearing, strength, 0.5);
  }
}

// ── Path writer ─────────────────────────────────────────────────────────────
//
// Takes an A*-smoothed path and writes interest at the bearing toward the
// first useful waypoint. "Useful" = the first waypoint that's at least
// LOOKAHEAD_MIN units ahead of the vehicle — skipping waypoints the vehicle
// has already effectively passed. Strength should match the tactic's
// interest priority (e.g. 0.9 for aggressive) so the ring's selection is
// the same as a direct-line tactic when the path is straight, and only
// differs when the path wraps around geometry.
const PATH_LOOKAHEAD_MIN = 2;

export function writePathInterest(
  ring: ContextRing,
  self: VehicleState,
  path: Position[],
  strength: number,
): boolean {
  if (path.length === 0) return false;
  for (const waypoint of path) {
    const d = dist2d(self.position, waypoint);
    if (d < PATH_LOOKAHEAD_MIN) continue;
    const bearing = bearingTo(self.position, waypoint);
    // Single-slot write — path already handles routing around geometry, no
    // need for ±45°/±90° sidesteps (those would bypass the path's planning).
    ring.writeInterest(bearing, strength);
    return true;
  }
  // All waypoints are within the lookahead radius — we're essentially at
  // the goal. Write interest at the last waypoint so the vehicle finishes
  // rather than drifting.
  const goal = path[path.length - 1];
  const dGoal = dist2d(self.position, goal);
  if (dGoal < 0.5) return false; // basically on top of goal; let tactic fall through
  ring.writeInterest(bearingTo(self.position, goal), strength);
  return true;
}

// Commit-to-a-side helper used by tactic writer — when the direct line to
// the goal is blocked (target bearing's slot has danger), we need interest
// to survive in slots off-axis so the ring has somewhere to go. Writes
// symmetric interest at ±45° and ±90° off the primary — the ring's danger
// layer then selects whichever side is clear. Writing BOTH sides (rather
// than hash-picking one) is essential for concave-corner navigation: if
// the hash picked the blocked side, the AI would have no off-axis
// candidate at all.
export function writeGoalInterest(
  ring: ContextRing,
  _self: VehicleState,
  bearing: number,
  strength: number,
): void {
  ring.writeInterest(bearing, strength);
  // Mid-strength sidesteps 45° off both sides
  ring.writeInterest((bearing + 45 + 360) % 360, strength * 0.6);
  ring.writeInterest((bearing - 45 + 360) % 360, strength * 0.6);
  // Weaker 90° options both sides for when even the sidesteps are blocked
  ring.writeInterest((bearing + 90 + 360) % 360, strength * 0.3);
  ring.writeInterest((bearing - 90 + 360) % 360, strength * 0.3);
}

// ── Interest writers ────────────────────────────────────────────────────────

// Simple helper — write interest at a specific bearing. The tactic layer and
// commander-order short-circuits can use this without knowing ring details.
export function writeInterestAt(ring: ContextRing, bearing: number, strength: number): void {
  ring.writeInterest(bearing, strength);
}

// Stub for Phase 2's later tasks — survival and stuck-escape writers plug in
// via writeInterestAt for now. Keeping this module surface stable lets Phase 3
// add a writePathInterest(ring, self, path) alongside without re-signing the
// import list in driver.ts.
