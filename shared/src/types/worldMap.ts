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

export type SettlementKind = 'city' | 'town' | 'village' | 'outpost';

export interface GeneratedSettlement {
  id: string;
  name: string;
  kind: SettlementKind;
  x: number;
  y: number;
  population: number;
  services: string[];          // 'garage' | 'arena' | 'jobs' | 'market' | 'fuel' | 'repairs'
  controllingGangId?: string;
}

export interface GeneratedRoad {
  id: string;
  from: string;
  to: string;
  distance: number;
  roadType: RoadType;          // already exported: 'highway' | 'urban' | 'dirt' | 'mountain'
  danger: number;              // 0..1
  encounterTable: string;      // derived from roadType + danger at generation time
}

export interface GeneratedWorld {
  seed: number;
  settlements: GeneratedSettlement[];
  roads: GeneratedRoad[];
  capitals: string[];          // settlement IDs
  playerStartSettlementId: string;
}
