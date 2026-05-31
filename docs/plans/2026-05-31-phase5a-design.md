# Phase 5a — Procedural World Generator Design

**Date:** 2026-05-31
**Scope:** Sub-phase 5a of the Territory & Rivals plan
**Approach:** Hard cutover — no midville backwards compat, one existing player migrated at schema init

---

## Decision: Hard cutover

The plan's backwards compatibility path (keep midville as fallback for existing players) is dropped. There is one active player. The schema init runs a one-time migration to generate a world for any gang row with `generated_world IS NULL`. After that, `midville.ts`, `getRegion()`, and `WORLD_REGIONS` are deleted. No dual-path code anywhere.

---

## Section 1: Generator module

**File:** `server/src/rules/worldGen.ts` (new)

Pure function — no DB, no side effects, fully testable with deterministic seeds.

```
generateWorld(seed: number): GeneratedWorld
```

**Algorithm:**
1. Place 4–8 capitals via Poisson-disc sampling on a 1000×1000 grid (min 200px apart). Each capital gets a seeded population roll (weighted buckets: 40% 250k–1M, 30% 50k–250k, 30% 10k–50k).
2. Assign subordinate settlements to regions via Voronoi (nearest capital). Count per region: `floor(sqrt(capitalPopulation / 10000))`. Bucket by distance from capital:
   - Close → Town (1k–10k pop, services: garage + arena + jobs + market)
   - Mid → Village (500–5k pop, services: garage + jobs)
   - Far → Outpost (100–1k pop, services: fuel + repairs)
3. Roads: complete graph between capitals (highways), one road per subordinate to parent capital, local roads between neighbours < 150 units. Danger = `clamp(0.05 + distance/1000 + edgeProximity, 0.05, 0.8)`.
4. Player start: settlements with pop < 5000, bottom 25th percentile by distance from map centre.
5. Name generator: ~200 morphemes, seeded recombination — no authored full names.

**Types added to `shared/src/types/worldMap.ts`:**
- `GeneratedSettlement` — id, name, kind, x, y, population, services[], controllingGangId?
- `GeneratedRoad` — id, from, to, distance, roadType, danger
- `GeneratedWorld` — seed, settlements[], roads[], capitals[], playerStartSettlementId

---

## Section 2: Schema + migration

```sql
ALTER TABLE gangs ADD COLUMN IF NOT EXISTS world_seed INTEGER;
ALTER TABLE gangs ADD COLUMN IF NOT EXISTS generated_world JSONB;
```

One-time migration (idempotent `DO $$ ... $$` block inside schema.sql): for every gang row where `generated_world IS NULL`, generate a world with a random seed and write it back.

`midville.ts`, `getRegion()`, and `WORLD_REGIONS` registry deleted. No fallback path.

---

## Section 3: API layer

**`server/src/api/world.ts`**
- `GET /api/world/map` — new endpoint, replaces `/api/world/regions/:id`. Loads `generated_world` from gang row (generates + stores if NULL). Returns `GeneratedWorld`.
- `POST /api/world/travel` — replace `getRegion('midville')` with `getWorldForGang(db, playerId)` helper. Road lookup and danger rolls unchanged, just against `GeneratedWorld.roads`.
- `GET /api/world/state` — no change.
- `GET /api/world/regions/:id` — removed.

**`server/src/api/deploy.ts`**
- Remove `const REGION_ID = 'midville'` and all `getRegion()` calls.
- Use shared `getWorldForGang(db, playerId): Promise<GeneratedWorld>` helper (extracted to a small utility used by both world.ts and deploy.ts).
- `zoneDifficulty()` typed to `GeneratedSettlement` (same logic).
- `deploymentSeconds()` reads `GeneratedRoad.danger` — same field name, no logic change.

---

## Section 4: Client

**`client/src/scenes/WorldMapScene.ts`**
- Fetch: `/api/world/regions/midville` → `/api/world/map`
- Shape: `region.nodes[]` → `world.settlements[]`; `node.kind` values unchanged; `services[]` replaces per-node boolean flags
- Node colours: derived from `settlement.kind`
- Road colours: from `road.roadType` (highway/urban/dirt/mountain)
- Player location: unchanged — still reads `currentNodeId` from `/api/world/state`
- Deploy panel, ATTEND/DEPLOY buttons: no changes

No new scenes, no structural changes to WorldMapScene.

---

## Section 5: Tests

**`server/tests/worldGen.test.ts`** (new):
- Same seed → identical output (deterministic)
- Different seeds → structurally different maps
- Settlement count in valid range (1–200)
- At least one road between every capital pair
- No orphan settlements (all reachable from player start)
- Player start settlement population < 5000
- All road from/to IDs reference valid settlement IDs
- All settlement names unique within a world

**`server/tests/world-api.test.ts`**, **`server/tests/worldmap.test.ts`**: updated to mock `GeneratedWorld` shape instead of midville `WorldRegion`.

---

## Files changed

| File | Action |
|------|--------|
| `server/src/rules/worldGen.ts` | New |
| `shared/src/types/worldMap.ts` | Extend with GeneratedWorld types |
| `server/src/db/schema.sql` | Add columns, migration block |
| `server/src/api/world.ts` | New endpoint, refactor travel |
| `server/src/api/deploy.ts` | Remove midville, use getWorldForGang |
| `server/src/rules/world/index.ts` | Delete (or gut to shell) |
| `server/src/rules/world/regions/midville.ts` | Delete |
| `client/src/scenes/WorldMapScene.ts` | Fetch + render updates |
| `server/tests/worldGen.test.ts` | New |
| `server/tests/world-api.test.ts` | Update mocks |
| `server/tests/worldmap.test.ts` | Update mocks |
