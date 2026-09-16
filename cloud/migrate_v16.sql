-- v16 — where a lead's category came from.
--
-- Categories set by a person, or carried in from the master sheets, are the
-- authoritative ones. Deriving a niche from an Instagram bio is useful but
-- measurably less reliable: validated against the 7,632 leads a human had
-- already categorised, the deriver agreed exactly 32% of the time, or 74% once
-- SMM / Agency / Business & Marketing / Online Money Making are treated as one
-- family (they are the same kind of business described in different words).
-- It produces nothing at all for 42%.
--
-- So derived values are marked. That keeps three things possible:
--   * telling at a glance whether a category was chosen or inferred
--   * re-deriving after the keywords improve, without touching manual ones
--   * undoing the whole backfill by deleting only rows marked 'bio'
--
-- Values: '' (pre-existing / unknown provenance), 'manual' (set in the app),
-- 'bio' (inferred from the Instagram bio).
ALTER TABLE entries ADD COLUMN category_src TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_entries_category_src ON entries (category_src);
