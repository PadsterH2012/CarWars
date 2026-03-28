export interface SuspensionDef {
  id: string;
  name: string;
  costMultiplier: number; // multiplied by body price
  carHC: number;
  vanHC: number;
  subHC: number;
}

export const SUSPENSIONS: SuspensionDef[] = [
  { id: 'light',    name: 'Light',    costMultiplier: 0,   carHC: 1, vanHC: 0, subHC: 2 },
  { id: 'standard', name: 'Standard', costMultiplier: 0,   carHC: 2, vanHC: 1, subHC: 3 },
  { id: 'improved', name: 'Improved', costMultiplier: 1.0, carHC: 2, vanHC: 1, subHC: 3 },
  { id: 'heavy',    name: 'Heavy',    costMultiplier: 1.5, carHC: 3, vanHC: 2, subHC: 4 },
  { id: 'off_road', name: 'Off-Road', costMultiplier: 5.0, carHC: 2, vanHC: 1, subHC: 3 },
];
