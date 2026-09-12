# KICKOFF — Lead-Gen / CRM Platform  *(session 1 of 5)*

**First message for a fresh session** (launch Claude Code from `D:\` so memory auto-loads):
> Read your MEMORY.md, then `D:\SuperProfile.claude\leadgen_platform\KICKOFF.md`. This session owns the Lead-Gen/CRM platform ONLY — ignore the other workstreams. Then wait.

**Scope of this session:** the live platform's code, data and deploys. NOT the Instantly DNS bug (own session, `instantly_ops/KICKOFF.md`), NOT brand/community/comment-scraper work.

---

## What it is
Live lead tracker with the old CRM fully merged in — one app, one D1 DB, one live Instantly sync.
- **Live:** https://superprofile-leadgen.superprofile-crm.workers.dev
- **Code (ground truth):** `D:\SuperProfile.claude\leadgen_platform\cloud\` — Cloudflare Worker `src/worker.js` + vanilla SPA in `static/`. Sibling fallback CRM: `crm_platform\cloud\` (worker+UI still up, cron retired).
- **Git:** PRIVATE `github.com/sid13dharth/SuperProfile-CRM`, remote `origin`, push from `D:\SuperProfile.claude\leadgen_platform`. `snapshots/` gitignored (lead PII).
- **Deep history:** session "LEADGEN_HANDOFF platform build" (`local_1e3fcb68-8644-4388-8b5a-2730b8d6080c`, cwd `D:\`, ~5,284 msgs). Page it for anything not in memory `leadgen-platform.md`.

## Infra
- Cloudflare acct `b9adbd733b7629f367f66d1dacfd1820` (siddharth.pradeep@cosmofeed.com). Token: `leadgen_platform/cloud/cf_token.txt` (gitignored).
- D1 `superprofile-leadgen`, id `7700f30a-bca0-4d06-b460-45cb6ef1fd03`.
- Deploy: `cd leadgen_platform/cloud && CLOUDFLARE_API_TOKEN=$(cat cf_token.txt) npx wrangler deploy`
- Migrations: `... d1 execute superprofile-leadgen --remote --file=migrate_vN.sql` — **ceiling is v9**, no v10+ yet.
- CRM link is a **service binding** `env.CRM`, not public fetch (same-acct Worker→Worker over workers.dev mis-routes POST→GET→404). `LOOKUP_KEY` secret identical on both workers.
- Two Instantly workspaces: ws1 (main) + ws2 (India); `workspaces.api_key` stored PLAINTEXT in D1. Leadgen cron (`* * * * *`, round-robin 1 ws/tick) is the sole syncer.

## Data model (the part that trips people up)
- **`entries`** ≈21,871 rows = 21,451 `source='master'` + 420 `source='crm'` + 0 `source='added'`.
- **ONE tree, TWO fields:** `stage` = the 4 buckets (Leads · Responses · Closed · Failed); `position` = a `pipeline_nodes.key` inside that stage. Status/Label/breadcrumb are DERIVED by walking parents.
- **`position_source`** = `'auto'` (re-derived from CRM each sync) | `'manual'` (human-set, frozen, never overwritten).
- **`stage_data` JSON holds every manual per-lead field** — so new per-lead fields need NO migration, just add to `SD_FIELDS`/`STAGE_FIELDS`.
- Grid filtering = three flat AND-combined dropdowns (Stage · Status · Label), override-aware via `effSD()`. The tree UI is gone from the grid but the tree DATA still drives the funnel.
- `videos` table (v5, +lead_name/referral/saas in v9). `master_usernames` is DEPRECATED/empty.

## Gotchas — read before touching anything
- `wrangler deploy` **prints nothing even on success** — verify by serving `/app.js` and grepping a marker, or checking the versions API.
- **D1 caps bound params at ~100** → chunk every `IN(...)` at ≤90. A 200-chunk regression was already caught once.
- `wrangler d1 execute --command` **HANGS** (interactive confirm). `--file` returns exec stats, not row values. To read live values: inject a temp `sessions` row, curl the live API with `Cookie: lg_session=<token>`, then DELETE the session.
- When C: is full, wrangler fails → use the D1 REST API (`POST .../d1/database/<dbid>/query`, Bearer = cf_token.txt) and the secrets REST endpoint.
- Local dev lock: kill workerd (`Get-Process workerd | Stop-Process -Force`) before `rm -rf .wrangler`.
- User must click ⟳ **Refresh CRM** to populate status/label/stage/deal across ~21k leads (~2 min).

## Recent state (2026-09-10)
migrate_v9 live; `/api/activity` + 📈 Activity modal (teammate-ADDED leads only, `source='added'`, per IST day — reads empty until teammates hand-add); `/api/analytics` from Instantly; email dedup on add; read-only conversation popup on Responses (💬); grid 1000-cap removed (`filtered_total` + `limit=100000`).

## OPEN — start here
1. ~~VERIFY the $5 Workers Paid plan~~ **DONE 2026-09-10 — acct `b9adbd733b…` IS on Workers Paid.** Proven by usage (the `cf_token.txt` token has no Billing:Read scope; all `/subscriptions` + `/billing/profile` endpoints 401): D1 ran 31 straight days at ~257M rows read/day + ~3.4M written/day, vs free caps of 5M/day + 100k/day. The old "free-tier row-read limit" error was not this DB — stop chasing it. **New items it surfaced:**
   - **1a. D1 WRITE overage is the real bill (~$70–116/mo on top of the $5).** Paid includes 50M writes/mo; steady state is ~120M/mo and the last 7 days ran ~166M/mo. Reads (~9B/mo vs 25B incl) and storage (677 MB vs 5 GB incl) cost **$0** — so read-reduction is the WRONG lever, the every-minute cron's *write* volume is the one. Overage price: $1.00/M writes.
   - **1b. Sep-3 regression: D1 `readQueries` jumped ~30× (~120k/day → ~3.5M/day)** and never came back down. That's ~1,000+ queries per Worker invocation, i.e. sitting on D1's paid 1000-queries-per-invocation ceiling. Find what landed Sep 3.
   - **1c. The cron failed on ~every tick for ~2 weeks — now fixed, cause unknown.** Aug 25–Sep 2 ≈1,440 `exceededMemory`/day; Sep 3–Sep 9 ≈1,420 `internalError`/day (both ≈ the 1440 ticks/day). Stopped ~Sep 9 20:00 UTC; Sep 10 clean. Confirm what the Sep 9 evening change was so it doesn't regress.
   - **RESOLVED 2026-09-10 (user fixed it Sep 9) — cost + cron are both back inside the $5 plan.** The fix landed **2026-09-09 21:00 UTC** and cut, hour-over-hour: rowsWritten ~290k/hr → **~42k/hr (-86%)**, readQueries ~190k/hr → **~24k/hr (-87%)**, invocation errors ~60/hr → **0**. rowsRead was NOT affected (~11M/hr before and after) — the scan load is unchanged and is the thing that would bite first if lead volume grows.
     - **Post-fix run rate vs $5 Paid included (measured over 15 clean hrs, projected to 730h/mo):** rows read 8.18B/25B (33%) · rows written 32.2M/50M (65%) · storage 0.68 GB/5 GB (14%) · requests 174k/10M (1.7%) · CPU 16.0M ms/30M ms (53%). **All inside → $5.00/mo, $0 overage.**
     - **Trailing 30d (Aug 11–Sep 9) for contrast:** rows written 117.5M (235% of incl) = $67.49 + CPU 46.8M ms (156%) = $0.34 → **~$72.83/mo**. Reads (9.04B), storage (0.68 GB) and requests (112k) were never the cost.
     - **Already-accrued caveat:** can't read the renewal date (token has no Billing:Read). If the cycle follows acct creation (Jul 19), Aug 19–Sep 10 already banked 90.9M writes ≈ **$40.92 overage** that the fix can't reverse → expect ~$50 for the current cycle, $5 after.
     - **Useful method (reusable):** all of this came from the GraphQL analytics API with the existing `cf_token.txt` — `d1AnalyticsAdaptiveGroups{sum{rowsRead rowsWritten readQueries writeQueries}}` (dims: date/datetimeHour/databaseId) and `workersInvocationsAdaptive{sum{requests errors cpuTimeUs}}` (dims: date/datetimeHour/scriptName/**status**). `status` is how the cron failures were spotted (`exceededMemory`/`internalError` ≈1,440/day = one per tick). Billing endpoints all 401 — usage analytics is the way in.
     - **Paid rates for future math:** D1 25B reads incl then $0.001/M · 50M writes incl then **$1.00/M** · 5 GB incl then $0.75/GB-mo. Workers 10M req incl then $0.30/M · 30M CPU-ms incl then $0.02/M.
1d. **Grid perf fixed 2026-09-10 — IN THE WORKING TREE, NOT DEPLOYED.** Scroll lag was (a) 568,685 DOM nodes from the removed 1000-row cap and (b) a full `innerHTML` rebuild fired ~once a minute by the 12s `/api/version` poll, mid-scroll. Now **paginated at 100/page** (user chose pages over the virtualisation that was built first): `sync.js` guards its two unguarded `bumpVersion` calls; `app.js` renders one page at a time with a First/Prev/numbered/Next/Last pager + "Go to" box + 100/250/500/1000 size select + ←/→ keys; `index.html` gains `#pager` outside `#list`; `style.css` gains `.gfixed`/`.pg-*` and moves striping to `tr.odd`. Measured on All Leads (21,871 rows / 219 pages): DOM 568,685 → **~4,400**; cold render 5.6-11.3 s → **106 ms**; warm re-render → **1.3 ms**; page flip **30 ms**.
   - **Deploy still needed** (`npx wrangler deploy`) — verify by serving `/app.js` and grepping for `renderPager`. NB the working tree also carries the user's own uncommitted Sep-9 `worker.js`/`index.html` changes, so a deploy ships those too.
   - **Deferred by the user: move paging SERVER-side.** `/api/entries` has LIMIT but **no OFFSET** (worker.js ~1145) — add an `offset` param. Until then the full ~22k-row payload is still downloaded + parsed on every load and every 12s refresh; only the DOM cost is gone.
   - **Trap:** `style.css:395` has `.row { display:flex }`; a `<tr class="row">` silently makes rows flex and breaks all table layout. Never put a generic class on grid rows.
1e. **Instagram enrichment (HikerAPI) — DEPLOYED 2026-09-10.** **Followers / Last Post / Avg Views (10)** columns on every lead tab, from HikerAPI via `cloud/src/hiker.js` + `migrate_v10`. Enrich-on-add + a manual `📸 IG data` modal (this page / engaged backfill / all); **no background refresh by design** — the modal shows the call estimate before you spend. Secret set, migration applied (all 7 `ig_*` columns verified), worker version `70a49153`, cron clean.
   - **Cost: 2 calls per lead.** `/v1/user/by/username` (followers + numeric id) then `/gql/user/clips` (reels). `ig_user_id` is cached so refreshes stay cheap. Full backfill of 23,426 leads ≈ 46,850 calls.
   - **GOTCHA, cost an hour to find:** `/gql/user/clips` **needs `flat=true`** (without it: zero items) and flattening **prefixes keys** — `taken_at` arrives as **`1ltaken_at`** while `play_count` stays plain. That is why the first live run returned views but blank dates. `pick()` in hiker.js matches exact-then-suffix; do NOT "simplify" it back to direct property access.
   - **CSS specificity trap:** the global `table.grid th, table.grid td { max-width: 280px }` (0,1,2) outranks a bare `td.notes`/`td.ig` (0,1,1), so those per-column max-widths never applied. Qualify per-column overrides as `table.grid td.<cls>`. Notes is now pinned to 280px on every tab (it was 280 on Leads/All but 56px elsewhere) and `textarea.cellta` fills its cell instead of forcing `min-width:240px`.
   - **Column-width trap:** pinned widths are measured from sampled rows, so a mostly-empty column gets sized for `—`. "Last Post" landed 1px under what `DD/MM/YYYY` needs. Fixed with `min-width` (66px on `.ig`, 104px on `.igdate`) — and the `.igdate` rule must sit AFTER `.ig` in style.css, equal specificity. Any future column filled by enrichment/sync needs a min-width for the same reason.
   - **Nothing is backfilled yet** — every lead reads "not fetched" until someone opens the modal. Start with "This page" to sanity-check the numbers before the engaged backfill (~2,468 calls).


1f. **Bio / Link-in-bio columns + grid sorting — DEPLOYED 2026-09-10 (`234ba830`, migrate_v11).** Bio and link cost **no extra HikerAPI calls** (both ride the profile response v10 already fetches). `ig_bio` / `ig_link` / `ig_link_domain`; `linkDomain()` normalises to a bare host so the platform filter is an indexed `=`. Toolbar `#link-filter` dropdown lists the domains actually present with counts (`GET /api/entries/ig-domains`), plus has-a-link / no-link options. `Followers` and `Avg Views (10)` headers are click-sortable over the whole filtered set (desc → asc → off), blanks always last, resets to page 1.
   - migrate_v11 also re-queued the 101 v10-enriched leads (`ig_checked_at` cleared) so their Bio fills in on the next backfill.
   - **Backfill speed:** `IG_CONCURRENCY` 5→15, `IG_STEP_LEADS` 25→50 (version `b41cb403`). Steps were 61.8s wall / 1ms CPU = pure I/O wait; HikerAPI showed no 429s at 15-wide and per-call latency actually improved. Engaged backfill ~3h → ~18 min. Do NOT lower these back without re-probing.
   - **Close stops a backfill** after the in-flight step; progress is committed per step and resumes from the `ig_checked_at = ''` queue. Same if the tab closes — the loop is client-driven.
   - `Last Post` is deliberately NOT sortable yet — one-line `sortable: true` if wanted.

1g. **Empty conversation popups — diagnosed + partly fixed 2026-09-10 (`66f5e299`).** `conversations` only holds threads WITH a reply, and a row is created from Instantly's reply COUNTER regardless of whether bodies were ingested → 41/5,485 (0.7%) claim replies but hold zero emails. **Bug in `runReplyReconcile`:** it only repaired when Instantly reported MORE replies than stored, so count-1-bodies-0 never qualified. Now also repairs "claims replies, holds no mail", bounded to `last_lead_msg_at` within 180 days (older threads are gone from Instantly — probed; without the bound they would churn ~1.5k wasted calls/day forever).
   - The popup now shows an orange notice when replies-on-record exceed messages held, naming the other address — instead of rendering a one-sided thread that looks broken.
   - **Not investigated:** 251 of 5,165 Responses entries have NO conversation row at all. Different, older issue.
   - Leads often reply from a DIFFERENT address than the one on the entry (that was the reported case) — matching is by handle, which is why the lead is still bucketed correctly.

1h. **Chrome extension (Instagram → CRM lookup) — BUILT + DEPLOYED 2026-09-11 (`519d690e`).** `leadgen_platform/extension/`, MV3, read-only, unpacked install. Endpoint `GET /api/ext/lead?handle=…` auth'd by `x-ext-key` against the `EXT_KEY` secret.
   - **Key design points, do not "fix" these:** the app cookie is SameSite=Lax so it can never be used from instagram.com (hence the header key); and there are deliberately NO CORS headers because the extension fetches from its background service worker, which is exempt.
   - `content.js` patches pushState/replaceState + popstate — Instagram is an SPA and without that the panel only updates on manual refresh.
   - Read-only by choice. Add-lead / edit-stage and per-user tokens are the obvious next step if wanted.

1i. **"Contacted, never replied" was always 0 — FIXED 2026-09-11 (`21ec4f26`).** `refresh-crm` built its signal only from `conversations`, which only exist once a lead REPLIES, so it could never mark contacted-without-reply. Real numbers: **12,201 leads emailed, 8,594 never replied**, all showing "never contacted" against 51,645 outbound emails. Now falls back to the `emails` table like `localCrm` always did.
   - **No lead changes stage** (verified: stage only moves on `crmSuggest()` or `crm_replied`).
   - **The funnel WILL change** once someone clicks ⟳ Refresh CRM: it is `crm_known=1` based with `reached = contacted`, so "reached" goes ~4,662 → ~12,201. A correction, but it will not match previously quoted figures. Nothing moves until that button is pressed.

1j. **Extension v1.3.0 — per-user auth (2026-09-12, worker `9f8caef3`).** No shared key needed: `chrome.cookies.get()` CAN read the HttpOnly `lg_session` (SameSite only blocks page JS), sent as `x-lg-session`; `getUser()` accepts it alongside the cookie. Key remains as a fallback. Teammates just log into the CRM. Also: `POST /api/ext/set-email` (the one write, 4 guards) and an inline add-email box.
   - Ship `superprofile-crm-extension.zip` (repo root) on its own — no key, nothing separate.
   - **Unverified:** chrome.cookies reading HttpOnly in a real browser. Test by clearing the key and seeing if the panel still works.

2. **Security findings, unfixed:** open `/api/setup` = admin-seizure risk; missing admin gates on `/api/sync` and `/api/admin/relink`.
3. Offered, not done: scrub the one early git commit that briefly tracked `snapshots/` PII; make the conversation popup interactive (reply/status) and available on all tabs; further cron read-reduction.
4. Deferred: ~11,900 leads lack name/date/category (old handle+email-only master uploads; fix = one consolidated sheet matched by handle — parser `build_master_entries_sql.js`). "Video Ideas" + "Reply Tracker" tabs (columns never defined). Removing the temp `/api/admin/relink` endpoint. 398 email-only conversations stay unlinked (no handle — expected floor).
