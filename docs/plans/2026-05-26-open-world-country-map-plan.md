# Open World Country Map Implementation Plan

> **For Hermes:** Use subagent-driven-development skill only after the architecture is reviewed and the first task is proven manually. Jenny can be looped in later for bounded implementation tasks, not orchestration yet.

**Goal:** Add an open-world layer where cities, towns, truck stops, arenas, and roads form a country/region map; travelling between locations can trigger tactical encounters using existing arena map composition.

**Architecture:** Keep the country map as a lightweight graph of nodes and roads. Do not build one giant continuous Phaser world. Travel is simulated on the strategic map; combat or events instantiate local tactical maps through the existing `ArenaMap`, `composeMap`, and snippet system.

**Tech Stack:** TypeScript, Express API, PostgreSQL persistence, Phaser scenes, existing CarWars shared types, Vitest.

---

## Design stance

This is an incremental open-world layer, not a rewrite.

Use three levels:

```text
World / country graph
  -> Road travel + encounters
      -> Tactical local maps generated from snippets
```

Avoid the rabbit hole of continuous streaming terrain, real-time overworld driving, or procedural country generation until the gameplay loop is fun.

---

## Phase 0: Safety and scope

### Task 0.1: Keep Jenny out of orchestration for now

**Objective:** Avoid making the first Jenny-managed task a broad architecture feature.

**Decision:** Amber owns the architecture and first small implementation. Jenny can later implement a tightly scoped task such as `Add world graph shared types` or `Create static Midville region data`.

**Reason:** This feature touches game architecture, persistence, UI flow, and generated maps. It is too broad for a first-time orchestrator run.

---

## Implementation status

- ✅ Phase 1 complete: shared world-map types, Midville static region data, validation helpers, and `server/tests/worldmap.test.ts`.
- ✅ Phase 2.1 complete: read-only `/api/world/regions` and `/api/world/regions/:id` endpoints with `server/tests/world-api.test.ts`.
- ✅ Live service verified on `127.0.0.1:3001` after deploying `/opt/carwars/src/server/dist/main.js` to `/opt/carwars/app/dist/main.js`.
- ⏭️ Next: `WorldMapScene` client view and GarageScene `[WORLD MAP]` entry point.

---

## Phase 1: Static world graph

### Task 1.1: Add shared world map types

**Objective:** Define the strategic map model independently from tactical `ArenaMap`.

**Files:**
- Modify/Create: `shared/src/types/worldMap.ts`
- Modify: `shared/src/index.ts`
- Test: `server/tests/worldmap.test.ts`

**Types to add:**

```ts
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
```

**Verification:**

```bash
npm --workspace @carwars/shared run build
npm --workspace @carwars/server test -- tests/worldmap.test.ts
```

---

### Task 1.2: Add static Midville region data

**Objective:** Create a hand-authored first region with enough structure to test the loop.

**Files:**
- Create: `server/src/rules/world/regions/midville.ts`
- Create: `server/src/rules/world/index.ts`
- Test: `server/tests/worldmap.test.ts`

**Initial locations:**

```text
midville-city           city / garage / jobs / market
rustwater-truck-stop    truck stop / repairs / fuel
new-boston              city / jobs / market
fort-grimm              arena / hostile gang presence
dust-pike-arena         arena
blacktop-market         market / black market
```

**Initial roads:**

```text
midville-city <-> rustwater-truck-stop   highway, low danger
rustwater-truck-stop <-> new-boston      highway, medium danger
midville-city <-> fort-grimm             urban/highway, high danger
rustwater-truck-stop <-> dust-pike-arena dirt, medium danger
new-boston <-> blacktop-market           urban, medium danger
```

**Validation rules:**
- every road endpoint exists
- danger is between 0 and 1
- every node has unique id
- every road has positive distance

---

## Phase 2: World API

### Task 2.1: Add read-only world map API

**Objective:** Allow the client to load the strategic map.

**Files:**
- Create: `server/src/api/world.ts`
- Modify: `server/src/app.ts`
- Test: `server/tests/world-api.test.ts`

**Endpoints:**

```text
GET /api/world/regions
GET /api/world/regions/:id
```

**Verification:**

```bash
curl http://127.0.0.1:3001/api/world/regions/midville
```

Expected: region JSON with nodes and roads.

---

## Phase 3: World map scene

### Task 3.1: Add `WorldMapScene`

**Objective:** Show nodes and roads, let the player choose a destination.

**Files:**
- Create: `client/src/scenes/WorldMapScene.ts`
- Modify: `client/src/main.ts`
- Modify: `client/src/scenes/GarageScene.ts`

**UI v0:**
- draw roads as lines
- draw locations as labelled dots
- current location highlighted
- clicking a connected location opens a travel confirmation panel

**Garage integration:**
Add `[WORLD MAP]` near `[JOB BOARD]` / `[STOCK SHOP]`.

---

## Phase 4: Travel simulation

### Task 4.1: Add player current location

**Objective:** Track where the player/gang currently is.

**Files:**
- Create migration or lightweight column depending on existing DB pattern
- likely modify: `server/src/db/schema.ts` or migration path after inspection
- Modify: `/api/me` or new `/api/world/state`

**YAGNI version:** Store `current_world_node_id` on player or gang. Default `midville-city`.

---

### Task 4.2: Add travel endpoint

**Objective:** Move between connected nodes and roll for travel event.

**Endpoint:**

```text
POST /api/world/travel
body: { toNodeId: string }
```

**Response shapes:**

```ts
{ outcome: 'arrived', currentNodeId: string }
{ outcome: 'encounter', encounterId: string, tacticalMapId: string, description: string }
```

**Rules v0:**
- destination must be connected to current node
- roll encounter from road danger
- if no encounter, update current location
- if encounter, do not update location until resolved

---

## Phase 5: Road encounter tactical maps

### Task 5.1: Add road encounter map generator

**Objective:** Generate tactical maps suitable for road encounters.

**Files:**
- Create: `server/src/rules/maps/generators/roadEncounter.ts`
- Test: `server/tests/road-encounter-map.test.ts`

**Generators v0:**
- `highway-ambush`
- `crossroads-blockade`
- `truck-stop-forecourt`

Use existing snippets where possible. If a snippet is missing, add it deliberately rather than hacking one-off wall arrays.

**Validation:**
- player and AI spawns exist
- spawns are not inside walls
- at least one clear route between teams
- map dimensions match road type

---

## Phase 6: Gameplay loop integration

### Task 6.1: Start arena from travel encounter

**Objective:** If travel creates an encounter, launch `ArenaScene` with the generated/selected map.

**Approach:**
- tactical map can initially be one of the static maps
- then switch to generated map registry once dynamic map serving is stable

**Avoid initially:** dynamic DB-stored maps unless needed.

---

### Task 6.2: Resolve encounter back to world travel

**Objective:** After the fight, return to world/garage and complete/abort travel.

**Rules v0:**
- win: arrive at destination and apply reward/salvage
- lose/destroyed: return to last safe node or garage
- flee: return to origin, maybe partial damage/fuel cost later

---

## Phase 7: Polish after loop is playable

Ideas to defer until core works:

- procedural country generation
- gang territory overlays
- fuel/ammo logistics
- road tolls and patrols
- convoy jobs
- city-specific shops
- random events without combat
- persistent generated route maps
- map thumbnails/previews

---

## Risk notes

- **Biggest risk:** scope creep into continuous open-world driving. Do not do that yet.
- **Second risk:** generated tactical maps that AI cannot navigate. Add map validation early.
- **Third risk:** UI sprawl. Keep v0 world map simple and readable.
- **Jenny risk:** broad orchestration is not appropriate yet. Use Jenny later as an implementer for one isolated task with clear tests.

---

## Recommended execution

1. Amber creates/lands the design and Phase 1 types/static data.
2. Run tests/build locally on `hl-carwars`.
3. If clean, give Jenny one bounded task: read plan and implement `WorldMapScene` only, or implement one road encounter generator only.
4. Amber reviews Jenny output before deployment.

