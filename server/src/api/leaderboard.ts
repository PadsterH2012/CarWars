import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';
import { getWorldForGang } from '../rules/worldLoader';

export const leaderboardRouter = Router();

leaderboardRouter.get('/', requireAuth, async (req: AuthRequest, res) => {
  try {
    const db  = getDb();
    const ctx = await getWorldForGang(db, req.playerId!);
    if (!ctx) return res.status(404).json({ error: 'Gang not found' });

    const gangRes = await db.query<{
      id: string; name: string; primary_colour: number;
      dominant_since: Date | null; retired: boolean; retire_bonus: number;
    }>(
      `SELECT id, name, primary_colour, dominant_since, retired, retire_bonus
         FROM gangs WHERE owner_player_id = $1`,
      [req.playerId],
    );
    if (!gangRes.rows.length) return res.status(404).json({ error: 'Gang not found' });
    const playerGang = gangRes.rows[0];

    const settlementIds = ctx.world.settlements.map(s => s.id);
    const infRes = await db.query<{
      gang_id: string; total_influence: number; settlement_count: number;
    }>(
      `SELECT gang_id,
              SUM(influence)::int     AS total_influence,
              COUNT(DISTINCT settlement_id)::int AS settlement_count
         FROM zone_influence
         WHERE settlement_id = ANY($1::text[])
         GROUP BY gang_id
         ORDER BY total_influence DESC`,
      [settlementIds],
    );

    // Build a name/colour map: player's own gang + generated rival gangs
    const gangMap = new Map<string, { name: string; primaryColour: number; isPlayer: boolean }>();
    gangMap.set(playerGang.id, {
      name: playerGang.name,
      primaryColour: playerGang.primary_colour,
      isPlayer: true,
    });
    for (const g of ctx.gangs) {
      gangMap.set(g.id, { name: g.name, primaryColour: g.primary_colour, isPlayer: false });
    }

    const ranked = infRes.rows.map((row, i) => {
      const info = gangMap.get(row.gang_id);
      return {
        rank:            i + 1,
        gangId:          row.gang_id,
        gangName:        info?.name ?? 'Unknown Gang',
        primaryColour:   info?.primaryColour ?? 0x888888,
        isPlayer:        info?.isPlayer ?? false,
        totalInfluence:  row.total_influence,
        settlementCount: row.settlement_count,
      };
    });

    const top20      = ranked.slice(0, 20);
    const playerEntry = ranked.find(r => r.isPlayer);
    const playerRank  = playerEntry?.rank ?? ranked.length + 1;

    // Endgame check: 3 real-time hours at #1 triggers the win state
    let endgame = false;
    if (playerRank === 1) {
      if (!playerGang.dominant_since) {
        await db.query(
          `UPDATE gangs SET dominant_since = NOW() WHERE id = $1`,
          [playerGang.id],
        );
      } else {
        const ms = Date.now() - new Date(playerGang.dominant_since).getTime();
        if (ms >= 3 * 3600 * 1000) endgame = true;
      }
    } else if (playerGang.dominant_since) {
      await db.query(
        `UPDATE gangs SET dominant_since = NULL WHERE id = $1`,
        [playerGang.id],
      );
    }

    return res.json({
      entries:     top20,
      playerRank,
      totalGangs:  ranked.length,
      endgame,
      retired:     playerGang.retired,
      retireBonus: playerGang.retire_bonus,
    });
  } catch (err) {
    console.error('[leaderboard/GET]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/leaderboard/retire — archive the gang, credit retire bonus
leaderboardRouter.post('/retire', requireAuth, async (req: AuthRequest, res) => {
  const db = getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const gangRes = await client.query<{
      id: string; dominant_since: Date | null; retired: boolean;
    }>(
      `SELECT id, dominant_since, retired FROM gangs WHERE owner_player_id = $1 FOR UPDATE`,
      [req.playerId],
    );
    if (!gangRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Gang not found' });
    }
    const gang = gangRes.rows[0];

    if (gang.retired) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Already retired' });
    }
    if (
      !gang.dominant_since ||
      Date.now() - new Date(gang.dominant_since).getTime() < 3 * 3600 * 1000
    ) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not eligible — must hold #1 for 3 hours' });
    }

    // Sum total influence across all settlements for this gang
    const infRes = await client.query<{ total: number }>(
      `SELECT COALESCE(SUM(influence), 0)::int AS total
         FROM zone_influence WHERE gang_id = $1`,
      [gang.id],
    );
    const totalInfluence = infRes.rows[0]?.total ?? 0;
    const bonus = Math.max(25000, Math.floor(totalInfluence * 10));

    // Conditional UPDATE — only touches the row if it hasn't been retired by a concurrent request
    const updateRes = await client.query(
      `UPDATE gangs SET retired = TRUE, retire_bonus = $1, dominant_since = NULL
         WHERE id = $2 AND retired = FALSE RETURNING id`,
      [bonus, gang.id],
    );
    if (!updateRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Already retired' });
    }

    await client.query(
      `UPDATE players SET money = money + $1 WHERE id = $2`,
      [bonus, req.playerId],
    );

    await client.query('COMMIT');
    return res.json({ bonus });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[leaderboard/retire]', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});
