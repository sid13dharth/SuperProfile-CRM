# SuperProfile Lead-Gen Dedup Platform

Real-time lead data-entry tool for the lead-gen team. Teammates add leads
(Instagram handle + email); every entry is stored live and flagged with **two
independent signals**:

1. **Duplicate by Instagram username** — the platform's own dedup. Checked
   against an uploaded **master list** *and* every prior entry, enforced
   atomically by a `UNIQUE` index on the normalised handle so two teammates
   adding the same username (even seconds apart) can't both slip through.
2. **Prior Instantly conversation** — fetched from the **CRM** over HTTPS via
   `POST /api/lookup` (keyed on email, reliable). Surfaced separately, with a
   **View conversation** deep link into the CRM.

The two are kept independent (handoff §1, point 4): a username-dup with
`replied:false` is still reachable — the UI says so.

Each lead also carries an optional **First name** and **Notes**. The leads page
has a **date-range picker** (with Today / 7d / 30d / All presets) that scopes the
list and shows a live summary (total leads · with email), and an **Activity**
dashboard (open to everyone) with a per-member × per-day table of leads found and
leads-with-email, plus combined daily totals. All "per day" grouping uses **IST
(UTC+5:30)** day boundaries.

Built on **Cloudflare Workers + D1 + a vanilla-JS SPA**, same shape as the CRM.
Integration with the CRM is pure HTTPS, so this can run under a different
Cloudflare account.

## Layout

```
cloud/
  src/worker.js        backend: auth, entries, dedup, master upload, CRM proxy
  schema.sql           D1 schema (users, sessions, meta, entries, master_usernames)
  static/              the SPA (index.html, app.js, style.css)
  wrangler.jsonc       worker config (edit database_id + CRM_URL)
```

## Endpoints (all under `/api`)

| Method + path | Purpose |
|---|---|
| `GET /me`, `POST /setup`, `POST /login`, `POST /logout` | auth (PBKDF2 + cookie sessions) |
| `GET /users`, `POST /users` | admin: manage teammates |
| `POST /check` | live, no-insert preview of both signals for the add form |
| `POST /entries` | add a lead (`social_url`, `email`, `first_name`, `notes`; atomic dedup + CRM snapshot) |
| `GET /entries` | list (filters: `q`, `owner`, `signal=new\|master\|contacted\|prior`, `from`, `to`) |
| `GET /stats` | date-range totals + per-day + per-member-per-day (leads / with-email), grouped by **IST** day |
| `DELETE /entries` | delete (owner or admin) |
| `POST /entries/refresh-crm` | re-check every lead against the CRM |
| `GET /master/stats`, `POST /master/upload` | admin: the re-uploadable master list |
| `GET /version` | cheap poll for real-time list refresh |

## Deploy

From `cloud/`:

```bash
# 1. Create the D1 database and paste the printed id into wrangler.jsonc
npx wrangler d1 create superprofile-leadgen

# 2. Load the schema (remote)
npx wrangler d1 execute superprofile-leadgen --remote --file=schema.sql

# 3. Set the CRM lookup secret (paste the LOOKUP_KEY when prompted)
npx wrangler secret put LOOKUP_KEY

# 4. (CRM_URL is already set as a var in wrangler.jsonc; override there if needed)

# 5. Deploy
npx wrangler deploy
```

Then open the deployed URL — the **first sign-up becomes the admin**. The admin
uploads the master list and adds teammates under **👥 Team**.

### Secrets / vars

- `LOOKUP_KEY` — **secret**. The CRM's read-only lookup key (provided by
  Siddharth). Without it, the platform still runs and does username dedup; the
  prior-conversation panel just shows "not configured".
- `CRM_URL` — **var** in `wrangler.jsonc`. Defaults to the live CRM.

## Master list format

CSV or TSV. Any column holding an Instagram handle or profile URL is
auto-detected (`username`, `handle`, `instagram`, `profile`, `url`, …); an
optional `email` column is stored too. Single-column files (just handles) work
with no header. **Excel:** export the sheet as CSV first. Re-uploadable any time
— "Merge" adds/updates, "Replace" wipes and reloads. Existing entries are
re-flagged against the refreshed master automatically.

## Local dev

```bash
cd cloud
npm install
npx wrangler d1 execute superprofile-leadgen --local --file=schema.sql
npx wrangler dev --local
```

Handle normalisation (lower-case, strip `@`/trailing `/`, extract the handle
from a full `instagram.com` URL, ignore non-profile paths like `/p/…`) is shared
by add, check, and master import so a link and a bare handle always match.
