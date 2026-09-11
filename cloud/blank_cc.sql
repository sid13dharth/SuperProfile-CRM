-- The sheet carried a junk owner value "cc" on a single lead; blank it.
UPDATE entries SET lead_owner = '', lead_manager = '' WHERE lead_owner = 'Cc';
