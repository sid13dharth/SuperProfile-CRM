-- v1: add lead first name + notes to entries.
ALTER TABLE entries ADD COLUMN first_name TEXT NOT NULL DEFAULT '';
ALTER TABLE entries ADD COLUMN notes      TEXT NOT NULL DEFAULT '';
