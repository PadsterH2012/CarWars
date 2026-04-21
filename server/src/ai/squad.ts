// Squad brain — converts four independent AI fighters into a coordinated gang.
//
// Phase 4 of the AI rewrite. Introduces three shared layers:
//   - Role auction: assigns each squadmate one of {anchor, flanker_l, flanker_r,
//     support} based on current squad state. Runs periodically (every 20 ticks
//     = 2 seconds) so roles stay stable but adapt to casualties.
//   - Target claims: when a squadmate fires at an enemy it registers a DPS
//     claim. Other AIs reading the claim prefer less-saturated targets —
//     prevents four squadmates dog-piling the weakest enemy (saturation).
//   - Member lifecycle: dead vehicles fall off members; survivors keep their
//     roles unless the auction reassigns.
//
// The squad layer is READ-ONLY from driver.ts's perspective — it observes
// state and biases tactic/target selection. Claims are written by drivers
// (via updateClaims fed by fire events) but the auction is computed by the
// zone-runner.

import type { VehicleState } from '@carwars/shared';

export type SquadRole = 'anchor' | 'flanker_l' | 'flanker_r' | 'support';

export interface ClaimInfo {
  claimants: string[];       // vehicle IDs currently committed to this target
  committedDps: number;      // approximate combined damage/second the claimants are outputting
  lastFiredTick: Map<string, number>; // per-claimant last-fired tick (for decay)
}

export class SquadContext {
  playerId: string;
  members: string[] = [];                        // alive members, sorted
  roleByAgent = new Map<string, SquadRole>();    // vehicle ID → role
  targetClaims = new Map<string, ClaimInfo>();   // enemy ID → claim info
  lastAuctionTick = -1;
  // Rally point — centroid of surviving squadmates, updated by the auction.
  // Used by the 'support' role to loiter near the group rather than charge.
  rallyPoint = { x: 0, y: 0 };

  constructor(playerId: string) {
    this.playerId = playerId;
  }
}

// ── Claim updates ───────────────────────────────────────────────────────────

export interface FireEvent {
  attackerId: string;
  targetId: string;
  fired: boolean;      // true if the AI pulled the trigger this tick
  dps: number;         // damage-per-second estimate for the attacker's weapon
}

const CLAIM_EXPIRY_TICKS = 30;   // 3 seconds of no-fire → claim expires

// Update the claim registry. Called once per tick by the zone-runner with the
// list of fire events that just happened. Claims decay if a claimant hasn't
// fired at their target within CLAIM_EXPIRY_TICKS.
export function updateClaims(squad: SquadContext, events: FireEvent[], tick: number): void {
  for (const ev of events) {
    if (!ev.fired) continue;
    let claim = squad.targetClaims.get(ev.targetId);
    if (!claim) {
      claim = { claimants: [], committedDps: 0, lastFiredTick: new Map() };
      squad.targetClaims.set(ev.targetId, claim);
    }
    if (!claim.claimants.includes(ev.attackerId)) {
      claim.claimants.push(ev.attackerId);
      claim.committedDps += ev.dps;
    }
    claim.lastFiredTick.set(ev.attackerId, tick);
  }
  // Expire stale claimants
  for (const [targetId, claim] of squad.targetClaims.entries()) {
    const fresh: string[] = [];
    let freshDps = 0;
    for (const claimant of claim.claimants) {
      const last = claim.lastFiredTick.get(claimant) ?? -Infinity;
      if (tick - last <= CLAIM_EXPIRY_TICKS) {
        fresh.push(claimant);
        freshDps += claim.committedDps / Math.max(1, claim.claimants.length);
      } else {
        claim.lastFiredTick.delete(claimant);
      }
    }
    claim.claimants = fresh;
    claim.committedDps = freshDps;
    if (fresh.length === 0) squad.targetClaims.delete(targetId);
  }
}

// Returns a saturation score for a target: 0 = nobody on it, 1 = saturated.
// Used by target-selection to prefer less-claimed enemies.
export function saturationOf(squad: SquadContext, targetId: string): number {
  const claim = squad.targetClaims.get(targetId);
  if (!claim) return 0;
  return Math.min(1, claim.claimants.length / 2); // 2 claimants = fully saturated
}

// ── Role auction ────────────────────────────────────────────────────────────

function armorFrac(v: VehicleState): number {
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

function dist2d(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Role set sized by squad membership. Greedy assignment: for each role in
// priority order, pick the member with the best fit (weighted bid), remove
// them from the pool, repeat. Role stickiness: current role gets −15% on
// own re-bid to prevent churn between two nearly-equal candidates.
//
// Rally-shift: when the squad average HP is below 40%, the auction promotes
// 'support' (rally role) over 'flanker' — damaged squads cluster rather
// than split. This is the cheap version of the plan's full utility scoring;
// good enough to hit the rally ship gate without the influence-map cost.
export function runAuction(squad: SquadContext, allVehicles: VehicleState[]): void {
  // Prune dead members
  squad.members = squad.members.filter(id => {
    const v = allVehicles.find(vv => vv.id === id);
    return v && !v.stats.damageState.destroyed;
  });
  if (squad.members.length === 0) {
    squad.roleByAgent.clear();
    return;
  }

  const members = squad.members
    .map(id => allVehicles.find(v => v.id === id))
    .filter((v): v is VehicleState => !!v);
  const enemies = allVehicles.filter(v =>
    v.playerId !== squad.playerId && !v.stats.damageState.destroyed,
  );

  // Rally point = centroid of surviving squadmates
  if (members.length > 0) {
    const cx = members.reduce((s, v) => s + v.position.x, 0) / members.length;
    const cy = members.reduce((s, v) => s + v.position.y, 0) / members.length;
    squad.rallyPoint = { x: cx, y: cy };
  }

  const avgHealth = members.reduce((s, v) => s + armorFrac(v), 0) / Math.max(1, members.length);
  const rallyMode = avgHealth < 0.4;

  // Role priority list scales with squad size. In rally mode the support
  // slot gets upgraded to "first non-anchor" so the damaged squad has a
  // designated regrouper rather than all going anchor.
  const rolePriority: SquadRole[] = [];
  if (members.length >= 1) rolePriority.push('anchor');
  if (rallyMode && members.length >= 2) rolePriority.push('support');
  if (members.length >= 2) rolePriority.push('flanker_r');
  if (members.length >= 3) rolePriority.push('flanker_l');
  if (!rallyMode && members.length >= 4) rolePriority.push('support');

  const bid = (role: SquadRole, v: VehicleState): number => {
    const hp = armorFrac(v);
    // Anchor: full-strength member closest to best target
    if (role === 'anchor') {
      const closest = enemies.length > 0
        ? Math.min(...enemies.map(e => dist2d(v.position, e.position)))
        : 0;
      return hp * 1.5 - closest / 40; // high hp + short distance → high bid
    }
    // Flanker: any healthy member, bias by "not the anchor candidate"
    if (role === 'flanker_l' || role === 'flanker_r') {
      return hp * 1.0 + (role === 'flanker_l' ? v.position.x / 100 : -v.position.x / 100);
    }
    // Support: damaged vehicles preferred (supports rally behaviour)
    if (role === 'support') {
      return (1 - hp) * 1.5 + 0.2; // low hp → high bid, small baseline
    }
    return 0;
  };

  // Greedy assignment with role stickiness
  const assigned = new Set<string>();
  const newRoles = new Map<string, SquadRole>();
  for (const role of rolePriority) {
    let bestId = '';
    let bestScore = -Infinity;
    for (const v of members) {
      if (assigned.has(v.id)) continue;
      let score = bid(role, v);
      if (squad.roleByAgent.get(v.id) === role) score *= 1.15; // stickiness
      if (score > bestScore) {
        bestScore = score;
        bestId = v.id;
      }
    }
    if (bestId) {
      newRoles.set(bestId, role);
      assigned.add(bestId);
    }
  }
  // Leftovers (if members.length > role slots) — default to support
  for (const v of members) {
    if (!newRoles.has(v.id)) newRoles.set(v.id, 'support');
  }
  squad.roleByAgent = newRoles;
}

// ── Target preference helper ────────────────────────────────────────────────

// Given the squad's claim registry, adjust a raw target "attractiveness" score
// by saturation — targets already claimed by 2+ squadmates lose attractiveness
// so new AIs pick a different enemy.
export function saturationAdjustedScore(squad: SquadContext, targetId: string, rawScore: number): number {
  const sat = saturationOf(squad, targetId);
  // 0 claimants: unchanged. 1: slight penalty. 2+: strong penalty.
  return rawScore * (1 - sat * 0.6);
}
