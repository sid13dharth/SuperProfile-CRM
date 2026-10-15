-- End conversation (Unibox): a conversation the team is done with — deal
-- bagged, failed, or anything else. It leaves every inbox count (Needs Reply
-- and the rest) and lives in an Ended tab until someone reopens it.
ALTER TABLE conversations ADD COLUMN ended_at TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN ended_by TEXT NOT NULL DEFAULT '';
