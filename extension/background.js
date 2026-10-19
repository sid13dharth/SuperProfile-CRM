/* Background service worker (Instagram, YouTube and Skool pages).

   Every network call lives here, not in the content script, for two reasons:
   fetches from the service worker are exempt from CORS (the extension's
   host_permissions cover the worker origin), and the API key never has to be
   exposed to a page that Instagram's own scripts share a tab with.          */

const DEFAULT_BASE = 'https://superprofile-leadgen.superprofile-crm.workers.dev';

// Small in-memory cache: Instagram fires several navigations per profile click,
// and there is no reason to re-ask the CRM for the same handle each time.
const cache = new Map();
const TTL_MS = 60_000;

/* Read the caller's own CRM session cookie. chrome.cookies can see HttpOnly
   cookies (that flag only blocks page JavaScript), so a teammate who is logged
   into the CRM in this browser needs no key at all — and their actions are
   attributed to them rather than to a shared identity. */
async function sessionToken(base) {
  try {
    const c = await chrome.cookies.get({ url: base + '/', name: 'lg_session' });
    return (c && c.value) || '';
  } catch { return ''; }
}

// Session first, shared key as the fallback.
async function authHeaders() {
  const { base, key } = await settings();
  const tok = await sessionToken(base);
  if (tok) return { base, headers: { 'x-lg-session': tok } };
  if (key) return { base, headers: { 'x-ext-key': key } };
  return { base, headers: null };
}

/* chrome.storage.sync throws when sync is disabled for the profile or the
   quota is unhappy. That used to reject all the way out of lookup(), which
   left the panel waiting forever. Defaults are fine here — the base URL has
   one, and no key just means 'use my session'. */
async function settings() {
  let s = {};
  try { s = await chrome.storage.sync.get(['base', 'key']) || {}; } catch (e) { s = {}; }
  return { base: (s.base || DEFAULT_BASE).replace(/\/+$/, ''), key: s.key || '' };
}

/* Instagram: ?handle=. YouTube/Skool: ?platform=…&id=…&id=… — a YouTube
   channel can be named several ways and the CRM tries each. */
/* Is a newer build published? The CRM serves /downloads/extension.json next to
   the zip; checked at most hourly. Unpacked extensions never update on their
   own, so this is how people find out. */
let updateInfo = null, updateCheckedAt = 0;
const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
async function checkUpdate(base) {
  if (Date.now() - updateCheckedAt < 3600_000) return updateInfo;
  updateCheckedAt = Date.now();
  try {
    const r = await fetch(base + '/downloads/extension.json', { cache: 'no-store' });
    const j = r.ok ? await r.json() : null;
    const mine = chrome.runtime.getManifest().version;
    updateInfo = j && newer(j.version, mine) ? { version: j.version, zip: base + j.zip, guide: base + (j.guide || '') } : null;
  } catch (e) { /* offline or not published: say nothing */ }
  return updateInfo;
}

async function lookup(msg) {
  const now = Date.now();
  const ck = msg.cacheKey || msg.handle;
  const hit = cache.get(ck);
  if (hit && now - hit.t < TTL_MS) return hit.v;
  const qs = msg.platform && msg.platform !== 'instagram'
    ? 'platform=' + encodeURIComponent(msg.platform) + (msg.ids || []).map(i => '&id=' + encodeURIComponent(i)).join('')
    : 'handle=' + encodeURIComponent(msg.handle);

  const { base, headers } = await authHeaders();
  if (!headers) return { error: 'no_key' };

  let r;
  try {
    r = await fetch(`${base}/api/ext/lead?${qs}`, {
      headers: { ...headers, accept: 'application/json' },
    });
  } catch (e) {
    return { error: 'network', detail: String(e && e.message || e) };
  }
  if (r.status === 401) return { error: 'bad_key' };
  if (!r.ok) return { error: 'http', detail: 'HTTP ' + r.status };

  let v;
  try { v = await r.json(); } catch { return { error: 'parse' }; }
  v.base = base;
  v.update = await checkUpdate(base);
  cache.set(ck, { t: now, v });
  return v;
}

async function setEmail(msg) {
  const { base, headers } = await authHeaders();
  if (!headers) return { error: 'no_key' };
  let r;
  try {
    r = await fetch(`${base}/api/ext/set-email`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ handle: msg.handle || '', key: msg.key || '', email: msg.email }),
    });
  } catch (e) { return { error: 'network', detail: String(e && e.message || e) }; }
  let v = {};
  try { v = await r.json(); } catch {}
  if (!r.ok) return { error: 'refused', detail: v.detail || ('HTTP ' + r.status) };
  cache.delete(msg.cacheKey || msg.handle);   // the panel must re-read, not show a stale miss
  return v;
}

/* Returning true holds the reply channel open, so EVERY path has to answer —
   a rejected promise here is a panel that hangs rather than an error the user
   can act on. Hence the .catch on both. */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fail = e => sendResponse({ error: 'worker', detail: String((e && e.message) || e) });
  if (msg && msg.type === 'lookup' && (msg.handle || (msg.ids && msg.ids.length))) {
    lookup(msg).then(sendResponse, fail);
    return true;               // keep the channel open for the async reply
  }
  if (msg && msg.type === 'setEmail' && (msg.handle || msg.key)) {
    setEmail(msg).then(sendResponse, fail);
    return true;
  }
});
