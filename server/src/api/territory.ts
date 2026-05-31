import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';
import { getWorldForGang } from '../rules/worldLoader';

export const territoryRouter = Router();

territoryRouter.get('/influence', requireAuth, async (req: AuthRequest, res) => {
  try {
    const db  = getDb();
    const ctx = await getWorldForGang(db, req.playerId!);
    if (!ctx) return res.status(404).json({ error: 'Gang not found' });

    const settlementIds = ctx.world.settlements.map(s => s.id);
    const result = await db.query<{
      settlement_id: string; gang_id: string; influence: number;
    }>(
      `SELECT settlement_id, gang_id, influence
         FROM zone_influence
         WHERE settlement_id = ANY($1::text[])
         ORDER BY settlement_id, influence DESC`,
      [settlementIds],
    );

    const bySettlement: Record<string, { gangId: string; influence: number }[]> = {};
    for (const row of result.rows) {
      if (!bySettlement[row.settlement_id]) bySettlement[row.settlement_id] = [];
      bySettlement[row.settlement_id].push({ gangId: row.gang_id, influence: row.influence });
    }

    return res.json({ bySettlement });
  } catch (err) {
    console.error('[territory/influence]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

territoryRouter.get('/player-influence', requireAuth, async (req: AuthRequest, res) => {
  try {
    const db  = getDb();
    const ctx = await getWorldForGang(db, req.playerId!);
    if (!ctx) return res.status(404).json({ error: 'Gang not found' });

    const result = await db.query<{
      settlement_id: string; influence: number;
    }>(
      `SELECT settlement_id, influence FROM zone_influence WHERE gang_id = $1 ORDER BY influence DESC`,
      [ctx.gangId],
    );

    const totalInfluence = result.rows.reduce((s, r) => s + r.influence, 0);
    return res.json({
      settlements: result.rows.map(r => r.settlement_id),
      totalInfluence,
    });
  } catch (err) {
    console.error('[territory/player-influence]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
