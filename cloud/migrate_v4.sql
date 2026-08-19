-- v4: deal stage + stage data + CRM-pulled label & deal fields.
ALTER TABLE entries ADD COLUMN stage      TEXT NOT NULL DEFAULT '';  -- '' | CLOSED | Negotiating | Negotiation Failed
ALTER TABLE entries ADD COLUMN stage_data TEXT NOT NULL DEFAULT '';  -- JSON: manual overrides of the stage rate/deliverable fields
ALTER TABLE entries ADD COLUMN crm_label  TEXT NOT NULL DEFAULT '';  -- pulled from the CRM
ALTER TABLE entries ADD COLUMN crm_deal   TEXT NOT NULL DEFAULT '';  -- JSON: {their_initial,their_final,our_initial,our_final,deliverables,budget} from the CRM
CREATE INDEX IF NOT EXISTS idx_entries_stage ON entries (stage);
