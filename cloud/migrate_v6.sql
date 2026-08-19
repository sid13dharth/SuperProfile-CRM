-- v6: unified pipeline classification (Stage bucket + position node tree).
-- Replaces the old free-floating stage/status/label mix with ONE ordered tree.
-- pipeline_nodes is seeded in code (ensurePipeline) on first API hit.

/* new pipeline position on each lead (node key it currently sits at) */
ALTER TABLE entries ADD COLUMN position TEXT NOT NULL DEFAULT '';

/* the editable classification tree */
CREATE TABLE IF NOT EXISTS pipeline_nodes (
    key        TEXT PRIMARY KEY,
    parent     TEXT NOT NULL DEFAULT '',
    stage      TEXT NOT NULL DEFAULT '',
    label      TEXT NOT NULL DEFAULT '',
    sort       INTEGER NOT NULL DEFAULT 0,
    deletable  INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pipeline_parent   ON pipeline_nodes (parent);
CREATE INDEX IF NOT EXISTS idx_pipeline_stage    ON pipeline_nodes (stage);
CREATE INDEX IF NOT EXISTS idx_entries_position  ON entries (position);

/* ── backfill existing leads onto the new vocabulary ────────────────────────
   Do position first (it reads the OLD stage value), then rewrite the stage. */
UPDATE entries SET position = 'Responses/interested/relevant/negotiating' WHERE stage = 'Negotiating';

UPDATE entries SET stage = CASE
    WHEN stage = 'CLOSED'             THEN 'Closed'
    WHEN stage = 'Negotiation Failed' THEN 'Failed'
    WHEN stage = 'Negotiating'        THEN 'Responses'
    WHEN crm_replied = 1              THEN 'Responses'
    ELSE 'Leads'
END;
