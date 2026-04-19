import type { VehicleState, ArenaMap, SquadOrder } from '@carwars/shared';
import { WEAPONS } from '../rules/data/weapons';

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
  inClose: boolean;       // hysteresis flag: true when inside closeRange dead-zone
  fireCooldown: number;   // ticks until next shot allowed (Car Wars: once per phase = 10 ticks)
}
const driverState = new Map<string, DriverState>();

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
  others: VehicleState[],
  skill: number,
  map?: ArenaMap,
  order?: SquadOrder,
  allVehicles?: VehicleState[],
): AiInput {
  const enemies = others.filter(o => o.playerId !== self.playerId && !o.stats.damageState.destroyed);

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

  // Stuck detection: if we haven't moved >0.1 units in a tick, increment counter
  const moved = dist2d(self.position, { x: ds.lastX, y: ds.lastY });
  ds.stuckTicks = moved < 0.1 ? ds.stuckTicks + 1 : 0;
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

  let desiredFacing: number;
  let desiredSpeed: number;

  // ── Recovery: if stuck against a wall/building ───────────────────────────
  // Phase 1 (4–29 ticks): sidestep perpendicular to enemy bearing, alternating sides
  // Phase 2 (30–59 ticks): drive away from enemy (bearing + 180)
  // Phase 3 (60+ ticks):   sweep 8 world compass directions, 10 ticks each
  if (ds.stuckTicks >= 4) {
    let escapeHeading: number;
    if (ds.stuckTicks >= 60) {
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
    desiredSpeed = self.stats.maxSpeed;
    console.log(`[AI] ${self.id.padEnd(10)} STUCK×${ds.stuckTicks} — escape heading=${escapeHeading.toFixed(0)}° pos=(${self.position.x.toFixed(1)},${self.position.y.toFixed(1)})`);
    // Fall through to wall avoidance — do NOT early-return here.
    // Blind escape at max speed into a wall is what caused the original bug.
  }

  switch (tactic) {
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
  // based on how exposed the vehicle is. This cannot be disabled by any tactic.
  {
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
