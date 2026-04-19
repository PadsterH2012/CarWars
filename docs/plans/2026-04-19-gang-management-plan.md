# Gang Management — Plan

**Date:** 2026-04-19
**Status:** Design locked (full ambition) — 5 phases, Phase 1 first

**Goal:** Turn the player's collection of vehicles + drivers into a named gang that fights as a squad of up to 4 cars against named persistent rival gangs, with a commander-mode tactical overlay during combat and a full ongoing-cost economy between matches.

**Architecture:** Three new DB tables (`gangs`, `rival_gangs`, `rival_gang_rep`), a new WebSocket command stream for tactical orders, a tactical-overlay scene on the client, and a scheduled "game time" tick that drives recurring costs. The existing per-player systems (vehicles, drivers, money, reputation) stay put but gain a gang-level layer on top.

---

## Locked-in design decisions

| # | Decision | Notes |
|---|----------|-------|
| 1 | **Squad cap: 4 per side** | Both player and enemy teams. Enemy count scales 1:1 with player squad size. |
| 2 | **Commander mode** | Pause-able tactical overlay (spacebar, or a dedicated key). Queue orders for squadmates: attack target, move to waypoint, follow leader, retreat. Match resumes when you close the overlay. |
| 3 | **Gang entity** | New `gangs` table. Player belongs to a gang. Gang owns vehicles + drivers (migrate existing player ownership). Gang has its own treasury, reputation, primary+secondary colour. Personal player money becomes gang treasury. |
| 4 | **Rival gangs** | New `rival_gangs` seed table (5–8 named gangs). Per-player-gang rep tracked in `rival_gang_rep`. Beating a rival drops their rep; keep beating → they bring better cars and more squadmates on rematch. Lose → underworld rep takes a hit (affects job pricing). |
| 5 | **Full economy** | Driver wages per match (skill-based: $50 × skill per match). Monthly garage fees ($100 per vehicle). Optional insurance ($50/month per vehicle, pays 75% of rebuild cost on total loss). Maintenance ($10 per vehicle per match). "Month" = N real-world game days or a configurable tick. |

---

## Phase 1 — Squad Mechanics (the baseline, no gang entity yet)

**Goal:** You can bring up to 4 of your vehicles into an arena, they fight on your team, XP distributes correctly. No gang name, no commander mode, no rivals, no wages. This is the "I can play with a squad" milestone.

### Tasks

- **1.1** Shared: `join_zone` gains `squadVehicleIds?: string[]`
- **1.2** Server: `handler.ts` accepts squad list, validates ownership + driver assignment + `in_arena` availability, spawns all on player team
- **1.3** Enemies scale with squad size (1v1 up to 4v4). Spawn point count grows; if the map runs out, fall back to the existing 3 enemy names + `ai-yellow`
- **1.4** Engine: track kill attribution — when a wreck is created, stash the id of the last vehicle that damaged it
- **1.5** XP distribution: each driver gets `10 × kills + 20 if survived`. `onEnd` walks squad vehicles, looks up assigned drivers, awards per-driver XP + skill-up checks
- **1.6** Salvage already filters by winner's playerId — works unchanged for squads
- **1.7** Garage UI: Fight button → squad-picker modal (checkboxes up to 4, the clicked vehicle is the primary)
- **1.8** Arena HUD: squad members rendered in a muted team colour so the player's own car stays distinct
- **1.9** End-of-match: clear `in_arena` for every squad vehicle, show per-vehicle kill tally on the victory screen

### Tests
- Squad join validates all vehicles
- XP fan-out correct for 2-kill 1-surviving-driver match
- Enemy count matches squad size
- Salvage excludes all squad wrecks from the total

## Phase 2 — Commander Mode

**Goal:** Tactical pause with queued orders for squadmates.

### Tasks

- **2.1** Client: new `TacticalOverlay` scene. Triggered by spacebar; when shown, client sends `pause: true` to server; rendering continues from last known state but no updates applied
- **2.2** Server: pause mode — existing engine tick runs but all inputs are queued, no state advance sent to clients while paused. Unpause drains the queue and resumes
- **2.3** Shared: new client→server message `squad_order` — `{ vehicleId, type: 'attack'|'move'|'follow'|'retreat', targetId?, targetPos?, leaderId? }`
- **2.4** AI driver: accept an optional `order` override that biases tactic selection (attack → prioritise specified target, move → drive to waypoint ignoring combat, follow → stay in formation, retreat → maximise distance from enemies)
- **2.5** Overlay UI: top-down view of arena with squad (blue), enemies (red), wrecks (grey). Click a squadmate to select, click an enemy/target to issue an attack order, right-click to move, keyboard shortcut for follow/retreat
- **2.6** Visual indicators during play: selected squadmate gets an outline; active order is shown as an arrow/icon above the sprite

### Tests
- Squad_order message reaches the target vehicle's AI driver
- Attack order keeps the squadmate locked on the specified target even when closer enemies are available

## Phase 3 — Gang Entity

**Goal:** Migrate player-owned things into gang-owned. Gang has name + colours + treasury + rep.

### Tasks

- **3.1** DB: `gangs` table (id, owner_player_id, name, primary_colour, secondary_colour, treasury, reputation)
- **3.2** Migration: on player register, create a default gang (name derived from username, default colours). Move `vehicles.player_id` → `vehicles.gang_id`; `drivers.player_id` → `drivers.gang_id`. Treasury starts = current player money
- **3.3** API: `GET /api/gangs/mine`, `PATCH /api/gangs/mine` (rename, change colours)
- **3.4** Garage UI: show gang name as header; colour picker in a settings panel
- **3.5** Client sprite tinting: use gang primary colour for all squad vehicles instead of the hardcoded green
- **3.6** Match rewards (prize, salvage, job payout) credit the gang treasury. "Personal money" concept removed from UI

### Tests
- Register creates a gang
- Vehicles + drivers are listed by gang
- Match rewards go to gang treasury

## Phase 4 — Named Persistent Rivals

**Goal:** Rival gangs have names, memory, and escalate over time.

### Tasks

- **4.1** DB: `rival_gangs` seed table (id, name, style description, base_skill, colour) — 5–8 rivals authored
- **4.2** DB: `rival_gang_rep` (player_gang_id, rival_id, rep_score, encounters, wins, losses) — rep 0..100, 50 = neutral
- **4.3** On match start, pick a rival based on player's division and current rep with each rival; fill enemy team with that rival's signature vehicles (eventually data-driven; for Phase 4 MVP, hardcode a loadout per rival)
- **4.4** After match, update `rival_gang_rep`. Beat them → their rep drops (they escalate). Lose → player's reputation takes a hit ("rumour spreads"). Enemy skill/loadout quality scales inversely with rival rep (the more you dominate, the meaner they get back)
- **4.5** Post-match UI shows rival name + their taunt/boast based on outcome
- **4.6** Job board: some jobs can target specific rivals ("The Wolves are running guns through Sector 7 — intercept their convoy")

### Tests
- New player starts with default rep against all rivals
- Match outcome moves the correct rival's rep
- Low-rep rivals field tougher squads

## Phase 5 — Full Ongoing Economy

**Goal:** Wages, fees, insurance, maintenance. Gang can go broke.

### Tasks

- **5.1** DB: `gang_ledger` (gang_id, tick, event_type, amount, description) — audit log. `gangs.last_tick_processed`
- **5.2** "Game month" tick: a scheduler (could be cron or a timer) that runs monthly costs. Applied at login if overdue ticks accumulated while offline
- **5.3** Per-match deductions (on match end, alongside rewards):
  - Driver wages: each squadmate's driver, `$50 × skill`
  - Maintenance: `$10 × squad size`
- **5.4** Monthly deductions:
  - Garage fees: `$100 × vehicle count`
  - Insurance premiums for any insured vehicles: `$50 per insured vehicle`
- **5.5** Insurance payouts: when a vehicle is totalled (destroyed + can't be repaired to full), if insured, gang receives 75% of rebuild cost
- **5.6** Garage UI: insurance toggle per vehicle. Monthly statement shows last cycle's income + costs
- **5.7** Bankruptcy state: treasury can't go negative; if monthly costs exceed balance, gang goes into arrears (vehicles get repossessed one by one, starting with most expensive, until arrears cleared). "Game over" only if all vehicles + drivers are lost

### Tests
- Match end debits wages + maintenance
- Monthly tick debits garage fees
- Insured totalled vehicle credits 75% of rebuild cost

---

## Phase ordering rationale

- **Phase 1** unlocks the fantasy — everything else assumes you can field a squad
- **Phase 2** is high-impact UI work, independent of persistence layers
- **Phase 3** is a schema migration + small UI; natural follow-up before rivals because rivals need a gang-level rep target
- **Phase 4** adds the "career loop" motivation — you fight specific people, not faceless AI
- **Phase 5** adds the "meta-game loop" motivation — you manage money between fights

Phases are sequential — each assumes its predecessors. Every phase ships as a set of commits deployed to hl-carwars and playable.

## Cross-phase risks to watch

- **Phase 3 migration** touches every existing table that references `player_id`. Needs care — probably a single migration script, non-destructive, backwards compatible for at least one deploy
- **Phase 2 pause** interacts with multiplayer later. Pausing a single-player match is easy; if multiplayer ever lands, pause becomes a consensus problem
- **Phase 5 scheduler** — where does the monthly tick run? Options: cron on the VM, in-process timer in the Node server, computed-on-read (process arrears next time player logs in). Probably the last — simplest, works through restarts

---

## Success criteria (Phase 1 — the next milestone)

1. Can build a 2–4 car squad in the garage
2. Squadmates appear on my team in the arena, AI-driven
3. Enemy count matches squad size
4. XP distributes per-driver based on kills + survival
5. `in_arena` clears for all squad vehicles on match end
6. Post-match screen shows per-vehicle kill tallies

Next-phase starts only when Phase 1 is green and deployed.
