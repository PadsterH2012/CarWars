import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';

export const gangsRouter = Router();
gangsRouter.use(requireAuth);

// Emblem template ids — keep in sync with client/src/game/CoatOfArms.ts
const VALID_EMBLEMS = new Set([
  'stripes', 'cross', 'chevron', 'quartered', 'star', 'skull', 'circle', 'tire',
]);

// GET /api/gangs/mine — the calling player's gang
gangsRouter.get('/mine', async (req: AuthRequest, res) => {
  const db = getDb();
  const result = await db.query(
    `SELECT id, name, primary_colour, secondary_colour, emblem_id, treasury, reputation
     FROM gangs WHERE owner_player_id = $1`,
    [req.playerId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Gang not found' });
  return res.json(result.rows[0]);
});

// PATCH /api/gangs/mine — rename / recolour / emblem.
// Body: { name?, primary_colour?, secondary_colour?, emblem_id? }
gangsRouter.patch('/mine', async (req: AuthRequest, res) => {
  const { name, primary_colour, secondary_colour, emblem_id } = req.body ?? {};
  if (name !== undefined && (typeof name !== 'string' || name.length < 1 || name.length > 64)) {
    return res.status(400).json({ error: 'name must be 1–64 chars' });
  }
  for (const [key, v] of [['primary_colour', primary_colour], ['secondary_colour', secondary_colour]] as const) {
    if (v !== undefined && (typeof v !== 'number' || v < 0 || v > 0xffffff || !Number.isInteger(v))) {
      return res.status(400).json({ error: `${key} must be an integer 0..0xFFFFFF` });
    }
  }
  if (emblem_id !== undefined && (typeof emblem_id !== 'string' || !VALID_EMBLEMS.has(emblem_id))) {
    return res.status(400).json({ error: `emblem_id must be one of: ${[...VALID_EMBLEMS].join(', ')}` });
  }

  const db = getDb();
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (name !== undefined) { sets.push(`name = $${idx++}`); params.push(name); }
  if (primary_colour !== undefined) { sets.push(`primary_colour = $${idx++}`); params.push(primary_colour); }
  if (secondary_colour !== undefined) { sets.push(`secondary_colour = $${idx++}`); params.push(secondary_colour); }
  if (emblem_id !== undefined) { sets.push(`emblem_id = $${idx++}`); params.push(emblem_id); }
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.playerId);

  const result = await db.query(
    `UPDATE gangs SET ${sets.join(', ')} WHERE owner_player_id = $${idx}
     RETURNING id, name, primary_colour, secondary_colour, emblem_id, treasury, reputation`,
    params
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Gang not found' });
  return res.json(result.rows[0]);
});
