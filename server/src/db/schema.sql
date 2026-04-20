CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  money INTEGER NOT NULL DEFAULT 25000,
  division INTEGER NOT NULL DEFAULT 5,
  reputation INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  loadout JSONB NOT NULL,
  original_loadout JSONB,
  damage_state JSONB NOT NULL DEFAULT '{}',
  value INTEGER NOT NULL DEFAULT 0,
  in_arena BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS drivers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  skill INTEGER NOT NULL DEFAULT 3,
  aggression INTEGER NOT NULL DEFAULT 3,
  loyalty INTEGER NOT NULL DEFAULT 5,
  xp INTEGER NOT NULL DEFAULT 0,
  assigned_vehicle_id UUID REFERENCES vehicles(id) ON DELETE SET NULL,
  alive BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS event_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  result JSONB NOT NULL,
  money_delta INTEGER NOT NULL DEFAULT 0,
  occurred_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  description TEXT NOT NULL,
  payout INTEGER NOT NULL,
  division_min INTEGER NOT NULL DEFAULT 5,
  taken_by UUID REFERENCES players(id) ON DELETE SET NULL,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jobs_zone_id ON jobs(zone_id);

-- Migrations: add columns to existing tables if they don't exist
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vehicles' AND column_name='original_loadout') THEN
    ALTER TABLE vehicles ADD COLUMN original_loadout JSONB;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vehicles' AND column_name='in_arena') THEN
    ALTER TABLE vehicles ADD COLUMN in_arena BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;

-- Gangs (added 2026-04-19 — Gang Management Phase 3)
CREATE TABLE IF NOT EXISTS gangs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_player_id UUID UNIQUE NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  primary_colour INTEGER NOT NULL DEFAULT 52616, -- 0x00CD68 (default green)
  secondary_colour INTEGER NOT NULL DEFAULT 6710886, -- 0x666666 (default grey)
  treasury INTEGER NOT NULL DEFAULT 0,
  reputation INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Emblem (coat-of-arms template id) — authored template + gang colours render the shield
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='gangs' AND column_name='emblem_id') THEN
    ALTER TABLE gangs ADD COLUMN emblem_id TEXT NOT NULL DEFAULT 'stripes';
  END IF;
END $$;

-- Add gang_id FK to vehicles + drivers (nullable during the migration window)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vehicles' AND column_name='gang_id') THEN
    ALTER TABLE vehicles ADD COLUMN gang_id UUID REFERENCES gangs(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='drivers' AND column_name='gang_id') THEN
    ALTER TABLE drivers ADD COLUMN gang_id UUID REFERENCES gangs(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Backfill: every player without a gang gets a default one, treasury = current money
INSERT INTO gangs (owner_player_id, name, treasury)
SELECT p.id, p.username || '''s Gang', p.money
FROM players p
LEFT JOIN gangs g ON g.owner_player_id = p.id
WHERE g.id IS NULL;

-- Backfill vehicles.gang_id from player's gang
UPDATE vehicles v SET gang_id = g.id
FROM gangs g
WHERE g.owner_player_id = v.player_id AND v.gang_id IS NULL;

-- Backfill drivers.gang_id from player's gang
UPDATE drivers d SET gang_id = g.id
FROM gangs g
WHERE g.owner_player_id = d.player_id AND d.gang_id IS NULL;

-- Rival gangs (added 2026-04-19 — Gang Management Phase 4)
-- Authored enemy gangs that persist across matches. Each player has a per-rival
-- grudge score in player_rival_rep; higher grudge → tougher rematches.
CREATE TABLE IF NOT EXISTS rival_gangs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  base_skill INTEGER NOT NULL DEFAULT 3,
  primary_colour INTEGER NOT NULL DEFAULT 16711748,     -- 0xFF4444 (red)
  secondary_colour INTEGER NOT NULL DEFAULT 2236962,    -- 0x222222 (dark)
  emblem_id TEXT NOT NULL DEFAULT 'skull',
  min_division INTEGER NOT NULL DEFAULT 5,
  boast_lines JSONB NOT NULL DEFAULT '[]',    -- shown when rival beats the player
  defeat_lines JSONB NOT NULL DEFAULT '[]',   -- shown when player beats the rival
  lineup JSONB NOT NULL DEFAULT '{}'          -- {"5":["stock_id","..."],"10":[...],...} — stock ids fielded per division
);
-- Add the column if the table existed before this migration
ALTER TABLE rival_gangs ADD COLUMN IF NOT EXISTS lineup JSONB NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS player_rival_rep (
  player_gang_id UUID NOT NULL REFERENCES gangs(id) ON DELETE CASCADE,
  rival_id TEXT NOT NULL REFERENCES rival_gangs(id),
  grudge INTEGER NOT NULL DEFAULT 0,    -- 0 = neutral; higher = angrier = tougher
  encounters INTEGER NOT NULL DEFAULT 0,
  player_wins INTEGER NOT NULL DEFAULT 0,
  rival_wins INTEGER NOT NULL DEFAULT 0,
  last_encounter TIMESTAMPTZ,
  PRIMARY KEY (player_gang_id, rival_id)
);
CREATE INDEX IF NOT EXISTS idx_rival_rep_player_gang ON player_rival_rep(player_gang_id);

-- Gang ledger — append-only record of every income and expense that hits the gang
-- treasury. Gives the garage a 'last 10 entries' statement and the post-match
-- screen an authoritative breakdown of where money went.
CREATE TABLE IF NOT EXISTS gang_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gang_id UUID NOT NULL REFERENCES gangs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,   -- 'arena_prize' | 'salvage' | 'wages' | 'maintenance' | 'job_payout' | 'vehicle_build' | 'vehicle_sell' | 'repair'
  amount INTEGER NOT NULL,    -- signed: positive for income, negative for expenses
  description TEXT NOT NULL DEFAULT '',
  result JSONB NOT NULL DEFAULT '{}',  -- free-form context (zoneId, vehicleIds, rival, etc.)
  occurred_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gang_ledger_gang_occurred ON gang_ledger(gang_id, occurred_at DESC);

-- Seed 5 rival gangs (idempotent — ON CONFLICT keeps existing rows untouched)
INSERT INTO rival_gangs (id, name, description, base_skill, primary_colour, secondary_colour, emblem_id, min_division, boast_lines, defeat_lines) VALUES
  ('iron_wolves', 'The Iron Wolves',
   'Ex-military surplus crew. Heavy armour, bigger guns, little mercy.',
   3, 14492683, 1118481, 'skull', 5,
   $$["You ride like farmhands. Next time, bring a proper gang.", "The Wolves eat amateurs for breakfast."]$$,
   $$["We'll remember this. The pack never forgets.", "You got lucky. Cherish it."]$$),
  ('neon_samurai', 'Neon Samurai',
   'Speed-cult cyclists from the strip. Precision lasers, no armour to spare.',
   4, 1168383, 13459711, 'circle', 5,
   $$["Too slow. Too clumsy. Too dead.", "We dance circles while you burn."]$$,
   $$["Hmph. A worthy opponent. This time.", "The blade meets its match. Rarely."]$$),
  ('rust_raiders', 'The Rust Raiders',
   'Scrap-built strays. Numerous, chaotic, and weirdly dangerous on a budget.',
   2, 16743168, 6703104, 'chevron', 5,
   $$["Hah! We didn't even have to try.", "Scrap meets scrap. Yours is worse."]$$,
   $$["Oi, not bad. We'll be back with more mates.", "You win this scrap. Next one's ours."]$$),
  ('executioners', 'The Executioners',
   'Veteran hit squad. Small numbers, max skill. One mistake and you are gone.',
   5, 11010099, 1118481, 'cross', 4,
   $$["Precision. You lacked it.", "Contract fulfilled. Another name crossed off."]$$,
   $$["Professional work. We'll study your moves.", "The contract is withdrawn. For now."]$$),
  ('highway_apostles', 'The Highway Apostles',
   'A ramplate cult that worships the divine crash. More brick than brains.',
   3, 16777215, 16764160, 'star', 5,
   $$["The road has judged you. Guilty.", "Your faith was weak. Our ramplates, strong."]$$,
   $$["The saints bled for this loss. We shall return.", "You drive well. Perhaps there is hope for you."]$$)
ON CONFLICT (id) DO NOTHING;

-- Rival lineups — which stock blueprints each gang fields at each division.
-- UPDATE (not INSERT) so adjustments roll out to existing seeded rows. Each
-- gang's picks match their flavour: Iron Wolves favour heavy metal, Samurai
-- favour lasers, Rust Raiders the cheap MG/VMG rigs, Executioners pair
-- precision lasers with turrets, Apostles chase the ram-plate Omega-20.
UPDATE rival_gangs SET lineup = $$
  {"5":["sprocket"],"10":["mg3","guardian"],"15":["gatling"],"20":["omega_20","desperado"],"25":["firedrake"],"30":["stormy_weather"]}
$$ WHERE id = 'iron_wolves';
UPDATE rival_gangs SET lineup = $$
  {"5":["lo_beam"],"10":["guardian"],"15":["gatling"],"20":["desperado"],"25":["firedrake"],"30":["stormy_weather"]}
$$ WHERE id = 'neon_samurai';
UPDATE rival_gangs SET lineup = $$
  {"5":["sprocket","lo_beam"],"10":["mg3"],"15":["gatling","volcano"],"20":["desperado"],"25":["firedrake"],"30":["stormy_weather"]}
$$ WHERE id = 'rust_raiders';
UPDATE rival_gangs SET lineup = $$
  {"5":["lo_beam"],"10":["guardian"],"15":["volcano"],"20":["desperado"],"25":["firedrake"],"30":["stormy_weather"]}
$$ WHERE id = 'executioners';
UPDATE rival_gangs SET lineup = $$
  {"5":["sprocket"],"10":["mg3","guardian"],"15":["gatling","volcano"],"20":["omega_20"],"25":["firedrake"],"30":["stormy_weather"]}
$$ WHERE id = 'highway_apostles';

-- Trigger: keep gangs.treasury in sync with players.money so existing money-update
-- paths automatically credit/debit the gang. One-way for Phase 3; later phases will
-- retire players.money entirely and move the source of truth to gangs.treasury.
CREATE OR REPLACE FUNCTION sync_gang_treasury() RETURNS TRIGGER AS $$
BEGIN
  UPDATE gangs SET treasury = NEW.money WHERE owner_player_id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_sync_gang_treasury ON players;
CREATE TRIGGER trg_sync_gang_treasury
AFTER UPDATE OF money ON players
FOR EACH ROW
WHEN (OLD.money IS DISTINCT FROM NEW.money)
EXECUTE FUNCTION sync_gang_treasury();

-- Same for reputation
CREATE OR REPLACE FUNCTION sync_gang_reputation() RETURNS TRIGGER AS $$
BEGIN
  UPDATE gangs SET reputation = NEW.reputation WHERE owner_player_id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_sync_gang_reputation ON players;
CREATE TRIGGER trg_sync_gang_reputation
AFTER UPDATE OF reputation ON players
FOR EACH ROW
WHEN (OLD.reputation IS DISTINCT FROM NEW.reputation)
EXECUTE FUNCTION sync_gang_reputation();

-- Stock vehicles — pre-designed blueprints from published AADA Vehicle Guides.
-- Players purchase instances of these; the purchase copies `loadout` into a new
-- row in `vehicles` and debits the treasury. Rivals may also field stock designs.
CREATE TABLE IF NOT EXISTS stock_vehicles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  division INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  loadout JSONB NOT NULL,
  cost INTEGER NOT NULL,
  weight INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'aada_v3'
);
CREATE INDEX IF NOT EXISTS idx_stock_vehicles_division ON stock_vehicles(division);

-- Seed 10 hand-curated vehicles inspired by AADA Vehicle Guide Vol 3. Loadouts
-- map AADA stats onto our Compendium catalog (body/plant/tires/etc. IDs match
-- server/src/rules/data/*). ON CONFLICT DO NOTHING keeps existing rows.
INSERT INTO stock_vehicles (id, name, division, description, loadout, cost, weight, source) VALUES
  ('sprocket', 'Sprocket', 5,
   'Vanilla workhorse: load up the Vulcan and take on all comers. Poor handling, solid firepower.',
   $${"bodyType":"compact","chassisType":"light","suspensionType":"light","powerPlantType":"elec_medium","tireType":"heavy_duty","armorType":"ablative","armor":{"front":20,"back":16,"left":12,"right":12,"top":4,"underbody":4},"mounts":[{"id":"m0","arc":"front","weaponId":"vmg","ammo":20}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":4994,"chassisId":"mid","engineId":"medium","suspensionId":"light"}$$,
   4994, 3118, 'aada_v3'),

  ('lo_beam', 'Lo-Beam', 5,
   'Subcompact laser platform. Pop the LL out when you move up divisions.',
   $${"bodyType":"subcompact","chassisType":"heavy","suspensionType":"light","powerPlantType":"elec_small","tireType":"standard","armorType":"ablative","armor":{"front":20,"back":16,"left":15,"right":15,"top":4,"underbody":4},"mounts":[{"id":"m0","arc":"front","weaponId":"ll","ammo":0}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":4994,"chassisId":"mid","engineId":"small","suspensionId":"light"}$$,
   4994, 2340, 'aada_v3'),

  ('mg3', 'MG3', 10,
   'Triple-MG deterrent. Front, left and right guns put out constant area fire.',
   $${"bodyType":"mid_sized","chassisType":"standard","suspensionType":"standard","powerPlantType":"elec_medium","tireType":"puncture_resistant","armorType":"ablative","armor":{"front":25,"back":20,"left":15,"right":15,"top":5,"underbody":5},"mounts":[{"id":"m0","arc":"front","weaponId":"mg","ammo":20},{"id":"m1","arc":"left","weaponId":"mg","ammo":20},{"id":"m2","arc":"right","weaponId":"mg","ammo":20}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":9850,"chassisId":"mid","engineId":"medium","suspensionId":"standard"}$$,
   9850, 4100, 'aada_v3'),

  ('guardian', 'Guardian', 10,
   'Defensive pillar: heavy frame, turreted light laser, recoilless rifle up front.',
   $${"bodyType":"compact","chassisType":"heavy","suspensionType":"heavy","powerPlantType":"elec_medium","tireType":"puncture_resistant","armorType":"ablative","armor":{"front":30,"back":25,"left":20,"right":20,"top":6,"underbody":6},"mounts":[{"id":"m0","arc":"front","weaponId":"rr","ammo":10},{"id":"m1","arc":"turret","turretSize":"standard","weaponId":"ll","ammo":0}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":9960,"chassisId":"mid","engineId":"medium","suspensionId":"heavy"}$$,
   9960, 4050, 'aada_v3'),

  ('gatling', 'Gatling', 15,
   'Mid-sized gun platform: vulcan up front, standard MG covering the rear.',
   $${"bodyType":"mid_sized","chassisType":"standard","suspensionType":"standard","powerPlantType":"elec_large","tireType":"puncture_resistant","armorType":"ablative","armor":{"front":30,"back":25,"left":20,"right":20,"top":6,"underbody":6},"mounts":[{"id":"m0","arc":"front","weaponId":"vmg","ammo":20},{"id":"m1","arc":"back","weaponId":"mg","ammo":20}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":14820,"chassisId":"mid","engineId":"large","suspensionId":"standard"}$$,
   14820, 4800, 'aada_v3'),

  ('volcano', 'Volcano', 15,
   'Rocket saturation — 2 heavy rockets front, 1 heavy rocket back. Makes noise.',
   $${"bodyType":"sedan","chassisType":"standard","suspensionType":"improved","powerPlantType":"elec_large","tireType":"puncture_resistant","armorType":"ablative","armor":{"front":25,"back":25,"left":20,"right":20,"top":6,"underbody":6},"mounts":[{"id":"m0","arc":"front","weaponId":"hr","ammo":1},{"id":"m1","arc":"front","weaponId":"hr","ammo":1},{"id":"m2","arc":"back","weaponId":"hr","ammo":1}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":14980,"chassisId":"mid","engineId":"large","suspensionId":"improved"}$$,
   14980, 5000, 'aada_v3'),

  ('desperado', 'Desperado', 20,
   'Turreted heavy laser, MG front, oil jet back — a flexible all-rounder.',
   $${"bodyType":"sedan","chassisType":"heavy","suspensionType":"heavy","powerPlantType":"elec_large","tireType":"puncture_resistant","armorType":"ablative","armor":{"front":30,"back":25,"left":25,"right":25,"top":7,"underbody":7},"mounts":[{"id":"m0","arc":"front","weaponId":"mg","ammo":20},{"id":"m1","arc":"back","weaponId":"oj","ammo":5},{"id":"m2","arc":"turret","turretSize":"heavy","weaponId":"hl","ammo":0}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":19950,"chassisId":"mid","engineId":"large","suspensionId":"heavy"}$$,
   19950, 5600, 'aada_v3'),

  ('omega_20', 'Omega-20', 20,
   'Sabre Motors ram car. Heavy armor, autocannon front, built to bury opponents.',
   $${"bodyType":"compact","chassisType":"extra_heavy","suspensionType":"improved","powerPlantType":"elec_large","tireType":"puncture_resistant","armorType":"metal","hasRamplate":true,"armor":{"front":40,"back":25,"left":25,"right":25,"top":6,"underbody":6},"mounts":[{"id":"m0","arc":"front","weaponId":"ac","ammo":10}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":19920,"chassisId":"mid","engineId":"large","suspensionId":"improved"}$$,
   19920, 5700, 'aada_v3'),

  ('firedrake', 'Firedrake', 25,
   'Medium laser turret paired with a flamer front — denies close approaches.',
   $${"bodyType":"sedan","chassisType":"heavy","suspensionType":"heavy","powerPlantType":"elec_super","tireType":"puncture_resistant","armorType":"fireproof","armor":{"front":35,"back":30,"left":30,"right":30,"top":8,"underbody":8},"mounts":[{"id":"m0","arc":"front","weaponId":"ft","ammo":20},{"id":"m1","arc":"turret","turretSize":"standard","weaponId":"ml","ammo":0}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":24870,"chassisId":"mid","engineId":"super","suspensionId":"heavy"}$$,
   24870, 6400, 'aada_v3'),

  ('stormy_weather', 'Stormy Weather', 30,
   'Luxury cruiser: heavy laser front, side MGs, oil slick tail.',
   $${"bodyType":"luxury","chassisType":"heavy","suspensionType":"heavy","powerPlantType":"elec_super","tireType":"puncture_resistant","armorType":"ablative","armor":{"front":40,"back":30,"left":30,"right":30,"top":9,"underbody":9},"mounts":[{"id":"m0","arc":"front","weaponId":"hl","ammo":0},{"id":"m1","arc":"left","weaponId":"mg","ammo":20},{"id":"m2","arc":"right","weaponId":"mg","ammo":20},{"id":"m3","arc":"back","weaponId":"oj","ammo":5}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":29940,"chassisId":"mid","engineId":"super","suspensionId":"heavy"}$$,
   29940, 7000, 'aada_v3')
ON CONFLICT (id) DO NOTHING;

-- Indexes for frequent foreign key lookups
CREATE INDEX IF NOT EXISTS idx_vehicles_player_id ON vehicles(player_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_gang_id ON vehicles(gang_id);
CREATE INDEX IF NOT EXISTS idx_drivers_player_id ON drivers(player_id);
CREATE INDEX IF NOT EXISTS idx_drivers_gang_id ON drivers(gang_id);
CREATE INDEX IF NOT EXISTS idx_drivers_assigned_vehicle_id ON drivers(assigned_vehicle_id);
CREATE INDEX IF NOT EXISTS idx_event_history_player_id ON event_history(player_id);
CREATE INDEX IF NOT EXISTS idx_gangs_owner_player_id ON gangs(owner_player_id);
