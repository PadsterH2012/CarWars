import type { VehicleState, ArenaMap, SquadOrder } from '@carwars/shared';
import { WEAPONS } from '../rules/data/weapons';
import type { AiContext } from './types';

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
function pickTarget(self: VehicleState, enemies: VehicleState[]): VehicleState {
  return enemies.reduce((best, e) => {
    const eHealth = armorFrac(e);
    const bHealth = armorFrac(best);
    if (Math.abs(eHealth - bHealth) > 0.15) return eHealth < bHealth ? e : best; // weakest wins
    return dist2d(self.position, e.position) < dist2d(self.position, best.position) ? e : best;
  });
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
): Tactic {
  const health = armorFrac(self);

  // Critically low armor: evade regardless
  if (health < 0.25) return 'evasive';

  // Any face at zero — orbit to stop presenting it, regardless of skill
  if (Math.min(faceArmor(self, 'front'), faceArmor(self, 'back'), faceArmor(self, 'left'), faceArmor(self, 'right')) === 0) return 'orbit';

  // Front armor nearly gone — orbit to stop presenting it
  if (faceArmor(self, 'front') < 2 && health < 0.65) return 'orbit';

  // Sniping: have a long-range weapon and skill to use it, but break out after a while
  if (w && w.longRange >= 14 && skill >= 3 && health > 0.4) {
    // After holding snipe for 80+ ticks, charge aggressively to vary positioning
    if (prev === 'snipe' && prevTicks > 80 && Math.random() < 0.65) {
      return health > 0.5 ? 'aggressive' : 'orbit';
    }
    return 'snipe';
  }

  // Flanking: healthy, high skill, enemy is reachable
  if (health > 0.75 && skill >= 4 && d < 35) return 'flanking';

  // Orbit: moderately damaged or already in range and facing issues
  if (health < 0.55 && d < (w?.longRange ?? 16)) return 'orbit';

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
      const bearingDeg = bearingTo(self.position, { x: order.x, y: order.y });
      const dist = dist2d(self.position, { x: order.x, y: order.y });
      if (dist < 1.5) return { speed: 0, steer: 0, fireWeapon: null };  // arrived
      const steer = Math.max(-MAX_TURN, Math.min(MAX_TURN, shortestTurn(self.facing, bearingDeg)));
      return { speed: Math.min(self.stats.maxSpeed, dist > 6 ? self.stats.maxSpeed : Math.floor(self.stats.maxSpeed * 0.5)), steer, fireWeapon: null };
    }
    if (order.type === 'retreat') {
      if (enemies.length > 0) {
        const cx = enemies.reduce((s, e) => s + e.position.x, 0) / enemies.length;
        const cy = enemies.reduce((s, e) => s + e.position.y, 0) / enemies.length;
        const awayBearing = bearingTo({ x: cx, y: cy }, self.position);
        const steer = Math.max(-MAX_TURN, Math.min(MAX_TURN, shortestTurn(self.facing, awayBearing)));
        return { speed: self.stats.maxSpeed, steer, fireWeapon: null };
      }
      return { speed: 0, steer: 0, fireWeapon: null };
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

  // Record current position in the ring buffer (last 20 ticks)
  ds.positionHistory.push({ x: self.position.x, y: self.position.y });
  if (ds.positionHistory.length > POS_HISTORY_LEN) ds.positionHistory.shift();

  // Stuck detection — two layers:
  //   Fast: moved < 0.1 this tick → increment
  //   Robust: net distance travelled over the last 15 ticks < 3 units means the
  //           vehicle is bouncing-but-not-progressing (wall pin). We force stuckTicks
  //           to at least 5 so the escape logic kicks in.
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
    if (maxSpread < 3) ds.stuckTicks = Math.max(ds.stuckTicks, 5);
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
  const target = attackTarget ?? pickTarget(self, enemies);
  const d = dist2d(self.position, target.position);
  const bearing = bearingTo(self.position, target.position);
  const w = pickWeapon(self);

  // Choose tactic — don't flip-flop: hold for at least 15 ticks unless critical
  const forcedChange = armorFrac(self) < 0.2;
  ds.tacticTicks++;
  if (forcedChange || ds.tacticTicks >= 15) {
    const newTactic = chooseTactic(self, target, d, skill, ds.tactic, ds.tacticTicks, w);
    if (newTactic !== ds.tactic) {
      ds.tactic = newTactic;
      ds.tacticTicks = 0;
    }
  }
  const tactic = ds.tactic;

  // personality shifts preferred range ±2 units and orbit angles ±10° — persistent per vehicle
  const personalityRangeOffset = Math.round(ds.personality * 4 - 2);
  const personalityAngleOffset = Math.round(ds.personality * 20 - 10);

  const prefRange  = (w?.preferredRange ?? 12) + personalityRangeOffset;
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
      // Reverse burst: keep facing roughly the current direction (we just want to
      // back out). Slight steering toward the escape heading so we gain clearance.
      const reverseFacingHint = (bearing + 180 + 360) % 360;  // back toward enemy side
      desiredFacing = reverseFacingHint;
      desiredSpeed = REVERSE_SPEED;
      ds.reverseTicks--;
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
        } else {
          // Wall pin — aim at centre with a per-vehicle scatter so two stuck
          // vehicles in the same corner don't pick identical headings.
          const scatter = (hash % 180) - 90;
          escapeHeading = (bearingTo(self.position, { x: 0, y: 0 }) + scatter + 360) % 360;
        }
        const phaseOffset = Math.abs(hash) % 5;
        escapeSpeed = Math.floor((ds.stuckTicks + phaseOffset) / 5) % 2 === 0
          ? self.stats.maxSpeed
          : REVERSE_SPEED;
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

    if (bestAvoidTarget && bestUrgency > 0.05) {
      const toTarget = bearingTo(self.position, bestAvoidTarget.position);
      // Deterministic side selection: pick a side based on a cheap hash of
      // the vehicle id so two symmetric vehicles don't oscillate (one always
      // goes right, the other always left). Without this, their 'turn away'
      // directions flip each tick as positions swap, locking them in a dance.
      const hash = [...self.id].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
      const side = (hash & 1) === 0 ? 1 : -1;
      // Sharp 120° turn off the target bearing, not a softer 90° off own facing
      const avoidHeading = (toTarget + side * 120 + 360) % 360;
      const urgency = Math.min(1, bestUrgency);
      const tactTurn  = shortestTurn(self.facing, desiredFacing);
      const avoidTurn = shortestTurn(self.facing, avoidHeading);
      // At high urgency (<2.5 units — inside blast radius + buffer), abandon
      // the tactical goal entirely and purely avoid. Tactical blend only
      // applies in the outer half of the bubble.
      const hardOverride = urgency >= 0.6;
      desiredFacing = hardOverride
        ? (self.facing + avoidTurn + 360) % 360
        : (self.facing + tactTurn * (1 - urgency) + avoidTurn * urgency + 360) % 360;
      // Reverse kick when extremely close — nothing else creates gap fast enough
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

  // ── Wall avoidance overlay (final pass — cannot be overridden) ──────────
  // Probes along both current facing AND desiredFacing to catch cases where the
  // tactic or survival overlay just aimed us at a wall.
  // Runs last so nothing can overwrite it.
  if (map && map.walls.length > 0 && desiredSpeed > 0) {
    // More generous lookahead: at least 5 units, scales with speed
    const lookDist = Math.max(5, Math.min(12, desiredSpeed / 8));

    // Check both current heading and desired heading — take the more urgent threat
    const wCur  = lookAhead(self.position, self.facing,    map.walls, lookDist);
    const wDes  = lookAhead(self.position, desiredFacing,  map.walls, lookDist);
    const wall  = wCur.urgency >= wDes.urgency ? wCur : wDes;

    if (wall.urgency > 0) {
      const avoidAngle   = 60 + 30 * wall.urgency;
      const avoidHeading = (self.facing + wall.avoidDir * avoidAngle + 360) % 360;
      const blendFactor  = Math.min(1, wall.urgency * 1.5);
      const tactTurn     = shortestTurn(self.facing, desiredFacing);
      const avoidTurn    = shortestTurn(self.facing, avoidHeading);
      desiredFacing      = (self.facing + tactTurn * (1 - blendFactor) + avoidTurn * blendFactor + 360) % 360;
      desiredSpeed       = Math.floor(desiredSpeed * (1 - wall.urgency * 0.5));
      if (wall.urgency >= 0.5) {
        console.log(`[WALL] ${self.id.padEnd(10)} urgency=${wall.urgency.toFixed(2)} avoid=${avoidHeading.toFixed(0)}° src=${wCur.urgency >= wDes.urgency ? 'facing' : 'desired'}`);
      }
    }
  }

  // ── Steer toward desired facing ───────────────────────────────────────────
  // Higher skill = sharper turns; skill 1 = 50% of max turn rate, skill 6 = 100%
  const skillMul = 0.5 + (skill - 1) / 10;
  const maxTurnThisTick = Math.round(MAX_TURN * skillMul);
  let steer = shortestTurn(self.facing, desiredFacing);
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
