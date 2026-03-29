import { Router } from 'express';
import type { BodyType, ChassisType, SuspensionType, TireType, ArmorType, PowerPlantType, ArmorDistribution } from '@carwars/shared';
import { BODIES } from '../rules/data/bodies';
import { POWER_PLANTS } from '../rules/data/power-plants';
import { SUSPENSIONS } from '../rules/data/suspensions';
import { TIRES } from '../rules/data/tires';
import { deriveStats } from '../rules/vehicle';

export const designRouter = Router();

designRouter.post('/', (req, res) => {
  const { bodyType, chassisType, suspensionType, powerPlantType, tireType, armorType, armor } = req.body;

  if (!bodyType || !powerPlantType) {
    return res.status(400).json({ error: 'bodyType and powerPlantType are required' });
  }

  const body = BODIES.find(b => b.id === bodyType);
  if (!body) return res.status(400).json({ error: `Unknown bodyType: ${bodyType}` });

  const plant = POWER_PLANTS.find(p => p.id === powerPlantType);
  if (!plant) return res.status(400).json({ error: `Unknown powerPlantType: ${powerPlantType}` });

  const susp = SUSPENSIONS.find(s => s.id === (suspensionType ?? 'standard'));
  if (!susp) return res.status(400).json({ error: `Unknown suspensionType: ${suspensionType}` });

  const tire = TIRES.find(t => t.id === (tireType ?? 'standard'));
  if (!tire) return res.status(400).json({ error: `Unknown tireType: ${tireType}` });

  const armorDist: ArmorDistribution = armor ?? { front: 0, back: 0, left: 0, right: 0, top: 0, underbody: 0 };

  // Validate armor values are non-negative numbers
  const armorFields = ['front', 'back', 'left', 'right', 'top', 'underbody'] as const;
  for (const field of armorFields) {
    const val = armorDist[field];
    if (typeof val !== 'number' || !isFinite(val) || val < 0) {
      return res.status(400).json({ error: `armor.${field} must be a non-negative number` });
    }
  }

  // Validate armor surfaces: reject surfaces not valid for this body type
  const validSurfaces = new Set(body.surfaces);
  for (const field of armorFields) {
    const val = armorDist[field];
    if (val > 0 && !validSurfaces.has(field)) {
      return res.status(400).json({ error: `${field} is not a valid armor surface for body type ${bodyType}` });
    }
  }

  // Validate power plant matches body category (cycleOnly plants can't go in cars and vice versa)
  if (plant.cycleOnly && !body.isCycle) {
    return res.status(400).json({ error: `Power plant ${powerPlantType} is for cycles only` });
  }
  if (!plant.cycleOnly && body.isCycle) {
    return res.status(400).json({ error: `Body type ${bodyType} requires a cycle power plant` });
  }

  // tireCount mirrors the rule in deriveStats: cycles have 2, cars have 4, trikes have 3
  const tireCount = body.tireCount ?? (body.isCycle ? 2 : 4);

  const loadout = {
    chassisId: 'standard', engineId: 'medium', suspensionId: 'standard',
    tires: Array.from({ length: tireCount }, (_, i) => ({ id: `t${i}`, blown: false })),
    mounts: [],
    armor: armorDist,
    totalCost: 0,
    bodyType: bodyType as BodyType,
    chassisType: (chassisType ?? 'standard') as ChassisType,  // carried through for future use; not yet applied in deriveStats
    suspensionType: (suspensionType ?? 'standard') as SuspensionType,
    tireType: (tireType ?? 'standard') as TireType,
    armorType: (armorType ?? 'ablative') as ArmorType,
    powerPlantType: powerPlantType as PowerPlantType,
  };

  try {
    const stats = deriveStats('design-preview', 'Preview', loadout);

    const armorPts = Object.values(armorDist).reduce((s, v) => s + (v as number), 0);
    const totalCost = body.price + plant.cost + tire.costPerTire * tireCount + armorPts * body.armorCostPerPt;

    return res.json({
      maxSpeed: stats.maxSpeed,
      acceleration: stats.acceleration,
      handlingClass: stats.handlingClass,
      totalWeight: stats.weight,
      totalCost,
    });
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }
});
