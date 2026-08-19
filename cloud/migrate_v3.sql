-- v3: unify master reference into the leads table.
-- source = 'added' (teammate added via the platform) | 'master' (imported sheet).
ALTER TABLE entries ADD COLUMN source TEXT NOT NULL DEFAULT 'added';
CREATE INDEX IF NOT EXISTS idx_entries_source ON entries (source);
