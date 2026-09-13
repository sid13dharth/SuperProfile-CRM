/* Injects the CRM panel onto an Instagram profile.

   Instagram is a single-page app: clicking from one profile to another never
   reloads the document, so a script that only runs at load would appear to work
   and then silently go stale. We watch for URL changes instead.              */

const PANEL_ID = 'spcrm-panel';

// Paths that are NOT profiles. Everything else at /<something>/ is one.
const NON_PROFILE = new Set([
  'explore', 'reels', 'stories', 'direct', 'accounts', 'p', 'tv', 'about',
  'developer', 'legal', 'privacy', 'terms', 'your_activity', 'challenge',
  'emails', 'session', 'ajax', 'graphql', 'api', 'oauth', 'web',
]);

function handleFromPath() {
  const seg = location.pathname.split('/').filter(Boolean);
  if (!seg.length) return '';
  const h = seg[0].toLowerCase();
  if (NON_PROFILE.has(h)) return '';
  // /<handle>/ or /<handle>/reels/ etc. — anything deeper than a sub-tab is not
  // a profile view we want to annotate.
  if (seg.length > 2) return '';
  return /^[a-z0-9._]{1,30}$/.test(h) ? h : '';
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtCount(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'K';
  return (n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, '') + 'M';
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
    + ` <span class="spcrm-ago">(${days}d)</span>`;
}

function ensurePanel() {
  let el = document.getElementById(PANEL_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = PANEL_ID;
    const ver = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?';
    el.innerHTML = '<div class="spcrm-head"><b>SuperProfile CRM</b><span class="spcrm-ver">v' + ver + '</span>'
      + '<span class="spcrm-x" title="Hide">×</span></div><div class="spcrm-body"></div>';
    document.body.appendChild(el);
    el.querySelector('.spcrm-x').addEventListener('click', () => el.remove());
  }
  return el;
}

function row(k, v) { return `<div class="spcrm-row"><span class="spcrm-k">${esc(k)}</span><span class="spcrm-v">${v}</span></div>`; }

function render(handle, d) {
  const el = ensurePanel();
  const body = el.querySelector('.spcrm-body');
  el.classList.remove('spcrm-in', 'spcrm-out', 'spcrm-warn');

  if (d && d.error) {
    el.classList.add('spcrm-warn');
    const msg = d.error === 'no_key' ? 'Log in to the CRM in this browser (or add the team key via the extension icon).'
      : d.error === 'bad_key' ? 'The API key was rejected. Check it in the extension options.'
      : d.error === 'network' ? 'Could not reach the CRM.'
      : 'Lookup failed' + (d.detail ? ` — ${esc(d.detail)}` : '');
    body.innerHTML = `<div class="spcrm-msg">${esc(msg)}</div>`;
    return;
  }
  if (!d || !d.found) {
    el.classList.add('spcrm-out');
    const base = (d && d.base) || '';
    body.innerHTML = `<div class="spcrm-msg"><b>@${esc(handle)}</b> is not in the CRM.</div>`
      + `<a class="spcrm-btn" href="${esc(base)}/?add=${encodeURIComponent(handle)}" target="_blank" rel="noopener">+ Add lead</a>`;
    return;
  }

  el.classList.add('spcrm-in');
  const crumb = (d.breadcrumb && d.breadcrumb.length)
    ? d.breadcrumb.map(esc).join(' <span class="spcrm-sep">›</span> ') : '';
  const ig = d.ig || {};
  const parts = [];
  parts.push(`<div class="spcrm-name">${esc(d.first_name || '@' + handle)}`
    + `<span class="spcrm-stage spcrm-s-${esc((d.stage || 'none').toLowerCase())}">${esc(d.stage || 'No stage')}</span></div>`);
  if (crumb) parts.push(`<div class="spcrm-crumb">${crumb}</div>`);
  if (d.label) parts.push(row('Label', esc(d.label)));
  if (d.lead_owner) parts.push(row('Owner', esc(d.lead_owner)));
  if (d.poc && d.poc !== d.lead_owner) parts.push(row('POC', esc(d.poc)));
  if (d.email) parts.push(row('Email', esc(d.email)));
  if (d.category) parts.push(row('Category', esc(d.category)));
  if (d.contacted && d.last_contact_at) parts.push(row('Contacted', fmtDate(d.last_contact_at)));
  if (d.replied && d.last_reply_at) parts.push(row('Replied', fmtDate(d.last_reply_at)));
  if (d.campaigns && d.campaigns.length) parts.push(row('Campaigns', esc(d.campaigns.join(', '))));
  if (ig.checked_at) {
    parts.push(`<div class="spcrm-ig">${fmtCount(ig.followers)} followers`
      + ` · avg ${fmtCount(ig.avg_views_10)} views`
      + ` · last post ${ig.last_post_at ? fmtDate(ig.last_post_at) : '—'}</div>`);
  }
  /* Say what our relationship with this lead actually is. "Open Conversation"
     on someone who never replied would promise a thread that does not exist. */
  const base = esc(d.base || '');
  const qh = encodeURIComponent(handle);
  // Partner first: having posted for us outranks anything in the pipeline.
  parts.push(partnerHtml(d, base, qh));

  if (!d.email) {
    // Inline, so an email can be captured in the two seconds you are looking at
    // the profile — leaving for the CRM is how it never gets filled in.
    parts.push('<div class="spcrm-flag">No email in DB</div>'
      + '<button class="spcrm-btn" id="spcrm-addmail">+ Add email</button>'
      + '<div class="spcrm-mailbox" hidden>'
      + '<input type="email" id="spcrm-mail" placeholder="name@example.com" autocomplete="off">'
      + '<button class="spcrm-btn spcrm-primary" id="spcrm-mailsave">Save</button>'
      + '<div class="spcrm-mailmsg"></div></div>');
  }
  if (d.replied) {
    parts.push(`<a class="spcrm-btn spcrm-primary" href="${base}/?lead=${qh}" target="_blank" rel="noopener">Open Conversation →</a>`);
  } else {
    parts.push(`<div class="spcrm-state">${d.contacted ? 'Contacted but never replied' : 'Never Contacted'}</div>`
      + `<a class="spcrm-btn" href="${base}/?lead=${qh}" target="_blank" rel="noopener">Open in CRM →</a>`);
  }
  body.innerHTML = parts.join('');
  wireAddEmail(body, handle);
}

/* Videos this creator has posted for us. Shown above the pipeline detail,
   because "they already made us a video" is the single most useful thing to
   know when you land on a profile. */
function partnerHtml(d, base, qh) {
  const vids = Array.isArray(d.videos) ? d.videos : [];
  if (!vids.length) return '';
  const live = vids.filter(v => !v.post_status);
  const v = live[0] || vids[0];
  const n = vids.length;
  const num = x => (x === null || x === undefined || x === '') ? null : Number(x).toLocaleString();
  const bits = [];
  if (num(v.views) !== null) bits.push(num(v.views) + ' views');
  if (num(v.likes) !== null) bits.push(num(v.likes) + ' likes');
  if (num(v.comments) !== null) bits.push(num(v.comments) + ' comments');
  const when = v.date_posted ? fmtDay(v.date_posted) : '';
  const dead = v.post_status ? ' <span class="spcrm-dead">(unavailable)</span>' : '';
  return '<div class="spcrm-partner">'
    + '<div class="spcrm-ptag">\u2605 Partner \u00b7 ' + n + ' video' + (n === 1 ? '' : 's') + ' for us</div>'
    + '<div class="spcrm-pline">' + (when ? '<b>' + esc(when) + '</b>' : '<b>Latest</b>') + dead + '</div>'
    + (bits.length ? '<div class="spcrm-pstats">' + esc(bits.join(' \u00b7 ')) + '</div>' : '')
    // esc() escapes quotes, so it is safe inside the attribute. The http(s)
    // test is the real guard \u2014 never build an href from a stored string
    // without checking its scheme first.
    + (/^https?:\/\//i.test(v.url || '') ? '<a class="spcrm-plink" href="' + esc(v.url) + '" target="_blank" rel="noopener">View the post \u2197</a>' : '')
    + '<a class="spcrm-btn" href="' + base + '/?videos=' + qh + '" target="_blank" rel="noopener">Open videos in CRM</a>'
    + '</div>';
}

// YYYY-MM-DD as a short human date; anything else is passed through.
function fmtDay(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(s || '');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return +m[3] + ' ' + MON[+m[2] - 1] + ' ' + m[1];
}

function wireAddEmail(body, handle) {
  const btn = body.querySelector('#spcrm-addmail');
  if (!btn) return;
  const box = body.querySelector('.spcrm-mailbox');
  const input = body.querySelector('#spcrm-mail');
  const save = body.querySelector('#spcrm-mailsave');
  const msg = body.querySelector('.spcrm-mailmsg');
  btn.addEventListener('click', () => {
    box.hidden = false; btn.hidden = true; input.focus();
  });
  const submit = async () => {
    const email = (input.value || '').trim();
    if (!email) return;
    save.disabled = true; msg.className = 'spcrm-mailmsg'; msg.textContent = 'Saving…';
    let r;
    try { r = await chrome.runtime.sendMessage({ type: 'setEmail', handle, email }); }
    catch { r = { error: 'network', detail: 'extension reloaded — refresh the page' }; }
    save.disabled = false;
    if (r && r.ok) {
      msg.className = 'spcrm-mailmsg ok';
      msg.textContent = 'Saved to the CRM.';
      inflight = '';               // force the panel to re-read on the next pass
      setTimeout(() => update(), 600);
      return;
    }
    msg.className = 'spcrm-mailmsg err';
    msg.textContent = (r && (r.detail || r.error)) || 'Could not save.';
  };
  save.addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

let inflight = '';

async function update() {
  const handle = handleFromPath();
  if (!handle) { const el = document.getElementById(PANEL_ID); if (el) el.remove(); inflight = ''; return; }
  if (handle === inflight) return;
  inflight = handle;

  const el = ensurePanel();
  el.querySelector('.spcrm-body').innerHTML = `<div class="spcrm-msg">Checking <b>@${esc(handle)}</b>…</div>`;

  let d;
  try { d = await chrome.runtime.sendMessage({ type: 'lookup', handle }); }
  catch (e) { d = { error: 'network', detail: 'extension reloaded — refresh the page' }; }
  // The user may have navigated on while we waited.
  if (handleFromPath() !== handle) return;
  render(handle, d);
}

/* Instagram swaps pages via the History API, which fires no event of its own.
   Patch push/replaceState and listen for popstate; the MutationObserver is the
   safety net for renders that change the URL without either. */
function onRouteChange(fn) {
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    history[m] = function (...a) { const r = orig.apply(this, a); fn(); return r; };
  }
  window.addEventListener('popstate', fn);
  let last = location.href;
  new MutationObserver(() => { if (location.href !== last) { last = location.href; fn(); } })
    .observe(document, { subtree: true, childList: true });
}

onRouteChange(() => setTimeout(update, 150));
update();
