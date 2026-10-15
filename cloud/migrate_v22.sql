-- Platforms: Instagram, YouTube, X, Skool, and any added from the UI.
--
-- Every existing lead is Instagram, which is what the DEFAULT gives them, so
-- nothing about the 24,866 rows changes. Non-Instagram leads key handle_norm as
-- "<platform>:<id>" (see src/platforms.js), which keeps the existing
-- UNIQUE(handle_norm) and makes it unique per platform without a table rebuild.
--
-- Additive only: new columns with defaults, two new tables, new indexes.
-- The previous worker ignores all of it, so applying this before deploying is
-- safe, and so is rolling the code back afterwards.

ALTER TABLE entries ADD COLUMN platform TEXT NOT NULL DEFAULT 'instagram';

-- Platform-specific data. One column per idea rather than per platform, labelled
-- per platform in the grid: "audience" is Subscribers on YouTube, Followers on
-- X and Members on Skool. Instagram keeps its own ig_* columns from HikerAPI.
ALTER TABLE entries ADD COLUMN p_display       TEXT NOT NULL DEFAULT '';  -- channel / community name
ALTER TABLE entries ADD COLUMN p_audience      INTEGER;                   -- NULL = unknown, not zero
ALTER TABLE entries ADD COLUMN p_last_activity TEXT NOT NULL DEFAULT '';  -- last upload / post
ALTER TABLE entries ADD COLUMN p_price         TEXT NOT NULL DEFAULT '';  -- Skool membership price

CREATE INDEX IF NOT EXISTS idx_entries_platform       ON entries (platform);
-- The duplicate check: the same email on more than one platform.
CREATE INDEX IF NOT EXISTS idx_entries_email_platform ON entries (email_norm, platform);

CREATE TABLE IF NOT EXISTS platforms (
  key        TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  builtin    INTEGER NOT NULL DEFAULT 0,
  sort       INTEGER NOT NULL DEFAULT 100,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO platforms (key, name, builtin, sort) VALUES
  ('instagram', 'Instagram', 1, 1),
  ('youtube',   'YouTube',   1, 2),
  ('x',         'X',         1, 3),
  ('skool',     'Skool',     1, 4);

-- Which platform each campaign is for, so a reply updates the right lead.
-- platform_src: 'name' (read from the campaign name), 'default' (no platform in
-- the name — assumed Instagram, needs confirming), 'manual' (set by a person,
-- never overwritten by detection).
ALTER TABLE campaigns ADD COLUMN platform     TEXT NOT NULL DEFAULT '';
ALTER TABLE campaigns ADD COLUMN platform_src TEXT NOT NULL DEFAULT '';
