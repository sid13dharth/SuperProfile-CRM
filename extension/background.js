/* Background service worker.

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

async function lookup(handle) {
  const now = Date.now();
  const hit = cache.get(handle);
  if (hit && now - hit.t < TTL_MS) return hit.v;

  const { base, headers } = await authHeaders();
  if (!headers) return { error: 'no_key' };

  let r;
  try {
    r = await fetch(`${base}/api/ext/lead?handle=${encodeURIComponent(handle)}`, {
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
  cache.set(handle, { t: now, v });
  return v;
}

async function setEmail(handle, email) {
  const { base, headers } = await authHeaders();
  if (!headers) return { error: 'no_key' };
  let r;
  try {
    r = await fetch(`${base}/api/ext/set-email`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ handle, email }),
    });
  } catch (e) { return { error: 'network', detail: String(e && e.message || e) }; }
  let v = {};
  try { v = await r.json(); } catch {}
  if (!r.ok) return { error: 'refused', detail: v.detail || ('HTTP ' + r.status) };
  cache.delete(handle);            // the panel must re-read, not show a stale miss
  return v;
}

/* Returning true holds the reply channel open, so EVERY path has to answer —
   a rejected promise here is a panel that hangs rather than an error the user
   can act on. Hence the .catch on both. */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fail = e => sendResponse({ error: 'worker', detail: String((e && e.message) || e) });
  if (msg && msg.type === 'lookup' && msg.handle) {
    lookup(msg.handle).then(sendResponse, fail);
    return true;               // keep the channel open for the async reply
  }
  if (msg && msg.type === 'setEmail' && msg.handle) {
    setEmail(msg.handle, msg.email).then(sendResponse, fail);
    return true;
  }
});
