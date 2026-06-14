import type { VehicleStats, BodyType } from './vehicle';

export type ZoneType = 'highway' | 'town' | 'arena';

export interface ZoneMetadata {
  id: string;
  type: 'arena' | 'town' | 'highway';
  name: string;
  exits: { direction: 'north' | 'south' | 'east' | 'west'; destinationZoneId: string }[];
}

export interface Position {
  x: number;
  y: number;
}

export type WallType = 'wall' | 'building' | 'turret';

export interface Rect {
  x: number;       // center x in world units
  y: number;       // center y in world units
  w: number;       // width
  h: number;       // height
  type?: WallType; // for client rendering colour
}

export interface SpawnPoint {
  x: number;
  y: number;
  facing: number;
  team: 'player' | 'ai';
}

// Floor surfaces — large painted rectangles UNDER walls, giving each area its own
// texture and colour. Client paints them on the map background layer.
export type FloorType =
  | 'asphalt'      // charcoal road surface
  | 'concrete'     // grey slab courtyard / plaza
  | 'dirt'         // brown unpaved
  | 'gravel'       // flecked dark grey
  | 'sand'         // tan desert floor
  | 'scrub_grass'  // dry muted green
  | 'rust_plate'   // orange-brown corroded metal
  | 'neon_tile';   // dark with cyan grid — cyberpunk flourish

export interface FloorTile {
  x: number;       // center x in world units
  y: number;       // center y in world units
  w: number;       // width
  h: number;       // height
  type: FloorType;
}

// Decorations — small detail items overlaid on the floor. Non-colliding,
// purely visual, rendered above floor but below walls. Orientation is only
// used for directional ones (arrow, tire_marks, lane_*).
export type DecorationType =
  | 'lane_yellow'   // dashed yellow road line
  | 'lane_white'    // solid white road line
  | 'parking_stall' // white outlined parking bay
  | 'oil_stain'     // dark blotch
  | 'crack'         // pavement crack line
  | 'pothole'       // dark circular hole
  | 'tire_marks'    // dark parallel skid streaks
  | 'cone'          // orange traffic cone
  | 'barrel'        // red hazmat barrel
  | 'crate'         // wooden crate
  | 'dumpster'      // green dumpster
  | 'rubble'        // grey debris cluster
  | 'sign'          // yellow warning sign
  | 'arrow'         // directional arrow
  | 'fuel_pump'     // gas station pump
  | 'neon_strip'    // cyan glowing strip
  | 'blood_splat';  // dark red combat splat

export interface Decoration {
  x: number;       // center x in world units
  y: number;       // center y in world units
  type: DecorationType;
  w?: number;      // optional width; default = type's natural size
  h?: number;      // optional height
  facing?: number; // optional rotation in degrees (0=up/north, 90=east) — for directional types
}

// Visual mood — tints background and default floor colours. Individual floor
// tiles override the palette's default surface for local variety.
export type MapPalette = 'industrial' | 'urban' | 'desert' | 'wasteland';

export interface ArenaMap {
  id: string;
  width: number;        // total world units (arena spans ±width/2)
  height: number;       // total world units (arena spans ±height/2)
  walls: Rect[];
  spawnPoints: SpawnPoint[];
  floor?: FloorTile[];
  decorations?: Decoration[];
  palette?: MapPalette; // client background + default surface tint
}

export interface VehicleState {
  id: string;
  playerId: string;
  driverId: string;
  position: Position;
  facing: number;
  speed: number;
  stats: VehicleStats;
  // Current AI behaviour label (scout/ambush/pursue/aggressive/orbit/snipe/
  // flanking/evasive/recovering/manual/…) — set by the zone-runner each tick
  // for the squad HUD. Absent until perceived.
  task?: string;
}

export interface HazardObject {
  id: string;
  type: 'oil' | 'mine';
  position: Position;
  ownerId: string;
}

export interface CombatEvent {
  attackerId: string;
  targetId: string;
  hit: boolean;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  weapon: string;
  damage?: number;     // damage dealt on a hit (undefined or 0 on miss)
  location?: string;   // face hit: 'front' | 'back' | 'left' | 'right' | 'top' | 'underbody'
  destroyed?: boolean; // true if this hit destroyed the target
}

// A destroyed vehicle persists as wreckage — a collidable, optionally burning obstacle.
// State progresses over time (burning → smouldering → debris) but the object itself
// is never removed during gameplay.
export type WreckageState = 'burning' | 'smouldering' | 'debris';
export type WreckageCause = 'fire' | 'explosion' | 'kinetic' | 'energy' | 'collision';

export interface WreckageObject {
  id: string;
  sourceVehicleId: string;
  playerId: string;          // team identifier for salvage eligibility (winner doesn't salvage own wrecks)
  killedByVehicleId?: string; // which vehicle landed the killing blow — for per-driver XP attribution
  position: Position;
  facing: number;
  bodyType?: BodyType;
  state: WreckageState;
  stateStartedAt: number;    // tick at which the current state began
  remainingDP: number;       // damage wreck can absorb before disintegrating to debris
  maxDP: number;             // starting DP, for salvage-intactness ratio
  originalValue: number;     // loadout.totalCost at moment of destruction
  mass: 'light' | 'medium' | 'heavy';
  pushable: boolean;         // true if a ramplate vehicle can shove it aside
  carriedAmmo: number;       // ammo remaining across all mounts at moment of destruction
  causedBy: WreckageCause;
}

export interface ZoneState {
  id: string;
  type: ZoneType;
  tick: number;
  vehicles: VehicleState[];
  hazardObjects: HazardObject[];
  wreckage?: WreckageObject[];
  combatEvents?: CombatEvent[];
  mapId?: string;      // which arena map is loaded
  mapWidth?: number;   // world-unit width of the loaded map (sent on join)
  mapHeight?: number;  // world-unit height of the loaded map (sent on join)
  walls?: Rect[];      // only present in the initial join state, not every tick
  floor?: FloorTile[]; // only present in the initial join state
  decorations?: Decoration[]; // only present in the initial join state
  palette?: MapPalette;
}
