-- v11 — Instagram bio + link-in-bio.
-- Both already come back from the /v1/user/by/username call v10 makes for the
-- follower count, so storing them costs no extra HikerAPI credits.
--
-- ig_link_domain is the normalised host of ig_link ('stan.store' from
-- 'http://stan.store/creativelycarla'). It exists so the grid can offer a
-- pick-a-platform filter without a LIKE scan over 23k rows.
ALTER TABLE entries ADD COLUMN ig_bio         TEXT NOT NULL DEFAULT '';
ALTER TABLE entries ADD COLUMN ig_link        TEXT NOT NULL DEFAULT '';
ALTER TABLE entries ADD COLUMN ig_link_domain TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_entries_ig_link_domain ON entries (ig_link_domain);

-- The leads enriched under v10 have no bio/link stored (those columns did not
-- exist yet). Clearing their check stamp puts them back in the normal backfill
-- queue so the 📸 IG data modal re-fetches them once, rather than leaving a
-- permanently blank Bio column on the leads you have already paid to enrich.
UPDATE entries SET ig_checked_at = ''
 WHERE ig_checked_at != '' AND ig_bio = '' AND ig_link = '';
