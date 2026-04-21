// Headless arena match harness — runs in-process without HTTP, WS, or DB.
// Purpose: playability benchmarking. Fire many matches through the same AI
// stack the live server uses, collect per-match signatures (stuck/panic
// counts, match duration, kills, damage dealt), summarise anomalies.
//
// Usage:
//   npx tsx server/scripts/bench-match.ts                 # 5 matches on open
//   npx tsx server/scripts/bench-match.ts --map truck-stop --runs 20
//   npx tsx server/scripts/bench-match.ts --map town-square --runs 50 --quiet
//   npx tsx server/scripts/bench-match.ts --map open --runs 10 --verbose
//
// Flags:
//   --map  { open | truck-stop | town-square }   default: open
//   --runs N                                     default: 5
//   --squad-size N                               default: 2 (per side)
//   --max-ticks N                                default: 1200 (2 min at 10Hz)
//   --quiet                                      no per-tick AI log spam
//   --verbose                                    print per-tick AI/ring/stuck logs

import type { VehicleState, ZoneState, VehicleLoadout } from '@carwars/shared';
import { createTurnEngine } from '../src/rules/engine';
import { deriveStats } from '../src/rules/vehicle';
import { getMap } from '../src/rules/maps';
import { computeAiInput } from '../src/ai/driver';
import { Pathfinder, hashWreckage } from '../src/ai/pathfinder';
import { SquadContext, runAuction, updateClaims, type FireEvent } from '../src/ai/squad';

// ── Stock loadouts (lifted verbatim from server/src/db/schema.sql) ─────────

const TRI_ROCK: VehicleLoadout = {
  bodyType: 'trike', chassisType: 'standard', suspensionType: 'improved',
  powerPlantType: 'cyc_elec_medium', tireType: 'heavy_duty', armorType: 'ablative',
  armor: { front: 17, back: 17, left: 6, right: 25 },
  mounts: [
    { id: 'm0', arc: 'right', weaponId: 'mml', ammo: 5 },
    { id: 'm1', arc: 'right', weaponId: 'mml', ammo: 5 },
    { id: 'm2', arc: 'back', weaponId: 'mr', ammo: 1 },
  ],
  tires: [{ id: 't0', blown: false }, { id: 't1', blown: false }, { id: 't2', blown: false }],
  totalCost: 4880, chassisId: 'mid', engineId: 'medium', suspensionId: 'improved',
} as unknown as VehicleLoadout;

const FIRE_IMP: VehicleLoadout = {
  bodyType: 'hvy_cycle', chassisType: 'standard', suspensionType: 'heavy',
  powerPlantType: 'cyc_gas_small', tireType: 'heavy_duty', armorType: 'fireproof',
  armor: { front: 21, back: 20, left: 0, right: 0 },
  mounts: [{ id: 'm0', arc: 'back', weaponId: 'lft', ammo: 8 }],
  tires: [{ id: 't0', blown: false }, { id: 't1', blown: false }],
  totalCost: 4883, chassisId: 'mid', engineId: 'small', suspensionId: 'heavy',
} as unknown as VehicleLoadout;

const SPEEDBALL: VehicleLoadout = {
  bodyType: 'med_cycle', chassisType: 'standard', suspensionType: 'light',
  powerPlantType: 'cyc_elec_small', tireType: 'standard', armorType: 'ablative',
  armor: { front: 13, back: 12, left: 0, right: 0 },
  mounts: [
    { id: 'm0', arc: 'front', weaponId: 'mg', ammo: 20 },
    { id: 'm1', arc: 'front', weaponId: 'mg', ammo: 20 },
  ],
  tires: [{ id: 't0', blown: false }, { id: 't1', blown: false }],
  totalCost: 4991, chassisId: 'mid', engineId: 'small', suspensionId: 'light',
} as unknown as VehicleLoadout;

const STOCK_POOL: VehicleLoadout[] = [TRI_ROCK, FIRE_IMP, SPEEDBALL];

// ── CLI parsing ───────────────────────────────────────────────────────────
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const MAP_ID       = String(args['map']       ?? 'open');
const RUNS         = parseInt(String(args['runs']       ?? '5'), 10);
const SQUAD_SIZE   = parseInt(String(args['squad-size'] ?? '2'), 10);
const MAX_TICKS    = parseInt(String(args['max-ticks']  ?? '1200'), 10);
const QUIET        = !!args['quiet'];
const VERBOSE      = !!args['verbose'];

// Suppress the driver's verbose per-tick logs unless --verbose
if (!VERBOSE) {
  const _log = console.log;
  console.log = (...xs: unknown[]) => {
    const first = String(xs[0] ?? '');
    if (QUIET) return;
    // Pass through match-summary lines only (our harness output starts with "[MATCH]")
    if (first.startsWith('[AI]') || first.startsWith('[RING]') ||
        first.startsWith('[SURV]') || first.startsWith('[AVOID]') ||
        first.startsWith('[WALL]') || first.startsWith('[PATH]') ||
        first.startsWith('[SQUAD]') || first.startsWith('[CLAIM]')) {
      return;
    }
    _log(...xs);
  };
}

// ── Match runner ──────────────────────────────────────────────────────────

interface DriverSpec { skill: number; aggression: number; loyalty: number; }

interface MatchReport {
  mapId: string;
  ticks: number;
  outcome: 'team_a' | 'team_b' | 'mutual' | 'timeout';
  survivors: { a: number; b: number };
  kills: { a: number; b: number };
  totalDamage: { a: number; b: number };
  crashes: number;
  durationMs: number;
}

function buildVehicle(
  id: string, playerId: string, loadout: VehicleLoadout,
  x: number, y: number, facing: number,
): VehicleState {
  const stats = deriveStats(id, id, loadout);
  return {
    id, playerId, driverId: `d_${id}`,
    position: { x, y }, facing, speed: 0,
    stats,
  };
}

function spawnPoints(
  map: { width: number; height: number; spawnPoints?: Array<{ x: number; y: number; facing: number; team: string }> },
  squadSize: number,
): { a: Array<{ x: number; y: number; facing: number }>; b: Array<{ x: number; y: number; facing: number }>; } {
  // Prefer each map's authored spawn points when enough exist
  const mapPlayer = (map.spawnPoints ?? []).filter(s => s.team === 'player');
  const mapAi     = (map.spawnPoints ?? []).filter(s => s.team === 'ai');
  if (mapPlayer.length >= squadSize && mapAi.length >= squadSize) {
    return {
      a: mapPlayer.slice(0, squadSize),
      b: mapAi.slice(0, squadSize),
    };
  }
  // Fallback: opposite corners with generous spacing. The map-aware spread
  // keeps open-arena (23u tall) matches from devolving into immediate
  // mutual-destruction head-ons.
  const yGap = Math.max(map.height * 0.35, 6);
  const spread = Math.max(map.width * 0.08, 3);
  const a = Array.from({ length: squadSize }, (_, i) => ({
    x: (i - (squadSize - 1) / 2) * spread,
    y:  yGap,
    facing: 0,
  }));
  const b = Array.from({ length: squadSize }, (_, i) => ({
    x: (i - (squadSize - 1) / 2) * spread,
    y: -yGap,
    facing: 180,
  }));
  return { a, b };
}

function isDestroyed(v: VehicleState): boolean {
  return v.stats.damageState.destroyed;
}

async function runMatch(matchIndex: number): Promise<MatchReport> {
  const t0 = Date.now();
  const map = getMap(MAP_ID);
  const spawns = spawnPoints(map, SQUAD_SIZE);

  // Alternate loadouts from the stock pool per squad member to get variety
  const squadA: VehicleState[] = spawns.a.map((p, i) => {
    const loadout = STOCK_POOL[(matchIndex + i) % STOCK_POOL.length];
    return buildVehicle(`a${i}`, 'team_a', loadout, p.x, p.y, p.facing);
  });
  const squadB: VehicleState[] = spawns.b.map((p, i) => {
    const loadout = STOCK_POOL[(matchIndex + i + 1) % STOCK_POOL.length];
    return buildVehicle(`b${i}`, 'team_b', loadout, p.x, p.y, p.facing);
  });

  // Contrasting driver personalities so the aggression/loyalty code sees load
  const driverByVehicle = new Map<string, DriverSpec>();
  for (const [i, v] of squadA.entries()) {
    driverByVehicle.set(v.id, { skill: 3, aggression: i === 0 ? 6 : 2, loyalty: i === 0 ? 3 : 7 });
  }
  for (const [i, v] of squadB.entries()) {
    driverByVehicle.set(v.id, { skill: 3, aggression: i === 0 ? 5 : 3, loyalty: i === 0 ? 4 : 6 });
  }

  const engine = createTurnEngine(
    { id: 'bench', type: 'arena', tick: 0, vehicles: [], hazardObjects: [] },
    map,
    { getDriverSkill: (vid) => driverByVehicle.get(vid)?.skill },
  );
  for (const v of [...squadA, ...squadB]) engine.addVehicle(v);
  const pathfinder = new Pathfinder(map);
  let lastWreckageHash = '';
  const squads = new Map<string, SquadContext>();
  squads.set('team_a', new SquadContext('team_a'));
  squads.set('team_b', new SquadContext('team_b'));

  const report: MatchReport = {
    mapId: MAP_ID, ticks: 0, outcome: 'timeout',
    survivors: { a: squadA.length, b: squadB.length },
    kills: { a: 0, b: 0 }, totalDamage: { a: 0, b: 0 },
    crashes: 0, durationMs: 0,
  };

  // Capture CRASH log lines from the engine per match so the harness can
  // report them without needing the log stream. Monkey-patch console.log
  // for the match lifetime only.
  const _rawLog = console.log;
  console.log = (...xs: unknown[]) => {
    const first = String(xs[0] ?? '');
    if (first.includes('CRASH')) report.crashes++;
    if (VERBOSE) _rawLog(...xs);
  };

  let fireEvents: FireEvent[] = [];

  for (let t = 0; t < MAX_TICKS; t++) {
    const state = engine.getState();
    // Pathfinder obstacle refresh on wreckage change
    const wreckage = state.wreckage ?? [];
    const wh = hashWreckage(wreckage);
    if (wh !== lastWreckageHash) {
      pathfinder.updateObstacles(wreckage);
      lastWreckageHash = wh;
    }
    // Squad maintenance — auction every 20 ticks, claims every tick
    const byPlayer = new Map<string, string[]>();
    for (const v of state.vehicles) {
      if (isDestroyed(v)) continue;
      const arr = byPlayer.get(v.playerId) ?? [];
      arr.push(v.id);
      byPlayer.set(v.playerId, arr);
    }
    for (const [pid, mem] of byPlayer) {
      const squad = squads.get(pid)!;
      squad.members = mem;
      if (t - squad.lastAuctionTick >= 20) {
        runAuction(squad, state.vehicles, (id) => driverByVehicle.get(id));
        squad.lastAuctionTick = t;
      }
    }
    for (const squad of squads.values()) {
      const squadEvents = fireEvents.filter(e => squad.members.includes(e.attackerId));
      updateClaims(squad, squadEvents, t);
    }
    fireEvents = [];

    // Compute + queue AI for each alive vehicle
    const ctxBase = {
      map, allVehicles: state.vehicles, wreckage, tick: t, pathfinder,
    };
    for (const v of state.vehicles) {
      if (isDestroyed(v)) continue;
      const ds = driverByVehicle.get(v.id) ?? { skill: 3, aggression: 3, loyalty: 5 };
      const squad = squads.get(v.playerId);
      const input = computeAiInput(v, { ...ctxBase, ...ds, squad });
      engine.queueInput(v.id, input);
    }

    const newState = engine.resolveTick();
    report.ticks = t + 1;

    // Collect fire events for next tick's claim update + damage tracking
    for (const ev of newState.combatEvents ?? []) {
      fireEvents.push({
        attackerId: ev.attackerId, targetId: ev.targetId, fired: true, dps: ev.damage ?? 1,
      });
      if (!ev.hit) continue;
      const team = ev.attackerId.startsWith('a') ? 'a' : 'b';
      report.totalDamage[team] += ev.damage ?? 0;
      if (ev.destroyed) {
        const killedTeam = ev.targetId.startsWith('a') ? 'a' : 'b';
        report.kills[team === killedTeam ? (team === 'a' ? 'b' : 'a') : team] += 0; // no-op
        report.kills[team] += 1;
      }
    }

    // End condition
    const aliveA = newState.vehicles.filter(v => v.playerId === 'team_a' && !isDestroyed(v)).length;
    const aliveB = newState.vehicles.filter(v => v.playerId === 'team_b' && !isDestroyed(v)).length;
    report.survivors = { a: aliveA, b: aliveB };
    if (aliveA === 0 && aliveB === 0) { report.outcome = 'mutual'; break; }
    if (aliveA === 0) { report.outcome = 'team_b'; break; }
    if (aliveB === 0) { report.outcome = 'team_a'; break; }
  }

  console.log = _rawLog;
  report.durationMs = Date.now() - t0;
  return report;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.error(`bench-match: map=${MAP_ID} runs=${RUNS} squadSize=${SQUAD_SIZE} maxTicks=${MAX_TICKS}`);
  const reports: MatchReport[] = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await runMatch(i);
    reports.push(r);
    const dur = (r.ticks * 100 / 1000).toFixed(1); // world-time seconds
    const wallMs = r.durationMs;
    process.stderr.write(
      `run ${String(i + 1).padStart(3)}/${RUNS}  map=${r.mapId.padEnd(12)}  ${r.outcome.padEnd(7)}  ticks=${String(r.ticks).padStart(4)} (${dur}s)  ` +
      `surv a=${r.survivors.a} b=${r.survivors.b}  dmg a=${String(r.totalDamage.a).padStart(3)} b=${String(r.totalDamage.b).padStart(3)}  ` +
      `kills a=${r.kills.a} b=${r.kills.b}  crashes=${r.crashes}  wall=${wallMs}ms\n`,
    );
  }

  // Summary
  const winA    = reports.filter(r => r.outcome === 'team_a').length;
  const winB    = reports.filter(r => r.outcome === 'team_b').length;
  const mutual  = reports.filter(r => r.outcome === 'mutual').length;
  const tmo     = reports.filter(r => r.outcome === 'timeout').length;
  const avgTicks = Math.round(reports.reduce((s, r) => s + r.ticks, 0) / reports.length);
  const avgWall  = Math.round(reports.reduce((s, r) => s + r.durationMs, 0) / reports.length);
  const totalDmg = reports.reduce((s, r) => s + r.totalDamage.a + r.totalDamage.b, 0);
  const avgDmgPerMatch = Math.round(totalDmg / reports.length);

  const totalCrashes = reports.reduce((s, r) => s + r.crashes, 0);
  const avgCrashes   = (totalCrashes / reports.length).toFixed(1);

  console.error('\n— summary —');
  console.error(`outcomes   : team_a ${winA}  team_b ${winB}  mutual ${mutual}  timeout ${tmo}`);
  console.error(`avg ticks  : ${avgTicks} (${(avgTicks * 100 / 1000).toFixed(1)}s)`);
  console.error(`avg wall   : ${avgWall}ms`);
  console.error(`avg damage : ${avgDmgPerMatch} per match (weapon hits)`);
  console.error(`avg crashes: ${avgCrashes} per match`);
  if (tmo > 0) {
    console.error(`⚠ ${tmo} match(es) hit the ${MAX_TICKS}-tick cap — AI may be stuck`);
  }
  if (mutual / reports.length > 0.6) {
    console.error(`⚠ ${mutual}/${reports.length} matches ended in mutual destruction — spawn distance or AI aggression may be too high`);
  }
  if (avgDmgPerMatch === 0 && totalCrashes > 0) {
    console.error(`⚠ damage=0 across all matches — AI is destroying each other by collision, not combat`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
