-- v8 (MERGE Phase 1): bring the CRM's outreach/conversation layer into the
-- leadgen DB as new, EMPTY tables. Additive only — no existing leadgen table is
-- touched, so this is safe to apply to the live DB with zero impact.
--
-- Model: `entries` stays the master PERSON (unique Instagram handle). Each CRM
-- lead row (one per campaign+email, exists only after a reply) becomes a
-- `conversations` row linked to a person via entry_id (resolved by email/handle).

/* ── conversations = CRM `leads`, per campaign+email, + link to entries ── */
CREATE TABLE IF NOT EXISTS conversations (
    key                 TEXT PRIMARY KEY,          -- "<campaign_id>|<lower(email)>"
    entry_id            INTEGER NOT NULL DEFAULT 0,-- → entries.id (0 = not yet linked)
    campaign_id         TEXT NOT NULL DEFAULT '',
    email               TEXT NOT NULL DEFAULT '',
    handle_norm         TEXT NOT NULL DEFAULT '',  -- persisted, derived from social_url (was regex-only in CRM)
    first_name          TEXT NOT NULL DEFAULT '',
    subject             TEXT NOT NULL DEFAULT '',
    preview             TEXT NOT NULL DEFAULT '',
    eaccount            TEXT NOT NULL DEFAULT '',
    last_lead_msg_at    TEXT NOT NULL DEFAULT '',
    last_our_msg_at     TEXT NOT NULL DEFAULT '',
    last_msg_at         TEXT NOT NULL DEFAULT '',
    last_msg_ue_type    INTEGER NOT NULL DEFAULT 0,
    first_reply_at      TEXT NOT NULL DEFAULT '',
    msg_count           INTEGER NOT NULL DEFAULT 0,
    lead_reply_count    INTEGER NOT NULL DEFAULT 0,
    quoted_usd          REAL,
    quoted_currency     TEXT NOT NULL DEFAULT '',
    quoted_amount       REAL,
    quoted_all          TEXT NOT NULL DEFAULT '',
    quoted_qty          REAL,
    quoted_unit         TEXT NOT NULL DEFAULT '',
    quoted_per_unit_usd REAL,
    quoted_source       TEXT NOT NULL DEFAULT '',
    quoted_other        TEXT NOT NULL DEFAULT '',
    manual_status       TEXT NOT NULL DEFAULT '',
    snoozed_until       TEXT NOT NULL DEFAULT '',
    updated_at          TEXT NOT NULL DEFAULT '',
    social_url          TEXT NOT NULL DEFAULT '',
    lead_owner          TEXT NOT NULL DEFAULT '',
    poc                 TEXT NOT NULL DEFAULT '',
    enriched            INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT '',
    status_source       TEXT NOT NULL DEFAULT '',
    label               TEXT NOT NULL DEFAULT '',
    label_checked       INTEGER NOT NULL DEFAULT 0,
    auto_checked        INTEGER NOT NULL DEFAULT 0,
    deal_videos         TEXT NOT NULL DEFAULT '',
    deal_budget         TEXT NOT NULL DEFAULT '',
    deal_deliverables   TEXT NOT NULL DEFAULT '',
    fail_reason         TEXT NOT NULL DEFAULT '',
    fail_notes          TEXT NOT NULL DEFAULT '',
    rate_their_initial  TEXT NOT NULL DEFAULT '',
    rate_their_final    TEXT NOT NULL DEFAULT '',
    rate_our_initial    TEXT NOT NULL DEFAULT '',
    rate_our_final      TEXT NOT NULL DEFAULT '',
    ws                  INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_conv_campaign ON conversations (campaign_id);
CREATE INDEX IF NOT EXISTS idx_conv_email    ON conversations (email);
CREATE INDEX IF NOT EXISTS idx_conv_handle   ON conversations (handle_norm);
CREATE INDEX IF NOT EXISTS idx_conv_entry    ON conversations (entry_id);
CREATE INDEX IF NOT EXISTS idx_conv_ws       ON conversations (ws);

/* ── raw messages ── */
CREATE TABLE IF NOT EXISTS emails (
    id                TEXT PRIMARY KEY,
    campaign_id       TEXT NOT NULL DEFAULT '',
    lead_email        TEXT NOT NULL DEFAULT '',
    thread_id         TEXT NOT NULL DEFAULT '',
    eaccount          TEXT NOT NULL DEFAULT '',
    ue_type           INTEGER NOT NULL DEFAULT 0,  -- 1=our campaign send, 2=lead reply, 3=our manual reply
    from_email        TEXT NOT NULL DEFAULT '',
    to_email          TEXT NOT NULL DEFAULT '',
    subject           TEXT NOT NULL DEFAULT '',
    preview           TEXT NOT NULL DEFAULT '',
    body_html         TEXT NOT NULL DEFAULT '',
    body_text         TEXT NOT NULL DEFAULT '',
    timestamp_email   TEXT NOT NULL DEFAULT '',
    timestamp_created TEXT NOT NULL DEFAULT '',
    body_checked      INTEGER NOT NULL DEFAULT 0,
    ws                INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_emails_lead      ON emails (campaign_id, lead_email, timestamp_email);
CREATE INDEX IF NOT EXISTS idx_emails_ws        ON emails (ws);
CREATE INDEX IF NOT EXISTS idx_emails_created   ON emails (timestamp_created);
CREATE INDEX IF NOT EXISTS idx_emails_leademail ON emails (lead_email, timestamp_email);

/* ── Instantly campaigns ── */
CREATE TABLE IF NOT EXISTS campaigns (
    id      TEXT PRIMARY KEY,
    name    TEXT NOT NULL DEFAULT '',
    status  TEXT NOT NULL DEFAULT '',
    ws      INTEGER NOT NULL DEFAULT 1,
    created TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_campaigns_ws ON campaigns (ws);

/* ── configurable outreach statuses (drive the pipeline auto-map) ── */
CREATE TABLE IF NOT EXISTS statuses (
    key      TEXT PRIMARY KEY,
    label    TEXT NOT NULL,
    form     TEXT NOT NULL DEFAULT 'none',
    terminal INTEGER NOT NULL DEFAULT 0,
    builtin  INTEGER NOT NULL DEFAULT 0,
    sort     INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO statuses (key, label, form, terminal, builtin, sort) VALUES
    ('moved_to_wa',           'Moved to WA',           'none',    0, 1, 1),
    ('call_pitched',          'Call pitched',          'none',    0, 1, 2),
    ('call_booked',           'Call booked',           'none',    0, 1, 3),
    ('partner_of_competitor', 'Partner of competitor', 'none',    1, 1, 4),
    ('rates_quoted',          'Rates quoted',          'rates',   0, 1, 5),
    ('closed',                'Closed',                'deal',    1, 1, 6),
    ('not_relevant',          'Not relevant',          'none',    1, 1, 7),
    ('failed',                'Failed',                'failure', 1, 1, 8);

/* ── CRM labels (Instantly interest-status) ── */
CREATE TABLE IF NOT EXISTS crm_labels (
    name    TEXT PRIMARY KEY,
    builtin INTEGER NOT NULL DEFAULT 0,
    sort    INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO crm_labels (name, builtin, sort) VALUES
    ('Not Relevant',      1, 1),
    ('DND (REMOVE LEAD)', 1, 2),
    ('Out of budget',     1, 3);

/* ── per-conversation notes + activity log ── */
CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_key   TEXT NOT NULL,
    author     TEXT NOT NULL DEFAULT '',
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_lead ON notes (lead_key);

CREATE TABLE IF NOT EXISTS activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_key   TEXT NOT NULL,
    author     TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_lead ON activity (lead_key);

/* ── shared reply templates + quick links ── */
CREATE TABLE IF NOT EXISTS templates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    body       TEXT NOT NULL,
    sort       INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS links (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    url        TEXT NOT NULL,
    sort       INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT ''
);

/* ── Instantly accounts (multi-workspace); api_key stored like the CRM ── */
CREATE TABLE IF NOT EXISTS workspaces (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    api_key    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ''
);

/* users.booking_link — the CRM stores a personal meeting link per user for reply templates */
ALTER TABLE users ADD COLUMN booking_link TEXT NOT NULL DEFAULT '';
