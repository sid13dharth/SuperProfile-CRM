const DEFAULT_BASE = 'https://superprofile-leadgen.superprofile-crm.workers.dev';
const $ = id => document.getElementById(id);

chrome.storage.sync.get(['base', 'key']).then(s => {
  $('base').value = s.base || DEFAULT_BASE;
  $('key').value = s.key || '';
});

$('save').addEventListener('click', async () => {
  const base = ($('base').value || DEFAULT_BASE).trim().replace(/\/+$/, '');
  const key = $('key').value.trim();
  const msg = $('msg');
  msg.className = ''; msg.textContent = 'Testing…';
  await chrome.storage.sync.set({ base, key });

  // Prove the key works now rather than letting it fail silently on Instagram.
  // A handle that cannot exist still exercises auth: 401 = bad key, 200 = fine.
  try {
    const r = await fetch(`${base}/api/ext/lead?handle=spcrm_probe_handle`, {
      headers: { 'x-ext-key': key, accept: 'application/json' },
    });
    if (r.status === 401) { msg.className = 'err'; msg.textContent = 'Saved, but the key was rejected (401).'; return; }
    if (r.status === 503) { msg.className = 'err'; msg.textContent = 'Saved, but no key is configured on the worker yet.'; return; }
    if (!r.ok) { msg.className = 'err'; msg.textContent = `Saved, but the CRM returned HTTP ${r.status}.`; return; }
    await r.json();
    msg.className = 'ok'; msg.textContent = 'Saved — connected to the CRM.';
  } catch (e) {
    msg.className = 'err';
    msg.textContent = 'Saved, but the CRM could not be reached: ' + (e && e.message || e);
  }
});
