/* Injects the CRM panel on Instagram profiles, YouTube channels/videos and
   Skool communities/member profiles.

   All three are single-page apps: moving from one page to the next never
   reloads the document, so a script that only runs at load would appear to
   work and then silently go stale. We watch for URL changes instead, and on
   pages whose subject is only known once the page has rendered (a YouTube
   video's channel, a Skool member's communities) we keep looking for a few
   seconds. */

const PANEL_ID = 'spcrm-panel';
const SITE = /(^|\.)youtube\.com$/.test(location.hostname) ? 'youtube'
  : /(^|\.)skool\.com$/.test(location.hostname) ? 'skool' : 'instagram';
const SITE_NAME = { instagram: 'Instagram', youtube: 'YouTube', skool: 'Skool' };

/* ── who is this page about? ──────────────────────────────────────
   Returns { platform, key, label, ids[] } or null. `key` identifies the
   subject for de-duplicating lookups; `ids` are what the CRM is asked about
   (a YouTube channel can be named by @handle AND by its channel id, and a
   lead may be stored under either). */

// Instagram: paths that are NOT profiles. Everything else at /<something>/ is one.
const IG_NON_PROFILE = new Set([
  'explore', 'reels', 'stories', 'direct', 'accounts', 'p', 'tv', 'about',
  'developer', 'legal', 'privacy', 'terms', 'your_activity', 'challenge',
  'emails', 'session', 'ajax', 'graphql', 'api', 'oauth', 'web',
]);
function instagramSubject() {
  const seg = location.pathname.split('/').filter(Boolean);
  if (!seg.length) return null;
  const h = seg[0].toLowerCase();
  if (IG_NON_PROFILE.has(h) || seg.length > 2) return null;
  if (!/^[a-z0-9._]{1,30}$/.test(h)) return null;
  return { platform: 'instagram', key: h, label: '@' + h, handle: h };
}

function youtubeSubject() {
  const p = location.pathname;
  const ids = [];
  let label = '';
  // A channel page: /@name, /channel/UC…, /c/name, /user/name (and their tabs).
  let m = p.match(/^\/(@[\w.\-]+)/);
  if (m) { ids.push('https://www.youtube.com/' + m[1]); label = m[1]; }
  m = p.match(/^\/channel\/(UC[\w\-]{10,})/);
  if (m) { ids.push('https://www.youtube.com/channel/' + m[1]); label = label || m[1]; }
  m = p.match(/^\/(c|user)\/([\w.\-]+)/);
  if (m) { ids.push(`https://www.youtube.com/${m[1]}/${m[2]}`); label = label || m[2]; }
  if (ids.length) {
    // On a channel page YouTube also says the canonical channel id.
    const canon = document.querySelector('link[rel="canonical"]');
    const cm = canon && canon.href.match(/\/channel\/(UC[\w\-]{10,})/);
    if (cm) ids.push('https://www.youtube.com/channel/' + cm[1]);
  } else if (p === '/watch' || p.startsWith('/shorts/')) {
    // A video: the channel is only known once the owner block has rendered.
    const a = document.querySelector('ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a, ytd-video-owner-renderer a[href^="/@"], ytd-reel-video-renderer[is-active] a[href^="/@"], ytd-reel-player-header-renderer a[href^="/@"]');
    const href = a && a.getAttribute('href') || '';
    const hm = href.match(/^\/(@[\w.\-]+)|^\/channel\/(UC[\w\-]{10,})/);
    if (!hm) return { pending: true };
    if (hm[1]) { ids.push('https://www.youtube.com/' + hm[1]); label = hm[1]; }
    if (hm[2]) { ids.push('https://www.youtube.com/channel/' + hm[2]); label = label || hm[2]; }
    const owner = document.querySelector('ytd-watch-flexy meta[itemprop="channelId"], meta[itemprop="channelId"]');
    if (owner && /^UC/.test(owner.content)) ids.push('https://www.youtube.com/channel/' + owner.content);
  }
  if (!ids.length) return null;
  return { platform: 'youtube', key: ids[0].toLowerCase(), label, ids: [...new Set(ids)] };
}

// Skool paths that are not communities.
const SKOOL_NON_COMMUNITY = new Set(['discovery', 'signup', 'login', 'settings', 'pricing', 'legal', 'terms', 'privacy',
  'chat', 'notifications', 'create', 'about', 'careers', 'affiliate', 'games', 'apps']);
function skoolSubject() {
  const seg = location.pathname.split('/').filter(Boolean);
  if (!seg.length) return null;
  if (seg[0].startsWith('@')) {
    /* A member's profile. A Skool lead is a community, so this person is
       matched through the communities listed under "Owned by …". Member-of
       communities are deliberately ignored: being in a group says nothing
       about who runs it. */
    const owned = skoolOwnedSlugs();
    // Still rendering: wait, but give up after ~8 s and treat it as owning none.
    if (owned === null && pendingTries < 15) return { pending: true };
    const person = seg[0];
    return { platform: 'skool', key: 'member:' + person.toLowerCase(), label: person, member: person,
      ids: (owned || []).map(s => 'https://www.skool.com/' + s) };
  }
  const slug = seg[0].toLowerCase();
  if (SKOOL_NON_COMMUNITY.has(slug) || !/^[a-z0-9][a-z0-9\-]{1,80}$/.test(slug)) return null;
  return { platform: 'skool', key: slug, label: slug, ids: ['https://www.skool.com/' + slug] };
}
/* The communities under the "Owned by …" heading, in page order up to the
   next heading ("Memberships"). null = the page has not rendered that part
   yet; [] = it has, and they own none. */
function skoolOwnedSlugs() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let inOwned = false, sawHeadings = false;
  const out = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const own = n.childNodes.length && [...n.childNodes].some(c => c.nodeType === 3 && /^\s*Owned by\b/i.test(c.textContent));
    const mem = n.childNodes.length && [...n.childNodes].some(c => c.nodeType === 3 && /^\s*Memberships?\b/i.test(c.textContent));
    if (own) { inOwned = true; sawHeadings = true; continue; }
    if (mem) { sawHeadings = true; if (inOwned) break; continue; }
    if (inOwned && n.tagName === 'A') {
      const m = (n.getAttribute('href') || '').match(/^\/([a-z0-9][a-z0-9\-]{1,80})(?:\/|$)/i);
      if (m && !SKOOL_NON_COMMUNITY.has(m[1].toLowerCase()) && !m[1].startsWith('@')) out.push(m[1].toLowerCase());
    }
  }
  if (!sawHeadings) return null;
  return [...new Set(out)];
}

function subject() {
  return SITE === 'youtube' ? youtubeSubject() : SITE === 'skool' ? skoolSubject() : instagramSubject();
}

/* YouTube enforces Trusted Types: element.innerHTML only accepts markup that
   went through a named policy. This one passes the string through unchanged —
   safe because every value in the panel's markup is esc()'d first. Sites
   without Trusted Types (or that refuse the policy) take the plain string. */
const ttPolicy = (() => {
  try { return window.trustedTypes && trustedTypes.createPolicy ? trustedTypes.createPolicy('spcrm-panel', { createHTML: x => x }) : null; }
  catch (e) { return null; }
})();
function setHTML(el, html) { el.innerHTML = ttPolicy ? ttPolicy.createHTML(html) : html; }

/* ── formatting ─────────────────────────────────────────────── */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtCount(n) {
  if (n === null || n === undefined || n === '') return '—';
  n = Number(n);
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

// YYYY-MM-DD as a short human date; anything else is passed through.
function fmtDay(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(s || '');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return +m[3] + ' ' + MON[+m[2] - 1] + ' ' + m[1];
}

/* The glass follows the site: light glass on a light page, dark on a dark one.
   Read from the page itself (YouTube and Instagram both have their own theme
   switch that the OS setting does not see). */
function siteIsDark() {
  if (SITE === 'youtube') return document.documentElement.hasAttribute('dark');
  const bg = getComputedStyle(document.body).backgroundColor || '';
  const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
  if (!m || (m[4] !== undefined && +m[4] === 0)) return matchMedia('(prefers-color-scheme: dark)').matches;
  return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255 < 0.5;
}

/* Tucked away: the panel slides off the right edge and leaves a small tab
   (in the same status colour) to slide it back. Remembered across pages and
   tabs, so it stays out of the way until you want it. × still closes it for
   this page only. */
const TAB_ID = 'spcrm-tab';
let tucked = false;
try { chrome.storage.local.get('spcrm_tucked').then(v => { tucked = !!(v && v.spcrm_tucked); applyTuck(); }).catch(() => {}); } catch (e) {}
function setTucked(v) {
  tucked = v; applyTuck();
  try { chrome.storage.local.set({ spcrm_tucked: v }); } catch (e) {}
}
function applyTuck() {
  const el = document.getElementById(PANEL_ID);
  let tab = document.getElementById(TAB_ID);
  if (!el) { if (tab) tab.remove(); return; }
  el.classList.toggle('spcrm-tucked', tucked);
  if (!tab) {
    tab = document.createElement('div');
    tab.id = TAB_ID;
    tab.title = 'Show the SuperProfile CRM panel';
    tab.setAttribute('role', 'button');
    setHTML(tab, '<span class="spcrm-tab-chev">‹</span><span class="spcrm-tab-icon">SP</span>');
    tab.addEventListener('click', () => setTucked(false));
    document.body.appendChild(tab);
  }
  // The tab carries the panel's status colour, so you can still read it tucked away.
  tab.className = (el.className.match(/spcrm-(exists|noemail|new|warn)/g) || []).join(' ') + (el.classList.contains('spcrm-dark') ? ' spcrm-dark' : '');
  tab.classList.toggle('spcrm-shown', tucked);
}

function ensurePanel() {
  let el = document.getElementById(PANEL_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = PANEL_ID;
    const ver = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?';
    setHTML(el, '<div class="spcrm-head"><span class="spcrm-icon">SP</span><b>SuperProfile CRM</b>'
      + `<span class="spcrm-site spcrm-p-${SITE}">${SITE_NAME[SITE]}</span><span class="spcrm-ver">v${ver}</span>`
      + '<span class="spcrm-hbtn spcrm-tuck" title="Slide to the side" role="button" aria-label="Slide to the side">›</span>'
      + '<span class="spcrm-hbtn spcrm-x" title="Close for this page" role="button" aria-label="Close">×</span></div><div class="spcrm-body"></div>');
    document.body.appendChild(el);
    el.querySelector('.spcrm-x').addEventListener('click', () => { el.remove(); applyTuck(); });
    el.querySelector('.spcrm-tuck').addEventListener('click', () => setTucked(true));
  }
  el.classList.toggle('spcrm-dark', siteIsDark());
  applyTuck();
  return el;
}

function row(k, v) { return `<div class="spcrm-row"><span class="spcrm-k">${esc(k)}</span><span class="spcrm-v">${v}</span></div>`; }

// Links back into the CRM. Other platforms pass &platform= so the CRM opens
// the right tab; the value is then the lead's stored key.
function crmLink(base, kind, subj, d) {
  if (subj.platform === 'instagram') return `${base}/?${kind}=${encodeURIComponent(subj.handle)}`;
  const v = kind === 'add' ? (subj.ids[0] || '') : (d.key || d.handle);
  return `${base}/?${kind}=${encodeURIComponent(v)}&platform=${subj.platform}`;
}

function render(subj, d) {
  const el = ensurePanel();
  const body = el.querySelector('.spcrm-body');
  el.classList.remove('spcrm-exists', 'spcrm-noemail', 'spcrm-new', 'spcrm-warn');

  if (d && d.error) {
    el.classList.add('spcrm-warn'); applyTuck();
    const msg = d.error === 'timeout' ? 'The extension’s background worker did not respond. Reload the extension at chrome://extensions, then reload this page.'
      : d.error === 'worker' ? 'Background worker error: ' + (d.detail || 'unknown')
      : d.error === 'no_key' ? 'Log in to the CRM in this browser (or add the team key via the extension icon).'
      : d.error === 'bad_key' ? 'The API key was rejected. Check it in the extension options.'
      : d.error === 'network' ? 'Could not reach the CRM.'
      : 'Lookup failed' + (d.detail ? ` — ${esc(d.detail)}` : '');
    setHTML(body, `<div class="spcrm-msg">${esc(msg)}</div>`);
    return;
  }
  const base = esc((d && d.base) || '');
  if (!d || !d.found) {
    el.classList.add('spcrm-new'); applyTuck();
    if (subj.member) {
      // A Skool member: none of the communities they own is a lead.
      setHTML(body, `<div class="spcrm-msg"><b>${esc(subj.label)}</b> `
        + (subj.ids.length ? (subj.ids.length === 1 ? 'owns a community that is not in the CRM.' : `owns ${subj.ids.length} communities, none of them in the CRM.`)
                           : 'does not own a Skool community, so there is nothing to match in the CRM.') + '</div>'
        + (subj.ids.length === 1 ? `<a class="spcrm-btn" href="${esc(crmLink(d && d.base || '', 'add', { ...subj, ids: subj.ids }, d || {}))}" target="_blank" rel="noopener">+ Add their community</a>` : ''));
      return;
    }
    setHTML(body, `<div class="spcrm-msg"><b>${esc(subj.label)}</b> is not in the CRM.</div>`
      + `<a class="spcrm-btn" href="${esc(crmLink(d && d.base || '', 'add', subj, d || {}))}" target="_blank" rel="noopener">+ Add lead</a>`);
    return;
  }

  el.classList.add(d.email ? 'spcrm-exists' : 'spcrm-noemail'); applyTuck();
  const crumb = (d.breadcrumb && d.breadcrumb.length)
    ? d.breadcrumb.map(esc).join(' <span class="spcrm-sep">›</span> ') : '';
  const ig = d.ig || {};
  const parts = [];
  if (subj.member) parts.push(`<div class="spcrm-via">Owner of <b>${esc(d.p_display || d.profile || '')}</b></div>`);
  parts.push(`<div class="spcrm-name">${esc(d.first_name || subj.label)}`
    + `<span class="spcrm-stage spcrm-s-${esc((d.stage || 'none').toLowerCase())}">${esc(d.stage || 'No stage')}</span></div>`);
  if (crumb) parts.push(`<div class="spcrm-crumb">${crumb}</div>`);
  const also = Array.isArray(d.also_on) ? d.also_on : [];
  if (also.length) {
    const PN = { instagram: 'Instagram', youtube: 'YouTube', skool: 'Skool', x: 'X' };
    parts.push('<div class="spcrm-also"><div class="spcrm-also-h">Also a lead on</div>' + also.map(o =>
      `<div class="spcrm-also-r"><span class="spcrm-p-${esc(o.platform)}">${esc(PN[o.platform] || o.platform)}</span>`
      + `<span class="spcrm-also-id">${esc(o.profile ? (o.platform === 'instagram' || o.platform === 'x' ? '@' + o.profile : o.profile) : '')}</span>`
      + `<span class="spcrm-stage spcrm-s-${esc((o.stage || 'none').toLowerCase())}">${esc(o.stage || '—')}</span></div>`).join('') + '</div>');
  }
  if (d.label) parts.push(row('Label', esc(d.label)));
  // Same two names the CRM grid uses: who sourced it, and the teammate who owns it.
  if (d.lead_owner) parts.push(row('Added by', esc(d.lead_owner)));
  if (d.lead_manager) parts.push(row('Lead Owner', esc(d.lead_manager)));
  if (d.email) parts.push(row('Email', esc(d.email)));
  if (d.category) parts.push(row('Category', esc(d.category)));
  if (subj.platform !== 'instagram' && d.p_audience != null) parts.push(row(subj.platform === 'youtube' ? 'Subscribers' : 'Members', esc(fmtCount(d.p_audience))));
  if (d.contacted && d.last_contact_at) parts.push(row('Contacted', fmtDate(d.last_contact_at)));
  if (d.replied && d.last_reply_at) parts.push(row('Replied', fmtDate(d.last_reply_at)));
  if (d.campaigns && d.campaigns.length) parts.push(row('Campaigns', esc(d.campaigns.join(', '))));
  if (subj.platform === 'instagram' && ig.checked_at) {
    parts.push(`<div class="spcrm-ig">${fmtCount(ig.followers)} followers`
      + ` · avg ${fmtCount(ig.avg_views_10)} views`
      + ` · last post ${ig.last_post_at ? fmtDate(ig.last_post_at) : '—'}</div>`);
  }
  // Partner first: having posted for us outranks anything in the pipeline.
  if (subj.platform === 'instagram') parts.push(partnerHtml(d, base, encodeURIComponent(subj.handle)));

  if (!d.email) {
    // Inline, so an email can be captured in the two seconds you are looking at
    // the page — leaving for the CRM is how it never gets filled in.
    parts.push('<div class="spcrm-flag">No email in DB</div>'
      + '<button class="spcrm-btn" id="spcrm-addmail">+ Add email</button>'
      + '<div class="spcrm-mailbox" hidden>'
      + '<input type="email" id="spcrm-mail" placeholder="name@example.com" autocomplete="off">'
      + '<button class="spcrm-btn spcrm-primary" id="spcrm-mailsave">Save</button>'
      + '<div class="spcrm-mailmsg"></div></div>');
  }
  /* Say what our relationship with this lead actually is. "Open Conversation"
     on someone who never replied would promise a thread that does not exist. */
  if (d.replied) {
    parts.push(`<a class="spcrm-btn spcrm-primary" href="${esc(crmLink(d.base || '', 'conv', subj, d))}" target="_blank" rel="noopener">Open Conversation →</a>`);
  } else {
    parts.push(`<div class="spcrm-state">${d.contacted ? 'Contacted but never replied' : 'Never contacted'}</div>`
      + `<a class="spcrm-btn" href="${esc(crmLink(d.base || '', 'lead', subj, d))}" target="_blank" rel="noopener">Open in CRM →</a>`);
  }
  setHTML(body, parts.join(''));
  wireAddEmail(body, subj, d);
}

/* Videos this creator has posted for us (Instagram). Shown above the pipeline
   detail, because "they already made us a video" is the single most useful
   thing to know when you land on a profile. */
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
    + '<div class="spcrm-ptag">★ Partner · ' + n + ' video' + (n === 1 ? '' : 's') + ' for us</div>'
    + '<div class="spcrm-pline">' + (when ? '<b>' + esc(when) + '</b>' : '<b>Latest</b>') + dead + '</div>'
    + (bits.length ? '<div class="spcrm-pstats">' + esc(bits.join(' · ')) + '</div>' : '')
    // The http(s) test is the real guard — never build an href from a stored
    // string without checking its scheme first.
    + (/^https?:\/\//i.test(v.url || '') ? '<a class="spcrm-plink" href="' + esc(v.url) + '" target="_blank" rel="noopener">View the post ↗</a>' : '')
    + '<a class="spcrm-btn" href="' + base + '/?videos=' + qh + '" target="_blank" rel="noopener">Open videos in CRM</a>'
    + '</div>';
}

function wireAddEmail(body, subj, d) {
  const btn = body.querySelector('#spcrm-addmail');
  if (!btn) return;
  const box = body.querySelector('.spcrm-mailbox');
  const input = body.querySelector('#spcrm-mail');
  const save = body.querySelector('#spcrm-mailsave');
  const msg = body.querySelector('.spcrm-mailmsg');
  btn.addEventListener('click', () => { box.hidden = false; btn.hidden = true; input.focus(); });
  const submit = async () => {
    const email = (input.value || '').trim();
    if (!email) return;
    save.disabled = true; msg.className = 'spcrm-mailmsg'; msg.textContent = 'Saving…';
    let r;
    try {
      r = await chrome.runtime.sendMessage({ type: 'setEmail', handle: subj.handle || '', key: subj.platform === 'instagram' ? '' : (d.key || ''), email, cacheKey: subj.key });
    } catch { r = { error: 'network', detail: 'extension reloaded — refresh the page' }; }
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
let pendingTries = 0;

async function update() {
  const subj = subject();
  if (subj && subj.pending) {
    // The page has not rendered the part that says who it is about yet.
    if (pendingTries++ < 16) setTimeout(update, 500);
    return;
  }
  pendingTries = 0;
  if (!subj) { const el = document.getElementById(PANEL_ID); if (el) el.remove(); applyTuck(); inflight = ''; return; }
  if (subj.key === inflight) return;   // same subject: leave the panel (or its closed state) alone
  inflight = subj.key;

  const el = ensurePanel();
  setHTML(el.querySelector('.spcrm-body'), `<div class="spcrm-msg">Checking <b>${esc(subj.label)}</b>…</div>`);

  let d;
  /* Race the worker against a timer. If the service worker dies mid-request
     the reply channel can stay open with nothing on the other end, and the
     panel would sit on "Checking…" with no way to tell something broke. */
  try {
    if (subj.member && !subj.ids.length) d = { found: false };
    else {
      const msg = subj.platform === 'instagram'
        ? { type: 'lookup', platform: 'instagram', handle: subj.handle, cacheKey: subj.key }
        : { type: 'lookup', platform: subj.platform, ids: subj.ids, cacheKey: subj.key };
      d = await Promise.race([
        chrome.runtime.sendMessage(msg),
        new Promise(r => setTimeout(() => r({ error: 'timeout' }), 10000)),
      ]);
    }
  } catch (e) { d = { error: 'network', detail: 'extension reloaded — refresh the page' }; }
  // The user may have navigated on while we waited.
  const now = subject();
  if (!now || now.pending || now.key !== subj.key) return;
  render(subj, d);
}

/* The History API fires no event of its own, so patch push/replaceState and
   listen for popstate; YouTube also announces its own navigations; the
   MutationObserver is the safety net for renders that change the URL any
   other way. */
function onRouteChange(fn) {
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    history[m] = function (...a) { const r = orig.apply(this, a); fn(); return r; };
  }
  window.addEventListener('popstate', fn);
  window.addEventListener('yt-navigate-finish', fn);
  let last = location.href;
  new MutationObserver(() => { if (location.href !== last) { last = location.href; fn(); } })
    .observe(document, { subtree: true, childList: true });
}

onRouteChange(() => { pendingTries = 0; setTimeout(update, 200); });
update();
