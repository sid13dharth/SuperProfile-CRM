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

async function settings() {
  const s = await chrome.storage.sync.get(['base', 'key']);
  return { base: (s.base || DEFAULT_BASE).replace(/\/+$/, ''), key: s.key || '' };
}

async function lookup(handle) {
  const now = Date.now();
  const hit = cache.get(handle);
  if (hit && now - hit.t < TTL_MS) return hit.v;

  const { base, key } = await settings();
  if (!key) return { error: 'no_key' };

  let r;
  try {
    r = await fetch(`${base}/api/ext/lead?handle=${encodeURIComponent(handle)}`, {
      headers: { 'x-ext-key': key, accept: 'application/json' },
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'lookup' && msg.handle) {
    lookup(msg.handle).then(sendResponse);
    return true;               // keep the channel open for the async reply
  }
});
