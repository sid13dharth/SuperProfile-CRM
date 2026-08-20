-- Lead-Gen Dedup Platform — Cloudflare D1 schema.
-- Mirrors the CRM's auth shape (users / sessions / meta) and adds the two
-- dedup stores: `entries` (live leads teammates add) and `master_usernames`
-- (the re-uploadable CSV/Excel master of usernames we already have on record).

/* ── auth (same pattern as the CRM) ─────────────────────────── */
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL DEFAULT '',
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

/* ── live entries teammates add ─────────────────────────────── */
-- handle_norm is UNIQUE: this is the DB-level guarantee that two teammates
-- adding the same Instagram username (even simultaneously) can't both slip
-- through — the second INSERT fails the unique constraint and we report the
-- first adder instead. This is the "real-time dedup across teammates" rule.
CREATE TABLE IF NOT EXISTS entries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    handle_norm   TEXT NOT NULL UNIQUE,   -- normalised instagram handle (dedup key)
    handle_raw    TEXT NOT NULL DEFAULT '', -- what the teammate typed
    social_url    TEXT NOT NULL DEFAULT '', -- canonical https://instagram.com/<handle>
    email         TEXT NOT NULL DEFAULT '', -- as entered
    email_norm    TEXT NOT NULL DEFAULT '', -- lower-cased, trimmed
    first_name    TEXT NOT NULL DEFAULT '', -- lead's first name (optional)
    notes         TEXT NOT NULL DEFAULT '', -- free-text notes on the lead (optional)
    category      TEXT NOT NULL DEFAULT '', -- lead category / label (optional)
    lead_owner    TEXT NOT NULL DEFAULT '', -- owner: the teammate who added it, or the owner named in the master sheet
    created_by    TEXT NOT NULL DEFAULT '', -- username of the teammate who added it ('' for imported master rows)
    created_at    TEXT NOT NULL,
    source        TEXT NOT NULL DEFAULT 'added', -- 'added' (via platform) | 'master' (imported sheet)
    in_master     INTEGER NOT NULL DEFAULT 0, -- convenience flag; mirrors source='master'
    stage           TEXT NOT NULL DEFAULT '',  -- pipeline bucket: '' | Leads | Responses | Closed | Failed
    position        TEXT NOT NULL DEFAULT '',  -- pipeline_nodes.key the lead currently sits at ('' = unset)
    position_source TEXT NOT NULL DEFAULT 'auto', -- 'auto' = CRM-derived (re-synced) | 'manual' = human-set (frozen)
    stage_data    TEXT NOT NULL DEFAULT '',    -- JSON: manual overrides of stage rate/deliverable fields
    crm_label     TEXT NOT NULL DEFAULT '',    -- pulled from CRM
    crm_deal      TEXT NOT NULL DEFAULT '',    -- JSON: deal rates/deliverables pulled from CRM

    -- Snapshot of the CRM /api/lookup result at add time (refreshable):
    crm_known           INTEGER NOT NULL DEFAULT 0,
    crm_contacted       INTEGER NOT NULL DEFAULT 0,
    crm_replied         INTEGER NOT NULL DEFAULT 0,
    crm_status          TEXT NOT NULL DEFAULT '',
    crm_poc             TEXT NOT NULL DEFAULT '',
    crm_campaigns       TEXT NOT NULL DEFAULT '',   -- JSON array string
    crm_last_contact_at TEXT NOT NULL DEFAULT '',
    crm_last_reply_at   TEXT NOT NULL DEFAULT '',
    crm_checked_at      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_entries_email    ON entries (email_norm);
CREATE INDEX IF NOT EXISTS idx_entries_created  ON entries (created_at);
CREATE INDEX IF NOT EXISTS idx_entries_source   ON entries (source);
CREATE INDEX IF NOT EXISTS idx_entries_stage    ON entries (stage);
CREATE INDEX IF NOT EXISTS idx_entries_position ON entries (position);

/* ── pipeline classification tree (Stage → Status → Label → sub-labels) ──
   A flat, editable tree. `key` encodes the path from the stage; `parent` is the
   key one level up ('' for a stage-root node). A lead's entries.position holds
   the key of the node it currently sits at. Seeded in code (ensurePipeline). */
CREATE TABLE IF NOT EXISTS pipeline_nodes (
    key        TEXT PRIMARY KEY,               -- e.g. Responses/interested/relevant/call_booked
    parent     TEXT NOT NULL DEFAULT '',       -- parent key ('' = directly under the stage)
    stage      TEXT NOT NULL DEFAULT '',       -- Leads | Responses | Closed | Failed
    label      TEXT NOT NULL DEFAULT '',       -- display name
    sort       INTEGER NOT NULL DEFAULT 0,     -- order among siblings
    deletable  INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pipeline_parent ON pipeline_nodes (parent);
CREATE INDEX IF NOT EXISTS idx_pipeline_stage  ON pipeline_nodes (stage);

/* ── uploaded master list of known usernames ────────────────── */
/* ── linked video records (many per lead) ───────────────────── */
CREATE TABLE IF NOT EXISTS videos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id    INTEGER NOT NULL DEFAULT 0,
    handle      TEXT NOT NULL DEFAULT '',
    url         TEXT NOT NULL DEFAULT '',
    date_posted TEXT NOT NULL DEFAULT '',
    country     TEXT NOT NULL DEFAULT '',
    language    TEXT NOT NULL DEFAULT '',
    video_type  TEXT NOT NULL DEFAULT '',
    budget      TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    lead_name   TEXT NOT NULL DEFAULT '',
    referral    TEXT NOT NULL DEFAULT '',
    saas        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    created_by  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_videos_entry ON videos (entry_id);

/* ── shared, editable list of lead categories ───────────────── */
CREATE TABLE IF NOT EXISTS categories (
    name       TEXT PRIMARY KEY,
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO categories (name, sort) VALUES
    ('SMM', 1), ('Agency', 2), ('Creator Coach', 3), ('Videos', 4);

CREATE TABLE IF NOT EXISTS master_usernames (
    handle_norm TEXT PRIMARY KEY,          -- normalised handle
    handle_raw  TEXT NOT NULL DEFAULT '',  -- original cell value
    source_url  TEXT NOT NULL DEFAULT '',  -- full instagram URL if the source had one
    email       TEXT NOT NULL DEFAULT '',  -- optional email column from the master
    added_at    TEXT NOT NULL
);
