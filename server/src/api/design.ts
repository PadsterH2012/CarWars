import { Router } from 'express';
import type { BodyType, ChassisType, SuspensionType, TireType, ArmorType, PowerPlantType, ArmorDistribution } from '@carwars/shared';
import { BODIES } from '../rules/data/bodies';
import { POWER_PLANTS } from '../rules/data/power-plants';
import { SUSPENSIONS } from '../rules/data/suspensions';
import { TIRES } from '../rules/data/tires';
import { WEAPONS } from '../rules/data/weapons';
import { deriveStats } from '../rules/vehicle';
import { computeCapacity } from '../rules/capacity';
import { SIDECAR } from '../rules/data/sidecars';
import { ACCESSORY_INDEX } from '../rules/data/accessories';

// Armor type cost and weight multipliers (Compendium 2E, p.40)
// costMul applies to armorCostPerPt, wtMul applies to armorWtPerPt
const ARMOR_TYPE_MULS: Record<string, { costMul: number; wtMul: number }> = {
  ablative:         { costMul: 1, wtMul: 1 },
  metal:            { costMul: 1, wtMul: 2 },
  fireproof:        { costMul: 2, wtMul: 1 },
  laser_reflective: { costMul: 2, wtMul: 1 },
  lr_fireproof:     { costMul: 4, wtMul: 1 },
  radarproof:       { costMul: 2, wtMul: 1 },
};

export const designRouter = Router();

designRouter.post('/', (req, res) => {
  const { bodyType, chassisType, suspensionType, powerPlantType, tireType, armorType, armor, mounts } = req.body;

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

  // Resolve mounts: array of { weaponId, arc, ammo } from the request
  const mountList: { id: string; weaponId: string; arc: string; ammo: number }[] =
    Array.isArray(mounts)
      ? mounts.map((m: any, i: number) => ({
          id: m.id ?? `m${i}`,
          weaponId: m.weaponId,
          arc: m.arc ?? 'front',
          ammo: typeof m.ammo === 'number' ? m.ammo : 0,
        })).filter((m: { weaponId: string }) => WEAPONS.find(w => w.id === m.weaponId))
      : [];

  const loadout = {
    chassisId: 'standard', engineId: 'medium', suspensionId: 'standard',
    tires: Array.from({ length: tireCount }, (_, i) => ({ id: `t${i}`, blown: false })),
    mounts: mountList,
    armor: armorDist,
    totalCost: 0,
    bodyType: bodyType as BodyType,
    chassisType: (chassisType ?? 'standard') as ChassisType,  // carried through for future use; not yet applied in deriveStats
    suspensionType: (suspensionType ?? 'standard') as SuspensionType,
    tireType: (tireType ?? 'standard') as TireType,
    armorType: (armorType ?? 'ablative') as ArmorType,
    powerPlantType: powerPlantType as PowerPlantType,
    hasSidecar: !!req.body.hasSidecar,
    accessories: Array.isArray(req.body.accessories) ? req.body.accessories : [],
  };

  try {
    const stats = deriveStats('design-preview', 'Preview', loadout);

    const armorPts = Object.values(armorDist).reduce((s, v) => s + (v as number), 0);
    const suspCost = Math.round(susp.costMultiplier * body.price);
    const weaponCost = mountList.reduce((sum, m) => {
      const w = WEAPONS.find(ww => ww.id === m.weaponId);
      return w ? sum + w.cost + w.ammoCost * m.ammo : sum;
    }, 0);
    const armorMul = ARMOR_TYPE_MULS[loadout.armorType ?? 'ablative'] ?? ARMOR_TYPE_MULS.ablative;
    const accessoryCost = (loadout.accessories ?? []).reduce((s, a) => {
      const def = ACCESSORY_INDEX[a.id];
      return def ? s + def.cost : s;
    }, 0);
    const totalCost = body.price + plant.cost + tire.costPerTire * tireCount
      + armorPts * body.armorCostPerPt * armorMul.costMul
      + suspCost + weaponCost
      + (loadout.hasSidecar ? SIDECAR.cost : 0)
      + accessoryCost;

    const capacity = computeCapacity(loadout);
    return res.json({
      maxSpeed: stats.maxSpeed,
      acceleration: stats.acceleration,
      handlingClass: stats.handlingClass,
      totalWeight: stats.weight,
      totalCost,
      capacity,
    });
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }
});
