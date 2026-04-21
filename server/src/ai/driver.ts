import type { VehicleState, ArenaMap, SquadOrder } from '@carwars/shared';
import { WEAPONS } from '../rules/data/weapons';
import type { AiContext } from './types';
import { ContextRing } from './context-ring';
import { writeWallDanger, writeVehicleDanger, writeWreckageDanger, writeGoalInterest, writePathInterest } from './writers';

export type { AiContext } from './types';

export interface AiInput {
  speed: number;
  steer: number;
  fireWeapon: string | null;
}

type Tactic = 'aggressive' | 'flanking' | 'evasive' | 'snipe' | 'orbit';

const MAX_TURN = 30;

// Per-vehicle state that persists across ticks
interface DriverState {
  orbitDir: 1 | -1;       // clockwise (+1) or counter-clockwise (-1) orbit
  orbitFlipIn: number;    // ticks until next orbit direction reversal
  personality: number;    // 0.0–1.0: persistent variation — shifts orbit angles and range preference
  tactic: Tactic;
  tacticTicks: number;    // how long we've held this tactic
  stuckTicks: number;     // ticks without meaningful movement
  lastX: number;
  lastY: number;
  positionHistory: { x: number; y: number }[];  // ring buffer, last ~20 ticks; used for robust stuck detection
  reverseTicks: number;   // countdown of remaining ticks in an active reverse-out-of-wall manoeuvre
  inClose: boolean;       // hysteresis flag: true when inside closeRange dead-zone
  fireCooldown: number;   // ticks until next shot allowed (Car Wars: once per phase = 10 ticks)
  ring: ContextRing;      // per-vehicle context ring — mutated in place each tick
}
const driverState = new Map<string, DriverState>();

const POS_HISTORY_LEN = 20;
const REVERSE_BURST_TICKS = 10;   // after hitting a stuck state, reverse for this many ticks
const REVERSE_SPEED = -25;

function getState(vehicleId: string): DriverState {
  if (!driverState.has(vehicleId)) {
    driverState.set(vehicleId, {
      orbitDir: Math.random() < 0.5 ? 1 : -1,
      orbitFlipIn: 40 + Math.floor(Math.random() * 40),
      personality: Math.random(),
      tactic: 'aggressive',
      // Stagger tactic-change timing so vehicles don't all switch at once
      tacticTicks: Math.floor(Math.random() * 15),
      stuckTicks: 0,
      lastX: 0,
      lastY: 0,
      positionHistory: [],
      reverseTicks: 0,
      inClose: false,
      fireCooldown: 0,
      ring: new ContextRing(),
    });
  }
  return driverState.get(vehicleId)!;
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

function dist2d(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

// Compass bearing from `from` to `to` (0=north, CW)
function bearingTo(from: { x: number; y: number }, to: { x: number; y: number }): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const mathAngle = Math.atan2(-dy, dx) * 180 / Math.PI;
  return (90 - mathAngle + 360) % 360;
}

// Point at bearing B, distance D from position P (game coordinate system: Y-down, north=0)
function pointAt(p: { x: number; y: number }, bearing: number, d: number): { x: number; y: number } {
  return {
    x: p.x + Math.sin(bearing * Math.PI / 180) * d,
    y: p.y - Math.cos(bearing * Math.PI / 180) * d,
  };
}

// Shortest signed turn from current to desired (-180..+180)
function shortestTurn(current: number, desired: number): number {
  return ((desired - current + 540) % 360) - 180;
}

// ── Wall look-ahead ──────────────────────────────────────────────────────────
// Probe along `facing` up to `maxDist` units, checking for wall overlap.
// Returns urgency 0 (no wall) → 1 (wall immediately ahead) and which way to dodge.
// VEH_W/H: half-size clearance probe (vehicle is 1×2 units, add small buffer)
const VEH_PROBE_W = 0.9;
const VEH_PROBE_H = 1.4;

function lookAhead(
  pos: { x: number; y: number },
  facing: number,
  walls: ArenaMap['walls'],
  maxDist: number,
): { urgency: number; avoidDir: 1 | -1 } {
  for (let d = 1.0; d <= maxDist; d += 0.5) {
    const probe = pointAt(pos, facing, d);
    for (const wall of walls) {
      const ox = (VEH_PROBE_W + wall.w / 2) - Math.abs(probe.x - wall.x);
      const oy = (VEH_PROBE_H + wall.h / 2) - Math.abs(probe.y - wall.y);
      if (ox > 0 && oy > 0) {
        const urgency = 1 - (d - 1.0) / Math.max(0.1, maxDist - 1.0);
        // Turn away from wall: if wall is clockwise of our heading, turn CCW and vice versa
        const wallBearing = bearingTo(pos, { x: wall.x, y: wall.y });
        const diff = shortestTurn(facing, wallBearing);
        return { urgency: Math.max(0.15, urgency), avoidDir: diff > 0 ? -1 : 1 };
      }
    }
  }
  return { urgency: 0, avoidDir: 1 };
}

// ── Vehicle state assessors ──────────────────────────────────────────────────

function armorFrac(v: VehicleState): number {
  const cur  = Object.values(v.stats.damageState.armor).reduce((s, x) => s + (x ?? 0), 0);
  const orig = Object.values(v.stats.loadout.armor).reduce((s, x) => s + (x ?? 0), 0);
  return orig > 0 ? cur / orig : 1;
}

function faceArmor(v: VehicleState, face: 'front' | 'back' | 'left' | 'right'): number {
  return (v.stats.damageState.armor as Record<string, number>)[face] ?? 0;
}

// Face with most remaining armor
function strongestFace(v: VehicleState): 'front' | 'back' | 'left' | 'right' {
  const faces = ['front', 'back', 'left', 'right'] as const;
  return faces.reduce((best, f) => faceArmor(v, f) > faceArmor(v, best) ? f : best, 'front' as const);
}

// Angular offset to present a given face toward the enemy (bearing = angle from self to enemy)
// front→0, back→180, left→-90, right→+90
const FACE_OFFSET: Record<string, number> = { front: 0, back: 180, left: -90, right: 90 };

// Desired vehicle facing so that `face` points toward `bearing`
function facingToPresent(bearing: number, face: 'front' | 'back' | 'left' | 'right'): number {
  return (bearing - FACE_OFFSET[face] + 360) % 360;
}

// ── Weapon helpers ───────────────────────────────────────────────────────────

interface WeaponChoice {
  id: string;
  shortRange: number;
  longRange: number;
  preferredRange: number; // midpoint of range band
}

function pickWeapon(self: VehicleState): WeaponChoice | null {
  const mounts = self.stats.loadout?.mounts;
  if (!mounts || mounts.length === 0) return { id: 'mg', shortRange: 6, longRange: 12, preferredRange: 9 };

  const candidates: WeaponChoice[] = mounts
    .filter(m => (m.arc === 'front' || m.arc === 'turret') && m.weaponId && m.ammo > 0)
    .flatMap(m => {
      const def = WEAPONS.find(w => w.id === m.weaponId);
      if (!def) return [];
      return [{ id: m.weaponId!, shortRange: def.shortRange, longRange: def.longRange, preferredRange: Math.floor((def.shortRange + def.longRange) / 2) }];
    });

  if (candidates.length === 0) return null;

  // Prefer the weapon with longest effective range (gives most tactical flexibility)
  return candidates.reduce((best, c) => c.longRange > best.longRange ? c : best);
}

// ── Target selection ─────────────────────────────────────────────────────────

// Prefer: weakest enemy first, tiebreak on proximity
function pickTarget(self: VehicleState, enemies: VehicleState[], ctx?: AiContext): VehicleState {
  // Score each enemy: lower = better target. Incorporates squad saturation so
  // three squadmates don't dogpile the same weakest enemy (Phase 4). Without
  // squad context (solo match, test) the behaviour reduces to the original
  // weakest-then-closest picker.
  const squad = ctx?.squad;
  const scored = enemies.map(e => {
    const h = armorFrac(e);
    const d = dist2d(self.position, e.position);
    // Base: prefer weak (low h) and close — rawScore is smaller = better
    let rawScore = h * 20 + d * 0.5;
    if (squad) {
      const claim = squad.targetClaims.get(e.id);
      const claimants = claim?.claimants.length ?? 0;
      // Don't penalise if WE are already the claimant (keep firing at current target)
      const selfOnlyClaimant = claimants === 1 && claim?.claimants[0] === self.id;
      if (!selfOnlyClaimant) {
        // Loyalty scales saturation-aversion: loyal drivers (10) fully respect
        // claims; disloyal drivers (0) ignore them and happily poach. Base
        // penalty ramps: 1 other claimant = +8, 2+ = +20.
        const loyalty = ctx?.loyalty ?? 5;
        const loyaltyMul = loyalty / 10;
        const basePenalty = claimants === 1 ? 8 : claimants >= 2 ? 20 : 0;
        rawScore += basePenalty * loyaltyMul;
      }
    }
    return { e, rawScore };
  });
  scored.sort((a, b) => a.rawScore - b.rawScore);
  return scored[0].e;
}

// ── Tactic selection ─────────────────────────────────────────────────────────

function chooseTactic(
  self: VehicleState,
  target: VehicleState,
  d: number,
  skill: number,
  prev: Tactic,
  prevTicks: number,
  w: WeaponChoice | null,
  aggression = 3,
): Tactic {
  const health = armorFrac(self);

  // Critically low armor: evade regardless — even the most aggressive
  // driver isn't going to suicide-charge at 20% hp
  if (health < 0.25) return 'evasive';

  // Any face at zero — orbit to stop presenting it, regardless of skill
  if (Math.min(faceArmor(self, 'front'), faceArmor(self, 'back'), faceArmor(self, 'left'), faceArmor(self, 'right')) === 0) return 'orbit';

  // Front armor nearly gone — orbit to stop presenting it
  if (faceArmor(self, 'front') < 2 && health < 0.65) return 'orbit';

  // Aggression shifts the snipe threshold — timid drivers (aggression ≤ 2)
  // will snipe with any long-ish weapon; hot-head drivers (aggression ≥ 5)
  // skip snipe entirely and always close the distance.
  const snipeThreshold = aggression >= 5 ? 18 : aggression >= 3 ? 14 : 11;
  if (w && w.longRange >= snipeThreshold && skill >= 3 && health > 0.4 && aggression <= 4) {
    // After holding snipe for 80+ ticks, charge aggressively to vary positioning
    if (prev === 'snipe' && prevTicks > 80 && Math.random() < 0.65) {
      return health > 0.5 ? 'aggressive' : 'orbit';
    }
    return 'snipe';
  }

  // Flanking: healthy, high skill, enemy is reachable. Aggressive drivers
  // prefer aggressive > flanking (they close straight); calm drivers are
  // happier to take the longer, safer flank.
  if (health > 0.75 && skill >= 4 && d < 35 && aggression <= 4) return 'flanking';

  // Orbit: moderately damaged or already in range and facing issues. Highly
  // aggressive drivers shrug off the damage and keep attacking.
  if (health < 0.55 && d < (w?.longRange ?? 16) && aggression < 5) return 'orbit';

  return 'aggressive';
}

// ── Main AI function ─────────────────────────────────────────────────────────

export function computeAiInput(
  self: VehicleState,
  ctx: AiContext,
  order?: SquadOrder,
): AiInput {
  const { skill, map, allVehicles } = ctx;
  // Enemies derived from the full vehicle list — was the `others` argument
  // but now lives on the context so all callers share one source of truth.
  const enemies = allVehicles.filter(o =>
    o.id !== self.id && o.playerId !== self.playerId && !o.stats.damageState.destroyed,
  );

  // ── Commander-mode order handling ─────────────────────────────────────────
  // Short-circuit the full tactic engine for movement-focused orders (move/retreat/follow).
  // 'attack' orders fall through to the normal tactic loop with target narrowed
  // to the specified enemy.
  if (order) {
    if (order.type === 'move') {
      const goal = { x: order.x, y: order.y };
      const dist = dist2d(self.position, goal);
      if (dist < 1.5) return { speed: 0, steer: 0, fireWeapon: null };  // arrived
      // Phase 3: route through the pathfinder so 'move to (x, y)' can find
      // its way around buildings instead of steering headfirst into one.
      // Falls back to direct bearing if no path is available.
      let targetBearing = bearingTo(self.position, goal);
      const path = ctx.pathfinder?.find(self.position, goal);
      if (path && path.length > 0) {
        const first = path.find(p => dist2d(self.position, p) >= 2) ?? path[path.length - 1];
        targetBearing = bearingTo(self.position, first);
      }
      const steer = Math.max(-MAX_TURN, Math.min(MAX_TURN, shortestTurn(self.facing, targetBearing)));
      return { speed: Math.min(self.stats.maxSpeed, dist > 6 ? self.stats.maxSpeed : Math.floor(self.stats.maxSpeed * 0.5)), steer, fireWeapon: null };
    }
    if (order.type === 'retreat') {
      // Very low loyalty (≤ 1) means the driver ignores the retreat order
      // and keeps fighting — rolls each tick so orders eventually stick if
      // the player keeps issuing them. Captures "mercenary driver who won't
      // run away" flavour with actual gameplay weight.
      const loyalty = ctx.loyalty ?? 5;
      const disobey = loyalty <= 1 && Math.random() < 0.6;
      if (!disobey && enemies.length > 0) {
        const cx = enemies.reduce((s, e) => s + e.position.x, 0) / enemies.length;
        const cy = enemies.reduce((s, e) => s + e.position.y, 0) / enemies.length;
        const awayBearing = bearingTo({ x: cx, y: cy }, self.position);
        const steer = Math.max(-MAX_TURN, Math.min(MAX_TURN, shortestTurn(self.facing, awayBearing)));
        return { speed: self.stats.maxSpeed, steer, fireWeapon: null };
      }
      if (disobey) {
        // Fall through to normal combat logic — explicit console note so
        // the player can see WHY their order didn't take effect
        console.log(`[AI] ${self.id.padEnd(10)} RETREAT ignored (loyalty=${loyalty})`);
      } else {
        return { speed: 0, steer: 0, fireWeapon: null };
      }
    }
    if (order.type === 'follow' && allVehicles) {
      const leader = allVehicles.find(v => v.id === order.leaderId && !v.stats.damageState.destroyed);
      if (leader) {
        // Stay 4 units behind the leader along their facing
        const backRad = (leader.facing - 90 + 180) * Math.PI / 180;
        const targetX = leader.position.x + Math.cos(backRad) * 4;
        const targetY = leader.position.y + Math.sin(backRad) * 4;
        const dist = dist2d(self.position, { x: targetX, y: targetY });
        const bearingDeg = bearingTo(self.position, { x: targetX, y: targetY });
        const steer = Math.max(-MAX_TURN, Math.min(MAX_TURN, shortestTurn(self.facing, bearingDeg)));
        const speed = dist < 1 ? leader.speed : Math.min(self.stats.maxSpeed, Math.max(leader.speed, Math.floor(dist * 5)));
        // Follow mode prioritises positioning; firing is suspended so the player
        // can choose engage-vs-regroup via explicit attack/retreat orders.
        return { speed, steer, fireWeapon: null };
      }
    }
    // 'attack' orders narrow target selection but keep the normal tactic engine
  }

  if (enemies.length === 0) return { speed: 0, steer: 0, fireWeapon: null };

  const ds = getState(self.id);

  // ── Context ring (Phase 2) ──────────────────────────────────────────────
  // Reset + repopulate each tick. Danger writers run now; interest writers
  // (tactic, survival, stuck escape) get populated by the downstream blocks
  // as they compute their desired bearings. `ring.pick()` isn't yet wired
  // into the steer source (T2.9 flips that switch), so this runs in
  // parallel with the legacy logic without changing behaviour yet.
  ds.ring.reset();
  if (map) writeWallDanger(ds.ring, self.position, self.facing, map.walls, self.speed);
  writeVehicleDanger(ds.ring, self, ctx.allVehicles);
  writeWreckageDanger(ds.ring, self, ctx.wreckage);

  // Record current position in the ring buffer (last 20 ticks)
  ds.positionHistory.push({ x: self.position.x, y: self.position.y });
  if (ds.positionHistory.length > POS_HISTORY_LEN) ds.positionHistory.shift();

  // Stuck detection — two layers:
  //   Fast: moved < 0.1 this tick → increment (catches short outright pins)
  //   Robust: position spread over 15 ticks is tiny compared to how fast the
  //           vehicle is CURRENTLY moving. That's the wall-pin signature:
  //           engine says "speed 60" but the car's stuck against geometry so
  //           its actual displacement is 0. A sniper legitimately circling at
  //           slow speed (e.g. 40 mph × 15 ticks = 1.7 units straight-line)
  //           has a tiny spread too but that's NORMAL, not stuck.
  const moved = dist2d(self.position, { x: ds.lastX, y: ds.lastY });
  ds.stuckTicks = moved < 0.1 ? ds.stuckTicks + 1 : 0;
  if (ds.positionHistory.length >= 15) {
    const window = ds.positionHistory.slice(-15);
    let maxSpread = 0;
    for (let i = 0; i < window.length; i++) {
      for (let j = i + 1; j < window.length; j++) {
        const d2 = dist2d(window[i], window[j]);
        if (d2 > maxSpread) maxSpread = d2;
      }
    }
    // Expected straight-line travel for current speed: |speed| * 15 / 360.
    // Genuine stuck = actual spread is < 30% of expected. Low-speed sniping
    // circling is fine because expected is also small (no false positive).
    const expected = (Math.abs(self.speed) * 15) / 360;
    if (expected > 1 && maxSpread < expected * 0.3) {
      ds.stuckTicks = Math.max(ds.stuckTicks, 5);
    }
  }
  ds.lastX = self.position.x;
  ds.lastY = self.position.y;

  // Periodically reverse orbit direction to break up predictable circles
  ds.orbitFlipIn--;
  if (ds.orbitFlipIn <= 0) {
    ds.orbitDir = ds.orbitDir === 1 ? -1 : 1;
    ds.orbitFlipIn = 40 + Math.floor(Math.random() * 40);
  }

  // Attack order pins target selection to a specific enemy if it's still alive
  const attackTarget = order?.type === 'attack'
    ? enemies.find(e => e.id === order.targetId)
    : undefined;
  const target = attackTarget ?? pickTarget(self, enemies, ctx);
  const d = dist2d(self.position, target.position);
  const bearing = bearingTo(self.position, target.position);
  const w = pickWeapon(self);

  // Choose tactic — don't flip-flop: hold for at least 15 ticks unless critical
  const forcedChange = armorFrac(self) < 0.2;
  ds.tacticTicks++;
  if (forcedChange || ds.tacticTicks >= 15) {
    let newTactic = chooseTactic(self, target, d, skill, ds.tactic, ds.tacticTicks, w, ctx.aggression ?? 3);
    // Phase 4 — squad role biases tactic choice when the base picker is
    // indifferent. Flankers prefer flanking; supports prefer orbit (loiter
    // near rally); anchors prefer aggressive.
    const role = ctx.squad?.roleByAgent.get(self.id);
    if (role === 'flanker_l' || role === 'flanker_r') {
      if (newTactic === 'aggressive' || newTactic === 'orbit') newTactic = 'flanking';
    } else if (role === 'support') {
      // Support stays back — orbit at range unless critically hurt (evasive)
      if (newTactic === 'aggressive') newTactic = 'orbit';
    }
    if (newTactic !== ds.tactic) {
      ds.tactic = newTactic;
      ds.tacticTicks = 0;
    }
  }
  const tactic = ds.tactic;

  // personality shifts preferred range ±2 units and orbit angles ±10° — persistent per vehicle
  const personalityRangeOffset = Math.round(ds.personality * 4 - 2);
  const personalityAngleOffset = Math.round(ds.personality * 20 - 10);
  // Aggression also nudges preferred range: every point above 3 brings the
  // fight one unit closer; every point below pushes it one unit further.
  // Range at aggression 6 ≈ −3 units, at aggression 1 ≈ +2 units.
  const aggressionRangeOffset = 3 - (ctx.aggression ?? 3);

  const prefRange  = Math.max(4, (w?.preferredRange ?? 12) + personalityRangeOffset + aggressionRangeOffset);
  const fireRange  = w?.longRange ?? 16;
  const closeRange = w?.shortRange ?? 6;

  // Initialised to safe defaults (hold facing, no throttle) so the definite-
  // assignment checker is satisfied when the tactic switch is gated by
  // !isRecovering — otherwise TS can't prove both branches assign them.
  let desiredFacing: number = self.facing;
  let desiredSpeed: number = 0;

  // ── Recovery: if stuck against a wall/building ───────────────────────────
  // When stuck transitions from 0→non-zero, kick off a reverse burst: back
  // away from whatever we're pinned on for REVERSE_BURST_TICKS, then resume
  // forward-escape. reverseTicks counts down each tick we're in the burst.
  //
  // Phase 1 (4–29 ticks): sidestep perpendicular to enemy bearing, alternating sides
  // Phase 2 (30–59 ticks): drive away from enemy (bearing + 180)
  // Phase 3 (60–99 ticks): sweep 8 world compass directions, 10 ticks each
  // Phase 4 (100+ ticks):  PANIC — force heading toward arena centre at full reverse,
  //                        then full forward, alternating every 5 ticks to break any pin
  const isRecovering = ds.stuckTicks >= 4;
  if (isRecovering) {
    // If we just became stuck (and aren't already reversing), start a reverse burst.
    // Using >= 5 (not ===) so missed-tick edge cases still trigger the burst.
    if (ds.reverseTicks <= 0 && ds.stuckTicks >= 5 && ds.stuckTicks < 10) {
      ds.reverseTicks = REVERSE_BURST_TICKS;
    }

    if (ds.reverseTicks > 0) {
      // Reverse burst — speed is negative, so direction of actual motion is
      // OPPOSITE the facing. To move AWAY from whatever's pinning us, keep
      // facing TOWARD the current target bearing (typically the enemy, or
      // whatever's blocking our goal) and reverse. Previous code set
      // desiredFacing to bearing+180 and then drove in reverse, which
      // cancelled out — the vehicle stayed pinned.
      const reverseFacingHint = bearing;
      desiredFacing = reverseFacingHint;
      desiredSpeed = REVERSE_SPEED;
      ds.reverseTicks--;
      ds.ring.writeInterest(reverseFacingHint, 1.0);
      console.log(`[AI] ${self.id.padEnd(10)} REVERSE×${ds.reverseTicks} — pos=(${self.position.x.toFixed(1)},${self.position.y.toFixed(1)}) spd=${desiredSpeed}`);
    } else {
      let escapeHeading: number;
      let escapeSpeed = self.stats.maxSpeed;
      if (ds.stuckTicks >= 100) {
        // Panic unstick. Two failure modes to handle:
        //   1) Pinned on a wall → push toward arena centre
        //   2) Pinned on another vehicle → push opposite the blocker
        // Without (2), two adjacent stuck vehicles both aim at (0,0), lock
        // together, and never break free. Phase-offset the forward/reverse
        // cycle by id-hash so their burst timing also doesn't sync.
        const hash = [...self.id].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
        const blocker = allVehicles?.find(v =>
          v.id !== self.id &&
          !v.stats.damageState.destroyed &&
          dist2d(v.position, self.position) < 3,
        );
        if (blocker) {
          escapeHeading = (bearingTo(self.position, blocker.position) + 180) % 360;
          // Vehicle-blocker panic: just drive AWAY at max speed. Alternating
          // forward/reverse at a fixed heading is self-cancelling when the
          // blocker is another vehicle — both would oscillate in place.
          // Constant forward motion is what actually separates them.
          escapeSpeed = self.stats.maxSpeed;
        } else {
          // Wall pin — aim at centre with a per-vehicle scatter so two stuck
          // vehicles in the same corner don't pick identical headings.
          const scatter = (hash % 180) - 90;
          escapeHeading = (bearingTo(self.position, { x: 0, y: 0 }) + scatter + 360) % 360;
          // Wall traps can need forward-then-reverse shimmying to squeeze out
          // of concave geometry; alternation helps here. Phase-offset so two
          // corner-stuck vehicles don't sync up their forward/reverse bursts.
          const phaseOffset = Math.abs(hash) % 5;
          escapeSpeed = Math.floor((ds.stuckTicks + phaseOffset) / 5) % 2 === 0
            ? self.stats.maxSpeed
            : REVERSE_SPEED;
        }
      } else if (ds.stuckTicks >= 60) {
        const compassStep = Math.floor(ds.stuckTicks / 10) % 8;
        escapeHeading = compassStep * 45;
      } else if (ds.stuckTicks >= 30) {
        escapeHeading = (bearing + 180 + 360) % 360;
      } else {
        const phase = Math.floor(ds.stuckTicks / 10);
        const dir: 1 | -1 = phase % 2 === 0 ? ds.orbitDir : (ds.orbitDir === 1 ? -1 : 1);
        escapeHeading = (bearing + dir * 90 + 360) % 360;
      }
      desiredFacing = escapeHeading;
      desiredSpeed = escapeSpeed;
      // Stuck recovery writes with maximum strength so it outscores every
      // other interest writer. The ring's danger slots (walls / vehicles)
      // still constrain direction — so escape aims toward the clearest
      // heading near the escape direction rather than blindly driving
      // into whatever the vehicle was pinned on.
      ds.ring.writeInterest(escapeHeading, 1.0);
      console.log(`[AI] ${self.id.padEnd(10)} STUCK×${ds.stuckTicks} — escape heading=${escapeHeading.toFixed(0)}° pos=(${self.position.x.toFixed(1)},${self.position.y.toFixed(1)})${ds.stuckTicks >= 100 ? ' PANIC' : ''}`);
    }
  } else {
    // Not stuck — clear any pending reverse ticks so future matches start fresh
    ds.reverseTicks = 0;
  }

  // The tactic switch below used to run unconditionally, which silently
  // overwrote the stuck recovery values — that's why pinned AI would oscillate
  // between "reverse 1 tick" and "forward 1 tick" and never break free. When
  // recovering, skip tactic entirely so the escape heading sticks long enough
  // to open a gap; SURV + AVOID overlays still run so safety wins when needed.
  if (!isRecovering) switch (tactic) {
    // ── Evasive: flee at max speed, present strongest armor face ──────────────
    case 'evasive': {
      const best = strongestFace(self);
      desiredFacing = facingToPresent(bearing, best);
      desiredSpeed = self.stats.maxSpeed;
      break;
    }

    // ── Flanking: get to enemy's rear quarter ─────────────────────────────────
    case 'flanking': {
      // Target point: prefRange units behind enemy, offset 45° to one side
      const rearBearing = (target.facing + 180 + ds.orbitDir * 45 + 360) % 360;
      const flankPos = pointAt(target.position, rearBearing, prefRange);
      desiredFacing = bearingTo(self.position, flankPos);
      desiredSpeed = self.stats.maxSpeed;
      break;
    }

    // ── Snipe: stay at long range, circle, fire only when well-aimed ──────────
    case 'snipe': {
      const snapRange = fireRange - 1;
      if (d < snapRange - 2) {
        // Too close: strafe at an angle to open distance without reversing into walls
        desiredFacing = (bearing + ds.orbitDir * 120 + 360) % 360;
        desiredSpeed = Math.floor(self.stats.maxSpeed * 0.65);
      } else if (d > fireRange + 4) {
        // Too far: close to max range — slight angle offset so approaches aren't identical
        desiredFacing = (bearing + ds.orbitDir * Math.round(Math.abs(personalityAngleOffset) * 0.4) + 360) % 360;
        desiredSpeed = Math.floor(self.stats.maxSpeed * 0.8);
      } else {
        // In snipe band: slow circle — 50° keeps target near front arc for firing
        desiredFacing = (bearing + ds.orbitDir * (50 + personalityAngleOffset) + 360) % 360;
        desiredSpeed = Math.max(10, Math.floor(self.stats.maxSpeed * 0.55));
      }
      break;
    }

    // ── Orbit: circle at preferred range, present strongest face ─────────────
    case 'orbit': {
      const best = strongestFace(self);
      if (d > prefRange + 4) {
        desiredFacing = bearing;
        desiredSpeed = self.stats.maxSpeed;
      } else if (d < closeRange) {
        desiredFacing = (bearing + 180) % 360;
        desiredSpeed = Math.floor(self.stats.maxSpeed * 0.6);
      } else {
        const orbitAngle = 75 + personalityAngleOffset;
        const orbitHeading = (bearing + ds.orbitDir * orbitAngle + 360) % 360;
        const faceHeading  = facingToPresent(bearing, best);
        const turn = shortestTurn(self.facing, orbitHeading) * 0.6
                   + shortestTurn(self.facing, faceHeading)  * 0.4;
        desiredFacing = (self.facing + turn + 360) % 360;
        desiredSpeed  = Math.max(10, Math.floor(self.stats.maxSpeed * 0.5));
      }
      break;
    }

    // ── Aggressive: close in, then orbit at preferred range ──────────────────
    case 'aggressive':
    default: {
      // Hysteresis: enter close-mode at closeRange-1, exit at closeRange+1
      // Prevents want oscillating 80° each tick when distance straddles closeRange
      if (d < closeRange - 1) ds.inClose = true;
      else if (d > closeRange + 1) ds.inClose = false;

      if (d > prefRange + 3) {
        // Angle approach slightly — avoids all AIs charging the same straight line
        desiredFacing = (bearing + ds.orbitDir * Math.round(Math.abs(personalityAngleOffset) * 0.3) + 360) % 360;
        desiredSpeed  = self.stats.maxSpeed;
      } else {
        // Orbit at 35° — target stays in front 90° arc so MG can fire continuously.
        // At close range (inClose) use the same angle but slow down to avoid collisions.
        const orbitAngle = 35 + personalityAngleOffset;
        desiredFacing = (bearing + ds.orbitDir * orbitAngle + 360) % 360;
        desiredSpeed  = ds.inClose
          ? Math.max(10, Math.floor(self.stats.maxSpeed * 0.4))
          : Math.max(15, Math.floor(self.stats.maxSpeed * 0.65));
      }
      break;
    }
  }

  // Tactic goal → context ring interest. When a pathfinder is available
  // (Phase 3) and there's meaningful geometry between self and target, use
  // the first waypoint bearing so the AI routes AROUND obstacles rather than
  // greedy-pursuing through them. Fallback to writeGoalInterest (direct
  // bearing + symmetric sidesteps) when the pathfinder can't produce a
  // route — equivalent to the Phase 2 behaviour.
  if (!isRecovering) {
    const tacticInterest: Record<Tactic, number> = {
      aggressive: 0.9,
      flanking:   0.85,
      snipe:      0.85,
      orbit:      0.8,
      evasive:    1.0,
    };
    const strength = tacticInterest[tactic];
    let pathUsed = false;
    if (ctx.pathfinder && map && map.walls.length > 0) {
      // Pick the goal position based on tactic — aggressive/flanking head
      // toward the target; snipe/orbit head toward preferred-range arc;
      // evasive heads away. All collapse to "target position" for Phase 3 —
      // richer goal geometry can be added later without changing the wiring.
      const path = ctx.pathfinder.find(self.position, target.position);
      if (path && path.length > 0) {
        pathUsed = writePathInterest(ds.ring, self, path, strength);
        if (pathUsed) {
          // Also write the ±45° sidesteps off the path's first bearing so the
          // ring can dodge local obstacles without abandoning the overall route
          const first = path.find(p => {
            const dx = p.x - self.position.x, dy = p.y - self.position.y;
            return Math.hypot(dx, dy) >= 2;
          }) ?? path[path.length - 1];
          const pathBearing = (Math.atan2(first.x - self.position.x, -(first.y - self.position.y)) * 180 / Math.PI + 360) % 360;
          ds.ring.writeInterest((pathBearing + 45) % 360, strength * 0.4);
          ds.ring.writeInterest((pathBearing - 45 + 360) % 360, strength * 0.4);
        }
      }
    }
    if (!pathUsed) {
      writeGoalInterest(ds.ring, self, desiredFacing, strength);
    }
  }

  // ── Survival overlay: vehicle safety overrides offensive positioning ──────
  // Runs every tick after tactic and wall logic. Blends protective heading in
  // based on how exposed the vehicle is. Disabled during stuck recovery
  // because its speed-minimum would clobber the reverse burst (Math.max of
  // negative REVERSE_SPEED and positive target flips the sign, preventing
  // the vehicle from actually backing out of its pin).
  if (!isRecovering) {
    const selfHealth = armorFrac(self);
    const frontA = faceArmor(self, 'front');
    const backA  = faceArmor(self, 'back');
    const leftA  = faceArmor(self, 'left');
    const rightA = faceArmor(self, 'right');
    const minFace = Math.min(frontA, backA, leftA, rightA);
    const maxFace = Math.max(frontA, backA, leftA, rightA);

    // Urgency: 0 = no concern, 1 = critical — driven by face exposure and overall health
    let survivalUrgency = 0;
    if (minFace === 0 && maxFace > 2)          survivalUrgency = Math.max(survivalUrgency, 0.85);
    else if (minFace <= 2 && maxFace > 4)      survivalUrgency = Math.max(survivalUrgency, 0.55);
    if (selfHealth < 0.25)                     survivalUrgency = Math.max(survivalUrgency, 0.90);
    else if (selfHealth < 0.45)                survivalUrgency = Math.max(survivalUrgency, 0.45);

    if (survivalUrgency > 0) {
      // Orient to present the strongest available face toward the threat
      const best = strongestFace(self);
      const safeHeading  = facingToPresent(bearing, best);
      const tactTurn     = shortestTurn(self.facing, desiredFacing);
      const safeTurn     = shortestTurn(self.facing, safeHeading);
      desiredFacing      = (self.facing + tactTurn * (1 - survivalUrgency) + safeTurn * survivalUrgency + 360) % 360;

      // Also feed the ring: survival urgency directly becomes interest
      // strength at the safe heading. When T2.9 flips the steer source,
      // this write — combined with the wall/vehicle danger writes — lets
      // the ring pick a direction that's both safe AND tactically sound.
      ds.ring.writeInterest(safeHeading, survivalUrgency);

      // Open distance when hurt — don't let the enemy keep pounding at close range
      if (d < prefRange + 2 && survivalUrgency > 0.4) {
        desiredSpeed = Math.max(desiredSpeed, Math.floor(self.stats.maxSpeed * (0.6 + survivalUrgency * 0.4)));
      }

      if (survivalUrgency >= 0.7) {
        console.log(`[SURV] ${self.id.padEnd(10)} urgency=${survivalUrgency.toFixed(2)} hp=${Math.round(selfHealth*100)}% minFace=${minFace} best=${best} → ${safeHeading.toFixed(0)}°`);
      }
    }
  }

  // ── Proximity avoidance overlay ──────────────────────────────────────────
  // Keep a minimum gap from other vehicles so AI squadmates don't pile up
  // next to the player (and get caught by ammo cook-off blasts on kills).
  // Two tiers:
  //   - Friendly within 5 units (any direction) — soft avoid, minimum bubble
  //   - Any vehicle looking like it's about to explode (low armour+low hp)
  //     within blast radius ×2 — strong avoid regardless of which side
  //
  // Rationale: BLAST_RADIUS is 2 units. Allowing squadmates to drift within
  // 2-3 units guarantees blast-chain deaths. 5 units keeps everyone outside
  // the 2-unit cook-off radius with headroom for momentum.
  if (allVehicles && allVehicles.length > 1 && desiredSpeed > 0) {
    const FRIEND_AVOID_RANGE  = 5;   // 360° soft bubble around friendlies
    const BLAST_HAZARD_RANGE  = 5;   // steer clear of low-hp vehicles at this range
    const LOW_HP_FRACTION     = 0.30;

    const healthOf = (v: VehicleState): number => {
      const ds = v.stats.damageState;
      const orig = v.stats.loadout?.armor ?? {};
      const faces: (keyof typeof ds.armor)[] = ['front', 'back', 'left', 'right', 'top', 'underbody'];
      let origTotal = 0, curTotal = 0;
      for (const f of faces) {
        origTotal += (orig as Record<string, number>)[f] ?? 0;
        curTotal  += (ds.armor as Record<string, number>)[f] ?? 0;
      }
      return origTotal > 0 ? curTotal / origTotal : 1;
    };

    let bestAvoidTarget: VehicleState | null = null;
    let bestUrgency = 0;
    let bestDist = Infinity;

    for (const v of allVehicles) {
      if (v.id === self.id) continue;
      if (v.stats.damageState.destroyed) continue;
      const d = dist2d(self.position, v.position);
      let urgency = 0;

      if (v.playerId === self.playerId && d < FRIEND_AVOID_RANGE) {
        // Friendly in the bubble — urgency scales linearly to 1 at 0 units
        urgency = 1 - d / FRIEND_AVOID_RANGE;
      }
      // Any vehicle (friend OR foe) looking ready to pop — avoid its blast
      const hp = healthOf(v);
      if (hp < LOW_HP_FRACTION && d < BLAST_HAZARD_RANGE) {
        const blastUrgency = 1 - d / BLAST_HAZARD_RANGE;
        urgency = Math.max(urgency, blastUrgency * 1.2);  // blast hazard trumps squad spacing
      }

      if (urgency > bestUrgency || (urgency === bestUrgency && d < bestDist)) {
        bestUrgency = urgency;
        bestDist = d;
        bestAvoidTarget = v;
      }
    }

    // Phase 2: the ring's writeVehicleDanger has already written danger around
    // every nearby vehicle, so the ring will naturally steer away. This block
    // now only handles SPEED modulation — reverse kick when extremely close,
    // and gentler throttle when inside the bubble. No desiredFacing mutation.
    if (bestAvoidTarget && bestUrgency > 0.05) {
      const urgency = Math.min(1, bestUrgency);
      const hardOverride = urgency >= 0.6;
      if (bestDist < 1.5) {
        desiredSpeed = -20;
      } else {
        desiredSpeed = Math.floor(desiredSpeed * (1 - urgency * 0.85));
      }
      if (urgency >= 0.5) {
        const reason = bestAvoidTarget.playerId === self.playerId ? 'squad-bubble' : 'blast-hazard';
        console.log(`[AVOID] ${self.id.padEnd(10)} ${reason} ${bestAvoidTarget.id.padEnd(10)} dist=${bestDist.toFixed(1)} urgency=${urgency.toFixed(2)}${hardOverride ? ' HARD' : ''}${bestDist < 1.5 ? ' REVERSE' : ''}`);
      }
    }
  }

  // ── Wall proximity speed-brake ──────────────────────────────────────────
  // The ring's wall-danger writer handles steering away; this block only
  // trims throttle when a wall is imminent, so the AI doesn't blast into a
  // turn at max speed. Facing changes happen via ring.pick().
  if (map && map.walls.length > 0 && desiredSpeed > 0) {
    const lookDist = Math.max(5, Math.min(12, desiredSpeed / 8));
    const wall = lookAhead(self.position, self.facing, map.walls, lookDist);
    if (wall.urgency > 0) {
      desiredSpeed = Math.floor(desiredSpeed * (1 - wall.urgency * 0.5));
      if (wall.urgency >= 0.7) {
        console.log(`[WALL] ${self.id.padEnd(10)} urgency=${wall.urgency.toFixed(2)} speed-brake`);
      }
    }
  }

  // ── Steer toward chosen bearing (Phase 2: ring.pick() is now authoritative) ─
  // The ring reconciles every writer (tactic goal, survival, stuck escape,
  // wall/vehicle/wreckage danger) in one place. max-not-sum means a later
  // writer cannot silently invalidate an earlier one — it can only raise
  // the bar. The legacy `desiredFacing` is kept as a fallback and for
  // logging, but the actual steer now comes from the ring's chosen slot.
  const picked = ds.ring.pick(self.facing);
  const chosenBearing = picked.bearing;
  if (Math.abs(shortestTurn(desiredFacing, chosenBearing)) > 15) {
    console.log(`[RING] ${self.id.padEnd(10)} chose=${chosenBearing.toFixed(0).padStart(3)}° tactic=${desiredFacing.toFixed(0).padStart(3)}° danger=${picked.danger.toFixed(2)}`);
  }
  // Higher skill = sharper turns; skill 1 = 50% of max turn rate, skill 6 = 100%
  const skillMul = 0.5 + (skill - 1) / 10;
  const maxTurnThisTick = Math.round(MAX_TURN * skillMul);
  let steer = shortestTurn(self.facing, chosenBearing);
  // Proportional damping: within 12° of target, use at most 6° steer.
  // Prevents constant max-turn during small orbit corrections → reduces D-value accumulation.
  const absDiff = Math.abs(steer);
  const effectiveMax = absDiff <= 12 ? Math.min(maxTurnThisTick, 6) : maxTurnThisTick;
  steer = Math.max(-effectiveMax, Math.min(effectiveMax, steer));

  // ── Fire decision ─────────────────────────────────────────────────────────
  // Car Wars: one shot per phase (= 10 ticks). Cooldown prevents ammo depletion in seconds.
  if (ds.fireCooldown > 0) ds.fireCooldown--;
  const angleDiff = Math.abs(shortestTurn(self.facing, bearing));
  const fireThreshold = tactic === 'snipe' ? 15 : 45;
  const weaponId = w?.id ?? null;
  const canFire = weaponId && d <= fireRange && angleDiff < fireThreshold && ds.fireCooldown === 0;
  const fireWeapon = canFire ? weaponId : null;
  if (canFire) ds.fireCooldown = 10; // one shot per turn

  const hp = Math.round(armorFrac(self) * 100);
  const fireStr = fireWeapon
    ? `FIRE ${fireWeapon}`
    : `no-fire (${!weaponId ? 'no weapon' : d > fireRange ? `range ${d.toFixed(1)}` : `angle ${angleDiff.toFixed(0)}°`})`;
  console.log(
    `[AI] ${self.id.padEnd(10)} → ${target.id.padEnd(10)} dist=${d.toFixed(1).padStart(5)} ` +
    `facing=${self.facing.toFixed(0).padStart(3)}° want=${desiredFacing.toFixed(0).padStart(3)}° ` +
    `steer=${steer.toFixed(0).padStart(4)}° spd=${desiredSpeed.toFixed(0).padStart(3)} ` +
    `[${tactic}] hp=${hp}% ${fireStr}`,
  );

  return { speed: desiredSpeed, steer, fireWeapon };
}
