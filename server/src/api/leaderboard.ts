import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';
import { getWorldForGang } from '../rules/worldLoader';
import { GARAGE_COST } from './garages';

export const leaderboardRouter = Router();

// ── Blended "prominence" score (v1) ──────────────────────────────────────────
// Prominence = how prominent a gang is overall, blending three axes that each
// matter at a different stage of the game (see Obsidian "32 - Game Vision &
// Progression Spine"):
//   • territory  (influence held)        — dominant LATE game
//   • wealth     (total assets)          — carries you EARLY
//   • notoriety  (reputation)            — carries you EARLY
// Each axis is scored RELATIVE to the field leader (value ÷ max-across-gangs,
// 0–1) so the score stays fair regardless of raw magnitudes, then weighted.
// The early→late tiering is emergent: a new gang holds ~0 territory, so its
// territory term is ~0 and it ranks on wealth + notoriety; as land is taken the
// 0.5-weighted territory term takes over. No per-gang state.
export const PROMINENCE_WEIGHTS = { territory: 0.5, wealth: 0.3, notoriety: 0.2 };

// Rivals carry no vehicles / garages / reputation in the model, only a treasury
// and influence. So we derive a NOTIONAL wealth and notoriety from what they do
// have: their territory implies a fleet + infrastructure (wealth), and their
// power makes them known/feared (notoriety). Without this the player trivially
// tops the wealth and fame axes (rivals would read as $0 / 0 fame). Tunable;
// a cheap proxy until rivals get a fully-modelled economy + reputation.
const RIVAL_ASSETS_PER_INFLUENCE = 1000;   // notional fleet/infra value per influence pt
const RIVAL_NOTORIETY_PER_INFLUENCE = 1;   // fame/fear per influence pt

// Rival notional net worth = liquid treasury + the value their territory implies.
export function rivalWealth(treasury: number, influence: number): number {
  return treasury + influence * RIVAL_ASSETS_PER_INFLUENCE;
}
// Rival fame/fear, derived from how much territory they command.
export function rivalNotoriety(influence: number): number {
  return influence * RIVAL_NOTORIETY_PER_INFLUENCE;
}

export function safeShare(value: number, max: number): number {
  return max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
}

// Pure prominence score (0–100) for one gang given the field maxima. Relative
// per-axis shares × fixed weights. Exported for unit testing.
export function computeProminence(
  g: { totalInfluence: number; wealth: number; notoriety: number },
  max: { influence: number; wealth: number; notoriety: number },
): number {
  return Math.round(100 * (
    PROMINENCE_WEIGHTS.territory  * safeShare(g.totalInfluence, max.influence)
    + PROMINENCE_WEIGHTS.wealth    * safeShare(g.wealth, max.wealth)
    + PROMINENCE_WEIGHTS.notoriety * safeShare(g.notoriety, max.notoriety)
  ));
}

// Cosmetic title derived purely from holdings (decision 6 — does not gate
// anything). Rival gangs have no garage data, so they only ever reach the
// territory-based titles.
export function titleFor(influence: number, settlementCount: number, ownsGarage: boolean): string {
  if (settlementCount >= 5) return 'Kingpin';
  if (influence > 0)        return 'Gang Leader';
  if (ownsGarage)           return 'Garage Boss';
  return 'Duellist';
}

leaderboardRouter.get('/', requireAuth, async (req: AuthRequest, res) => {
  try {
    const db  = getDb();
    const ctx = await getWorldForGang(db, req.playerId!);
    if (!ctx) return res.status(404).json({ error: 'Gang not found' });

    const gangRes = await db.query<{
      id: string; name: string; primary_colour: number; treasury: number; reputation: number;
      dominant_since: Date | null; retired: boolean; retire_bonus: number;
    }>(
      `SELECT id, name, primary_colour, treasury, reputation, dominant_since, retired, retire_bonus
         FROM gangs WHERE owner_player_id = $1`,
      [req.playerId],
    );
    if (!gangRes.rows.length) return res.status(404).json({ error: 'Gang not found' });
    const playerGang = gangRes.rows[0];

    // Player total assets (decision 7): treasury + Σ vehicle value + garage
    // (structural value + uncollected income). Rivals have no vehicles/garages,
    // so their total assets = treasury.
    const [vehRes, garRes] = await Promise.all([
      db.query<{ total: number }>(
        `SELECT COALESCE(SUM(value), 0)::int AS total FROM vehicles WHERE player_id = $1`,
        [req.playerId],
      ),
      db.query<{ accumulated_income: number }>(
        `SELECT accumulated_income FROM garages WHERE player_id = $1`,
        [req.playerId],
      ),
    ]);
    const playerOwnsGarage = garRes.rows.length > 0;
    const playerAssets = playerGang.treasury
      + (vehRes.rows[0]?.total ?? 0)
      + (playerOwnsGarage ? GARAGE_COST + (garRes.rows[0]?.accumulated_income ?? 0) : 0);

    const settlementIds = ctx.world.settlements.map(s => s.id);
    const infRes = await db.query<{
      gang_id: string; total_influence: number; settlement_count: number;
    }>(
      `SELECT gang_id,
              SUM(influence)::int     AS total_influence,
              COUNT(DISTINCT settlement_id)::int AS settlement_count
         FROM zone_influence
         WHERE settlement_id = ANY($1::text[])
         GROUP BY gang_id`,
      [settlementIds],
    );
    const infMap = new Map(infRes.rows.map(r => [r.gang_id, r]));

    // Assemble every gang (player + rivals) with its three prominence inputs.
    type Raw = {
      gangId: string; gangName: string; primaryColour: number; isPlayer: boolean;
      ownsGarage: boolean;
      totalInfluence: number; settlementCount: number; wealth: number; notoriety: number;
    };
    const raw: Raw[] = [];
    raw.push({
      gangId: playerGang.id, gangName: playerGang.name, primaryColour: playerGang.primary_colour,
      isPlayer: true, ownsGarage: playerOwnsGarage,
      totalInfluence: infMap.get(playerGang.id)?.total_influence ?? 0,
      settlementCount: infMap.get(playerGang.id)?.settlement_count ?? 0,
      wealth: playerAssets, notoriety: playerGang.reputation,
    });
    for (const g of ctx.gangs) {
      const gInfluence = infMap.get(g.id)?.total_influence ?? 0;
      raw.push({
        gangId: g.id, gangName: g.name, primaryColour: g.primary_colour,
        isPlayer: false, ownsGarage: false,
        totalInfluence: gInfluence,
        settlementCount: infMap.get(g.id)?.settlement_count ?? 0,
        // Rivals: notional wealth (treasury + territory-implied assets) and
        // notoriety (territory-derived fame) so they contest those axes too.
        wealth: rivalWealth(g.treasury, gInfluence),
        notoriety: rivalNotoriety(gInfluence),
      });
    }

    // Field maxima for relative scoring.
    const maxInf   = Math.max(0, ...raw.map(r => r.totalInfluence));
    const maxWealth = Math.max(0, ...raw.map(r => r.wealth));
    const maxNotor = Math.max(0, ...raw.map(r => r.notoriety));
    const maxima = { influence: maxInf, wealth: maxWealth, notoriety: maxNotor };

    const scored = raw.map(r => ({
      gangId: r.gangId, gangName: r.gangName, primaryColour: r.primaryColour,
      isPlayer: r.isPlayer,
      totalInfluence: r.totalInfluence, settlementCount: r.settlementCount,
      wealth: r.wealth, notoriety: r.notoriety,
      prominence: computeProminence(r, maxima),
      title: titleFor(r.totalInfluence, r.settlementCount, r.ownsGarage),
    }));

    // Rank by prominence; tie-break on territory then wealth (keeps the late-game
    // territory bias even on equal prominence).
    scored.sort((a, b) =>
      b.prominence - a.prominence
      || b.totalInfluence - a.totalInfluence
      || b.wealth - a.wealth,
    );
    const ranked = scored.map((s, i) => ({ rank: i + 1, ...s }));

    const top20 = ranked.slice(0, 20);
    // Always surface the player's own row so the client can pin it when outside
    // the top 20. The player is always in `ranked` now (we seed every gang).
    const playerEntry = ranked.find(r => r.isPlayer)!;
    const playerRank = playerEntry.rank;

    // Endgame stays a TERRITORY win condition (control the most land), not a
    // prominence win — see doc 30. Player is the territory leader iff it holds
    // the strict-or-tied maximum influence and that maximum is > 0.
    const playerIsTerritoryLeader =
      playerEntry.totalInfluence > 0 && playerEntry.totalInfluence === maxInf;

    // Endgame check: 3 real-time hours as territory leader triggers the win state
    let endgame = false;
    if (playerIsTerritoryLeader) {
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
      playerEntry,
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
