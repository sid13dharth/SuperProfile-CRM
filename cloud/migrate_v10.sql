-- v10 — Instagram profile enrichment (HikerAPI).
-- Three lead-facing numbers the grid shows (Followers, Last posting date,
-- Avg views of the last 10 reels) plus the bookkeeping needed to fetch them
-- without burning credits: the resolved IG user id (so a refresh skips the
-- username lookup), when we last checked, and how that check went.
--
-- Nullable on purpose: NULL means "never fetched", which is different from a
-- real 0. '' on the text columns means the same.
ALTER TABLE entries ADD COLUMN ig_user_id      TEXT    NOT NULL DEFAULT '';
ALTER TABLE entries ADD COLUMN ig_followers    INTEGER;
ALTER TABLE entries ADD COLUMN ig_last_post_at TEXT    NOT NULL DEFAULT '';
ALTER TABLE entries ADD COLUMN ig_avg_views_10 INTEGER;
ALTER TABLE entries ADD COLUMN ig_reels_used   INTEGER;
ALTER TABLE entries ADD COLUMN ig_checked_at   TEXT    NOT NULL DEFAULT '';
-- '' = never checked | ok | private | notfound | error
ALTER TABLE entries ADD COLUMN ig_status       TEXT    NOT NULL DEFAULT '';

-- Drives "what still needs enriching" scans.
CREATE INDEX IF NOT EXISTS idx_entries_ig_checked ON entries (ig_checked_at);
