import fs from 'fs';
import { Router } from 'express';
import { requireAuth, AuthRequest } from './middleware';
import { getDb } from '../db/client';
import { getWorldForGang } from '../rules/worldLoader';

export const worldRouter = Router();

function encounterMapId(table: string): string {
  const MAP: Record<string, string> = {
    'highway-low':     'highway-ambush',
    'highway-medium':  'highway-ambush',
    'gang-high':       'crossroads-blockade',
    'dirt-medium':     'truck-stop-forecourt',
    'urban-medium':    'truck-stop-forecourt',
  };
  return MAP[table] ?? 'truck-stop';
}

worldRouter.get('/map', requireAuth, async (req: AuthRequest, res) => {
  try {
    const db  = getDb();
    const ctx = await getWorldForGang(db, req.playerId!);
    if (!ctx) return res.status(404).json({ error: 'Gang not found' });
    return res.json(ctx.world);
  } catch (err) {
    console.error('[world/map]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

worldRouter.post('/travel', requireAuth, async (req: AuthRequest, res) => {
  try {
    fs.appendFileSync('/tmp/travel.log', `[TRAVEL] ${new Date().toISOString()} body=${JSON.stringify(req.body)}\n`);
  } catch (_e) {}

  const { toNodeId } = req.body ?? {};
  if (!toNodeId || typeof toNodeId !== 'string') {
    return res.status(400).json({ error: 'toNodeId required' });
  }

  try {
    const db  = getDb();
    const ctx = await getWorldForGang(db, req.playerId!);
    if (!ctx) return res.status(404).json({ error: 'Gang not found' });

    const { world } = ctx;
    const fromNodeId = ctx.fromNodeId;

    const fromNode = world.settlements.find(s => s.id === fromNodeId);
    const toNode   = world.settlements.find(s => s.id === toNodeId);

    if (!fromNode) {
      return res.status(400).json({ error: `Current location '${fromNodeId}' not found` });
    }
    if (!toNode) {
      return res.status(404).json({ error: `Destination '${toNodeId}' not found` });
    }

    const road = world.roads.find(
      r => (r.from === fromNodeId && r.to === toNodeId) || (r.from === toNodeId && r.to === fromNodeId),
    );
    if (!road) {
      return res.status(400).json({ error: `No road between '${fromNodeId}' and '${toNodeId}'` });
    }

    const roll = Math.random();
    try {
      fs.appendFileSync('/tmp/travel.log', `outcome=${roll < road.danger ? 'ENCOUNTER' : 'ARRIVED'} danger=${road.danger} roll=${roll.toFixed(3)}\n`);
    } catch (_e) {}

    if (roll < road.danger) {
      return res.json({
        outcome: 'encounter',
        encounterId: `enc-${road.id}-${Date.now()}`,
        tacticalMapId: encounterMapId(road.encounterTable),
        description: `Ambush on the ${road.roadType} road to ${toNode.name}!`,
      });
    }

    await db.query(
      `UPDATE gangs SET current_world_node_id = $1 WHERE owner_player_id = $2`,
      [toNodeId, req.playerId],
    );

    return res.json({ outcome: 'arrived', currentNodeId: toNodeId });
  } catch (err) {
    console.error('[world/travel]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

worldRouter.get('/state', requireAuth, async (req: AuthRequest, res) => {
  const db = getDb();
  const result = await db.query(
    `SELECT current_world_node_id FROM gangs WHERE owner_player_id = $1`,
    [req.playerId]
  );
  if (!result.rows.length) {
    return res.status(404).json({ error: 'Gang not found' });
  }
  return res.json({ currentNodeId: result.rows[0].current_world_node_id });
});
