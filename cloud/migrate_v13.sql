-- v13 — post metrics on the videos table.
--
-- The tab was built for videos we commissioned (country, budget, referral…).
-- The export we import now carries the post's own numbers instead, so those
-- get their own columns rather than being crammed into notes.
--
-- post_type is the Instagram format (clips / carousel_container) and is NOT
-- video_type, which is our own categorisation of the collaboration — both are
-- kept because they answer different questions.
--
-- views/comments/likes are nullable on purpose: a deleted or private post has
-- no numbers at all, and 0 would read as "nobody watched it".
ALTER TABLE videos ADD COLUMN views       INTEGER;
ALTER TABLE videos ADD COLUMN comments    INTEGER;
ALTER TABLE videos ADD COLUMN likes       INTEGER;
ALTER TABLE videos ADD COLUMN post_type   TEXT NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN coauthors   TEXT NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN post_status TEXT NOT NULL DEFAULT '';

-- The Videos tab and the Chrome extension both look videos up by handle.
CREATE INDEX IF NOT EXISTS idx_videos_handle ON videos (handle);
-- Re-importing the same export must update rows, not duplicate them.
CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_url ON videos (url);
