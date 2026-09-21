/* ── HikerAPI enrichment ─────────────────────────────────────
   Fills three lead columns from Instagram: follower count, the date of the
   most recent post, and the average view count of the last 10 reels.

   Two calls per lead, and that is the whole cost model:
     1. /v1/user/by/username  → follower_count + the numeric user id
     2. /gql/user/clips       → recent reels (needs the id, not the handle)
   The id is stored on the row, so a REFRESH of an already-enriched lead only
   costs the second call unless the first one is needed for a fresh count.

   Views: Instagram only exposes a play/view count on video content, never on
   photos, so the average is taken over reels — that keeps the number
   comparable between leads instead of silently averaging in zeros.        */

const HIKER_BASE = 'https://api.hikerapi.com';
const HIKER_TIMEOUT_MS = 20000;
export const IG_REELS_SAMPLE = 10;   // "last 10 posts"
/* Step size and concurrency are the whole speed story. CPU per step is ~1ms —
   it is all I/O wait — and a probe against the live API showed 15 parallel
   requests returning NO 429s with per-call latency actually improving
   (1.9s at 5 wide, 1.3s at 15 wide). At 5/25 a step took ~60s; at 15/50 it is
   ~12s for twice the leads. 50 leads = 100 subrequests, well under the 1000
   per-invocation cap even with retries. Short steps also mean Close stops
   the backfill within seconds instead of a minute. */
export const IG_STEP_LEADS = 50;     // leads per bounded step (= 100 subrequests)
export const IG_CONCURRENCY = 15;    // parallel leads inside a step

class HikerError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

function hikerKey(env) {
  const key = (env.HIKER_API_KEY || '').trim();
  if (!key) throw new HikerError('error', 'HikerAPI key is not set — run: wrangler secret put HIKER_API_KEY');
  return key;
}

// GET with the retry/timeout shape the comment-scraper already proved out.
async function hikerGet(env, path, params) {
  const key = hikerKey(env);
  const url = new URL(HIKER_BASE + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), HIKER_TIMEOUT_MS);
    let r;
    try {
      r = await fetch(url, { headers: { 'x-access-key': key, accept: 'application/json' }, signal: ctl.signal });
    } catch (e) {
      clearTimeout(timer);
      if (attempt < 2) continue;                       // timeout / network blip → retry
      throw new HikerError('error', `${path} request failed (${e.name === 'AbortError' ? 'timed out' : e.message})`);
    }
    clearTimeout(timer);
    if (r.status === 429) { await new Promise(res => setTimeout(res, 1500)); continue; }
    // A handle that no longer exists is a normal outcome, not a failure.
    if (r.status === 404) throw new HikerError('notfound', `${path} → 404`);
    const text = await r.text();
    if (!r.ok) throw new HikerError('error', `${path} → ${r.status}: ${text.slice(0, 160)}`);
    try { return JSON.parse(text); } catch { return {}; }
  }
  throw new HikerError('error', `${path} rate-limited after 3 attempts`);
}

// HikerAPI wraps the user object differently across endpoint families.
function pickUser(data) {
  if (!data || typeof data !== 'object') return {};
  return data.user || (data.response && data.response.user) || data.graphql_user || data;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function followerCountOf(u) {
  return num(u.follower_count) ?? num(u.followers) ?? num(u.edge_followed_by && u.edge_followed_by.count);
}

// Instagram now allows several bio links; external_url is the primary one and
// bio_links[] carries the rest. Keep the primary, note the count for the tooltip.
function bioLinkOf(u) {
  const primary = (u.external_url || u.external_lynx_url || '').trim();
  const list = Array.isArray(u.bio_links) ? u.bio_links.map(b => (b && (b.url || b.lynx_url)) || '').filter(Boolean) : [];
  const url = primary || list[0] || '';
  return { url, extra: Math.max(0, list.length - (primary ? 0 : 1)) };
}

// 'http://stan.store/creativelycarla' -> 'stan.store'. Drives the
// pick-a-platform filter, so it must be stable and lower-cased.
export function linkDomain(url) {
  if (!url) return '';
  let h = String(url).trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // strip scheme
  h = h.split(/[/?#]/)[0];                         // host only
  h = h.replace(/^www\./, '');
  h = h.split('@').pop().split(':')[0];            // creds / port
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) && /\.[a-z]{2,}$/.test(h) ? h : '';
}

function userIdOf(u) {
  const v = u.pk ?? u.pk_id ?? u.id ?? u.user_id;
  return v === null || v === undefined ? '' : String(v);
}

// Reel/clip items arrive under several shapes depending on the endpoint family.
function extractClips(data) {
  if (!data) return [];
  const cands = [
    data.items, data.clips, data.medias, data.response && data.response.items,
    data.data && data.data.items, data.edges,
  ];
  for (const c of cands) if (Array.isArray(c) && c.length) return c;
  // gql shapes nest the media one level down.
  if (Array.isArray(data) && data.length) return data;
  return [];
}

function clipOf(item) {
  return (item && (item.media || item.node || item.clip)) || item || {};
}

/* The /gql/* endpoints need flat=true (without it the payload carries no
   items at all), and flattening prefixes some keys with an opaque marker —
   taken_at really arrives as "1ltaken_at". So try the exact name first, then
   fall back to any key ENDING in it. Confirmed against the live API. */
function pick(obj, names) {
  for (const n of names) if (obj[n] !== undefined && obj[n] !== null) return obj[n];
  const keys = Object.keys(obj);
  for (const n of names) {
    const k = keys.find(x => x.toLowerCase().endsWith(n));
    if (k && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function viewsOf(m) {
  return num(pick(m, ["play_count", "view_count", "ig_play_count", "video_play_count", "video_view_count"]));
}

// taken_at is a unix seconds timestamp on most shapes; some return ISO.
function takenAtIso(m) {
  const raw = pick(m, ["taken_at", "taken_at_timestamp", "device_timestamp", "created_at"]);
  if (raw === null || raw === undefined || raw === '') return '';
  if (typeof raw === 'string' && /\D/.test(raw)) {
    const d = new Date(raw);
    return isNaN(d) ? '' : d.toISOString();
  }
  let secs = Number(raw);
  if (!Number.isFinite(secs)) return '';
  if (secs > 1e14) secs = Math.floor(secs / 1e6);       // microseconds (device_timestamp)
  else if (secs > 1e12) secs = Math.floor(secs / 1000); // milliseconds
  const d = new Date(secs * 1000);
  return isNaN(d) ? '' : d.toISOString();
}

/* Enrich ONE lead. Never throws — every outcome is expressed as a patch so a
   bad handle can't abort a whole batch. Returns the column values to store. */
export async function fetchIgStats(env, handle, knownUserId) {
  const patch = {
    ig_user_id: knownUserId || '', ig_followers: null, ig_last_post_at: '',
    ig_avg_views_10: null, ig_reels_used: null, ig_checked_at: new Date().toISOString(), ig_status: 'ok',
    ig_bio: '', ig_link: '', ig_link_domain: '', ig_error: '',
  };
  if (!handle) { patch.ig_status = 'notfound'; patch.ig_error = 'no handle on the lead'; return patch; }

  // 1. profile → followers + user id
  let u = {};
  try {
    u = pickUser(await hikerGet(env, '/v1/user/by/username', { username: handle }));
  } catch (e) {
    patch.ig_status = e.kind === 'notfound' ? 'notfound' : 'error';
    patch.ig_error = String(e.message || e).slice(0, 300);
    return patch;
  }
  patch.ig_followers = followerCountOf(u);
  patch.ig_user_id = userIdOf(u) || patch.ig_user_id;
  // Bio + link ride along on this same response — no extra credit.
  patch.ig_bio = (u.biography || '').trim();
  const link = bioLinkOf(u);
  patch.ig_link = link.url;
  patch.ig_link_domain = linkDomain(link.url);
  if (u.is_private) {
    // Private accounts return no media — record it so we don't keep paying to
    // rediscover that. Followers are still public, so keep them.
    patch.ig_status = 'private';
    return patch;
  }
  if (!patch.ig_user_id) { patch.ig_status = 'error'; patch.ig_error = 'no user id in the profile response'; return patch; }

  // 2. reels → last post date + average views
  let clips = [];
  try {
    clips = extractClips(await hikerGet(env, '/gql/user/clips', { user_id: patch.ig_user_id, flat: true }));
  } catch (e) {
    // Followers already landed; report the partial rather than losing it.
    patch.ig_status = e.kind === 'notfound' ? 'notfound' : 'error';
    patch.ig_error = String(e.message || e).slice(0, 300);
    return patch;
  }

  const reels = clips.map(clipOf).filter(Boolean);
  let latest = '';
  const views = [];
  for (const m of reels) {
    const iso = takenAtIso(m);
    if (iso && iso > latest) latest = iso;
  }
  // "Last 10" = the 10 most recent by timestamp, not whatever order the API used.
  const sorted = reels.slice().sort((a, b) => (takenAtIso(b) > takenAtIso(a) ? 1 : -1));
  for (const m of sorted.slice(0, IG_REELS_SAMPLE)) {
    const v = viewsOf(m);
    if (v !== null) views.push(v);
  }
  patch.ig_last_post_at = latest;
  patch.ig_reels_used = views.length;
  patch.ig_avg_views_10 = views.length ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : null;
  return patch;
}

// The UPDATE for one enriched row.
export function igUpdateStmt(env, id, patch) {
  return env.DB.prepare(
    `UPDATE entries SET ig_user_id=?, ig_followers=?, ig_last_post_at=?, ig_avg_views_10=?,
       ig_reels_used=?, ig_checked_at=?, ig_status=?, ig_bio=?, ig_bio_lc=?, ig_link=?, ig_link_domain=?,
       ig_error=? WHERE id=?`)
    .bind(patch.ig_user_id, patch.ig_followers, patch.ig_last_post_at, patch.ig_avg_views_10,
          patch.ig_reels_used, patch.ig_checked_at, patch.ig_status,
          patch.ig_bio || '',
          // Folded here, not in SQL: JavaScript handles non-ASCII, SQLite
          // lower() does not, and bio search matches this column.
          (patch.ig_bio || '').toLowerCase(),
          patch.ig_link || '', patch.ig_link_domain || '', patch.ig_error || '', id);
}

/* Enrich a set of rows [{id, handle_norm, ig_user_id}] with bounded
   concurrency, then write them in one batch. Returns per-row outcomes. */
export async function enrichRows(env, rows) {
  const out = [];
  const stmts = [];
  for (let i = 0; i < rows.length; i += IG_CONCURRENCY) {
    const slice = rows.slice(i, i + IG_CONCURRENCY);
    const patches = await Promise.all(
      slice.map(r => fetchIgStats(env, r.handle_norm, r.ig_user_id).catch(() => ({
        ig_user_id: r.ig_user_id || '', ig_followers: null, ig_last_post_at: '', ig_avg_views_10: null,
        ig_reels_used: null, ig_checked_at: new Date().toISOString(), ig_status: 'error',
        ig_bio: '', ig_link: '', ig_link_domain: '', ig_error: 'enrichment threw before it could report',
      }))));
    slice.forEach((r, k) => {
      stmts.push(igUpdateStmt(env, r.id, patches[k]));
      out.push({ id: r.id, status: patches[k].ig_status, error: patches[k].ig_error || '' });
    });
  }
  if (stmts.length) await env.DB.batch(stmts);
  return out;
}
