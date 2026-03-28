export interface PowerPlantDef {
  id: string;
  name: string;
  fuelType: 'electric' | 'gas';
  cycleOnly: boolean;
  cost: number;
  weight: number;   // lbs
  spaces: number;
  dp: number;
  powerFactors: number;
}

export const POWER_PLANTS: PowerPlantDef[] = [
  // Electric cars
  { id: 'elec_small',      name: 'Electric Small',      fuelType: 'electric', cycleOnly: false, cost: 500,   weight: 500,  spaces: 3, dp: 5,  powerFactors: 800  },
  { id: 'elec_medium',     name: 'Electric Medium',     fuelType: 'electric', cycleOnly: false, cost: 1000,  weight: 700,  spaces: 4, dp: 8,  powerFactors: 1400 },
  { id: 'elec_large',      name: 'Electric Large',      fuelType: 'electric', cycleOnly: false, cost: 2000,  weight: 900,  spaces: 5, dp: 10, powerFactors: 2000 },
  { id: 'elec_super',      name: 'Electric Super',      fuelType: 'electric', cycleOnly: false, cost: 3000,  weight: 1100, spaces: 6, dp: 12, powerFactors: 2600 },
  { id: 'elec_sport',      name: 'Electric Sport',      fuelType: 'electric', cycleOnly: false, cost: 6000,  weight: 1000, spaces: 6, dp: 12, powerFactors: 3000 },
  { id: 'elec_thundercat', name: 'Electric Thundercat', fuelType: 'electric', cycleOnly: false, cost: 12000, weight: 2000, spaces: 8, dp: 15, powerFactors: 6700 },
  // Gas cars
  { id: 'gas_150', name: 'Gas 150', fuelType: 'gas', cycleOnly: false, cost: 400,  weight: 400, spaces: 3, dp: 6,  powerFactors: 700  },
  { id: 'gas_200', name: 'Gas 200', fuelType: 'gas', cycleOnly: false, cost: 700,  weight: 550, spaces: 4, dp: 8,  powerFactors: 1100 },
  { id: 'gas_300', name: 'Gas 300', fuelType: 'gas', cycleOnly: false, cost: 1200, weight: 750, spaces: 5, dp: 10, powerFactors: 1700 },
  { id: 'gas_400', name: 'Gas 400', fuelType: 'gas', cycleOnly: false, cost: 2000, weight: 950, spaces: 6, dp: 12, powerFactors: 2400 },
  // Electric cycles
  { id: 'cyc_elec_small',  name: 'Cycle Electric Small',  fuelType: 'electric', cycleOnly: true, cost: 200, weight: 100, spaces: 1, dp: 3, powerFactors: 400  },
  { id: 'cyc_elec_medium', name: 'Cycle Electric Medium', fuelType: 'electric', cycleOnly: true, cost: 400, weight: 150, spaces: 2, dp: 5, powerFactors: 700  },
  { id: 'cyc_elec_large',  name: 'Cycle Electric Large',  fuelType: 'electric', cycleOnly: true, cost: 800, weight: 200, spaces: 3, dp: 7, powerFactors: 1100 },
  // Gas cycles
  { id: 'cyc_gas_small',  name: 'Cycle Gas Small',  fuelType: 'gas', cycleOnly: true, cost: 150, weight: 80,  spaces: 1, dp: 3, powerFactors: 350  },
  { id: 'cyc_gas_medium', name: 'Cycle Gas Medium', fuelType: 'gas', cycleOnly: true, cost: 300, weight: 120, spaces: 2, dp: 5, powerFactors: 650  },
  { id: 'cyc_gas_large',  name: 'Cycle Gas Large',  fuelType: 'gas', cycleOnly: true, cost: 600, weight: 160, spaces: 3, dp: 7, powerFactors: 1000 },
];
