export interface TireDef {
  id: string;
  name: string;
  costPerTire: number;
  weightPerTire: number; // lbs
  dp: number;
  hcModifier: number;    // added to vehicle HC
}

export const TIRES: TireDef[] = [
  { id: 'standard',           name: 'Standard',            costPerTire: 50,   weightPerTire: 30,  dp: 4,  hcModifier: 0 },
  { id: 'heavy_duty',         name: 'Heavy-Duty',          costPerTire: 100,  weightPerTire: 40,  dp: 6,  hcModifier: 0 },
  { id: 'puncture_resistant', name: 'Puncture-Resistant',  costPerTire: 200,  weightPerTire: 50,  dp: 9,  hcModifier: 0 },
  { id: 'solid',              name: 'Solid',               costPerTire: 500,  weightPerTire: 75,  dp: 12, hcModifier: 0 },
  { id: 'plasticore',         name: 'Plasticore',          costPerTire: 1000, weightPerTire: 150, dp: 25, hcModifier: 0 },
];
