import { Router } from 'express';
import { getDb } from '../db/client';
import { requireAuth, AuthRequest } from './middleware';

export const divisionRouter = Router();
divisionRouter.use(requireAuth);

const DIVISION_THRESHOLDS = [
  { division: 25, minValue: 100000 },
  { division: 20, minValue: 50000 },
  { division: 15, minValue: 25000 },
  { division: 10, minValue: 10000 },
  { division: 5, minValue: 0 }
];

export function calcDivision(topVehicleValue: number): number {
  for (const { division, minValue } of DIVISION_THRESHOLDS) {
    if (topVehicleValue >= minValue) return division;
  }
  return 5;
}

divisionRouter.get('/', async (req: AuthRequest, res) => {
  const db = getDb();
  const pResult = await db.query(
    `SELECT division, money, reputation FROM players WHERE id = $1`,
    [req.playerId]
  );
  if (!pResult.rows.length) return res.status(404).json({ error: 'Not found' });
  const player = pResult.rows[0];

  const standings = await db.query(
    `SELECT p.username, p.money, p.reputation FROM players p WHERE p.division = $1
     ORDER BY p.reputation DESC LIMIT 10`,
    [player.division]
  );

  return res.json({
    division: player.division,
    money: player.money,
    reputation: player.reputation,
    standings: standings.rows
  });
});

divisionRouter.post('/recalculate', async (req: AuthRequest, res) => {
  const db = getDb();
  const vResult = await db.query(
    `SELECT MAX(value) as top_value FROM vehicles WHERE player_id = $1`,
    [req.playerId]
  );
  const topValue = vResult.rows[0]?.top_value ?? 0;
  const newDivision = calcDivision(topValue);

  await db.query(`UPDATE players SET division = $1 WHERE id = $2`, [newDivision, req.playerId]);
  return res.json({ division: newDivision, topVehicleValue: topValue });
});
