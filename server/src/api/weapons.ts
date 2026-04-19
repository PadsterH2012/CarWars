import { Router } from 'express';
import { WEAPONS } from '../rules/data/weapons';

// Public weapons catalog — read-only, used by the client's workshop UI to
// populate weapon pickers. No auth required; stats are game-public anyway.
export const weaponsRouter = Router();

weaponsRouter.get('/', (_req, res) => {
  return res.json(WEAPONS);
});
