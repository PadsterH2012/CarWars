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
  defeat_lines JSONB NOT NULL DEFAULT '[]'    -- shown when player beats the rival
);

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

-- Indexes for frequent foreign key lookups
CREATE INDEX IF NOT EXISTS idx_vehicles_player_id ON vehicles(player_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_gang_id ON vehicles(gang_id);
CREATE INDEX IF NOT EXISTS idx_drivers_player_id ON drivers(player_id);
CREATE INDEX IF NOT EXISTS idx_drivers_gang_id ON drivers(gang_id);
CREATE INDEX IF NOT EXISTS idx_drivers_assigned_vehicle_id ON drivers(assigned_vehicle_id);
CREATE INDEX IF NOT EXISTS idx_event_history_player_id ON event_history(player_id);
CREATE INDEX IF NOT EXISTS idx_gangs_owner_player_id ON gangs(owner_player_id);
