# CarWars — Project Instructions for Claude Code

## Source of Truth

The **Mac repo at `~/carwars`** is the working copy and the authoritative source. The hl-carwars VM (10.202.28.192) is a **deploy target only** — do not develop there. Changes are committed locally, then deployed with `./scripts/deploy.sh`.

## Phase Plans

Phase plans live in the Obsidian vault at:
`/Volumes/Breakaway/obsidian/Homelab/Projects/A1 - Main Projects/CarWars/`

Naming convention: `NN - Phase X Name.md` (e.g. `21 - Phase 2 Hire Driver Plan.md`)

When executing a plan, use the **phase prefix** derived from the filename:
- `21 - Phase 2 Hire Driver Plan.md` → prefix = `21 - Phase 2`
- `22 - Phase 3 Garage Bay Plan.md` → prefix = `22 - Phase 3`

All HELP files and completion reports use this prefix.

## Human-in-the-loop Protocol

When you need assistance, hit a decision point you can't resolve alone, or encounter an ambiguity — you MUST NOT guess. Follow this protocol.

### When you need assistance

1. **Write an assistance request** to the CarWars Obsidian folder using the phase prefix:
   `{prefix} - HELP - <brief-topic>.md`

   Example for Phase 2: `21 - Phase 2 - HELP - job-difficulty.md`

   Structure:
   ```markdown
   # Assistance Request: <topic>

   **Status:** waiting
   **Task:** <which task you were working on>
   **What I need:** <clear question>
   **What I have tried:** <options considered>
   **Context:** <relevant file paths, error messages, code snippets>
   ```

2. **Pause execution.** Do not proceed until the `Status` field changes.

3. **Poll every 60 seconds** by re-reading the file. When `**Status:**` changes from `waiting` to either `answered` or `guidance`, read the response below and continue.

4. **If the response is unclear**, write another request referencing the previous one.

### When you complete a task or the full phase

1. **Write a completion report** using the phase prefix:
   `{prefix} - report.md`

   Example for Phase 2: `21 - Phase 2 Hire Driver Plan - report.md`

   Format:
   - Table of what was implemented per task
   - Verification results (build output, test counts)
   - Design choices made (flag deviations)
   - What is not yet done (if deferred)
   - Issues the next phase should know about

2. **Flag follow-ups** — the report is read by Amber (the orchestrator) and by future Claude sessions.

### Who reads it

Amber (Hermes orchestrator) checks the folder every 2 minutes. When a HELP file appears with `Status: waiting`, she reads it and either:
- Answers directly if within her scope
- Pings Paddy on Discord for a decision
- Writes guidance back and sets status to `answered`

## Database

Local Postgres on the Mac for development. DB: `carwars`, user: `carwars`, password: `carwars_dev`. Schema at `server/src/db/schema.sql`.

## Build

- Server: `npm -w @carwars/server run build` (esbuild → `server/dist/main.js`)
- Client: `npm -w @carwars/client run build` (tsc + vite → `client/dist/`)
- Tests: `npm -w @carwars/server run test`
- Deploy: `./scripts/deploy.sh` (rsyncs to hl-carwars, builds, restarts service)