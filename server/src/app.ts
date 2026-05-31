import express from 'express';
import cors from 'cors';
import path from 'path';
import { authRouter } from './api/auth';
import { vehiclesRouter } from './api/vehicles';
import { driversRouter } from './api/drivers';
import { economyRouter, jobsRouter } from './api/economy';
import { divisionRouter } from './api/division';
import { zonesRouter } from './api/zones';
import { designRouter } from './api/design';
import { gangsRouter } from './api/gangs';
import { weaponsRouter } from './api/weapons';
import { catalogRouter } from './api/catalog';
import { stockRouter } from './api/stock';
import { mapsRouter } from './api/maps';
import { worldRouter } from './api/world';
import { garagesRouter } from './api/garages';
import { deployRouter } from './api/deploy';
import { reportsRouter } from './api/reports';
import { territoryRouter } from './api/territory';
import { requireAuth, AuthRequest } from './api/middleware';
import { getDb } from './db/client';
import { lastResults } from './ws/handler';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use('/api/auth', authRouter);
  app.use('/api/vehicles/design', designRouter);
  app.use('/api/vehicles', vehiclesRouter);
  app.use('/api/drivers', driversRouter);
  app.use('/api/economy', economyRouter);
  app.use('/api/jobs', jobsRouter);
  app.use('/api/division', divisionRouter);
  app.use('/api/zones', zonesRouter);
  app.use('/api/gangs', gangsRouter);
  app.use('/api/weapons', weaponsRouter);
  app.use('/api/catalog', catalogRouter);
  app.use('/api/stock', stockRouter);
  app.use('/api/maps', mapsRouter);
  app.use('/api/world', worldRouter);
  app.use('/api/garages', garagesRouter);
  app.use('/api/deploy', deployRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/territory', territoryRouter);

  app.get('/api/me', requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const result = await db.query(
      `SELECT id, username, money, division, reputation,
              selected_vehicle_id, selected_driver_id,
              wins, losses, kills, arena_count,
              attributes, xp_pool
       FROM players WHERE id = $1`,
      [req.playerId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json(result.rows[0]);
  });

  app.post('/api/me/select-vehicle', requireAuth, async (req: AuthRequest, res) => {
    const { vehicleId } = req.body ?? {};
    if (typeof vehicleId !== 'string' || !vehicleId) {
      return res.status(400).json({ error: 'vehicleId required' });
    }
    const db = getDb();
    const result = await db.query(
      `UPDATE players SET selected_vehicle_id = vehicles.id
       FROM vehicles
       WHERE vehicles.id = $1 AND vehicles.player_id = players.id AND players.id = $2
       RETURNING players.selected_vehicle_id`,
      [vehicleId, req.playerId]
    );
    if (!result.rows.length) return res.status(403).json({ error: 'Vehicle not found or not owned' });
    return res.json({ selectedVehicleId: result.rows[0].selected_vehicle_id });
  });

  app.get('/api/replays', requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const result = await db.query(
      `SELECT id, zone_id, opponent, duration_ticks, result, prize, recorded_at
       FROM match_replays WHERE player_id = $1 ORDER BY recorded_at DESC LIMIT 50`,
      [req.playerId]
    );
    return res.json(result.rows);
  });

  app.get('/api/replays/:id', requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const result = await db.query(
      `SELECT id, zone_id, opponent, duration_ticks, result, prize, data, recorded_at
       FROM match_replays WHERE id = $1 AND player_id = $2`,
      [req.params.id, req.playerId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json(result.rows[0]);
  });

  app.get('/api/me/last-result', requireAuth, async (req: AuthRequest, res) => {
    // One-shot read — clear after returning so a refresh doesn't keep showing
    // the same result. lastResults is in-process state populated by the WS
    // handler's onEnd callback.
    const result = lastResults.get(req.playerId!) ?? null;
    if (result) lastResults.delete(req.playerId!);
    return res.json(result);
  });

  app.post('/api/me/claim-starter', requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Check if player already has vehicles
      const existing = await client.query(
        'SELECT COUNT(*)::int AS cnt FROM vehicles WHERE player_id = $1',
        [req.playerId]
      );
      if (existing.rows[0].cnt > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Already have vehicles' });
      }

      // Build a starter loadout — Sprocket-like, front MG, basic armor
      const loadout = {
        chassisId: 'compact', engineId: 'medium', suspensionId: 'standard',
        tires: [{ id: 't0', blown: false }, { id: 't1', blown: false },
                { id: 't2', blown: false }, { id: 't3', blown: false }],
        mounts: [{ id: 'm0', arc: 'front', weaponId: 'mg', ammo: 200 }],
        armor: { front: 6, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
        totalCost: 12000,
      };
      const damageState = {
        armor: { front: 6, back: 4, left: 4, right: 4, top: 2, underbody: 2 },
        engineDamaged: false, driverWounded: false, tiresBlown: [], destroyed: false,
      };

      // Create the vehicle
      const vRes = await client.query(
        `INSERT INTO vehicles (player_id, name, loadout, original_loadout, damage_state, value)
         VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`,
        [req.playerId, 'Sprocket', JSON.stringify(loadout), JSON.stringify(damageState), 12000]
      );
      const vehicleId = vRes.rows[0].id;

      // Assign gang
      const gRes = await client.query('SELECT id FROM gangs WHERE owner_player_id = $1', [req.playerId]);
      if (gRes.rows.length) {
        await client.query('UPDATE vehicles SET gang_id = $1 WHERE id = $2', [gRes.rows[0].id, vehicleId]);
      }

      // Create a default driver assigned to the vehicle
      const dRes = await client.query(
        `INSERT INTO drivers (player_id, name, skill, aggression, loyalty, assigned_vehicle_id, gang_id)
         SELECT $1, $2, 3, 3, 5, $3, id FROM gangs WHERE owner_player_id = $1 RETURNING id`,
        [req.playerId, 'Rookie', vehicleId]
      );
      const driverId = dRes.rows.length ? dRes.rows[0].id : null;

      // Auto-select the starter vehicle + driver
      await client.query(
        'UPDATE players SET selected_vehicle_id = $1, selected_driver_id = $2 WHERE id = $3',
        [vehicleId, driverId, req.playerId]
      );

      await client.query('COMMIT');
      return res.status(201).json({ vehicleId, driverId });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('Failed to claim starter:', e);
      return res.status(500).json({ error: 'Server error' });
    } finally {
      client.release();
    }
  });

  // Debug-only: award XP to the player's pool directly. Disabled in production
  // because it would let any authenticated player grant themselves arbitrary XP.
  // Production XP comes exclusively from the match runner in ws/handler.ts.
  if (process.env.NODE_ENV !== 'production') {
    app.post('/api/me/award-xp', requireAuth, async (req: AuthRequest, res) => {
      const { xp } = req.body ?? {};
      if (typeof xp !== 'number' || xp < 0) return res.status(400).json({ error: 'Non-negative xp required' });
      const db = getDb();
      await db.query(`UPDATE players SET xp_pool = xp_pool + $1 WHERE id = $2`, [xp, req.playerId]);
      return res.json({ ok: true });
    });
  }


  app.post('/api/me/select-driver', requireAuth, async (req: AuthRequest, res) => {
    const { driverId } = req.body ?? {};
    if (typeof driverId !== 'string' || !driverId) {
      return res.status(400).json({ error: 'driverId required' });
    }
    const db = getDb();
    const result = await db.query(
      `UPDATE players SET selected_driver_id = drivers.id
       FROM drivers
       WHERE drivers.id = $1 AND drivers.player_id = players.id AND players.id = $2
       RETURNING players.selected_driver_id`,
      [driverId, req.playerId]
    );
    if (!result.rows.length) return res.status(403).json({ error: 'Driver not found or not owned' });
    return res.json({ selectedDriverId: result.rows[0].selected_driver_id });
  });

  // Serve client static files — in production these are in /public next to dist/main.js
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));
  // SPA fallback — return index.html for any non-API route
  app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  return app;
}
