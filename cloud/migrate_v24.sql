-- Instantly's own lead list, mirrored: one row per lead email per campaign.
-- "Contacted" means "uploaded to Instantly" (any campaign, either workspace),
-- not "we hold a copy of an email sent to them" — sent-email coverage is
-- partial, so that made thousands of uploaded leads look never contacted.
-- Kept current by back-to-back passes in the cron (sync.js syncInstantlyLeads)
-- and written immediately by "Add to Instantly". Never pruned: anyone ever
-- uploaded to Instantly counts as contacted.
CREATE TABLE IF NOT EXISTS instantly_leads (
    email       TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    ws          INTEGER NOT NULL DEFAULT 1,
    added_at    TEXT NOT NULL DEFAULT '',
    replied     INTEGER NOT NULL DEFAULT 0,
    seen_at     TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (email, campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_instantly_leads_email ON instantly_leads(email);
