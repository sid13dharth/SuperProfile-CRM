-- v5: linked video records (many per lead). Closed/Failed/All-Leads detail fields
-- reuse the existing stage_data JSON on entries, so no entries migration is needed.
CREATE TABLE IF NOT EXISTS videos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id    INTEGER NOT NULL DEFAULT 0,   -- links to entries.id
    handle      TEXT NOT NULL DEFAULT '',     -- denormalised lead handle for display
    url         TEXT NOT NULL DEFAULT '',
    date_posted TEXT NOT NULL DEFAULT '',
    country     TEXT NOT NULL DEFAULT '',
    language    TEXT NOT NULL DEFAULT '',
    video_type  TEXT NOT NULL DEFAULT '',
    budget      TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    created_by  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_videos_entry ON videos (entry_id);
CREATE INDEX IF NOT EXISTS idx_videos_created ON videos (created_at);
