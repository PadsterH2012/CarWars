import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';
import { getWorldForGang } from '../rules/worldLoader';
import { resolveRivalActions } from '../rules/rivalSim';
import { resolveSquadEngagement } from '../rules/squadEngagement';

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
      settlement_name: string; description: string; read: boolean; resolved: boolean; created_at: Date;
    }>(
      `SELECT id, action_type, gang_name, settlement_name, description, read, resolved, created_at
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

// POST /api/territory/attack/simulate — headless defense resolution
territoryRouter.post('/attack/simulate', requireAuth, async (req: AuthRequest, res) => {
  try {
    const db = getDb();
    const { logEntryId } = req.body as { logEntryId?: string };
    if (!logEntryId) return res.status(400).json({ error: 'logEntryId required' });

    // Load the attack log entry — must belong to this player, be an attack, unresolved
    const entryRes = await db.query<{
      id: string; gang_id: string; gang_name: string; settlement_id: string; settlement_name: string;
    }>(
      `SELECT id, gang_id, gang_name, settlement_id, settlement_name
         FROM gang_action_log
         WHERE id = $1 AND player_id = $2 AND action_type = 'attack' AND resolved = FALSE`,
      [logEntryId, req.playerId],
    );
    if (!entryRes.rows.length) return res.status(404).json({ error: 'Attack entry not found or already resolved' });
    const entry = entryRes.rows[0];

    const ctx = await getWorldForGang(db, req.playerId!);
    if (!ctx) return res.status(404).json({ error: 'Gang not found' });

    // Get player's available vehicles (not in arena, not destroyed) + drivers
    const vRes = await db.query<{ id: string; name: string; value: number }>(
      `SELECT v.id, v.name, v.value FROM vehicles v
         WHERE v.player_id = $1
           AND COALESCE((v.damage_state->>'destroyed')::boolean, false) = false
           AND v.in_arena = false
           AND NOT EXISTS (
             SELECT 1 FROM squad_deployments sd
             WHERE sd.status = 'in_transit' AND sd.vehicle_ids && ARRAY[v.id]::uuid[]
           )
         ORDER BY v.value DESC LIMIT 4`,
      [req.playerId],
    );
    if (!vRes.rows.length) return res.status(409).json({ error: 'No available vehicles to defend with' });

    const vehicleIds = vRes.rows.map(v => v.id);
    const dRes = await db.query<{ id: string; name: string; skill: number }>(
      `SELECT id, name, skill FROM drivers
         WHERE assigned_vehicle_id = ANY($1::uuid[]) AND player_id = $2 AND alive = TRUE`,
      [vehicleIds, req.playerId],
    );
    if (!dRes.rows.length) return res.status(409).json({ error: 'No available crew to defend with' });

    const result = resolveSquadEngagement({
      squad:          dRes.rows.map(r => ({ id: r.id, name: r.name, skill: r.skill })),
      vehicles:       vRes.rows.map(r => ({ id: r.id, name: r.name, value: r.value })),
      zoneDifficulty: 5,
      assignment:     'patrol',
      basePayout:     0,
      rival:          { id: entry.gang_id, name: entry.gang_name },
    });

    const playerWon = result.outcome === 'success' || result.outcome === 'partial';
    const influenceDelta = 15 + Math.floor(Math.random() * 11); // 15-25

    if (playerWon) {
      // Attacker loses influence in the contested settlement
      await db.query(
        `UPDATE zone_influence SET influence = GREATEST(0, influence - $1)
           WHERE settlement_id = $2 AND gang_id = $3`,
        [influenceDelta, entry.settlement_id, entry.gang_id],
      );
    } else {
      // Player's gang loses influence in the contested settlement
      await db.query(
        `UPDATE zone_influence SET influence = GREATEST(0, influence - $1)
           WHERE settlement_id = $2 AND gang_id = $3`,
        [10 + Math.floor(Math.random() * 11), entry.settlement_id, ctx.gangId],
      );
    }

    // Charge repair costs and deduct from gang treasury
    if (result.repairCost > 0) {
      await db.query(
        `UPDATE gangs SET treasury = GREATEST(0, treasury - $1) WHERE owner_player_id = $2`,
        [result.repairCost, req.playerId],
      );
    }

    // Mark resolved
    await db.query(
      `UPDATE gang_action_log SET resolved = TRUE, read = TRUE WHERE id = $1`,
      [logEntryId],
    );

    return res.json({
      outcome:         result.outcome,
      playerWon,
      repairCost:      result.repairCost,
      influenceDelta:  playerWon ? -influenceDelta : undefined,
      gangName:        entry.gang_name,
      settlementName:  entry.settlement_name,
      perDriver:       result.perDriver,
      vehicles:        result.vehicles,
    });
  } catch (err) {
    console.error('[territory/attack/simulate]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/territory/attack/prepare-defense — returns vehicle IDs + context for ArenaScene launch
territoryRouter.post('/attack/prepare-defense', requireAuth, async (req: AuthRequest, res) => {
  try {
    const db = getDb();
    const { logEntryId } = req.body as { logEntryId?: string };
    if (!logEntryId) return res.status(400).json({ error: 'logEntryId required' });

    const entryRes = await db.query<{
      id: string; gang_id: string; gang_name: string; settlement_id: string; settlement_name: string;
    }>(
      `SELECT id, gang_id, gang_name, settlement_id, settlement_name
         FROM gang_action_log
         WHERE id = $1 AND player_id = $2 AND action_type = 'attack' AND resolved = FALSE`,
      [logEntryId, req.playerId],
    );
    if (!entryRes.rows.length) return res.status(404).json({ error: 'Attack entry not found or already resolved' });
    const entry = entryRes.rows[0];

    // Pick best available vehicles (highest value → likely best equipped)
    const vRes = await db.query<{ id: string }>(
      `SELECT v.id FROM vehicles v
         WHERE v.player_id = $1
           AND COALESCE((v.damage_state->>'destroyed')::boolean, false) = false
           AND v.in_arena = false
           AND EXISTS (
             SELECT 1 FROM drivers d
             WHERE d.assigned_vehicle_id = v.id AND d.player_id = $1 AND d.alive = TRUE
           )
           AND NOT EXISTS (
             SELECT 1 FROM squad_deployments sd
             WHERE sd.status = 'in_transit' AND sd.vehicle_ids && ARRAY[v.id]::uuid[]
           )
         ORDER BY v.value DESC LIMIT 4`,
      [req.playerId],
    );
    if (!vRes.rows.length) return res.status(409).json({ error: 'No available vehicles to defend with' });

    return res.json({
      vehicleIds:     vRes.rows.map(r => r.id),
      logEntryId:     entry.id,
      gangName:       entry.gang_name,
      settlementName: entry.settlement_name,
    });
  } catch (err) {
    console.error('[territory/attack/prepare-defense]', err);
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
