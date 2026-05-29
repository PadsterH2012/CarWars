# Surface the Headless-Job System (Issue #7) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give the player a UI to assign drivers to headless contracts and to read their after-action reports, by wiring up the Phase 2 headless-job backend that currently has zero client UI.

**Architecture:** The headless-job server API is already complete and tested (`GET /api/jobs/headless`, `POST /api/jobs/assign`, `GET /api/jobs/outcomes`, `POST /api/jobs/:id/acknowledge`, lazy `resolveDueHeadlessJobs()`). This plan adds (1) two small backend additions — an "in-progress contracts" feed and a unified unread badge — and (2) the client surface: a **reusable driver-picker component**, a **Contracts section in `JobBoardScene`**, and **job outcomes merged into `ReportScene`**.

**Tech Stack:** TypeScript, Express, Postgres (`pg`), Vitest + Supertest (server tests, real Postgres), Phaser 3 (client scenes — no client unit harness; verified by build + Playwright).

**Context — what is already done (Phase 4, commit `c1c347a`):** squad deploy panel with driver selection, computed `status`/`remainingSeconds` on `/api/vehicles` and `/api/drivers`, garage status dots + ETAs, persistent world-map ETA indicators, squad after-action reports. Do **not** rebuild any of that.

**Design decisions (from issue triage):**
- Headless contracts live as a **section inside `JobBoardScene`** (arena jobs = "I drive these", contracts = "my drivers do these").
- The driver-picker is built as a **composable component** (`client/src/ui/DriverPicker.ts`) so the squad deploy panel can reuse it later.
- Job outcomes are **merged into `ReportScene`**; the garage `[REPORTS]` unread badge counts squad reports **and** unacknowledged job outcomes.

**Conventions to match:**
- Client fetch: ``const host = window.location.hostname;`` then ``fetch(`http://${host}:3001/api/...`, { headers: { Authorization: `Bearer ${this.token}` } })``.
- Server route files live in `server/src/api/`; jobs live in `economy.ts` (`jobsRouter`).
- Server tests: `server/tests/*.api.test.ts`, `createApp()` + `request(app)`, register a uniquely-named test player, clean up in `afterAll`.
- Run server tests: `npm -w @carwars/server run test`.
- Build: `npm -w @carwars/server run build` and `npm -w @carwars/client run build`.

---

## Phase A — Backend additions

### Task 1: `GET /api/jobs/active` — player's in-progress contracts

So the Contracts UI can show "your drivers currently out on contracts" with an ETA. `GET /api/jobs/headless` only returns *unassigned* jobs and `/outcomes` only *resolved* ones, so neither covers in-progress work.

**Files:**
- Modify: `server/src/api/economy.ts` (add route on `jobsRouter`, near `/outcomes`)
- Test: `server/tests/headlessJobs.api.test.ts`

**Step 1: Write the failing test.** Add inside the `describe('headless jobs', ...)` block (it relies on the existing `token`/`driverId` and the assign performed by earlier tests):

```typescript
it('GET /api/jobs/active lists in-progress contracts with ETA + driver name', async () => {
  // Assign a fresh driver to a fresh contract so one is definitely in-flight.
  const drv = await request(app).post('/api/drivers')
    .set('Authorization', `Bearer ${token}`).send({ name: 'Active Runner' });
  const jobs = (await request(app).get('/api/jobs/headless?zoneId=town-1')
    .set('Authorization', `Bearer ${token}`)).body;
  await request(app).post('/api/jobs/assign')
    .set('Authorization', `Bearer ${token}`).send({ jobId: jobs[0].id, driverId: drv.body.id });

  const res = await request(app).get('/api/jobs/active')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  const mine = res.body.find((j: any) => j.driverId === drv.body.id);
  expect(mine).toBeTruthy();
  expect(mine.driverName).toBe('Active Runner');
  expect(typeof mine.remainingSeconds).toBe('number');
  expect(mine.remainingSeconds).toBeGreaterThan(0);
});
```

**Step 2: Run it, expect FAIL.** Run: `npm -w @carwars/server run test -- headlessJobs` — expect 404 / undefined body (route missing).

**Step 3: Implement.** Add to `economy.ts` (after the `/outcomes` route). Resolve due jobs first so a just-expired contract drops off the active list:

```typescript
// GET /api/jobs/active — this player's in-progress headless contracts (driver
// assigned, not yet resolved). Used by the Contracts "in progress" section.
jobsRouter.get('/active', async (req: AuthRequest, res) => {
  await resolveDueHeadlessJobs(req.playerId!);
  const db = getDb();
  const rows = (await db.query(
    `SELECT j.id, j.job_type, j.description, j.payout, j.resolves_at,
            d.id AS driver_id, d.name AS driver_name, d.skill
       FROM jobs j JOIN drivers d ON d.id = j.assigned_driver_id
      WHERE d.player_id = $1 AND j.headless = TRUE AND j.outcome IS NULL
      ORDER BY j.resolves_at ASC`,
    [req.playerId],
  )).rows;
  return res.json(rows.map(r => ({
    id: r.id, jobType: r.job_type, description: r.description, payout: r.payout,
    driverId: r.driver_id, driverName: r.driver_name, skill: r.skill,
    remainingSeconds: Math.max(0, Math.ceil((new Date(r.resolves_at).getTime() - Date.now()) / 1000)),
  })));
});
```

**Step 4: Run test, expect PASS.** Run: `npm -w @carwars/server run test -- headlessJobs`

**Step 5: Commit.**
```bash
git add server/src/api/economy.ts server/tests/headlessJobs.api.test.ts
git commit -m "feat(jobs): add GET /api/jobs/active for in-progress contracts"
```

---

### Task 2: Unified unread badge — count job outcomes in `/api/reports/unread-count`

The garage `[REPORTS]` badge polls `/api/reports/unread-count`, which today counts only `engagement_reports`. Extend it so pending job outcomes also raise the badge.

**Files:**
- Modify: `server/src/api/reports.ts`
- Test: `server/tests/reports.api.test.ts`

**Step 1: Write the failing test.** Add a new `it(...)` in `reports.api.test.ts`. Register a player, give them a driver, assign a headless job, force it due, and assert the unread count includes the unacknowledged outcome:

```typescript
it('unread-count includes unacknowledged job outcomes', async () => {
  const db = getDb();
  const { token } = await register('reporter-jobs');
  USERS.push('reporter-jobs'); // ensure afterAll cleanup covers it
  const drv = await request(app).post('/api/drivers')
    .set('Authorization', `Bearer ${token}`).send({ name: 'Badge Runner' });
  const jobs = (await request(app).get('/api/jobs/headless?zoneId=town-1')
    .set('Authorization', `Bearer ${token}`)).body;
  await request(app).post('/api/jobs/assign')
    .set('Authorization', `Bearer ${token}`).send({ jobId: jobs[0].id, driverId: drv.body.id });
  // Force the contract due so it resolves into an (unacknowledged) outcome.
  await db.query(`UPDATE jobs SET resolves_at = NOW() - interval '1 second' WHERE id = $1`, [jobs[0].id]);

  const count = await request(app).get('/api/reports/unread-count')
    .set('Authorization', `Bearer ${token}`);
  expect(count.body.unread).toBeGreaterThanOrEqual(1);
});
```

> Note: `register()` currently appends to a fixed `USERS` array via literal; confirm the helper/cleanup pattern in the file and adjust the cleanup line to match (the existing file deletes `WHERE username = ANY($1)`).

**Step 2: Run it, expect FAIL** (count reflects only engagement reports → 0). Run: `npm -w @carwars/server run test -- reports`

**Step 3: Implement.** In `reports.ts`, import the resolver and union both sources:

```typescript
import { resolveDueHeadlessJobs } from './economy';
```
Replace the `/unread-count` handler body:
```typescript
reportsRouter.get('/unread-count', requireAuth, async (req: AuthRequest, res) => {
  await resolveDueDeployments(req.playerId!);
  await resolveDueHeadlessJobs(req.playerId!);
  const db = getDb();
  const [eng, jobs] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS n FROM engagement_reports WHERE player_id = $1 AND read = FALSE`, [req.playerId]),
    db.query(
      `SELECT COUNT(*)::int AS n FROM jobs j JOIN drivers d ON d.id = j.assigned_driver_id
        WHERE d.player_id = $1 AND j.outcome IS NOT NULL
          AND COALESCE((j.outcome->>'acknowledged')::boolean, FALSE) = FALSE`,
      [req.playerId]),
  ]);
  return res.json({ unread: eng.rows[0].n + jobs.rows[0].n });
});
```

> Watch for an import cycle: `economy.ts` does not import `reports.ts`, so importing `resolveDueHeadlessJobs` into `reports.ts` is one-directional and safe. Verify the build passes.

**Step 4: Run test, expect PASS.** Run: `npm -w @carwars/server run test -- reports`

**Step 5: Commit.**
```bash
git add server/src/api/reports.ts server/tests/reports.api.test.ts
git commit -m "feat(reports): include unacknowledged job outcomes in unread badge"
```

---

## Phase B — Reusable driver-picker component

### Task 3: `client/src/ui/DriverPicker.ts`

A composable overlay that lists the player's **available** drivers and resolves with the chosen `driverId` (or `null` if cancelled). Reused by the Contracts section now and the squad deploy panel later.

**Files:**
- Create: `client/src/ui/DriverPicker.ts`
- Reference (conventions): `client/src/ui/responsive.ts`, `client/src/scenes/GarageScene.ts` (status fields), `client/src/scenes/WorldMapScene.ts:325-355` (driver fetch shape)

**Step 1: Implement.** No client unit harness exists, so this task is build-verified. Match existing overlay style (semi-transparent backdrop, monospace text, container added to the calling scene).

```typescript
import Phaser from 'phaser';

interface DriverLite { id: string; name: string; skill: number; status?: string; title?: string; }

// Opens a modal driver picker over `scene`. Resolves with the chosen driver id,
// or null if the player cancels. Only `available` drivers are selectable.
export function openDriverPicker(
  scene: Phaser.Scene,
  token: string,
  opts: { title?: string } = {},
): Promise<string | null> {
  return new Promise(async (resolve) => {
    const host = window.location.hostname;
    const drivers: DriverLite[] = await (await fetch(`http://${host}:3001/api/drivers`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    const available = drivers.filter(d => d.status === 'available');

    const { width, height } = scene.scale;
    const layer = scene.add.container(0, 0).setDepth(1000);
    const backdrop = scene.add.rectangle(0, 0, width, height, 0x000000, 0.7)
      .setOrigin(0).setInteractive();
    layer.add(backdrop);

    const cx = width / 2;
    const title = scene.add.text(cx, height * 0.2, opts.title ?? 'ASSIGN DRIVER', {
      color: '#00ff88', fontSize: '20px', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    layer.add(title);

    const close = (id: string | null) => { layer.destroy(); resolve(id); };

    if (!available.length) {
      const none = scene.add.text(cx, height * 0.35, 'No available drivers — all are out or wounded.', {
        color: '#ff8844', fontSize: '14px', fontFamily: 'monospace',
      }).setOrigin(0.5);
      layer.add(none);
    } else {
      available.forEach((d, i) => {
        const row = scene.add.text(cx, height * 0.3 + i * 36,
          `${d.name}  ·  skill ${d.skill}${d.title ? '  ·  ' + d.title : ''}`, {
          color: '#cccccc', fontSize: '15px', fontFamily: 'monospace',
          backgroundColor: '#003322', padding: { x: 10, y: 5 },
        }).setOrigin(0.5).setInteractive();
        row.on('pointerover', () => row.setColor('#00ff88'));
        row.on('pointerout', () => row.setColor('#cccccc'));
        row.on('pointerdown', () => close(d.id));
        layer.add(row);
      });
    }

    const cancel = scene.add.text(cx, height * 0.8, '[CANCEL]', {
      color: '#888888', fontSize: '15px', fontFamily: 'monospace',
    }).setOrigin(0.5).setInteractive();
    cancel.on('pointerdown', () => close(null));
    backdrop.on('pointerdown', () => close(null));
    layer.add(cancel);
  });
}
```

**Step 2: Verify build.** Run: `npm -w @carwars/client run build` — expect success (no type errors).

**Step 3: Commit.**
```bash
git add client/src/ui/DriverPicker.ts
git commit -m "feat(ui): add reusable openDriverPicker overlay"
```

---

## Phase C — Contracts section in JobBoardScene

### Task 4: Available contracts + assign flow

**Files:**
- Modify: `client/src/scenes/JobBoardScene.ts`

**Step 1: Implement.** Extend the scene:
- Add `Contract` interface: `{ id: string; job_type: string; description: string; payout: number; difficulty: number; }`.
- In `create()`, after fetching arena jobs, also fetch `GET /api/jobs/headless?zoneId=town-1` and `GET /api/jobs/active`.
- Render a **"CONTRACTS — send a driver"** heading below the arena-jobs list, then one row per available contract: ``[${type}] ${description}` · `Payout $X` · `Difficulty N`` and an `[ASSIGN DRIVER]` button.
- On `[ASSIGN DRIVER]`: `const driverId = await openDriverPicker(this, this.token, { title: 'ASSIGN DRIVER TO CONTRACT' });` then if non-null `POST /api/jobs/assign { jobId, driverId }`; on success `this.scene.restart()` (re-fetches so the contract moves to in-progress); on error show `this.errorText`.
- Import: `import { openDriverPicker } from '../ui/DriverPicker';`
- Add the new text objects to `layout()` so they reposition (follow the existing `jobRows` pattern — keep contract rows in their own array, e.g. `contractRows`, laid out below the arena rows).

Keep difficulty colour-coded if cheap (green ≤3, amber ≤6, orange >6) to match the garage's status-dot palette, but this is optional polish.

**Step 2: Verify build.** Run: `npm -w @carwars/client run build`

**Step 3: Commit.**
```bash
git add client/src/scenes/JobBoardScene.ts
git commit -m "feat(jobboard): add contracts section with driver assignment"
```

---

### Task 5: In-progress contracts section (ETA)

**Files:**
- Modify: `client/src/scenes/JobBoardScene.ts`

**Step 1: Implement.** Using the `/api/jobs/active` data fetched in Task 4, render an **"IN PROGRESS"** sub-section listing each active contract: ``${driverName} → [${jobType}] ${description}` · `ETA mm:ss``. Reuse the existing `fmtRemaining`/ETA formatting helper — check `GarageScene.ts` / `WorldMapScene.ts` for the existing `fmtRemaining`/`fmtEta` helper and import or copy it (DRY: prefer importing if it already lives in a shared `ui` module; otherwise mirror the small formatter). Add a 1s timer (`this.time.addEvent`) to tick the ETA labels down, matching `WorldMapScene`'s deployment-timer pattern (`WorldMapScene.ts:150-152`). Add these rows to `layout()`.

> Do not add live polling beyond the local countdown; the player can re-open the board to refresh, consistent with the rest of the UI.

**Step 2: Verify build.** Run: `npm -w @carwars/client run build`

**Step 3: Commit.**
```bash
git add client/src/scenes/JobBoardScene.ts
git commit -m "feat(jobboard): show in-progress contracts with live ETA"
```

---

## Phase D — Merge job outcomes into ReportScene

### Task 6: Unified reports list

**Files:**
- Modify: `client/src/scenes/ReportScene.ts`

**Step 1: Implement.**
- Add a `JobOutcome` view-type for the rows returned by `GET /api/jobs/outcomes` (fields include `id`, `tier`/`outcome`, `payout`, `jobDescription`, `jobType`, `driverName`, plus the `resolveHeadlessJob` result fields — confirm exact shape from `economy.ts` `resolveDueHeadlessJobs` report object and `rules/headlessJob.ts`).
- In the load path (currently fetches `/api/reports`), **also** fetch `GET /api/jobs/outcomes`. Build one unified, time-sorted list with a discriminant (`kind: 'squad' | 'job'`). Squad reports already carry `created_at`; for job outcomes there is no timestamp in `/outcomes` — render them at the top (newest) or add `j.resolves_at`/`completed`-derived time to the `/outcomes` payload if ordering matters (small server tweak; only do this if needed).
- Render job-outcome rows with their own detail panel (driver name, job type/description, tier/outcome colour using the existing `OUTCOME_COLOUR` map where tiers map cleanly, payout, any wound/wreck consequences).
- When a job-outcome row is opened/viewed, call `POST /api/jobs/${id}/acknowledge` — the parallel of the squad `POST /api/reports/${id}/read`. This clears it from the badge.

**Step 2: Verify build.** Run: `npm -w @carwars/client run build`

**Step 3: Commit.**
```bash
git add client/src/scenes/ReportScene.ts
git commit -m "feat(reports): surface headless-job outcomes alongside squad reports"
```

---

## Phase E — Full verification

### Task 7: Build, test, smoke, deploy

**Step 1: Server tests.** Run: `npm -w @carwars/server run test` — expect all green (new Task 1 & 2 tests pass; no regressions).

**Step 2: Builds.** Run: `npm -w @carwars/server run build` and `npm -w @carwars/client run build` — expect both succeed.

**Step 3: Playwright smoke (local).** Start the app, log in, and verify the full loop end-to-end:
1. Garage → `[JOB BOARD]` → see arena jobs **and** a Contracts section.
2. Assign an available driver to a contract → driver picker shows only available drivers → after assign, contract appears under **IN PROGRESS** with a counting-down ETA, and the driver shows `ON JOB` back in the garage.
3. Force/await resolution → garage `[REPORTS]` badge increments → open Reports → job outcome appears alongside squad reports → opening it clears the badge.

> Use the Playwright MCP tools. Capture a screenshot of the Contracts section and the unified Reports list.

**Step 4: Final review.** Run `git diff main --stat` and confirm every change traces to a task above. No edits to the squad deploy panel, garage status dots, or world-map indicators (already done by Phase 4).

**Step 5: Deploy (only when the user asks).** `./scripts/deploy.sh` (rsync → hl-carwars → build → restart). Do not deploy without explicit instruction.

---

## Out of scope (explicitly not doing)
- Rebuilding squad deploy / garage status / world-map ETAs — already shipped in Phase 4.
- A driver picker for **arena** jobs — arena jobs are driven by the player, not assigned.
- Server-side merge endpoint unioning reports + outcomes — client-side merge is sufficient (YAGNI).
- Real-time websocket push for contract completion — lazy resolution + badge poll is the established pattern.
