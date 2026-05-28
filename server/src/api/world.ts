import fs from 'fs';
import { Router } from 'express';
import { getRegion, WORLD_REGIONS } from '../rules/world';
import { requireAuth, AuthRequest } from './middleware';
import { getDb } from '../db/client';

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

worldRouter.get('/regions', (_req, res) => {
  const summary = Object.values(WORLD_REGIONS).map(region => ({
    id: region.id,
    name: region.name,
    nodeCount: region.nodes.length,
    roadCount: region.roads.length,
  }));
  res.json(summary);
});

worldRouter.get('/regions/:id', (req, res) => {
  const region = getRegion(req.params.id);
  if (!region) return res.status(404).json({ error: 'Region not found' });
  return res.json(region);
});

worldRouter.post('/travel', requireAuth, async (req: AuthRequest, res) => {
  try { fs.appendFileSync('/tmp/travel.log', `[TRAVEL] ${new Date().toISOString()} body=${JSON.stringify(req.body)} toNodeId=${(req.body ?? {}).toNodeId}\n`); } catch(e) {}
  const { toNodeId } = req.body ?? {};
  if (!toNodeId || typeof toNodeId !== 'string') {
    return res.status(400).json({ error: 'toNodeId required' });
  }

  const db = getDb();

  const gangResult = await db.query(
    `SELECT id, current_world_node_id FROM gangs WHERE owner_player_id = $1`,
    [req.playerId]
  );
  if (!gangResult.rows.length) {
    return res.status(404).json({ error: 'Gang not found' });
  }

  const gang = gangResult.rows[0];
  const fromNodeId = gang.current_world_node_id;

  let region = getRegion('midville');
  if (!region) {
    return res.status(500).json({ error: 'World region not found' });
  }

  const fromNode = region.nodes.find(n => n.id === fromNodeId);
  const toNode = region.nodes.find(n => n.id === toNodeId);

  if (!fromNode) {
    return res.status(400).json({ error: `Current location '${fromNodeId}' not found in region` });
  }
  if (!toNode) {
    return res.status(404).json({ error: `Destination '${toNodeId}' not found in region` });
  }

  const road = region.roads.find(
    r => (r.from === fromNodeId && r.to === toNodeId) || (r.from === toNodeId && r.to === fromNodeId)
  );
  if (!road) {
    return res.status(400).json({ error: `No road between '${fromNodeId}' and '${toNodeId}'` });
  }

  const roll = Math.random();
  try { fs.appendFileSync('/tmp/travel.log', `outcome=${roll < road.danger ? "ENCOUNTER" : "ARRIVED"} danger=${road.danger} roll=${roll.toFixed(3)}\n`); } catch(e) {}
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
    [toNodeId, req.playerId]
  );

  return res.json({
    outcome: 'arrived',
    currentNodeId: toNodeId,
  });
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
