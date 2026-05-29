CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  money INTEGER NOT NULL DEFAULT 25000,
  division INTEGER NOT NULL DEFAULT 5,
  reputation INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  kills INTEGER NOT NULL DEFAULT 0,
  arena_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- selected_vehicle_id / selected_driver_id reference rows in tables that are
-- declared below this point — column-level FK constraints can't reference a
-- table that doesn't exist yet, so they're added by ALTER TABLE further down
-- the file. The ALTER TABLE block at the bottom also covers existing DBs.

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

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='drivers' AND column_name='wounded') THEN
    ALTER TABLE drivers ADD COLUMN wounded BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='drivers' AND column_name='wounded_until') THEN
    ALTER TABLE drivers ADD COLUMN wounded_until TIMESTAMPTZ;
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
  {"5":["sprocket","santa_cruz","omega_5"],"10":["mg3","guardian","boomer","matilda"],"15":["gatling","army_surplus","cyclops"],"20":["omega_20","desperado","army_surplus","jackhammer"],"25":["firedrake","tankbuster","omega_25"],"30":["stormy_weather"],"40":["kali","skylark","beamer"]}
$$ WHERE id = 'iron_wolves';
UPDATE rival_gangs SET lineup = $$
  {"5":["lo_beam","speedball","slingshot"],"10":["guardian","cheetah","desert_wind"],"15":["gatling","slayer"],"20":["desperado","slayer"],"25":["firedrake","sensei","twin_25","hades_mk3"],"30":["stormy_weather"],"40":["skylark","kali","beamer"]}
$$ WHERE id = 'neon_samurai';
UPDATE rival_gangs SET lineup = $$
  {"5":["sprocket","lo_beam","speedball","santa_cruz","zipper","rock_lobster"],"10":["mg3","boomer","bubba","granite"],"15":["gatling","volcano","army_surplus"],"20":["desperado","army_surplus","holdout","incinerator_mk2"],"25":["firedrake","getaway"],"30":["stormy_weather"],"40":["kali"]}
$$ WHERE id = 'rust_raiders';
UPDATE rival_gangs SET lineup = $$
  {"5":["lo_beam","fire_imp","platypus"],"10":["guardian","cheetah","desert_wind","overkill"],"15":["volcano","cyclops"],"20":["desperado","slayer","holdout"],"25":["firedrake","sensei","tankbuster","twin_25"],"30":["stormy_weather"],"40":["skylark","kali","beamer"]}
$$ WHERE id = 'executioners';
UPDATE rival_gangs SET lineup = $$
  {"5":["sprocket","tri_rock","omega_5","flare","riotmaster"],"10":["mg3","guardian","boomer","omega_10","the_hatchet","matilda"],"15":["gatling","volcano","omega_15","pop_cart"],"20":["omega_20","army_surplus","omega_20r","flashcube"],"25":["firedrake","omega_25"],"30":["stormy_weather"],"40":["omega_40","skylark"]}
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
   $${"bodyType":"sedan","chassisType":"heavy","suspensionType":"heavy","powerPlantType":"elec_large","tireType":"puncture_resistant","armorType":"ablative","armor":{"front":30,"back":25,"left":25,"right":25,"top":7,"underbody":7},"mounts":[{"id":"m0","arc":"front","weaponId":"mg","ammo":20},{"id":"m1","arc":"back","weaponId":"oj","ammo":5},{"id":"m2","arc":"turret","turretSize":"standard","weaponId":"hl","ammo":0}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":19950,"chassisId":"mid","engineId":"large","suspensionId":"heavy"}$$,
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
   29940, 7000, 'aada_v3'),

  -- Phase 4 batch 1: 10 additional AADA Vol 3 designs (cycles, trikes, a
  -- Div 10 blast cannon, a Div 10 racer, Div 20 armoured brute, and three
  -- Div 40 heavies).
  ('speedball', 'Speedball', 5,
   'Offence-minded med cycle: linked front MGs and a 112 mph top speed.',
   $${"bodyType":"med_cycle","chassisType":"standard","suspensionType":"light","powerPlantType":"cyc_elec_small","tireType":"standard","armorType":"ablative","armor":{"front":13,"back":12,"left":0,"right":0},"mounts":[{"id":"m0","arc":"front","weaponId":"mg","ammo":20},{"id":"m1","arc":"front","weaponId":"mg","ammo":20}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false}],"totalCost":4991,"chassisId":"mid","engineId":"small","suspensionId":"light"}$$,
   4991, 1097, 'aada_v3'),

  ('fire_imp', 'Fire Imp', 5,
   'Shogun Cycles gas burner with a rear-facing light flamer and fireproof armour.',
   $${"bodyType":"hvy_cycle","chassisType":"standard","suspensionType":"heavy","powerPlantType":"cyc_gas_small","tireType":"heavy_duty","armorType":"fireproof","armor":{"front":21,"back":20,"left":0,"right":0},"mounts":[{"id":"m0","arc":"back","weaponId":"lft","ammo":8}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false}],"totalCost":4883,"chassisId":"mid","engineId":"small","suspensionId":"heavy"}$$,
   4883, 1088, 'aada_v3'),

  ('tri_rock', 'Tri-Rock', 5,
   'Sloped-armour light trike with 2 micromissile launchers right + a medium rocket back.',
   $${"bodyType":"trike","chassisType":"standard","suspensionType":"improved","powerPlantType":"cyc_elec_medium","tireType":"heavy_duty","armorType":"ablative","armor":{"front":17,"back":17,"left":6,"right":25},"mounts":[{"id":"m0","arc":"right","weaponId":"mml","ammo":5},{"id":"m1","arc":"right","weaponId":"mml","ammo":5},{"id":"m2","arc":"back","weaponId":"mr","ammo":1}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false}],"totalCost":4880,"chassisId":"mid","engineId":"medium","suspensionId":"improved"}$$,
   4880, 2345, 'aada_v3'),

  ('santa_cruz', 'Santa Cruz', 5,
   'No-frills Crane Industries combat cycle: MG front, minedropper tail, PR tires.',
   $${"bodyType":"hvy_cycle","chassisType":"heavy","suspensionType":"heavy","powerPlantType":"cyc_elec_large","tireType":"puncture_resistant","armorType":"ablative","armor":{"front":15,"back":14,"left":0,"right":0},"mounts":[{"id":"m0","arc":"front","weaponId":"mg","ammo":20},{"id":"m1","arc":"back","weaponId":"sd","ammo":10}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false}],"totalCost":5948,"chassisId":"mid","engineId":"large","suspensionId":"heavy"}$$,
   5948, 1299, 'aada_v3'),

  ('boomer', 'Boomer', 10,
   'Hendricks Blast Cannon up front with a bumper-trigger surprise for rammers.',
   $${"bodyType":"mid_sized","chassisType":"light","suspensionType":"light","powerPlantType":"elec_medium","tireType":"heavy_duty","armorType":"ablative","armor":{"front":26,"back":25,"left":20,"right":20,"top":5,"underbody":10},"mounts":[{"id":"m0","arc":"front","weaponId":"bc","ammo":8}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":9990,"chassisId":"mid","engineId":"medium","suspensionId":"light"}$$,
   9990, 4210, 'aada_v3'),

  ('cheetah', 'Cheetah', 10,
   'Light-frame sedan racer: sport power plant, PR tires, single MG front.',
   $${"bodyType":"sedan","chassisType":"light","suspensionType":"improved","powerPlantType":"elec_sport","tireType":"puncture_resistant","armorType":"ablative","armor":{"front":18,"back":18,"left":14,"right":14,"top":5,"underbody":5},"mounts":[{"id":"m0","arc":"front","weaponId":"mg","ammo":20}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":9880,"chassisId":"mid","engineId":"super","suspensionId":"improved"}$$,
   9880, 3800, 'aada_v3'),

  ('army_surplus', 'Army Surplus', 20,
   'Armoured-personnel-carrier mid-size: linked RRs front, spikedropper back, heavy plating.',
   $${"bodyType":"mid_sized","chassisType":"heavy","suspensionType":"heavy","powerPlantType":"elec_large","tireType":"puncture_resistant","armorType":"ablative","armor":{"front":45,"back":34,"left":35,"right":35,"top":10,"underbody":11},"mounts":[{"id":"m0","arc":"front","weaponId":"rr","ammo":10},{"id":"m1","arc":"front","weaponId":"rr","ammo":10},{"id":"m2","arc":"back","weaponId":"sd","ammo":10}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":19950,"chassisId":"mid","engineId":"large","suspensionId":"heavy"}$$,
   19950, 5276, 'aada_v3'),

  ('kali', 'Kali', 40,
   'Multi-armed Imperial luxury: 2 ATGs front + MML back + 2 HRs + heavy armour.',
   $${"bodyType":"luxury","chassisType":"extra_heavy","suspensionType":"heavy","powerPlantType":"gas_300","tireType":"plasticore","armorType":"ablative","armor":{"front":40,"back":30,"left":28,"right":28,"top":8,"underbody":12},"mounts":[{"id":"m0","arc":"front","weaponId":"atg","ammo":10},{"id":"m1","arc":"front","weaponId":"atg","ammo":10},{"id":"m2","arc":"back","weaponId":"mml","ammo":5},{"id":"m3","arc":"right","weaponId":"hr","ammo":1},{"id":"m4","arc":"left","weaponId":"hr","ammo":1}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":39237,"chassisId":"mid","engineId":"super","suspensionId":"heavy"}$$,
   39237, 6531, 'aada_v3'),

  ('omega_40', 'Omega-40', 40,
   'Sabre Motors ramplate cruiser: fireproof sedan with rocket launcher front + oil back.',
   $${"bodyType":"sedan","chassisType":"extra_heavy","suspensionType":"heavy","powerPlantType":"gas_300","tireType":"puncture_resistant","armorType":"fireproof","hasRamplate":true,"armor":{"front":60,"back":60,"left":55,"right":55,"top":25,"underbody":25},"mounts":[{"id":"m0","arc":"front","weaponId":"rl","ammo":5},{"id":"m1","arc":"back","weaponId":"oj","ammo":5}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":39770,"chassisId":"mid","engineId":"super","suspensionId":"heavy"}$$,
   39770, 6120, 'aada_v3'),

  ('skylark', 'Skylark', 40,
   'Turreted heavy laser + 2 linked heavy rockets up front. Heavy armour all around.',
   $${"bodyType":"luxury","chassisType":"extra_heavy","suspensionType":"heavy","powerPlantType":"gas_200","tireType":"solid","armorType":"ablative","hasRamplate":true,"armor":{"front":50,"back":45,"left":40,"right":40,"top":15,"underbody":15},"mounts":[{"id":"m0","arc":"front","weaponId":"hr","ammo":1},{"id":"m1","arc":"front","weaponId":"hr","ammo":1},{"id":"m2","arc":"turret","turretSize":"standard","weaponId":"hl","ammo":0}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":39655,"chassisId":"mid","engineId":"large","suspensionId":"heavy"}$$,
   39655, 6560, 'aada_v3'),

  -- Phase 5 batch: ~30 more AADA Vol 3 designs read directly from the PDF
  -- via vision (much more accurate than pdftotext). Some weapons are mapped
  -- pragmatically — book uses FCD/MD/OG/SG/PDG/VFRP/FG/HDSS/HDFOJ/SS/icD/XL/
  -- TwL which we collapse to oj / sd / gl / rl / mg / ll / hl / fr equivalents.

  ('omega_5', 'Omega-5', 5,
   'Sabre Motors ramplate ram-car. Heavy armour up front, no actual weapons — just bury opponents.',
   $${"bodyType":"subcompact","chassisType":"extra_heavy","suspensionType":"improved","powerPlantType":"elec_medium","tireType":"puncture_resistant","armorType":"ablative","hasRamplate":true,"armor":{"front":30,"back":19,"left":15,"right":15,"top":6,"underbody":6},"mounts":[],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":4926,"chassisId":"mid","engineId":"medium","suspensionId":"improved"}$$,
   4926, 2760, 'aada_v3'),

  ('platypus', 'Platypus', 5,
   'Defensive compact: 2 light rockets front, MR back, spikedroppers each side.',
   $${"bodyType":"compact","chassisType":"standard","suspensionType":"light","powerPlantType":"elec_medium","tireType":"heavy_duty","armorType":"ablative","armor":{"front":25,"back":19,"left":17,"right":17,"top":6,"underbody":6},"mounts":[{"id":"m0","arc":"front","weaponId":"ltr","ammo":1},{"id":"m1","arc":"front","weaponId":"ltr","ammo":1},{"id":"m2","arc":"back","weaponId":"mr","ammo":1},{"id":"m3","arc":"left","weaponId":"sd","ammo":10},{"id":"m4","arc":"right","weaponId":"sd","ammo":10}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":4995,"chassisId":"mid","engineId":"medium","suspensionId":"light"}$$,
   4995, 3430, 'aada_v3'),

  ('rock_lobster', 'Rock Lobster', 5,
   'Subcompact gasburner: 2 light rockets + grenade launcher loaded with explosives.',
   $${"bodyType":"subcompact","chassisType":"standard","suspensionType":"improved","powerPlantType":"gas_150","tireType":"heavy_duty","armorType":"ablative","armor":{"front":20,"back":19,"left":13,"right":13,"top":3,"underbody":5},"mounts":[{"id":"m0","arc":"left","weaponId":"ltr","ammo":1},{"id":"m1","arc":"right","weaponId":"ltr","ammo":1},{"id":"m2","arc":"front","weaponId":"gl","ammo":9}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":4966,"chassisId":"mid","engineId":"small","suspensionId":"improved"}$$,
   4966, 2099, 'aada_v3'),

  ('zipper', 'Zipper', 5,
   'CA-frame teenager-mobile: front MG plus decoy "fakes" (silly intimidation).',
   $${"bodyType":"subcompact","chassisType":"standard","suspensionType":"light","powerPlantType":"elec_small","tireType":"heavy_duty","armorType":"ablative","armor":{"front":25,"back":17,"left":15,"right":15,"top":5,"underbody":10},"mounts":[{"id":"m0","arc":"front","weaponId":"mg","ammo":20}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":4987,"chassisId":"mid","engineId":"small","suspensionId":"light"}$$,
   4987, 2050, 'aada_v3'),

  ('slingshot', 'Slingshot', 5,
   'Imperial Motors med cycle with HESH-loaded RR up front.',
   $${"bodyType":"med_cycle","chassisType":"standard","suspensionType":"improved","powerPlantType":"cyc_elec_small","tireType":"standard","armorType":"ablative","armor":{"front":12,"back":11,"left":0,"right":0},"mounts":[{"id":"m0","arc":"front","weaponId":"rr","ammo":8}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false}],"totalCost":4922,"chassisId":"mid","engineId":"small","suspensionId":"improved"}$$,
   4922, 1100, 'aada_v3'),

  ('flare', 'Flare', 5,
   'Imperial trike: 2 light flamers per side + oil jet rear.',
   $${"bodyType":"trike","chassisType":"standard","suspensionType":"light","powerPlantType":"cyc_gas_small","tireType":"heavy_duty","armorType":"ablative","armor":{"front":20,"back":15,"left":25,"right":25},"mounts":[{"id":"m0","arc":"right","weaponId":"lft","ammo":10},{"id":"m1","arc":"left","weaponId":"lft","ammo":10},{"id":"m2","arc":"back","weaponId":"oj","ammo":5}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false}],"totalCost":4998,"chassisId":"mid","engineId":"small","suspensionId":"light"}$$,
   4998, 2093, 'aada_v3'),

  ('riotmaster', 'Riotmaster', 5,
   'Heavy cycle for crowd-control: flechette guns front and back.',
   $${"bodyType":"hvy_cycle","chassisType":"standard","suspensionType":"light","powerPlantType":"cyc_gas_small","tireType":"heavy_duty","armorType":"ablative","armor":{"front":18,"back":17,"left":0,"right":0},"mounts":[{"id":"m0","arc":"front","weaponId":"mg","ammo":20},{"id":"m1","arc":"back","weaponId":"mg","ammo":20}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false}],"totalCost":4993,"chassisId":"mid","engineId":"small","suspensionId":"light"}$$,
   4993, 1289, 'aada_v3'),

  ('overkill', 'Overkill', 10,
   'Heavy trike with ATG side-mounted (book has 2 ATGs but our trike chassis only fits 1).',
   $${"bodyType":"trike","chassisType":"standard","suspensionType":"light","powerPlantType":"cyc_gas_large","tireType":"standard","armorType":"ablative","armor":{"front":20,"back":17,"left":19,"right":19},"mounts":[{"id":"m0","arc":"right","weaponId":"atg","ammo":7}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false}],"totalCost":9995,"chassisId":"mid","engineId":"medium","suspensionId":"light"}$$,
   9995, 2715, 'aada_v3'),

  ('omega_10', 'Omega-10', 10,
   'Sabre ramplate trike: RR front + spikedropper back (2 linked RRs in book trimmed for fit).',
   $${"bodyType":"trike","chassisType":"standard","suspensionType":"light","powerPlantType":"cyc_elec_large","tireType":"puncture_resistant","armorType":"ablative","hasRamplate":true,"armor":{"front":30,"back":25,"left":20,"right":20},"mounts":[{"id":"m0","arc":"front","weaponId":"rr","ammo":10},{"id":"m1","arc":"back","weaponId":"sd","ammo":10}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false}],"totalCost":9874,"chassisId":"mid","engineId":"large","suspensionId":"light"}$$,
   9874, 2797, 'aada_v3'),

  ('desert_wind', 'Desert Wind', 10,
   'X-Hvy subcompact, ML front, oil jet (book has 2 FCDs trimmed to 1 oj for fit).',
   $${"bodyType":"subcompact","chassisType":"extra_heavy","suspensionType":"heavy","powerPlantType":"elec_small","tireType":"puncture_resistant","armorType":"ablative","armor":{"front":30,"back":20,"left":20,"right":20,"top":6,"underbody":9},"mounts":[{"id":"m0","arc":"front","weaponId":"ml","ammo":0},{"id":"m1","arc":"right","weaponId":"oj","ammo":5}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":9938,"chassisId":"mid","engineId":"small","suspensionId":"heavy"}$$,
   9938, 2760, 'aada_v3'),

  ('granite', 'Granite', 10,
   'Heavy cycle with variable-fire rocket pod (mapped to RL).',
   $${"bodyType":"hvy_cycle","chassisType":"standard","suspensionType":"improved","powerPlantType":"cyc_gas_small","tireType":"heavy_duty","armorType":"ablative","armor":{"front":18,"back":17,"left":0,"right":0},"mounts":[{"id":"m0","arc":"front","weaponId":"rl","ammo":5}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false}],"totalCost":9689,"chassisId":"mid","engineId":"small","suspensionId":"improved"}$$,
   9689, 1295, 'aada_v3'),

  ('the_hatchet', 'The Hatchet', 10,
   'Lightweight trike racer: 2 MMLs (1L/1R), top speed 120.',
   $${"bodyType":"trike","chassisType":"standard","suspensionType":"heavy","powerPlantType":"cyc_gas_large","tireType":"heavy_duty","armorType":"ablative","armor":{"front":22,"back":17,"left":18,"right":18},"mounts":[{"id":"m0","arc":"left","weaponId":"mml","ammo":5},{"id":"m1","arc":"right","weaponId":"mml","ammo":5}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false}],"totalCost":9596,"chassisId":"mid","engineId":"medium","suspensionId":"heavy"}$$,
   9596, 1600, 'aada_v3'),

  ('matilda', 'Matilda', 10,
   'Aussie ramplate trike: RR front + spikedropper back (book has 2 RRs trimmed for fit).',
   $${"bodyType":"trike","chassisType":"standard","suspensionType":"light","powerPlantType":"cyc_elec_large","tireType":"puncture_resistant","armorType":"ablative","hasRamplate":true,"armor":{"front":20,"back":20,"left":20,"right":20},"mounts":[{"id":"m0","arc":"front","weaponId":"rr","ammo":10},{"id":"m1","arc":"back","weaponId":"sd","ammo":8}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false}],"totalCost":10000,"chassisId":"mid","engineId":"large","suspensionId":"light"}$$,
   10000, 2640, 'aada_v3'),

  ('dragon_10', 'Dragon-10', 10,
   'Compact w/ turreted light flamer (book has additional FCD/FOJ trimmed for fit).',
   $${"bodyType":"compact","chassisType":"heavy","suspensionType":"heavy","powerPlantType":"elec_super","tireType":"puncture_resistant","armorType":"ablative","armor":{"front":35,"back":25,"left":20,"right":20,"top":20,"underbody":7},"mounts":[{"id":"m0","arc":"turret","turretSize":"standard","weaponId":"lft","ammo":10}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":9991,"chassisId":"mid","engineId":"super","suspensionId":"heavy"}$$,
   9991, 4067, 'aada_v3'),

  ('bubba', 'Bubba', 10,
   'Heavy cycle with HESH-loaded blast cannon. Five rounds, all hate.',
   $${"bodyType":"hvy_cycle","chassisType":"standard","suspensionType":"light","powerPlantType":"cyc_gas_small","tireType":"standard","armorType":"ablative","armor":{"front":20,"back":17,"left":0,"right":0},"mounts":[{"id":"m0","arc":"front","weaponId":"bc","ammo":5}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false}],"totalCost":9692,"chassisId":"mid","engineId":"small","suspensionId":"light"}$$,
   9692, 1299, 'aada_v3'),

  ('cyclops', 'Cyclops', 15,
   'Heavy cycle with ATG up front (HESH ammo).',
   $${"bodyType":"hvy_cycle","chassisType":"standard","suspensionType":"heavy","powerPlantType":"cyc_gas_small","tireType":"solid","armorType":"ablative","armor":{"front":14,"back":14,"left":0,"right":0},"mounts":[{"id":"m0","arc":"front","weaponId":"atg","ammo":8}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false}],"totalCost":14902,"chassisId":"mid","engineId":"small","suspensionId":"heavy"}$$,
   14902, 1300, 'aada_v3'),

  ('omega_15', 'Omega-15', 15,
   'Sabre ramplate compact: oil jet rear, 250+ points sloped armour.',
   $${"bodyType":"compact","chassisType":"heavy","suspensionType":"heavy","powerPlantType":"gas_300","tireType":"puncture_resistant","armorType":"ablative","hasRamplate":true,"armor":{"front":50,"back":50,"left":50,"right":50,"top":25,"underbody":30},"mounts":[{"id":"m0","arc":"back","weaponId":"oj","ammo":5}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":14405,"chassisId":"mid","engineId":"super","suspensionId":"heavy"}$$,
   14405, 4070, 'aada_v3'),

  ('pop_cart', 'Pop-Cart', 15,
   'Compact ramplate with HESH-loaded blast cannon front.',
   $${"bodyType":"compact","chassisType":"heavy","suspensionType":"heavy","powerPlantType":"gas_150","tireType":"puncture_resistant","armorType":"ablative","hasRamplate":true,"armor":{"front":50,"back":45,"left":50,"right":50,"top":20,"underbody":20},"mounts":[{"id":"m0","arc":"front","weaponId":"bc","ammo":8}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":14980,"chassisId":"mid","engineId":"medium","suspensionId":"heavy"}$$,
   14980, 4070, 'aada_v3'),

  ('holdout', 'Holdout', 20,
   'Mid-size with turreted twin-laser + a medium rocket through a blow-thru port.',
   $${"bodyType":"mid_sized","chassisType":"heavy","suspensionType":"heavy","powerPlantType":"elec_large","tireType":"puncture_resistant","armorType":"ablative","armor":{"front":40,"back":33,"left":33,"right":33,"top":10,"underbody":10},"mounts":[{"id":"m0","arc":"turret","turretSize":"standard","weaponId":"ll","ammo":0},{"id":"m1","arc":"turret","turretSize":"standard","weaponId":"ll","ammo":0},{"id":"m2","arc":"back","weaponId":"mr","ammo":1}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":19994,"chassisId":"mid","engineId":"large","suspensionId":"heavy"}$$,
   19994, 5217, 'aada_v3'),

  ('incinerator_mk2', 'Incinerator Mk. 2', 20,
   'Mid-size flame circus: 2 flamers (R/L), oil jet back, all HT-loaded.',
   $${"bodyType":"mid_sized","chassisType":"heavy","suspensionType":"heavy","powerPlantType":"gas_150","tireType":"puncture_resistant","armorType":"fireproof","armor":{"front":10,"back":10,"left":2,"right":14,"top":2,"underbody":2},"mounts":[{"id":"m0","arc":"right","weaponId":"ft","ammo":10},{"id":"m1","arc":"left","weaponId":"ft","ammo":10},{"id":"m2","arc":"back","weaponId":"oj","ammo":5}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":19930,"chassisId":"mid","engineId":"medium","suspensionId":"heavy"}$$,
   19930, 5280, 'aada_v3'),

  ('slayer', 'Slayer', 20,
   'Mid-size with X-ray laser front (mapped to heavy laser).',
   $${"bodyType":"mid_sized","chassisType":"standard","suspensionType":"light","powerPlantType":"elec_medium","tireType":"standard","armorType":"ablative","armor":{"front":25,"back":25,"left":25,"right":25,"top":10,"underbody":10},"mounts":[{"id":"m0","arc":"front","weaponId":"hl","ammo":0}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":20000,"chassisId":"mid","engineId":"medium","suspensionId":"light"}$$,
   20000, 4398, 'aada_v3'),

  ('flashcube', 'Flashcube', 20,
   'Subcompact speedster: accel 15, 2 oil jets each side.',
   $${"bodyType":"subcompact","chassisType":"heavy","suspensionType":"heavy","powerPlantType":"gas_150","tireType":"solid","armorType":"ablative","armor":{"front":30,"back":28,"left":25,"right":25,"top":6,"underbody":6},"mounts":[{"id":"m0","arc":"left","weaponId":"oj","ammo":5},{"id":"m1","arc":"right","weaponId":"oj","ammo":5}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":19604,"chassisId":"mid","engineId":"medium","suspensionId":"heavy"}$$,
   19604, 2529, 'aada_v3'),

  ('omega_20r', 'Omega-20R', 20,
   'Reverse heavy trike racer with ramplate, spikedropper + oil jet back.',
   $${"bodyType":"trike","chassisType":"standard","suspensionType":"heavy","powerPlantType":"cyc_gas_large","tireType":"solid","armorType":"ablative","hasRamplate":true,"armor":{"front":50,"back":20,"left":23,"right":23},"mounts":[{"id":"m0","arc":"back","weaponId":"sd","ammo":10},{"id":"m1","arc":"back","weaponId":"oj","ammo":5}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false}],"totalCost":19985,"chassisId":"mid","engineId":"medium","suspensionId":"heavy"}$$,
   19985, 2798, 'aada_v3'),

  ('jackhammer', 'Jackhammer', 20,
   'X-Hvy trike with single blast cannon (book has 2 BCs trimmed for fit).',
   $${"bodyType":"trike","chassisType":"extra_heavy","suspensionType":"improved","powerPlantType":"cyc_gas_medium","tireType":"puncture_resistant","armorType":"ablative","armor":{"front":25,"back":20,"left":15,"right":15},"mounts":[{"id":"m0","arc":"right","weaponId":"bc","ammo":8}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false}],"totalCost":20000,"chassisId":"mid","engineId":"medium","suspensionId":"improved"}$$,
   20000, 3475, 'aada_v3'),

  ('smokin_joe', 'Smokin'' Joe', 25,
   'Sedan with HL front + heavy-duty smoke screen back.',
   $${"bodyType":"sedan","chassisType":"heavy","suspensionType":"improved","powerPlantType":"elec_large","tireType":"heavy_duty","armorType":"ablative","armor":{"front":40,"back":35,"left":30,"right":30,"top":10,"underbody":13},"mounts":[{"id":"m0","arc":"front","weaponId":"hl","ammo":0},{"id":"m1","arc":"back","weaponId":"oj","ammo":5}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":24972,"chassisId":"mid","engineId":"large","suspensionId":"improved"}$$,
   24972, 5606, 'aada_v3'),

  ('omega_25', 'Omega-25', 25,
   'Mid-sized ramplate cruiser with multi-arc oil jets.',
   $${"bodyType":"mid_sized","chassisType":"heavy","suspensionType":"improved","powerPlantType":"elec_sport","tireType":"solid","armorType":"ablative","hasRamplate":true,"armor":{"front":75,"back":65,"left":60,"right":60,"top":11,"underbody":12},"mounts":[{"id":"m0","arc":"left","weaponId":"oj","ammo":5},{"id":"m1","arc":"right","weaponId":"oj","ammo":5},{"id":"m2","arc":"back","weaponId":"oj","ammo":5}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":24962,"chassisId":"mid","engineId":"super","suspensionId":"improved"}$$,
   24962, 5278, 'aada_v3'),

  ('hades_mk3', 'Hades Mk. 3', 25,
   'Luxury laser-reflective mount: 3 linked VMGs front + oil back.',
   $${"bodyType":"luxury","chassisType":"extra_heavy","suspensionType":"light","powerPlantType":"gas_200","tireType":"puncture_resistant","armorType":"laser_reflective","armor":{"front":14,"back":13,"left":10,"right":10,"top":2,"underbody":2},"mounts":[{"id":"m0","arc":"front","weaponId":"vmg","ammo":20},{"id":"m1","arc":"front","weaponId":"vmg","ammo":20},{"id":"m2","arc":"front","weaponId":"vmg","ammo":20},{"id":"m3","arc":"back","weaponId":"oj","ammo":5}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":24544,"chassisId":"mid","engineId":"large","suspensionId":"light"}$$,
   24544, 6599, 'aada_v3'),

  ('getaway', 'Getaway', 25,
   'X-Hvy sedan: oil gun front + spike gun turret + flame-cloud back.',
   $${"bodyType":"sedan","chassisType":"extra_heavy","suspensionType":"heavy","powerPlantType":"elec_super","tireType":"puncture_resistant","armorType":"ablative","armor":{"front":40,"back":35,"left":35,"right":35,"top":29,"underbody":8},"mounts":[{"id":"m0","arc":"front","weaponId":"oj","ammo":5},{"id":"m1","arc":"turret","turretSize":"standard","weaponId":"sd","ammo":10},{"id":"m2","arc":"back","weaponId":"oj","ammo":5}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":24976,"chassisId":"mid","engineId":"super","suspensionId":"heavy"}$$,
   24976, 6118, 'aada_v3'),

  ('sensei', 'Sensei', 25,
   'Sedan with turreted laser + 2 linked MMLs front (AP loads).',
   $${"bodyType":"sedan","chassisType":"extra_heavy","suspensionType":"heavy","powerPlantType":"elec_large","tireType":"standard","armorType":"ablative","armor":{"front":50,"back":41,"left":47,"right":47,"top":30,"underbody":8},"mounts":[{"id":"m0","arc":"turret","turretSize":"standard","weaponId":"l","ammo":0},{"id":"m1","arc":"front","weaponId":"mml","ammo":5},{"id":"m2","arc":"front","weaponId":"mml","ammo":5}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":24492,"chassisId":"mid","engineId":"large","suspensionId":"heavy"}$$,
   24492, 5981, 'aada_v3'),

  ('tankbuster', 'Tankbuster', 25,
   'Heavy sedan with ATG (mixed HESH/APFSDS ammo) front + incendiary discharge.',
   $${"bodyType":"sedan","chassisType":"heavy","suspensionType":"heavy","powerPlantType":"elec_large","tireType":"puncture_resistant","armorType":"fireproof","armor":{"front":40,"back":35,"left":33,"right":33,"top":9,"underbody":12},"mounts":[{"id":"m0","arc":"front","weaponId":"atg","ammo":10},{"id":"m1","arc":"back","weaponId":"oj","ammo":5}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":24605,"chassisId":"mid","engineId":"large","suspensionId":"heavy"}$$,
   24605, 5610, 'aada_v3'),

  ('twin_25', 'Twin-25', 25,
   'Mid-size laser purist: 2 light lasers (TwL) front. No frills.',
   $${"bodyType":"mid_sized","chassisType":"heavy","suspensionType":"light","powerPlantType":"elec_large","tireType":"standard","armorType":"ablative","armor":{"front":34,"back":24,"left":24,"right":24,"top":6,"underbody":6},"mounts":[{"id":"m0","arc":"front","weaponId":"ll","ammo":0},{"id":"m1","arc":"front","weaponId":"ll","ammo":0}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":24996,"chassisId":"mid","engineId":"large","suspensionId":"light"}$$,
   24996, 5218, 'aada_v3'),

  ('beamer', 'Beamer', 40,
   'Luxury laser cruiser: 2 X-ray lasers (1F/1R) + 2 HRs back.',
   $${"bodyType":"luxury","chassisType":"extra_heavy","suspensionType":"light","powerPlantType":"elec_super","tireType":"heavy_duty","armorType":"ablative","armor":{"front":40,"back":30,"left":30,"right":30,"top":6,"underbody":12},"mounts":[{"id":"m0","arc":"front","weaponId":"hl","ammo":0},{"id":"m1","arc":"right","weaponId":"hl","ammo":0},{"id":"m2","arc":"back","weaponId":"hr","ammo":1},{"id":"m3","arc":"back","weaponId":"hr","ammo":1}],"tires":[{"id":"t0","blown":false},{"id":"t1","blown":false},{"id":"t2","blown":false},{"id":"t3","blown":false}],"totalCost":39960,"chassisId":"mid","engineId":"super","suspensionId":"light"}$$,
   39960, 6598, 'aada_v3')
ON CONFLICT (id) DO NOTHING;

-- Fix-up for any previously seeded desperado rows that used an invalid
-- heavy turret on a sedan chassis (sedan maxTurretSize = 'standard').
-- The INSERT above uses ON CONFLICT DO NOTHING so existing rows are
-- untouched; this UPDATE normalises them.
UPDATE stock_vehicles
SET loadout = jsonb_set(
  loadout,
  '{mounts,2,turretSize}',
  '"standard"'::jsonb,
  false
)
WHERE id = 'desperado'
  AND loadout #>> '{mounts,2,turretSize}' = 'heavy';

-- Hire-list candidates — transient pool of drivers offering their services.
-- Regenerated on demand; expired rows are ignored (pool-refresh endpoint
-- deletes them). Optional vehicle_stock_id lets a candidate bring their own
-- rig in a package deal (discount applied to the stock vehicle's base cost).
CREATE TABLE IF NOT EXISTS hire_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  skill INTEGER NOT NULL,
  aggression INTEGER NOT NULL DEFAULT 3,
  loyalty INTEGER NOT NULL DEFAULT 5,
  hire_cost INTEGER NOT NULL,
  vehicle_stock_id TEXT REFERENCES stock_vehicles(id),
  vehicle_discount_pct INTEGER NOT NULL DEFAULT 0,
  blurb TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '15 minutes'
);
CREATE INDEX IF NOT EXISTS idx_hire_candidates_player ON hire_candidates(player_id, expires_at);

-- Driver requests — drivers autonomously ask for repairs, ammo, or upgrades.
-- Player approves (fires the action + debits cost) or denies (closes +
-- loyalty ding). Requests expire after a few days so stale ones don't pile up.
CREATE TABLE IF NOT EXISTS driver_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  vehicle_id UUID REFERENCES vehicles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,             -- 'repair' | 'ammo' | 'armor_up' | 'accessory_add' | 'weapon_swap' | 'weapon_add'
  description TEXT NOT NULL,
  payload JSONB NOT NULL,
  cost INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'denied' | 'expired'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '3 days',
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_driver_requests_player_status ON driver_requests(player_id, status);
CREATE INDEX IF NOT EXISTS idx_driver_requests_driver ON driver_requests(driver_id);

-- Indexes for frequent foreign key lookups
CREATE INDEX IF NOT EXISTS idx_vehicles_player_id ON vehicles(player_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_gang_id ON vehicles(gang_id);
CREATE INDEX IF NOT EXISTS idx_drivers_player_id ON drivers(player_id);
CREATE INDEX IF NOT EXISTS idx_drivers_gang_id ON drivers(gang_id);
CREATE INDEX IF NOT EXISTS idx_drivers_assigned_vehicle_id ON drivers(assigned_vehicle_id);
CREATE INDEX IF NOT EXISTS idx_event_history_player_id ON event_history(player_id);
CREATE INDEX IF NOT EXISTS idx_gangs_owner_player_id ON gangs(owner_player_id);

-- World map: current node for each gang (added 2026-05-27 — Phase 4 travel)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='gangs' AND column_name='current_world_node_id') THEN
    ALTER TABLE gangs ADD COLUMN current_world_node_id TEXT NOT NULL DEFAULT 'midville-city'::text;
  END IF;
END $$;

-- Player profile expansion: persisted selections + stat counters
-- (added 2026-05-28 — Player Persistence Plan, task 2)
DO $$ BEGIN
  ALTER TABLE players ADD COLUMN IF NOT EXISTS selected_vehicle_id UUID REFERENCES vehicles(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE players ADD COLUMN IF NOT EXISTS selected_driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE players ADD COLUMN IF NOT EXISTS wins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS losses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS kills INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS arena_count INTEGER NOT NULL DEFAULT 0;

-- Match replays: compressed per-tick snapshots persisted on match end
-- (added 2026-05-28 — Phase 1 Duel Loop Plan, task 1)
CREATE TABLE IF NOT EXISTS match_replays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  zone_id TEXT NOT NULL,
  opponent TEXT,
  duration_ticks INTEGER NOT NULL,
  result TEXT NOT NULL,
  prize INTEGER NOT NULL DEFAULT 0,
  data JSONB NOT NULL,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_match_replays_player ON match_replays(player_id, recorded_at DESC);

-- ─── Phase 2 — Hire Driver / headless jobs (added 2026-05-29) ───────────────
-- Task 1: tiered hire pool. Candidates are drawn from rookie/standard/premium
-- bands; 'tier' groups them in the garage hire modal.
ALTER TABLE hire_candidates ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'standard';

-- Task 2: driver availability. A driver on a headless job is unavailable until
-- available_at; only available drivers can be assigned or enter the arena.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ DEFAULT NOW();

-- Task 2: headless job assignment. A job can be assigned to a driver who runs
-- it solo; it resolves (lazily, on the next API call) once resolves_at passes,
-- writing the after-action report into outcome.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS assigned_driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS resolves_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS outcome JSONB;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS headless BOOLEAN NOT NULL DEFAULT FALSE;
-- Task 3: job difficulty (1-10) drives the headless success roll. Higher = harder
-- = pays more. (Per Phase 2 HELP - job-difficulty, Option A.)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS difficulty INTEGER NOT NULL DEFAULT 3;
CREATE INDEX IF NOT EXISTS idx_jobs_assigned_driver ON jobs(assigned_driver_id);
CREATE INDEX IF NOT EXISTS idx_jobs_pending_resolution ON jobs(resolves_at) WHERE headless = TRUE AND outcome IS NULL;

-- ─── Phase 3 — Buy a Garage Bay (added 2026-05-29) ──────────────────────────
-- A permanent, one-per-player asset. Owning a garage grants a repair discount,
-- lazily-resolved passive income, and extra vehicle storage. accumulated_income
-- is a lifetime counter for the garage status screen; last_income_at marks the
-- point up to which income has already been credited (advanced in whole hours).
CREATE TABLE IF NOT EXISTS garages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE UNIQUE,
  name TEXT NOT NULL DEFAULT 'Your Garage',
  purchased_at TIMESTAMPTZ DEFAULT NOW(),
  last_income_at TIMESTAMPTZ DEFAULT NOW(),
  accumulated_income INTEGER NOT NULL DEFAULT 0,
  storage_slots INTEGER NOT NULL DEFAULT 3,
  repair_discount REAL NOT NULL DEFAULT 0.25
);
