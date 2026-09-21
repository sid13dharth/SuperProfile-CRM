-- Replies written now, sent later.
--
-- Instantly's /emails/reply fires immediately, so there is nothing to schedule
-- on their side: the queue lives here and the every-minute cron drains it.
-- Accuracy is therefore ~1 minute, and a worker hiccup makes a reply late
-- rather than lost.
--
-- status:
--   pending    waiting for its time
--   sent       delivered through Instantly
--   held       the lead replied after this was written, so it was NOT sent —
--              someone has to look at it (send as-is, edit, or discard)
--   cancelled  dropped by a person
--   failed     three send attempts failed; the error is kept for the thread
CREATE TABLE IF NOT EXISTS scheduled_replies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_key    TEXT    NOT NULL,              -- campaign_id|lead_email
  ws          INTEGER NOT NULL DEFAULT 1,
  text        TEXT    NOT NULL,
  send_at     TEXT    NOT NULL,              -- ISO UTC; the picker converts from IST
  status      TEXT    NOT NULL DEFAULT 'pending',
  created_by  TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT '',
  -- Newest inbound message when this was scheduled. A newer one at send time
  -- means the lead has spoken since, and the reply is held instead of fired.
  seen_msg_at TEXT    NOT NULL DEFAULT '',
  sent_at     TEXT    NOT NULL DEFAULT '',
  error       TEXT    NOT NULL DEFAULT '',
  attempts    INTEGER NOT NULL DEFAULT 0
);

-- The cron's own query: due pending rows, oldest first.
CREATE INDEX IF NOT EXISTS idx_sched_due ON scheduled_replies (status, send_at);
-- The thread view's query: everything outstanding on one conversation.
CREATE INDEX IF NOT EXISTS idx_sched_key ON scheduled_replies (lead_key, status);
