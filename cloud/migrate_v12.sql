-- v12 — Lead Manager.
-- Distinct from lead_owner: the owner is whoever the lead belongs to (often a
-- contractor or someone outside the CRM), while the manager is the teammate
-- accountable for them inside the CRM.
--
-- Default rule: manager = owner, but ONLY when that owner is an actual CRM user.
-- An owner who is not a teammate has no manager until someone assigns one, so
-- the column stays blank rather than inventing an accountable person.
-- Freely editable afterwards.
ALTER TABLE entries ADD COLUMN lead_manager TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_entries_lead_manager ON entries (lead_manager);
