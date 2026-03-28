export interface PowerPlantDef {
  id: string;
  name: string;
  cost: number;
  weight: number;   // lbs
  spaces: number;
  dp: number;
  powerFactors: number;
}

export const POWER_PLANTS: PowerPlantDef[] = [
  { id: 'small',      name: 'Small',      cost: 500,   weight: 500,  spaces: 3, dp: 5,  powerFactors: 800  },
  { id: 'medium',     name: 'Medium',     cost: 1000,  weight: 700,  spaces: 4, dp: 8,  powerFactors: 1400 },
  { id: 'large',      name: 'Large',      cost: 2000,  weight: 900,  spaces: 5, dp: 10, powerFactors: 2000 },
  { id: 'super',      name: 'Super',      cost: 3000,  weight: 1100, spaces: 6, dp: 12, powerFactors: 2600 },
  { id: 'sport',      name: 'Sport',      cost: 6000,  weight: 1000, spaces: 6, dp: 12, powerFactors: 3000 },
  { id: 'thundercat', name: 'Thundercat', cost: 12000, weight: 2000, spaces: 8, dp: 15, powerFactors: 6700 },
];
