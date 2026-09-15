-- v14 — lead country.
--
-- HikerAPI cannot supply this. Its user payload has city_name / address_street
-- / zip / lat-lng, and all of them were empty for every one of 25 sampled
-- leads; there is no country field. /v2 returns fifa_country_code, populated
-- 100% of the time and stable per account — but it disagreed with the lead's
-- own self-declared location in 13 of 14 cases and only ever returns US, CA or
-- MX. That is HikerAPI's proxy pool, not the creator. It is not used.
--
-- So country is derived from what we already hold, best source first:
--   sheet — the Country column in Retool_DB.csv and the earlier exports, which
--           are dumps of this same lead database from before the column was
--           dropped
--   pin   — a location stated after a 📍 in the Instagram bio
--   bio   — a country or unambiguous city named anywhere in the bio
--   tld   — a country-coded email domain (.co.uk, .com.au, .in)
--
-- Scored against the sheet country, which the disagreement sample showed to be
-- the reliable one: pin 85%, bio 83%, tld 87%. A flag emoji in the bio scored
-- only 44% and is deliberately NOT used — flags mark heritage, not residence
-- ("LA | 🇰🇷" is someone in Los Angeles).
--
-- country_src records which of those produced the value, so a wrong entry can
-- be traced to its source and a whole source can be re-derived or dropped.
ALTER TABLE entries ADD COLUMN country     TEXT NOT NULL DEFAULT '';
ALTER TABLE entries ADD COLUMN country_src TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_entries_country ON entries (country);
