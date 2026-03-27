# Car Wars — Game Design Document

**Date:** 2026-03-27
**Status:** Approved

---

## Overview

A faithful browser-based implementation of Car Wars (Steve Jackson Games, 1980s) — a tactical vehicular combat game with a seamless open world, campaign progression, and online multiplayer. Players own and manage a garage of armed vehicles, hire drivers, climb the division ladder, and survive a living world of highway combat and arena events.

---

## Scope

- Faithful Car Wars rules: 5-phase turns, facing, weapon arcs, armor locations, handling class, vehicle point-buy design
- Seamless open world: highways are live combat zones, towns have garages and job boards, arenas are venues within the world
- Campaign: arena circuit + division ladder + open world jobs and encounters
- Team/garage: own multiple cars, hire AI or human drivers; player drives one car, rest AI-driven or controlled by human teammates
- Multiplayer: single player vs AI, local multiplayer, online multiplayer

---

## Architecture

**Stack:**
- Client: Phaser.js + TypeScript (Vite build)
- Server: Node.js + TypeScript + WebSockets
- Database: PostgreSQL

**Runtime model:**
```
Browser (Phaser)              Node.js Server
─────────────────             ──────────────────────────────
World Scene              ←──WebSocket──→  Zone Server (persistent world state)
  └─ highways, towns                       └─ movement, encounters,
  └─ arena venues                               NPC traffic, rival gangs
  └─ garage/job board UI   ←──REST API──→  Campaign Server
                                            └─ accounts, garage, standings
```

The world is divided into **zones** (highway stretches, towns, arena interiors). Each zone is a live server-side simulation. The server is authoritative — clients send inputs, the server resolves game state and broadcasts results. This model supports both online multiplayer and single player vs AI with the same codebase.

---

## Core Game Systems

### 1. Rules Engine

The server runs a 5-phase turn structure:
- All vehicles declare speed at turn start
- Each phase: movement resolves simultaneously for all vehicles
- Hazard checks trigger on tight manoeuvres (cornering, swerving)
- Combat resolves within phases (weapons fire in declared arcs)
- All math (to-hit, damage, armor penetration) is server-side only

Key rule elements: vehicle facing (15° increments), speed (inches/phase), Handling Class, deferred actions, hazard rolls.

### 2. Vehicle System

Vehicles are defined by point-buy loadout:
- **Chassis** — determines space and weight limits
- **Engine** — affects top speed and acceleration
- **Suspension** — affects Handling Class
- **Tires** — tracked individually, blowouts have mechanical consequences
- **Weapon mounts** — determines firing arcs
- **Weapons & ammo** — diverse arsenal (MGs, rockets, lasers, oil, mines, etc.)
- **Armor** — distributed across 6 locations: front, back, left, right, top, underbody

Damage is tracked per armor location. Component damage (engine hit, tire blowout, driver wounded) has distinct mechanical effects. Vehicle loadouts stored as JSON in PostgreSQL.

### 3. World & Zone System

- Tile-based world map (Tiled editor format, `.tmx`)
- Zones: highway stretches, towns, arena interiors
- Each zone runs as a live server simulation
- NPC traffic, rival gang patrols, and random encounters generated per zone
- Zone transitions are seamless — vehicles drive through boundaries
- Towns pause action for garage/job board UI interactions

### 4. Combat System

- Weapons have firing arcs, range bands, and rate of fire
- To-hit rolls factor: range, speed differential, target size, crew skill
- Damage resolves against specific armor locations based on attack angle
- Special weapons (oil slicks, mines, smoke, dropped weapons) interact with the hazard system
- Explosions have area-of-effect damage with falloff

### 5. AI Driver System

Behaviour tree per driver:
```
AssessThreats → ChooseTarget → ManoeuvreToOptimalRange → SelectWeapon → FireIfInArc → AvoidHazards
```

- Hired drivers have skill stats affecting accuracy, handling, and threat assessment
- Rival gang AIs have persistent state — they remember player reputation and react (flee, escalate, negotiate)
- Driver skill scales AI difficulty; better drivers cost more to hire

---

## Campaign & Economy

### Division System

- Divisions based on car value (Division 5 = ~$25k, scaling up)
- Player starts with a budget and enters Division 5 events
- Car value rises with upgrades; game auto-qualifies player for higher divisions at thresholds
- Reputation grows with wins — lower-division rivals respond with escalating aggression

### Economy

**Income:** prize purses, highway job payouts (escort, ambush, delivery), vehicle/weapon salvage, selling cars
**Costs:** repairs (per location and component), ammo resupply, driver wages (cut of winnings), garage fees, insurance (purchasable)

Losing a car is a meaningful setback. Permadeath applies to drivers — a driver killed in combat is gone permanently.

### Garage & Roster

Accessible from any town garage:
- Design, buy, and upgrade vehicles
- Repair damage (per component/location, costs money and time)
- Hire and fire drivers (stats: skill, aggression, loyalty; gain XP over time)
- Assign drivers to vehicles
- Review team standings and finances

---

## Multiplayer

- Online players share the same world zones — organic open-world PvP
- PvP is opt-in via a flagging system (flagged = open to challenge)
- Arena division events: enter solo or as a gang (multiple cars, some driven by teammates)
- Simple matchmaking lobby for structured arena events
- Highway co-op: team up with other players for escort/ambush jobs

---

## Data Model

```
Player
  └─ Garage
       ├─ Vehicle[]
       │    ├─ Loadout (JSON): chassis, engine, weapons, armor distribution
       │    └─ DamageState: per-location armor remaining, component status
       └─ Driver[]
            ├─ Stats: skill, aggression, loyalty
            ├─ XP / level
            └─ AssignedVehicle (nullable)

Campaign
  ├─ Money
  ├─ Division
  ├─ Reputation
  └─ EventHistory[]
```

---

## Rendering

- Phaser renders tilemap world, vehicle sprites with rotation, weapon fire effects
- Vehicles visually degrade as armor is lost (damaged sprite variants)
- Minimap shows zone layout and positions
- UI overlays: phase indicator, armor bars per facing, team roster status, weapon arc visualiser

---

## Turn Resolution Flow (Server)

```
Every 100ms tick:
  1. Collect all pending player/AI inputs
  2. Compute phase movement for all vehicles simultaneously
  3. Resolve hazard checks (cornering, debris, oil)
  4. Resolve combat (to-hit rolls → damage → armor → component effects)
  5. Broadcast new world state to all clients in zone
  6. Clients interpolate between states for smooth rendering
```
