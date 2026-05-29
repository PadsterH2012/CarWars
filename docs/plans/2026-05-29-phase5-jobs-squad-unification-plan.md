# Phase 5 — Jobs on the Squad Engine Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make a job consume a player-composed squad (1–4 vehicle+driver pairs) by reusing the Phase 4 squad-deployment engine, so committed vehicles/drivers show as unavailable with an ETA and the job resolves headless into an after-action report. Retire the arena-dependent jobs and the single-driver contract.

**Architecture:** A job assignment becomes a `squad_deployments` row tagged with `job_id`. `resolveDueDeployments()` gains a branch: job-sourced deployments take difficulty/payout/name from the `jobs` row (no world node, no rival in MVP); zone deployments keep the existing path. All the downstream plumbing (`/api/vehicles` `deployed` status + ETA, driver sidelining, `engagement_reports`, `ReportScene`) is reused. The old arena `STATIC_JOBS` flow and the single-driver headless-contract path (shipped earlier today) are removed.

**Tech Stack:** TypeScript, Express, Postgres (`pg`), Vitest + Supertest (server tests, real Postgres), Phaser 3 (client — no unit harness; build + Playwright verified).

**Design doc:** `docs/plans/2026-05-29-phase5-jobs-squad-unification-design.md`

**Conventions:** server routes in `server/src/api/`; jobs on `jobsRouter` in `economy.ts`; deployments in `deploy.ts`. Tests: `server/tests/*.api.test.ts`, `createApp()` + `request(app)`, unique test player, `afterAll` cleanup. Run tests: `npm -w @carwars/server run test`. Builds: `npm -w @carwars/server run build`, `npm -w @carwars/client run build`. Client fetch: `const host = window.location.hostname; fetch(\`http://${host}:3001/api/…\`, { headers: { Authorization: \`Bearer ${token}\` } })`.

**Import-cycle note:** `deploy.ts` imports nothing from `economy.ts`; `reports.ts` imports both. `economy.ts` may import `resolveDueDeployments` from `deploy.ts` (one-directional, safe). Verify each build.

---

## Phase A — Schema + resolution engine

### Task 1: Schema — link deployments to jobs

**Files:**
- Modify: `server/src/db/schema.sql` (the `squad_deployments` block ~lines 695-708)
- Test: `server/tests/deploy.api.test.ts`

**Step 1: Write the failing test.** Add a test that a job-linked deployment row can be inserted (zone_id NULL, job_id set). It needs a job row + the migrated columns:

```typescript
it('squad_deployments accepts a job-linked row (zone_id null, job_id set)', async () => {
  const db = getDb();
  const { token, playerId } = await register('dep-jobcol');
  const job = (await db.query(
    `INSERT INTO jobs (zone_id, job_type, description, payout, division_min, headless, difficulty)
     VALUES ('town-1','patrol','Test job',300,5,TRUE,3) RETURNING id`)).rows[0];
  const ins = await db.query(
    `INSERT INTO squad_deployments (player_id, job_id, assignment, driver_ids, vehicle_ids, resolves_at)
     VALUES ($1,$2,'job','{}'::uuid[],'{}'::uuid[], NOW() + interval '1 minute') RETURNING id, zone_id, job_id`,
    [playerId, job.id]);
  expect(ins.rows[0].zone_id).toBeNull();
  expect(ins.rows[0].job_id).toBe(job.id);
  await db.query(`DELETE FROM jobs WHERE id = $1`, [job.id]);
});
```
(Confirm the `register` helper / `USERS` cleanup pattern in `deploy.api.test.ts`; add `dep-jobcol` to cleanup.)

**Step 2: Run, expect FAIL.** `npm -w @carwars/server run test -- deploy` — fails (column `job_id` does not exist / NOT NULL violation on zone_id).

**Step 3: Implement.** In `schema.sql`, after the `squad_deployments` CREATE TABLE, add idempotent migrations (match the file's existing ALTER…IF NOT EXISTS style):
```sql
ALTER TABLE squad_deployments ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE squad_deployments ALTER COLUMN zone_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deployments_job ON squad_deployments(job_id) WHERE job_id IS NOT NULL;
```
The test harness must apply schema.sql to the test DB — confirm how (look for a setup that runs schema.sql; if tests run against an already-migrated dev DB, apply the ALTERs manually to the local `carwars` DB with `psql carwars -f server/src/db/schema.sql`).

**Step 4: Run, expect PASS.** `npm -w @carwars/server run test -- deploy`

**Step 5: Commit.**
```bash
git add server/src/db/schema.sql server/tests/deploy.api.test.ts
git commit -m "feat(db): link squad_deployments to jobs (job_id, nullable zone_id)"
```

---

### Task 2: Branch `resolveDueDeployments()` on `job_id`

**Files:**
- Modify: `server/src/api/deploy.ts` (the `resolveDueDeployments` function lines 158-324, `buildSummary` 326-338)
- Test: `server/tests/deploy.api.test.ts`

**Step 1: Write the failing test.** A job-linked deployment, forced due, resolves into an `engagement_report`, marks the job completed, and frees the crew:

```typescript
it('resolves a job-linked deployment into a report and completes the job', async () => {
  const db = getDb();
  const { token, playerId } = await register('dep-jobres');
  const starter = await request(app).post('/api/me/claim-starter').set('Authorization', `Bearer ${token}`).send();
  const vehicleId = starter.body.vehicleId as string;
  // ensure the starter vehicle has a living assigned driver (claim-starter should create one; else create+assign)
  const job = (await db.query(
    `INSERT INTO jobs (zone_id, job_type, description, payout, division_min, headless, difficulty)
     VALUES ('town-1','patrol','Resolve me',300,5,TRUE,3) RETURNING id`)).rows[0];
  const driver = (await db.query(`SELECT id FROM drivers WHERE assigned_vehicle_id = $1`, [vehicleId])).rows[0];
  const dep = (await db.query(
    `INSERT INTO squad_deployments (player_id, job_id, assignment, driver_ids, vehicle_ids, resolves_at)
     VALUES ($1,$2,'job',$3::uuid[],$4::uuid[], NOW() - interval '1 second') RETURNING id`,
    [playerId, job.id, [driver.id], [vehicleId]])).rows[0];

  await resolveDueDeployments(playerId);

  const depAfter = (await db.query(`SELECT status, report_id FROM squad_deployments WHERE id = $1`, [dep.id])).rows[0];
  expect(depAfter.status).toBe('resolved');
  expect(depAfter.report_id).toBeTruthy();
  const jobAfter = (await db.query(`SELECT completed FROM jobs WHERE id = $1`, [job.id])).rows[0];
  expect(jobAfter.completed).toBe(true);
  const rep = (await db.query(`SELECT outcome, report FROM engagement_reports WHERE id = $1`, [depAfter.report_id])).rows[0];
  expect(['success','partial','failure','routed']).toContain(rep.outcome);
});
```
Import `resolveDueDeployments` in the test (it's exported). Adjust driver-setup if `claim-starter` doesn't auto-assign a driver.

**Step 2: Run, expect FAIL.** `npm -w @carwars/server run test -- deploy` — currently `resolveDueDeployments` does `const node = region.nodes.find(n => n.id === dep.zone_id); if (!node) continue;`, so a job deployment (zone_id null) is skipped → status stays in_transit.

**Step 3: Implement.** In `resolveDueDeployments`:
- Add `job_id` to the due-rows SELECT (line 161): `SELECT id, zone_id, job_id, assignment, driver_ids, vehicle_ids`.
- Replace the per-row context derivation. After fetching `driverRows`/`vehicleRows`, build a `ctx`:
```typescript
const assignment: Assignment = ASSIGNMENTS.includes(dep.assignment) ? dep.assignment : 'patrol';
let ctx: {
  difficulty: number; basePayout: number; placeName: string;
  zoneIdForReport: string; encounter: string;
  rival?: { id: string; name: string }; isJob: boolean; jobId?: string;
};

if (dep.job_id) {
  const jr = (await db.query(
    `SELECT id, description, payout, difficulty, zone_id, job_type FROM jobs WHERE id = $1`, [dep.job_id])).rows[0];
  if (!jr) continue;
  ctx = {
    difficulty: jr.difficulty, basePayout: jr.payout, placeName: jr.description,
    zoneIdForReport: jr.zone_id ?? 'job', encounter: `the ${jr.job_type} job`,
    rival: undefined, isJob: true, jobId: jr.id,
  };
} else {
  const node = region.nodes.find(n => n.id === dep.zone_id);
  if (!node) continue;
  const difficulty = zoneDifficulty(node, region);
  let rival: { id: string; name: string } | undefined;
  const wantRival = node.kind === 'arena' || difficulty >= 6 || assignment === 'raid';
  if (wantRival && gangId) {
    const picked = await pickRivalForMatch(db, gangId, division);
    if (picked) rival = { id: picked.id, name: picked.name };
  }
  ctx = {
    difficulty, basePayout: basePayout(difficulty, assignment), placeName: node.name,
    zoneIdForReport: dep.zone_id, isJob: false,
    rival,
    encounter: rival
      ? `${rival.name} ${node.kind === 'arena' ? 'in the arena' : 'patrol'}`
      : `${node.kind === 'arena' ? 'arena challengers' : 'roadside scavengers'} near ${node.name}`,
  };
}
```
- Use `ctx` in the engine call and report:
```typescript
const result = resolveSquadEngagement({
  squad: driverRows.rows.map(r => ({ id: r.id, name: r.name, skill: r.skill })),
  vehicles: vehicleRows.rows.map(r => ({ id: r.id, name: r.name, value: r.value })),
  zoneDifficulty: ctx.difficulty, assignment, basePayout: ctx.basePayout, rival: ctx.rival,
});
const report = {
  zone: ctx.zoneIdForReport, zoneName: ctx.placeName, assignment, encounter: ctx.encounter,
  summary: buildSummary(result, ctx.placeName, ctx.encounter),
  perDriver: result.perDriver, vehicles: result.vehicles,
  income: result.income, repairCost: result.repairCost, net: result.net,
  rivalRepChange: result.rivalRepChange ?? null, breakdown: result.breakdown,
};
```
- Change `buildSummary` signature to `buildSummary(result, placeName: string, encounter: string)` and replace `node.name` with `placeName` in its strings.
- In the commit block: rival/recordRivalOutcome only when `ctx.rival` set. The `engagement_reports` INSERT uses `ctx.zoneIdForReport` (NOT NULL still satisfied). After updating the deployment to resolved, **if `ctx.isJob`** add `await client.query('UPDATE jobs SET completed = TRUE WHERE id = $1', [ctx.jobId]);`. Gang-ledger description: use `ctx.placeName`.

**Step 4: Run, expect PASS.** `npm -w @carwars/server run test -- deploy` (both the new test AND the existing zone-deployment tests must pass — no regression).

**Step 5: Commit.**
```bash
git add server/src/api/deploy.ts server/tests/deploy.api.test.ts
git commit -m "feat(deploy): resolve job-linked deployments via the squad engine"
```

---

## Phase B — Job deploy endpoint + retirements

### Task 3: `POST /api/jobs/:id/deploy` (send a squad to a job)

**Files:**
- Modify: `server/src/api/economy.ts` (jobsRouter; import `resolveDueDeployments` from `./deploy`)
- Test: `server/tests/headlessJobs.api.test.ts` (or a new `jobsDeploy.api.test.ts`)

**Step 1: Write the failing test.** Deploy a squad to a job → 201 with ETA; the vehicle shows `deployed` on `/api/vehicles`; reject a 5-vehicle squad and a driverless/unavailable case:

```typescript
it('POST /api/jobs/:id/deploy sends a squad and marks the vehicle deployed', async () => {
  const starter = await request(app).post('/api/me/claim-starter').set('Authorization', `Bearer ${token}`).send();
  const vehicleId = starter.body.vehicleId;
  const jobs = (await request(app).get('/api/jobs/headless?zoneId=town-1').set('Authorization', `Bearer ${token}`)).body;
  const res = await request(app).post(`/api/jobs/${jobs[0].id}/deploy`)
    .set('Authorization', `Bearer ${token}`).send({ vehicleIds: [vehicleId] });
  expect(res.status).toBe(201);
  expect(res.body.deploymentId).toBeTruthy();
  expect(typeof res.body.etaSeconds).toBe('number');
  const vehicles = (await request(app).get('/api/vehicles').set('Authorization', `Bearer ${token}`)).body;
  expect(vehicles.find((v: any) => v.id === vehicleId).status).toBe('deployed');
});
```
(Use a player token that has a starter vehicle with an assigned driver. Mirror the existing `headlessJobs.api.test.ts` setup; the existing `beforeAll` may need a claimed starter.)

**Step 2: Run, expect FAIL** (404 route missing).

**Step 3: Implement.** Add to `economy.ts`. Define a job duration helper and the route. Reuse the same validation shape as `POST /api/deploy`:
```typescript
import { resolveDueDeployments } from './deploy';

const JOB_SQUAD_CAP = 4;
function jobDeploymentSeconds(difficulty: number): number { return 120 + difficulty * 30; }

jobsRouter.post('/:id/deploy', async (req: AuthRequest, res) => {
  const { id } = req.params;
  const vehicleIds = req.body?.vehicleIds;
  if (!Array.isArray(vehicleIds) || !vehicleIds.length) return res.status(400).json({ error: 'vehicleIds required' });
  if (vehicleIds.length > JOB_SQUAD_CAP) return res.status(400).json({ error: `A squad is at most ${JOB_SQUAD_CAP} vehicles` });
  const db = getDb();
  await resolveDueDeployments(req.playerId!);

  const jr = (await db.query(`SELECT id, difficulty, completed FROM jobs WHERE id = $1`, [id])).rows[0];
  if (!jr) return res.status(404).json({ error: 'Job not found' });
  if (jr.completed) return res.status(409).json({ error: 'Job already completed' });
  // one active deployment per job
  const existing = await db.query(`SELECT 1 FROM squad_deployments WHERE job_id = $1 AND status = 'in_transit' LIMIT 1`, [id]);
  if (existing.rows.length) return res.status(409).json({ error: 'Job already has a squad out' });

  // vehicles owned, intact, not in arena
  const vRes = await db.query(
    `SELECT id FROM vehicles WHERE id = ANY($1::uuid[]) AND player_id = $2
       AND COALESCE((damage_state->>'destroyed')::boolean,false)=false AND in_arena=false`,
    [vehicleIds, req.playerId]);
  if (vRes.rows.length !== vehicleIds.length) return res.status(403).json({ error: 'One or more vehicles are unavailable or not owned' });
  // not already deployed
  const busy = await db.query(`SELECT 1 FROM squad_deployments WHERE player_id=$1 AND status='in_transit' AND vehicle_ids && $2::uuid[] LIMIT 1`, [req.playerId, vehicleIds]);
  if (busy.rows.length) return res.status(409).json({ error: 'A selected vehicle is already deployed' });
  // living, available crew
  const dRes = await db.query(
    `SELECT id FROM drivers WHERE assigned_vehicle_id = ANY($1::uuid[]) AND player_id = $2
       AND alive = true AND COALESCE(available_at, NOW()) <= NOW()`,
    [vehicleIds, req.playerId]);
  if (!dRes.rows.length) return res.status(409).json({ error: 'No available crew for the selected vehicles' });
  const driverIds = dRes.rows.map(r => r.id);

  const seconds = jobDeploymentSeconds(jr.difficulty);
  const ins = await db.query(
    `INSERT INTO squad_deployments (player_id, job_id, assignment, driver_ids, vehicle_ids, resolves_at)
     VALUES ($1,$2,'job',$3::uuid[],$4::uuid[], NOW() + ($5 || ' seconds')::interval) RETURNING id, resolves_at`,
    [req.playerId, id, driverIds, vehicleIds, String(seconds)]);
  await db.query(`UPDATE drivers SET available_at = $2 WHERE id = ANY($1::uuid[])`, [driverIds, ins.rows[0].resolves_at]);
  // claim the job so it leaves the open board
  await db.query(`UPDATE jobs SET assigned_driver_id = $2 WHERE id = $1`, [id, driverIds[0]]);

  return res.status(201).json({ deploymentId: ins.rows[0].id, etaSeconds: seconds, resolvesAt: ins.rows[0].resolves_at });
});
```

**Step 4: Run, expect PASS.** `npm -w @carwars/server run test -- headlessJobs deploy` and verify build (`npm -w @carwars/server run build`) for the new import.

**Step 5: Commit.**
```bash
git add server/src/api/economy.ts server/tests/*.ts
git commit -m "feat(jobs): POST /api/jobs/:id/deploy — send a squad to a job"
```

---

### Task 4: Retire arena jobs + single-driver contract path

**Files:**
- Modify: `server/src/api/economy.ts` (remove `STATIC_JOBS`, `GET /api/jobs` arena seeding, `POST /:id/take`, `POST /:id/complete`, `POST /api/jobs/assign`, `GET /api/jobs/outcomes`, `POST /:id/acknowledge`, `resolveDueHeadlessJobs`); keep `GET /api/jobs/headless` (job list), `GET /api/jobs/active`, the new `/deploy`.
- Modify: `server/src/api/reports.ts` (`/unread-count` no longer needs `resolveDueHeadlessJobs` / the job-outcome count — outcomes now live in `engagement_reports`).
- Delete or orphan: `server/src/rules/headlessJob.ts` (only if nothing else imports it — grep first; leave it if referenced by a still-running test, and remove that test).
- Test: update `server/tests/headlessJobs.api.test.ts` and `reports.api.test.ts` to drop tests for removed endpoints; keep/adjust tests for `headless` (list), `active`, `deploy`.

**Step 1: Write/adjust tests first.** Change the headless test file so the removed routes are asserted gone (e.g. `POST /api/jobs/assign` → 404) and the retained ones still pass. Remove the reports test asserting the job-outcome unread count (or repoint it to engagement reports).

**Step 2: Run, expect FAIL** (routes still present return 200/409, not 404; or removed-resolver imports break the build).

**Step 3: Implement the removals.** Delete the listed handlers and `resolveDueHeadlessJobs`; remove its import from `reports.ts` and revert `/unread-count` to counting only `engagement_reports` (as it was before commit `8ee93a3`). Grep for any remaining references to deleted symbols and clean them up. Keep the `jobs` table columns (`assigned_driver_id` is now used by `/deploy` to mark the job claimed).

**Step 4: Run, expect PASS.** `npm -w @carwars/server run test` (full suite) + `npm -w @carwars/server run build`.

**Step 5: Commit.**
```bash
git add -A server/
git commit -m "refactor(jobs): retire arena-job and single-driver contract paths"
```

---

## Phase C — Client squad picker

### Task 5: Generalise `DriverPicker` → `openSquadPicker`

**Files:**
- Modify/replace: `client/src/ui/DriverPicker.ts` → add `openSquadPicker(scene, token, opts) => Promise<string[] | null>` returning chosen **vehicleIds** (1–4). Keep `openDriverPicker` only if still used elsewhere (grep; ReportScene/JobBoard will use the squad picker now).

**Step 1: Implement.** Build-verified (no client unit harness). The picker fetches `GET /api/vehicles` and `GET /api/drivers`, lists vehicles whose assigned driver has `status === 'available'` and `vehicle.status === 'available'`, shows `car · armour · driver (skN)`, lets the player toggle up to 4, and confirms → resolves with the selected vehicleIds (or null on cancel). Mirror the world-map deploy panel's composition logic (`WorldMapScene.fetchSquadComposition` / `openDeployPanel`, lines ~325-481) but standalone — takes `scene`+`token`, owns its container, destroys on close. Reuse the existing overlay style (backdrop, monospace, `#00ff88`).

**Step 2: Build.** `npm -w @carwars/client run build` — expect clean.

**Step 3: Commit.**
```bash
git add client/src/ui/DriverPicker.ts
git commit -m "feat(ui): openSquadPicker — multi-select vehicle+driver squad overlay"
```

---

## Phase D — Client job board

### Task 6: JobBoardScene — one job list, send a squad

**Files:**
- Modify: `client/src/scenes/JobBoardScene.ts`

**Step 1: Implement.** Build-verified.
- Remove the arena-jobs list + `[TAKE]`/`takeJob`/`cw_active_job` (those endpoints are gone). The scene now shows ONE list of jobs from `GET /api/jobs/headless?zoneId=town-1` (description · difficulty (colour-coded) · payout) each with `[SEND SQUAD]`.
- `[SEND SQUAD]` → `const vehicleIds = await openSquadPicker(this, this.token, { title: 'SEND SQUAD ON JOB' }); if (!vehicleIds) return;` → `POST /api/jobs/${job.id}/deploy { vehicleIds }`. On success `this.scene.restart()`; on error show `errorText`.
- Keep the "Out on jobs" / IN PROGRESS section from `GET /api/jobs/active` with live ETA (already built — repoint if its shape changed).
- Update `layout()` for the simplified single-list layout.

**Step 2: Build.** `npm -w @carwars/client run build`.

**Step 3: Commit.**
```bash
git add client/src/scenes/JobBoardScene.ts
git commit -m "feat(jobboard): single job list with send-a-squad assignment"
```

---

## Phase E — Client cleanup

### Task 7: ReportScene — single source

**Files:**
- Modify: `client/src/scenes/ReportScene.ts`

**Step 1: Implement.** Remove the `/api/jobs/outcomes` fetch + the job-outcome `Entry`/`renderJobDetail`/`selectJobOutcome` branch added earlier today (commit `33e64d4`). Job results now arrive as ordinary `engagement_reports` via `/api/reports`, so revert ReportScene to the squad-report-only rendering it had before that commit (the squad renderer already covers the unified shape). Keep the empty-state wording sensible ("No reports yet.").

**Step 2: Build.** `npm -w @carwars/client run build`.

**Step 3: Commit.**
```bash
git add client/src/scenes/ReportScene.ts
git commit -m "refactor(reports): single engagement-report source (jobs now report here)"
```

### Task 8: WorldMap — keep jobs off the map

**Files:**
- Modify: `client/src/scenes/WorldMapScene.ts`

**Step 1: Implement.** The world-map "active deployments" list/markers come from `GET /api/deploy`. Filter to zone deployments so job-deployments don't render on the map. Simplest: add `job_id` to the `GET /api/deploy` SELECT in `deploy.ts` and have the client filter `rows.filter(r => !r.job_id)` where it builds the deployments list (around `fetchActiveDeployments`/`drawDeployments`, lines ~517-583). (If touching the endpoint, do it in this task and note it.)

**Step 2: Build.** `npm -w @carwars/client run build` (+ `npm -w @carwars/server run build` if `deploy.ts` changed; rerun `-- deploy` tests).

**Step 3: Commit.**
```bash
git add client/src/scenes/WorldMapScene.ts server/src/api/deploy.ts
git commit -m "feat(worldmap): exclude job-deployments from the map deployment list"
```

---

## Phase F — Verification

### Task 9: Full verification

**Step 1: Server tests.** `npm -w @carwars/server run test` — all green, no regressions in the zone-deployment path.

**Step 2: Builds.** `npm -w @carwars/server run build` and `npm -w @carwars/client run build` — both clean.

**Step 3: Playwright smoke (local).** Start server (`node server/dist/main.js`) + client (`cd client && npm run dev`, port 3000). DB connects as OS user — seed via `psql carwars` (NOT `-U carwars`). Verify:
1. Job Board shows one job list with `[SEND SQUAD]` (no arena `[TAKE]` list).
2. `[SEND SQUAD]` → squad picker (multi-select vehicles+drivers) → confirm → job moves to "Out on jobs" with ETA; the chosen vehicle shows `DEPLOYED [ETA]` and its driver `ON JOB` in the garage.
3. Force the deployment due (`psql carwars`), open `[REPORTS]` → the job's after-action report appears (engagement-report style); job no longer on the board.
4. World map "active deployments" list does NOT show the job.
Capture screenshots of the job board, the squad picker, and the report.

**Step 4: Final review.** `git diff main --stat`; dispatch a holistic code reviewer (superpowers:code-reviewer) over the branch. Confirm scope: arena combat, garage status dots, the zone deploy panel, and rival logic are intact; only jobs were rerouted.

**Step 5: Cleanup.** Stop server/client, remove smoke screenshots + temp files + any smoke-test DB rows.

---

## Out of scope (future)
- Garage defense vs rival attacks; larger garages / crew capacity.
- Arena events (duels/tournaments/ladders vs rivals) — separate design.
- Rival opponents on jobs (MVP is NPC encounters).

## After build
Write Obsidian docs in the CarWars project folder covering **jobs** and **arena events** as the two income/prestige loops (user request).
