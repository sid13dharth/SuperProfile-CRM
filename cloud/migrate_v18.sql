-- CC / BCC on a queued reply.
--
-- Stored as Instantly stores them: a comma-separated address list, the shape
-- of cc_address_email_list / bcc_address_email_list on their email objects.
-- Empty string means "nobody copied", which is the overwhelming majority.
--
-- Kept on the row rather than re-derived at send time: the recipients are part
-- of what the person wrote, and must not change because the thread moved on.
ALTER TABLE scheduled_replies ADD COLUMN cc  TEXT NOT NULL DEFAULT '';
ALTER TABLE scheduled_replies ADD COLUMN bcc TEXT NOT NULL DEFAULT '';
