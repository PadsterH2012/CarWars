import type { Pool } from 'pg';
import type { GeneratedWorld } from '@carwars/shared';
import type { GeneratedGang } from './gangGen';
import { getWorldForGang } from './worldLoader';

export interface RivalActionLog {
  gangId:         string;
  gangName:       string;
  settlementId:   string;
  settlementName: string;
  actionType:     'patrol' | 'expand' | 'harass' | 'attack';
  description:    string;
}

type InfluenceMap = Map<string, number>;

function infKey(sid: string, gid: string): string { return `${sid}:${gid}`; }
function getInf(m: InfluenceMap, sid: string, gid: string): number { return m.get(infKey(sid, gid)) ?? 0; }
function setInf(m: InfluenceMap, sid: string, gid: string, val: number): void { m.set(infKey(sid, gid), Math.max(0, val)); }

function rollAction(): 'patrol' | 'expand' | 'harass' | 'attack' {
  const r = Math.random();
  if (r < 0.40) return 'patrol';
  if (r < 0.65) return 'expand';
  if (r < 0.85) return 'harass';
  return 'attack';
}

function adjacentTo(world: GeneratedWorld, sid: string): string[] {
  return world.roads
    .filter(r => r.from === sid || r.to === sid)
    .map(r => r.from === sid ? r.to : r.from);
}

export function simulateTurn(
  gang: GeneratedGang,
  world: GeneratedWorld,
  influence: Map<string, number>,
  allGangs: GeneratedGang[],
): RivalActionLog | null {
  const action = rollAction();

  if (action === 'patrol') {
    const present = world.settlements.filter(s => getInf(influence, s.id, gang.id) > 0);
    if (!present.length) return null;
    const target = present[Math.floor(Math.random() * present.length)];
    const gain   = 1 + Math.floor(getInf(influence, target.id, gang.id) / 20);
    setInf(influence, target.id, gang.id, getInf(influence, target.id, gang.id) + gain);
    return { gangId: gang.id, gangName: gang.name, settlementId: target.id, settlementName: target.name,
      actionType: 'patrol', description: `${gang.name} patrolled ${target.name} → +${gain} influence` };
  }

  if (action === 'expand') {
    const present = world.settlements.filter(s => getInf(influence, s.id, gang.id) > 0).map(s => s.id);
    const adjIds  = new Set(present.flatMap(sid => adjacentTo(world, sid)));
    const targets = world.settlements.filter(s => adjIds.has(s.id) && getInf(influence, s.id, gang.id) === 0);
    if (!targets.length) return null;
    const target = targets[Math.floor(Math.random() * targets.length)];
    const gain   = 5 + Math.floor(Math.random() * 6);
    setInf(influence, target.id, gang.id, gain);
    return { gangId: gang.id, gangName: gang.name, settlementId: target.id, settlementName: target.name,
      actionType: 'expand', description: `${gang.name} expanded into ${target.name} → +${gain} influence` };
  }

  if (action === 'harass') {
    const shared = world.settlements.filter(s => {
      if (getInf(influence, s.id, gang.id) === 0) return false;
      return allGangs.some(g => g.id !== gang.id && getInf(influence, s.id, g.id) > 0);
    });
    if (!shared.length) return null;
    const target = shared[Math.floor(Math.random() * shared.length)];
    const rivals = allGangs.filter(g => g.id !== gang.id && getInf(influence, target.id, g.id) > 0);
    if (!rivals.length) return null;
    const victim = rivals[Math.floor(Math.random() * rivals.length)];
    const loss   = 3 + Math.floor(Math.random() * 6);
    setInf(influence, target.id, victim.id, getInf(influence, target.id, victim.id) - loss);
    return { gangId: gang.id, gangName: gang.name, settlementId: target.id, settlementName: target.name,
      actionType: 'harass', description: `${gang.name} harassed ${victim.name} in ${target.name} → -${loss} influence` };
  }

  // attack — logged as a threat, no DEFEND/SIMULATE flow in Phase 5c
  const home = world.settlements.find(s => s.id === gang.home_settlement_id);
  if (!home) return null;
  return { gangId: gang.id, gangName: gang.name, settlementId: home.id, settlementName: home.name,
    actionType: 'attack', description: `⚠ ${gang.name} is threatening your territory in ${home.name}` };
}

export async function resolveRivalActions(playerId: string, db: Pool): Promise<RivalActionLog[]> {
  const ctx = await getWorldForGang(db, playerId);
  if (!ctx || !ctx.gangs.length) return [];

  const { world, gangs } = ctx;

  const timeRow = await db.query<{ last_rival_sim_at: Date | null }>(
    `SELECT last_rival_sim_at FROM gangs WHERE owner_player_id = $1`,
    [playerId],
  );
  if (!timeRow.rows.length) return [];

  const last  = timeRow.rows[0].last_rival_sim_at;
  const hours = last
    ? Math.min(24, Math.floor((Date.now() - last.getTime()) / 3_600_000))
    : 1;

  if (hours === 0) return [];

  const settlementIds = world.settlements.map(s => s.id);
  const infRows = await db.query<{ settlement_id: string; gang_id: string; influence: number }>(
    `SELECT settlement_id, gang_id, influence FROM zone_influence
       WHERE settlement_id = ANY($1::text[])`,
    [settlementIds],
  );
  const influence: InfluenceMap = new Map();
  for (const r of infRows.rows) influence.set(infKey(r.settlement_id, r.gang_id), r.influence);

  const logs: RivalActionLog[] = [];
  for (let t = 0; t < hours; t++) {
    for (const gang of gangs) {
      const log = simulateTurn(gang, world, influence, gangs);
      if (log) logs.push(log);
    }
  }

  // Batch-write updated influence
  for (const [key, val] of influence.entries()) {
    const colonIdx = key.indexOf(':');
    const sid = key.slice(0, colonIdx);
    const gid = key.slice(colonIdx + 1);
    await db.query(
      `INSERT INTO zone_influence (settlement_id, gang_id, influence)
       VALUES ($1, $2, $3)
       ON CONFLICT (settlement_id, gang_id) DO UPDATE SET influence = $3, last_action_at = NOW()`,
      [sid, gid, val],
    );
  }

  // Write log entries (max 50 per call)
  for (const log of logs.slice(0, 50)) {
    await db.query(
      `INSERT INTO gang_action_log
         (player_id, action_type, gang_id, gang_name, settlement_id, settlement_name, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [playerId, log.actionType, log.gangId, log.gangName,
       log.settlementId, log.settlementName, log.description],
    );
  }

  // Trim oldest if over 100 per player
  await db.query(
    `DELETE FROM gang_action_log WHERE player_id = $1
       AND id NOT IN (SELECT id FROM gang_action_log WHERE player_id = $1
                      ORDER BY created_at DESC LIMIT 100)`,
    [playerId],
  );

  await db.query(
    `UPDATE gangs SET last_rival_sim_at = NOW() WHERE owner_player_id = $1`,
    [playerId],
  );

  return logs;
}
