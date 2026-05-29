import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';
import { resolveDueDeployments } from './deploy';
import { resolveDueHeadlessJobs } from './economy';

export const reportsRouter = Router();

// ─── Phase 4 — After-action reports ─────────────────────────────────────────
// Reports are written when a squad deployment resolves (see api/deploy.ts).
// The garage shows an unread badge; opening the report list marks nothing read
// until the player explicitly reads a report (POST /:id/read).

// GET /api/reports — list this player's reports with an unread count. Resolves
// any due deployments first so freshly-returned squads surface immediately.
reportsRouter.get('/', requireAuth, async (req: AuthRequest, res) => {
  await resolveDueDeployments(req.playerId!);
  const db = getDb();
  const result = await db.query(
    `SELECT id, zone_id, outcome, report, read, created_at
       FROM engagement_reports
       WHERE player_id = $1
       ORDER BY created_at DESC LIMIT 50`,
    [req.playerId],
  );
  const unread = result.rows.reduce((n, r) => n + (r.read ? 0 : 1), 0);
  return res.json({ unread, reports: result.rows });
});

// GET /api/reports/unread-count — lightweight badge poll for the garage.
reportsRouter.get('/unread-count', requireAuth, async (req: AuthRequest, res) => {
  await resolveDueDeployments(req.playerId!);
  await resolveDueHeadlessJobs(req.playerId!);
  const db = getDb();
  const [eng, jobs] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS n FROM engagement_reports WHERE player_id = $1 AND read = FALSE`, [req.playerId]),
    db.query(
      `SELECT COUNT(*)::int AS n FROM jobs j JOIN drivers d ON d.id = j.assigned_driver_id
        WHERE d.player_id = $1 AND j.outcome IS NOT NULL
          AND COALESCE((j.outcome->>'acknowledged')::boolean, FALSE) = FALSE`,
      [req.playerId]),
  ]);
  return res.json({ unread: eng.rows[0].n + jobs.rows[0].n });
});

// POST /api/reports/:id/read — mark a single report read.
reportsRouter.post('/:id/read', requireAuth, async (req: AuthRequest, res) => {
  const db = getDb();
  const result = await db.query(
    `UPDATE engagement_reports SET read = TRUE WHERE id = $1 AND player_id = $2 RETURNING id`,
    [req.params.id, req.playerId],
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Report not found' });
  return res.json({ id: result.rows[0].id, read: true });
});
