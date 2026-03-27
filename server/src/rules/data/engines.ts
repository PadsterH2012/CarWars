export interface EngineDef {
  id: string;
  name: string;
  maxSpeed: number;
  spaces: number;
  weight: number;
  cost: number;
}

export const ENGINES: EngineDef[] = [
  { id: 'small',  name: 'Small',  maxSpeed: 10, spaces: 1, weight: 200, cost: 1000 },
  { id: 'medium', name: 'Medium', maxSpeed: 15, spaces: 2, weight: 300, cost: 2000 },
  { id: 'large',  name: 'Large',  maxSpeed: 20, spaces: 3, weight: 400, cost: 4000 },
  { id: 'super',  name: 'Super',  maxSpeed: 25, spaces: 4, weight: 500, cost: 8000 },
];
