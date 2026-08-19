-- v7: position_source — keeps CRM-derived pipeline positions in sync with the CRM
-- while freezing anything a human manually classified.
--   'auto'   = position came from the CRM; re-synced on every Refresh CRM.
--   'manual' = a teammate set stage/position by hand; never touched by a sync.
-- SQLite backfills all existing rows with the DEFAULT, i.e. 'auto' — so the next
-- Refresh CRM re-derives every not-yet-hand-edited lead from the live CRM status.
ALTER TABLE entries ADD COLUMN position_source TEXT NOT NULL DEFAULT 'auto';
