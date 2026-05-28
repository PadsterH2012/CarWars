export type WorldNodeKind = 'city' | 'town' | 'truck_stop' | 'arena' | 'garage' | 'market';
export type RoadType = 'highway' | 'urban' | 'dirt' | 'mountain';

export interface WorldNode {
  id: string;
  name: string;
  kind: WorldNodeKind;
  x: number;
  y: number;
  services: string[];
  controllingGangId?: string;
}

export interface WorldRoad {
  id: string;
  from: string;
  to: string;
  distance: number;
  roadType: RoadType;
  danger: number;
  encounterTable: string;
}

export interface WorldRegion {
  id: string;
  name: string;
  nodes: WorldNode[];
  roads: WorldRoad[];
}
