# Phase 5 — Jobs on the Squad Engine (Design)

**Status:** approved 2026-05-29
**Supersedes:** the single-driver headless-contract UI shipped earlier 2026-05-29 (commit `2764500`, issue #7) and the arena-dependent job-board flow.

## Problem

The job board has no resource-commitment model. Taking the "$3000 escort" arena job reserves no vehicle and tells the player nothing — you fulfil it by separately winning an arena fight. The player's mental model is the opposite: **send a car (and its crew) out on a job → it becomes unavailable → the rest stay home for the arena or other jobs.** They see no value in jobs whose completion depends on winning an arena fight.

## Goal

Make a job consume a **squad** (1–4 vehicle+driver pairs) that the player composes per job. Committed vehicles and drivers show as unavailable with an ETA; the job resolves headless and pays out with an after-action report. Retire the arena-dependent jobs and the redundant single-driver contract. The arena stays as a separate, opt-in activity (escalating events vs rival gangs — a **separate future design**).

## Key insight

`resolveSquadEngagement()` (`server/src/rules/squadEngagement.ts`) needs only `{ squad, vehicles, zoneDifficulty, assignment, basePayout, rival? }` — **no map zone, no enemy roster**. A job can drive it directly using the job's own difficulty + payout. The Phase 4 squad-deployment machinery (`squad_deployments` table, `resolveDueDeployments()`, `engagement_reports`, the computed `deployed` status on `/api/vehicles` and `/api/drivers`) is therefore reusable wholesale.

## Architecture

### Linchpin: a job assignment is a `squad_deployment` row tagged with `job_id`

- Add `job_id UUID REFERENCES jobs(id) ON DELETE CASCADE` (nullable) to `squad_deployments`.
- Relax `zone_id` to nullable (job-deployments have no world node).
- `resolveDueDeployments()` gains one branch: **if `job_id` is set**, take difficulty / payout / display-name from the `jobs` row instead of looking up a `WorldNode`; otherwise the existing zone path is unchanged.

**Why this is the win — downstream plumbing is reused, not rebuilt:**
- `/api/vehicles` already computes `status: 'deployed'` + `remainingSeconds` by joining `squad_deployments` → vehicles sent on a job show "DEPLOYED [ETA]" in the garage automatically. *(This is the original complaint, solved for free.)*
- Drivers already marked unavailable with an ETA via the same machinery.
- `resolveDueDeployments()` already applies wounds/damage, credits payout, and writes an `engagement_report`.

### ETA model

Jobs are not on the map, so they use a **fixed/difficulty-scaled timer** (reusing the headless 2–5 min window or a per-job duration), **not** road-distance travel time. The deployment row's `resolves_at` is set at assignment time.

### Opponent (MVP)

Job encounters are anonymous NPC scavengers (no rival). `resolveSquadEngagement`'s `rival` arg stays `undefined` for jobs in MVP. Rival-gang jobs (raid-type) are deferred to the arena-events work.

## Components

### Backend
- **Schema:** `squad_deployments` gains nullable `job_id`; `zone_id` nullable. Migration is idempotent (`schema.sql` IF-NOT-EXISTS style).
- **`POST /api/jobs/:id/deploy`** (new) — body `{ vehicleIds: string[] }` (1–4). Validates ownership, each vehicle has a living available assigned driver, none already deployed/in-arena. Creates a `squad_deployment` with `job_id`, `assignment='job'`, `resolves_at = NOW() + duration`. Marks drivers unavailable. Returns `{ deploymentId, etaSeconds, resolvesAt }`.
- **`resolveDueDeployments()`** — branch on `job_id` for difficulty/payout/name; mark the job completed when its deployment resolves.
- **Retire:** `STATIC_JOBS` arena jobs + `/api/jobs/:id/take`, `/:id/complete`; the single-driver path `/api/jobs/assign`, `/api/jobs/outcomes`, `/api/jobs/:id/acknowledge`, `resolveHeadlessJob`, `resolveDueHeadlessJobs`, `jobs.outcome`. The `jobs` table keeps `difficulty`, `payout`, `description`, `job_type`, `division_min`, `headless`, `completed`; loses the single-driver assignment columns where unused.
- **`GET /api/jobs/active`** (already exists) — repoint to job-deployments (or fold into the deployments query).

### Frontend
- **`JobBoardScene`** — one list of jobs (description · difficulty · payout · ETA). `[SEND SQUAD]` opens the squad picker; "Out on jobs" section shows in-progress job-deployments with live ETA (reusing the section already built).
- **Squad picker** — generalise `client/src/ui/DriverPicker.ts` into a reusable 1–4 vehicle+driver multi-select (mirrors the world-map deploy panel's composition list, but standalone — not coupled to `WorldMapScene`). Shows car + armour + driver + skill, eligibility reasons, max 4.
- **`WorldMapScene`** — filter its "active deployments" list/markers to zone-deployments (`job_id IS NULL`) so jobs don't appear on the map.
- **`ReportScene`** — simplify back to a single source (`/api/reports` engagement reports) now that jobs write `engagement_reports`; drop the `/api/jobs/outcomes` merge added earlier today.

### Carried over from the issue-#7 work
`openDriverPicker` (→ generalised), the job-board section layout, the in-progress/ETA rendering, the report rendering. Only the single-driver *mechanic* is dropped.

## Data flow

1. Player opens Job Board → sees jobs (difficulty/payout) + any in-progress job-deployments.
2. `[SEND SQUAD]` → squad picker → `POST /api/jobs/:id/deploy { vehicleIds }`.
3. `squad_deployment` row created (`job_id` set); vehicles show `deployed`, drivers `on_job`, both with ETA in the garage.
4. Timer expires → next API call lazily runs `resolveDueDeployments()` → `resolveSquadEngagement(job difficulty/payout)` → wounds/damage/payout applied → `engagement_report` written → job marked completed → vehicles/drivers freed.
5. Garage `[REPORTS]` badge (unread engagement reports) → `ReportScene` shows the after-action report.

## Error handling
- Deploy rejects: vehicle not owned / destroyed / in arena / already deployed; driverless vehicle; driver dead or unavailable; >4 vehicles; job already completed or already has an active deployment.
- Resolution is idempotent and atomic (existing `resolveDueDeployments` claim/lock pattern reused).

## Testing
- **Server (vitest+supertest, real PG):** deploy a squad to a job → vehicles/drivers show unavailable; force `resolves_at` due → engagement report written, job completed, crew freed, payout credited; reject invalid deploys (driverless, dead driver, >4, already deployed, completed job). Confirm world-map deployments still resolve (no regression in the zone path).
- **Client:** build clean; Playwright smoke — send a squad from the job board → garage shows DEPLOYED/ON JOB → force due → report in inbox.
- Full suite green before merge.

## Out of scope (future)
- Garage defense vs rival-gang attacks.
- Larger garages / crew capacity.
- Arena events: duels, tournaments, multi-stage ladders with escalating prize pools vs rivals — **its own design pass next.**
- Rival opponents on jobs.

## Documentation (after build)
Per the user's request, once the phase(s) land, write Obsidian docs in the CarWars project folder covering **jobs** and **arena events** as the game's two income/prestige loops.
