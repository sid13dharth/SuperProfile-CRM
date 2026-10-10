-- Two more things a closed deal can carry.
--
-- Both were being typed into "Other deliverables" as free prose — one real row
-- read "25% commission, 6 month SPF" — which means they could never be counted,
-- filtered or reported on. Giving them their own columns makes them data.
--
-- deal_referral_pct is a NUMBER so it can be summed and compared later; the UI
-- renders the % sign rather than storing it. NULL means "not agreed", which is
-- deliberately different from 0 ("agreed, but none").
ALTER TABLE conversations ADD COLUMN deal_referral_pct REAL;

-- Plan access stays free text: deals say "6 months", "1 year", "lifetime", and
-- a fixed list would block the first deal that does not fit.
ALTER TABLE conversations ADD COLUMN deal_plan_access TEXT NOT NULL DEFAULT '';
