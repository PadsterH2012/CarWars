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
