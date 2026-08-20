-- v9: video CSV import fields. Adds a free-text lead name (for standalone /
-- CSV-imported videos that aren't linked to a lead row), plus a referral
-- source column and a SAAS column. All free text, safe defaults.
ALTER TABLE videos ADD COLUMN lead_name TEXT NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN referral  TEXT NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN saas      TEXT NOT NULL DEFAULT '';
