import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';
import { getWorldForGang } from '../rules/worldLoader';
import { resolveRivalActions } from '../rules/rivalSim';

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

// GET /api/territory/activity/unread-count — badge count, triggers rival sim
territoryRouter.get('/activity/unread-count', requireAuth, async (req: AuthRequest, res) => {
  try {
    const db = getDb();
    await resolveRivalActions(req.playerId!, db);
    const result = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM gang_action_log WHERE player_id = $1 AND read = FALSE`,
      [req.playerId],
    );
    return res.json({ unread: result.rows[0]?.n ?? 0 });
  } catch (err) {
    console.error('[territory/activity/unread-count]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/territory/activity — recent rival action log
territoryRouter.get('/activity', requireAuth, async (req: AuthRequest, res) => {
  try {
    const db = getDb();
    const result = await db.query<{
      id: string; action_type: string; gang_name: string;
      settlement_name: string; description: string; read: boolean; created_at: Date;
    }>(
      `SELECT id, action_type, gang_name, settlement_name, description, read, created_at
         FROM gang_action_log WHERE player_id = $1
         ORDER BY created_at DESC LIMIT 50`,
      [req.playerId],
    );
    return res.json({ entries: result.rows });
  } catch (err) {
    console.error('[territory/activity]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/territory/activity/read-all — mark all activity log entries read
territoryRouter.post('/activity/read-all', requireAuth, async (req: AuthRequest, res) => {
  try {
    const db = getDb();
    await db.query(
      `UPDATE gang_action_log SET read = TRUE WHERE player_id = $1`,
      [req.playerId],
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('[territory/activity/read-all]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
