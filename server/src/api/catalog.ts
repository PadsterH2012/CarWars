import { Router } from 'express';
import { BODIES } from '../rules/data/bodies';
import { POWER_PLANTS } from '../rules/data/power-plants';
import { TIRES } from '../rules/data/tires';
import { WEAPONS } from '../rules/data/weapons';
import { TURRETS } from '../rules/data/turrets';

// Aggregate design catalog — read-only, powers the client's fit-check greying
// of engine / tire / armor-type pickers. No auth required.
export const catalogRouter = Router();

// Armor type weight multipliers — keep in sync with design.ts ARMOR_TYPE_MULS
const ARMOR_MULS: Record<string, { costMul: number; wtMul: number }> = {
  ablative:         { costMul: 1, wtMul: 1 },
  metal:            { costMul: 1, wtMul: 2 },
  fireproof:        { costMul: 2, wtMul: 1 },
  laser_reflective: { costMul: 2, wtMul: 1 },
  lr_fireproof:     { costMul: 4, wtMul: 1 },
  radarproof:       { costMul: 2, wtMul: 1 },
};

catalogRouter.get('/', (_req, res) => {
  res.json({
    bodies: BODIES.map(b => ({
      id: b.id, name: b.name, isCycle: b.isCycle,
      spaces: b.spaces, maxLoad: b.maxLoad, baseWeight: b.baseWeight,
      armorWtPerPt: b.armorWtPerPt,
      tireCount: b.tireCount ?? (b.isCycle ? 2 : 4),
      maxTurretSize: b.maxTurretSize,
    })),
    turrets: TURRETS,
    plants: POWER_PLANTS.map(p => ({
      id: p.id, name: p.name, cycleOnly: p.cycleOnly,
      spaces: p.spaces, weight: p.weight,
    })),
    tires: TIRES.map(t => ({
      id: t.id, name: t.name, weightPerTire: t.weightPerTire, hcModifier: t.hcModifier,
    })),
    armors: ARMOR_MULS,
    weapons: WEAPONS,
  });
});
