export interface ChassisDef {
  id: string;
  name: string;
  spaces: number;
  maxWeight: number;
  cost: number;
}

export const CHASSIS: ChassisDef[] = [
  { id: 'compact',  name: 'Compact',  spaces: 6,  maxWeight: 3000, cost: 1000 },
  { id: 'mid',      name: 'Midsize',  spaces: 8,  maxWeight: 4000, cost: 1500 },
  { id: 'van',      name: 'Van',      spaces: 14, maxWeight: 6000, cost: 3000 },
  { id: 'pickup',   name: 'Pickup',   spaces: 10, maxWeight: 5000, cost: 2000 },
];
