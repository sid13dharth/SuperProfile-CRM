-- v2: lead category + shared editable category list.
ALTER TABLE entries ADD COLUMN category TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS categories (
    name       TEXT PRIMARY KEY,
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO categories (name, sort) VALUES
    ('SMM', 1), ('Agency', 2), ('Creator Coach', 3), ('Videos', 4);
