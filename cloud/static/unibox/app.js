/* SuperProfile CRM — frontend */
'use strict';

const $ = (id) => document.getElementById(id);
// Real buckets a lead can actually be in (what the backend computes).
const REAL_BUCKETS = [
  ['first_reply', '✉️ 1st Reply'],
  ['in_conversation', '💬 In Conversation'],
  ['followup_due', '🟠 Follow Up Now'],
  ['waiting', '🟢 Waiting on Them'],
  ['snoozed', '💤 Snoozed'],
  ['closed', '✅ Closed'],
];
// Tabs shown to the user. "needs_reply" is a combined view of the two reply buckets.
const TABS = [['needs_reply', '🔴 Needs Reply'], ...REAL_BUCKETS];
const BUCKET_NAME = Object.fromEntries([...REAL_BUCKETS, ['needs_reply', '🔴 Needs Reply']]);
function tabBuckets(tab) {
  return tab === 'needs_reply' ? ['first_reply', 'in_conversation'] : [tab];
}
// Plain-language "Action Required" label per bucket (used in the CSV export).
const ACTION_LABEL = {
  first_reply: '1st Reply', in_conversation: 'In Conversation',
  followup_due: 'Follow up now', waiting: 'Waiting on them',
  snoozed: 'Snoozed', closed: 'Closed',
};
// Chip colour tone per built-in status (custom statuses fall back to 'info').
const STATUS_TONE = {
  moved_to_wa: 'info', call_pitched: 'info', call_booked: 'good',
  partner_of_competitor: 'mut', rates_quoted: 'warn',
  closed: 'good', not_relevant: 'mut', failed: 'bad',
};

let state = {
  leads: [], counts: {}, campaigns: [], statuses: [], labels: [],
  status_counts: {}, label_counts: {}, last_sync: '', version: 0,
};
let activeTab = 'all';
let rateFilter = '';           // active rate-range bucket key when viewing Rates quoted
let sortOrder = 'newest';      // 'newest' | 'oldest' — order leads by last lead reply
let activeView = 'home';       // 'home' | 'campaigns' | 'analytics'
let csvTargetCampaign = null;  // campaign id chosen for a CSV upload
let campaignNameCache = {};    // id -> name, filled by the Campaigns view
let activeWs = 1;              // active workspace (Instantly account) id
let workspaces = [];           // [{id, name}]
let openLeadKey = null;
let me = null;
let team = [];
let templates = [];
let links = [];
const selectedCampaigns = new Set();

/* ── API helper ─────────────────────────────────────── */
async function api(path, body, method) {
  const opts = body === undefined && !method ? {} : {
    method: method || 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const r = await fetch(path, opts);
  if (r.status === 401) { showLogin(false); throw new Error('Not logged in'); }
  if (!r.ok) {
    let msg = 'Request failed';
    try { msg = (await r.json()).detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  return r.json();
}

function toast(msg, isError) {
  const t = $('toast');
  t.textContent = msg;
  t.style.borderColor = isError ? 'var(--red)' : 'var(--border)';
  t.style.display = 'block';
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.style.display = 'none'; }, 3000);
}

/* ── Status / label lookups ─────────────────────────── */
function statusByKey(key) { return state.statuses.find(s => s.key === key); }
function statusLabel(key) { const s = statusByKey(key); return s ? s.label : ''; }
function statusTone(key) { return STATUS_TONE[key] || 'info'; }

/* ── Time formatting ────────────────────────────────── */
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit',
  });
}
function daysBadge(lead) {
  const d = lead.days_waiting;
  if (d === null || d === undefined) return '';
  const nd = Math.round(d);
  const label = d < 1 ? 'today' : nd + (nd === 1 ? ' day' : ' days');
  if (lead.bucket === 'first_reply' || lead.bucket === 'in_conversation') return `⏰ ${label} unanswered`;
  if (lead.bucket === 'followup_due') return `${label} since your reply`;
  if (lead.bucket === 'waiting') return `replied ${label} ago`;
  if (lead.bucket === 'snoozed') return `until ${new Date(lead.snoozed_until).toLocaleDateString()}`;
  return label;
}

/* ── Login / setup ──────────────────────────────────── */
function showLogin(needsSetup) {
  $('login-view').style.display = 'flex';
  $('app').style.display = 'none';
  $('login-title').textContent = needsSetup ? 'Create admin account' : 'Sign in';
  $('login-sub').textContent = needsSetup
    ? 'First run — create the admin account for your team.'
    : 'SuperProfile CRM';
  $('login-display').style.display = needsSetup ? 'block' : 'none';
  $('login-btn').textContent = needsSetup ? 'Create account' : 'Sign in';
  $('login-btn').dataset.mode = needsSetup ? 'setup' : 'login';
}

async function submitLogin() {
  const mode = $('login-btn').dataset.mode;
  const body = {
    username: $('login-user').value.trim(),
    password: $('login-pass').value,
    display_name: $('login-display').value.trim(),
  };
  $('login-error').textContent = '';
  try {
    await api(mode === 'setup' ? '/api/setup' : '/api/login', body);
    location.reload();
  } catch (e) {
    $('login-error').textContent = e.message;
  }
}

/* ── State / rendering ──────────────────────────────── */
function filterParams() {
  const p = new URLSearchParams();
  p.set('ws', activeWs);
  if (selectedCampaigns.size) p.set('campaign', [...selectedCampaigns].join(','));
  if ($('poc-filter').value) p.set('poc', $('poc-filter').value);
  if ($('status-filter').value) p.set('status', $('status-filter').value);
  if ($('label-filter').value) p.set('label', $('label-filter').value);
  if ($('search').value.trim()) p.set('q', $('search').value.trim());
  if ($('date-from').value) p.set('date_from', $('date-from').value);
  if ($('date-to').value) p.set('date_to', $('date-to').value);
  return p.toString();
}

async function refresh() {
  try {
    state = await api('/api/state?' + filterParams());
  } catch (e) { return; }
  if ($('status-filter').value !== 'rates_quoted') rateFilter = '';
  renderCampaigns();
  renderStatusLabelFilters();
  renderTabs();
  renderList();
  renderSync();
  if (openLeadKey) loadThread(openLeadKey, true);
}

function renderSync() {
  const el = $('sync-pill');
  if (!state.last_sync) { el.textContent = 'sync pending…'; return; }
  const mins = (Date.now() - new Date(state.last_sync)) / 60000;
  $('sync-dot').className = 'sync-dot' + (mins > 5 ? ' stale' : '');
  el.textContent = mins < 1 ? 'synced just now' : `synced ${Math.round(mins)}m ago`;
}

function campaignBtnLabel() {
  if (!selectedCampaigns.size) return 'All campaigns ▾';
  if (selectedCampaigns.size === 1) {
    const c = state.campaigns.find(c => selectedCampaigns.has(c.id));
    return (c ? c.name : '1 campaign') + ' ▾';
  }
  return `${selectedCampaigns.size} campaigns ▾`;
}

function renderCampaigns() {
  const btn = $('campaign-btn');
  const menu = $('campaign-menu');
  btn.textContent = campaignBtnLabel();
  btn.classList.toggle('active', selectedCampaigns.size > 0);
  const prevSearch = menu.querySelector('.dd-search') ? menu.querySelector('.dd-search').value : '';
  menu.innerHTML =
    `<input class="dd-search" placeholder="🔎 Search campaigns…">` +
    `<button class="dd-clear">All campaigns (clear selection)</button>` +
    state.campaigns.map(c => `<label>
      <input type="checkbox" value="${escAttr(c.id)}" ${selectedCampaigns.has(c.id) ? 'checked' : ''}>
      ${esc(c.name)} (${c.leads})</label>`).join('');
  const search = menu.querySelector('.dd-search');
  const applySearch = () => {
    const v = search.value.trim().toLowerCase();
    menu.querySelectorAll('label').forEach(lb => {
      lb.style.display = lb.textContent.toLowerCase().includes(v) ? '' : 'none';
    });
  };
  search.oninput = applySearch;
  search.value = prevSearch;
  if (prevSearch) applySearch();
  menu.querySelector('.dd-clear').onclick = () => {
    selectedCampaigns.clear();
    refresh();
  };
  menu.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.onchange = () => {
      if (cb.checked) selectedCampaigns.add(cb.value);
      else selectedCampaigns.delete(cb.value);
      refresh();
    };
  });
}

function renderPocFilter() {
  const sel = $('poc-filter');
  const cur = sel.value;
  const myName = me ? (me.display_name || me.username) : '';
  sel.innerHTML = '<option value="">POC: anyone</option>' +
    (myName ? `<option value="${escAttr(myName)}">👤 My leads</option>` : '') +
    '<option value="unassigned">POC: unassigned</option>' +
    team.filter(n => n !== myName)
        .map(n => `<option value="${escAttr(n)}">POC: ${esc(n)}</option>`).join('');
  sel.value = cur;
}

function renderStatusLabelFilters() {
  const sf = $('status-filter');
  const curS = sf.value;
  sf.innerHTML = '<option value="">Status: any</option><option value="none">Status: none</option>' +
    state.statuses.map(s => `<option value="${escAttr(s.key)}">Status: ${esc(s.label)}</option>`).join('');
  sf.value = curS;

  const lf = $('label-filter');
  const curL = lf.value;
  lf.innerHTML = '<option value="">Label: any</option><option value="none">Label: none</option>' +
    state.labels.map(l => `<option value="${escAttr(l.name)}">Label: ${esc(l.name)}</option>`).join('');
  lf.value = curL;
}

function renderTabs() {
  const total = state.leads.length;
  let html = `<button class="tab ${activeTab === 'all' ? 'active' : ''}" data-tab="all">All<span class="n">${total}</span></button>`;
  for (const [key, label] of TABS) {
    const n = key === 'needs_reply'
      ? (state.counts.first_reply || 0) + (state.counts.in_conversation || 0)
      : (state.counts[key] || 0);
    html += `<button class="tab ${activeTab === key ? 'active' : ''}" data-tab="${key}">${label}<span class="n">${n}</span></button>`;
  }
  $('tabs').innerHTML = html;
  $('tabs').querySelectorAll('.tab').forEach(b =>
    b.onclick = () => { activeTab = b.dataset.tab; renderTabs(); renderList(); });
}

function sortLeads(leads) {
  // Order by when the lead last replied. Leads with no reply fall back to the
  // last message time so they still sort sensibly. Newest first by default.
  const key = l => l.last_lead_msg_at || l.last_msg_at || '';
  const dir = sortOrder === 'oldest' ? 1 : -1;
  return [...leads].sort((a, b) => dir * key(a).localeCompare(key(b)));
}

function socialHandle(url) {
  const m = String(url).match(/(?:instagram\.com|tiktok\.com|youtube\.com)\/@?([^/?#]+)/i);
  return m ? '@' + m[1] : 'profile';
}

// FX to USD for the manual-rate live preview (mirrors USD_PER in the worker).
const USD_PER = { '$': 1, '₹': 1 / 83, '€': 1.08, '£': 1.27, 'C$': 0.73, 'A$': 0.66 };

// Rate-range buckets (USD). [min, max) — max Infinity for the open-ended top.
const RATE_RANGES = [
  ['0-100', '$0–100', 0, 100],
  ['100-500', '$100–500', 100, 500],
  ['500-1000', '$500–1k', 500, 1000],
  ['1000-2000', '$1k–2k', 1000, 2000],
  ['2000+', '$2k+', 2000, Infinity],
];
function rateBucket(usd) {
  if (usd == null) return null;
  for (const [k, , lo, hi] of RATE_RANGES) if (usd >= lo && usd < hi) return k;
  return null;
}
function fmtUsd(n) { return '$' + Math.round(n).toLocaleString(); }
// Total in USD, with the original amount in brackets unless it was already USD.
function totalLabel(l) {
  const usd = fmtUsd(l.quoted_usd);
  if (!l.quoted_currency || l.quoted_currency === '$') return usd;
  return `${usd} (${l.quoted_currency}${Number(l.quoted_amount).toLocaleString()})`;
}
// Deliverable composition of a manual quote, e.g. "1 reel + 1 carousel".
function manualDeliverables(l) {
  try {
    return JSON.parse(l.quoted_all || '[]')
      .filter(x => x && x.u)
      .map(x => `${x.q} ${x.u}${x.q > 1 ? 's' : ''}`).join(' + ');
  } catch (e) { return ''; }
}
// Compact badge for lead cards: headline per-unit rate.
function quoteBadge(l) {
  if (l.quoted_usd == null) return '';
  const u = l.quoted_unit;
  if (u === 'mixed') return `${fmtUsd(l.quoted_per_unit_usd)}/deliverable`;
  if (u && u !== 'flat') return `${fmtUsd(l.quoted_per_unit_usd)}/${u}`;
  return `${fmtUsd(l.quoted_usd)} flat`;
}
// Full label for the drawer: per-unit · total for <deliverables> (₹original).
function quoteLabel(l) {
  if (l.quoted_usd == null) return '';
  const u = l.quoted_unit;
  if (l.quoted_source === 'manual') {
    const comp = manualDeliverables(l);
    const per = u === 'mixed' ? `${fmtUsd(l.quoted_per_unit_usd)}/deliverable` : `${fmtUsd(l.quoted_per_unit_usd)}/${u}`;
    return comp ? `${per} · ${totalLabel(l)} for ${comp}` : `${per} · ${totalLabel(l)}`;
  }
  if (u && u !== 'flat') {
    const per = `${fmtUsd(l.quoted_per_unit_usd)}/${u}`;
    return l.quoted_qty > 1 ? `${per} · ${totalLabel(l)} for ${l.quoted_qty} ${u}s` : `${per} · ${totalLabel(l)}`;
  }
  return `${totalLabel(l)} flat`;
}

function statusChip(l) {
  if (!l.status) return '';
  const auto = l.status_source === 'auto' ? ' <span class="auto-dot" title="auto-detected">✨</span>' : '';
  return `<span class="status-chip tone-${statusTone(l.status)}">${esc(statusLabel(l.status))}${auto}</span>`;
}

function leadRow(l) {
  const status = statusChip(l);
  const label = l.label ? `<span class="chip label-chip">🏷 ${esc(l.label)}</span>` : '';
  const poc = l.poc ? `<span class="chip poc">👤 ${esc(l.poc)}</span>` : '';
  const rate = l.quoted_usd != null
    ? `<span class="chip rate" title="${escAttr(quoteLabel(l))}">💰 ${esc(quoteBadge(l))}</span>` : '';
  const social = l.social_url
    ? `<a class="chip social" href="${escAttr(l.social_url)}" target="_blank"
         rel="noopener" onclick="event.stopPropagation()">📸 ${esc(socialHandle(l.social_url))}</a>` : '';
  return `<div class="lead" data-key="${escAttr(l.key)}">
    <div class="who">
      <div class="name">${esc(l.first_name || l.email.split('@')[0])} ${status}</div>
      <div class="mail">${esc(l.email)}</div>
    </div>
    <div class="preview">${esc(l.preview)}</div>
    ${label}${social}${poc}${rate}
    <span class="chip camp" title="${escAttr(l.campaign_name)}">${esc(l.campaign_name)}</span>
    <span class="badge b-${l.bucket}">${daysBadge(l)}</span>
  </div>`;
}

// Rate-range chip bar — shown only while viewing the "Rates quoted" status.
// Counts are over the leads currently in view that carry a quote.
function rateBarHtml() {
  if ($('status-filter').value !== 'rates_quoted') return '';
  const quoted = state.leads.filter(l => l.quoted_usd != null);
  const count = k => quoted.filter(l => rateBucket(l.quoted_per_unit_usd) === k).length;
  const chip = (k, lbl, n) =>
    `<button class="rate-chip ${rateFilter === k ? 'active' : ''}" data-rate="${k}">${lbl}<span class="n">${n}</span></button>`;
  let html = '<div class="rate-bar">';
  html += chip('', 'All rates', quoted.length);
  for (const [k, lbl] of RATE_RANGES) html += chip(k, lbl, count(k));
  html += '</div>';
  return html;
}

function renderList() {
  const el = $('list');
  const rateBar = rateBarHtml();
  const applyRate = ls => (rateFilter && rateBar)
    ? ls.filter(l => rateBucket(l.quoted_per_unit_usd) === rateFilter) : ls;
  let html = '';
  const groups = activeTab === 'all' ? REAL_BUCKETS.map(b => b[0]) : tabBuckets(activeTab);
  const showHeaders = groups.length > 1;
  let any = false;
  for (const bucket of groups) {
    const leads = applyRate(sortLeads(state.leads.filter(l => l.bucket === bucket)));
    if (!leads.length) continue;
    any = true;
    if (showHeaders) {
      html += `<div class="bucket-head">${BUCKET_NAME[bucket]} · ${leads.length}</div>`;
    }
    html += leads.map(leadRow).join('');
  }
  if (!any) html = '<div class="empty">No leads match these filters.</div>';
  el.innerHTML = rateBar + html;
  el.querySelectorAll('.rate-chip').forEach(b =>
    b.onclick = () => { rateFilter = b.dataset.rate; renderList(); });
  el.querySelectorAll('.lead').forEach(row =>
    row.onclick = () => openDrawer(row.dataset.key));
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escAttr(s) { return esc(s); }

/* ── Drawer ─────────────────────────────────────────── */
function currentLead() { return state.leads.find(l => l.key === openLeadKey); }

function openDrawer(key) {
  openLeadKey = key;
  $('overlay').style.display = 'block';
  $('drawer').classList.add('open');
  renderDrawerHead();
  $('thread').innerHTML = '<div class="empty">Loading conversation…</div>';
  loadThread(key, false);
}

function closeDrawer() {
  openLeadKey = null;
  $('overlay').style.display = 'none';
  $('drawer').classList.remove('open');
}

/* ── Manual quoted-rate override ────────────────────── */
const RATE_UNITS = ['reel', 'carousel', 'story'];
let rateLines = [{ qty: 1, unit: 'reel' }];

function renderRateLines() {
  $('r-lines').innerHTML = rateLines.map((ln, i) => `
    <div class="rate-line" data-i="${i}">
      <label class="fld">Quantity<input class="rl-qty" type="number" min="1" step="1" value="${ln.qty}"></label>
      <label class="fld">Per<select class="rl-unit">
        ${RATE_UNITS.map(u => `<option value="${u}" ${ln.unit === u ? 'selected' : ''}>${u}</option>`).join('')}
      </select></label>
      ${rateLines.length > 1 ? '<button type="button" class="rl-del" title="Remove">×</button>' : '<span></span>'}
    </div>`).join('');
  $('r-lines').querySelectorAll('.rate-line').forEach(row => {
    const i = +row.dataset.i;
    row.querySelector('.rl-qty').oninput = () => { syncRateLines(); updateRatePreview(); };
    row.querySelector('.rl-unit').onchange = () => { syncRateLines(); updateRatePreview(); };
    const del = row.querySelector('.rl-del');
    if (del) del.onclick = () => { syncRateLines(); rateLines.splice(i, 1); renderRateLines(); updateRatePreview(); };
  });
}

function syncRateLines() {
  const rows = $('r-lines').querySelectorAll('.rate-line');
  rateLines = [...rows].map(row => ({
    qty: Math.max(1, Math.round(Number(row.querySelector('.rl-qty').value) || 1)),
    unit: row.querySelector('.rl-unit').value,
  }));
  if (!rateLines.length) rateLines = [{ qty: 1, unit: 'reel' }];
}

function updateRatePreview() {
  const amt = Number($('r-amount').value);
  const cur = $('r-cur').value;
  if (!isFinite(amt) || amt <= 0) { $('r-prev').textContent = ''; return; }
  const totalQty = rateLines.reduce((s, l) => s + l.qty, 0) || 1;
  const fx = USD_PER[cur] || 1;
  const perUsd = Math.round((amt / totalQty) * fx), totUsd = Math.round(amt * fx);
  const orig = cur !== '$' ? ` (${cur}${amt.toLocaleString()})` : '';
  const comp = rateLines.map(l => `${l.qty} ${l.unit}${l.qty > 1 ? 's' : ''}`).join(' + ');
  const single = rateLines.length === 1;
  const perLabel = single ? `$${perUsd.toLocaleString()}/${rateLines[0].unit}` : `$${perUsd.toLocaleString()}/deliverable`;
  $('r-prev').textContent = `${perLabel} · $${totUsd.toLocaleString()}${orig} for ${comp}`;
}

function openRateModal() {
  const l = currentLead();
  if (!l) return;
  const manual = l.quoted_source === 'manual';
  $('r-amount').value = manual && l.quoted_amount != null ? l.quoted_amount : '';
  $('r-cur').value = l.quoted_currency && USD_PER[l.quoted_currency] ? l.quoted_currency : '$';
  $('r-other').value = manual ? (l.quoted_other || '') : '';
  rateLines = [{ qty: 1, unit: 'reel' }];
  if (manual) {
    try {
      const lines = JSON.parse(l.quoted_all || '[]')
        .filter(x => x && RATE_UNITS.includes(x.u))
        .map(x => ({ qty: Math.max(1, Math.round(x.q || 1)), unit: x.u }));
      if (lines.length) rateLines = lines;
    } catch (e) { /* ignore */ }
  }
  renderRateLines();
  $('r-auto').style.display = l.quoted_usd != null ? '' : 'none';
  $('rate-bg').dataset.key = l.key;
  updateRatePreview();
  $('rate-bg').style.display = 'flex';
}

async function saveRate() {
  const key = $('rate-bg').dataset.key;
  const amount = Number($('r-amount').value);
  if (!isFinite(amount) || amount <= 0) { toast('Enter an amount greater than 0', true); return; }
  syncRateLines();
  try {
    await api('/api/lead/rate', {
      key, amount, currency: $('r-cur').value,
      lines: rateLines, other: $('r-other').value.trim(),
    });
    $('rate-bg').style.display = 'none';
    await refresh();
    toast('Rate saved ✓');
  } catch (e) { toast(e.message, true); }
}

async function clearRate() {
  try {
    await api('/api/lead/rate', { key: $('rate-bg').dataset.key, clear: true });
    $('rate-bg').style.display = 'none';
    await refresh();
    toast('Reverted to auto ✓');
  } catch (e) { toast(e.message, true); }
}

function renderDrawerHead() {
  const l = currentLead();
  if (!l) return;
  $('d-name').textContent = l.first_name || l.email;
  $('d-mail').textContent = `${l.email} · ${l.campaign_name} · ${l.msg_count} messages`;

  let links = '';
  if (l.social_url) {
    links += `<a href="${escAttr(l.social_url)}" target="_blank" rel="noopener">📸 ${esc(socialHandle(l.social_url))}</a>`;
  }
  if (l.lead_owner) {
    links += `${links ? ' · ' : ''}Lead owner (Instantly): ${esc(l.lead_owner)}`;
  }
  if (l.quoted_usd != null) {
    let detail = quoteLabel(l);
    if (l.quoted_source !== 'manual') {
      try {
        const all = JSON.parse(l.quoted_all || '[]');
        if (all.length > 1) detail += ' · all: ' + all.map(q =>
          q.u && q.u !== 'flat' ? `${q.c}${Number(q.t).toLocaleString()}/${q.q} ${q.u}` : `${q.c}${Number(q.t).toLocaleString()}`).join(', ');
      } catch (e) { /* ignore */ }
    }
    const src = l.quoted_source === 'manual' ? ' <span title="manually set">✋</span>' : '';
    if (l.quoted_other) detail += ` · +${l.quoted_other}`;
    links += `${links ? ' · ' : ''}<span class="d-rate">💰 Quoted${src}: ${esc(detail)}</span> <span class="d-rate-edit" id="d-rate-edit">✏️ edit</span>`;
  } else {
    links += `${links ? ' · ' : ''}<span class="d-rate-edit" id="d-rate-edit">💰 + Set quoted rate</span>`;
  }
  // Jump to Instantly's unibox (with the lead's email pre-filled as a search —
  // Instantly can't deep-link to a single email). Useful for viewing native
  // attachments/images the API doesn't expose.
  const uniboxUrl = 'https://app.instantly.ai/app/unibox?search=' + encodeURIComponent(l.email);
  links += `${links ? ' · ' : ''}<a href="${escAttr(uniboxUrl)}" target="_blank" rel="noopener" class="d-instantly">Open in Instantly ↗</a>`;
  $('d-links').innerHTML = links;
  const rateEdit = document.getElementById('d-rate-edit');
  if (rateEdit) rateEdit.onclick = openRateModal;

  // Status select
  const stSel = $('d-status');
  stSel.innerHTML = '<option value="">— no status —</option>' +
    state.statuses.map(s => `<option value="${escAttr(s.key)}" ${l.status === s.key ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
  stSel.value = l.status || '';
  stSel.onchange = () => onStatusPick(stSel.value);

  // Label select
  const lbSel = $('d-label');
  lbSel.innerHTML = '<option value="">— no label —</option>' +
    state.labels.map(x => `<option value="${escAttr(x.name)}" ${l.label === x.name ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  lbSel.value = l.label || '';
  lbSel.onchange = async () => {
    try { await api('/api/lead/label', { key: openLeadKey, label: lbSel.value }); toast('Label updated ✓'); refresh(); }
    catch (e) { toast(e.message, true); }
  };

  // POC select
  const pocSel = $('d-poc');
  pocSel.innerHTML = '<option value="">— none —</option>' +
    team.map(n => `<option value="${escAttr(n)}" ${l.poc === n ? 'selected' : ''}>${esc(n)}</option>`).join('');
  pocSel.value = l.poc || '';
  pocSel.onchange = async () => {
    try {
      await api('/api/lead/poc', { key: openLeadKey, poc: pocSel.value });
      toast(pocSel.value ? `POC set to ${pocSel.value} ✓` : 'POC cleared ✓');
    } catch (e) { toast(e.message, true); }
  };

  renderDealPanel(l);

  // Snooze buttons
  let html = '';
  if (l.bucket === 'snoozed') {
    html += `<button class="sbtn" data-snooze="0">🔔 Unsnooze</button>`;
  } else {
    html += `<button class="sbtn" data-snooze="2">💤 2d</button>
             <button class="sbtn" data-snooze="5">💤 5d</button>
             <button class="sbtn" data-snooze="7">💤 7d</button>`;
  }
  $('d-actions').innerHTML = html;
  $('d-actions').querySelectorAll('[data-snooze]').forEach(b => b.onclick = async () => {
    try { await api('/api/lead/snooze', { key: openLeadKey, days: +b.dataset.snooze }); }
    catch (e) { toast(e.message, true); }
  });
}

function renderDealPanel(l) {
  const rows = [];
  if (l.status === 'closed') {
    if (l.deal_videos) rows.push(['Number of videos', l.deal_videos]);
    if (l.deal_budget) rows.push(['Budget', l.deal_budget]);
    if (l.deal_deliverables) rows.push(['Other deliverables', l.deal_deliverables]);
  }
  if (l.status === 'failed') {
    if (l.fail_reason) rows.push(['Reason', l.fail_reason === 'out_of_budget' ? 'Out of budget' : 'Other reasons']);
    if (l.fail_notes) rows.push(['Notes', l.fail_notes]);
  }
  if (l.rate_their_initial || l.rate_their_final || l.rate_our_initial || l.rate_our_final) {
    if (l.rate_their_initial) rows.push(['Their initial rate', l.rate_their_initial]);
    if (l.rate_their_final) rows.push(['Their final rate', l.rate_their_final]);
    if (l.rate_our_initial) rows.push(['Our initial rate', l.rate_our_initial]);
    if (l.rate_our_final) rows.push(['Our final rate', l.rate_our_final]);
  }
  const panel = $('d-deal');
  if (!rows.length) { panel.style.display = 'none'; panel.innerHTML = ''; return; }
  panel.style.display = 'block';
  panel.innerHTML = rows.map(([k, v]) =>
    `<div class="deal-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('') +
    `<button class="mini-edit" id="deal-edit">Edit details</button>`;
  $('deal-edit').onclick = () => openStatusModal(currentLead().status, true);
}

/* ── Status pick + detail modal ─────────────────────── */
function onStatusPick(key) {
  const st = key ? statusByKey(key) : null;
  if (st && st.form !== 'none') {
    openStatusModal(key, false);
  } else {
    saveStatus(key, {});
  }
}

async function saveStatus(key, data) {
  try {
    await api('/api/lead/status', { key: openLeadKey, status: key, data });
    toast(key ? `Status: ${statusLabel(key)} ✓` : 'Status cleared ✓');
    refresh();
  } catch (e) { toast(e.message, true); revertStatusSelect(); }
}

function revertStatusSelect() {
  const l = currentLead();
  if (l) $('d-status').value = l.status || '';
}

function rateFields(l) {
  return `
    <label class="fld">Their initial rate<input id="f-their-initial" value="${escAttr(l.rate_their_initial || '')}"></label>
    <label class="fld">Their final rate<input id="f-their-final" value="${escAttr(l.rate_their_final || '')}"></label>
    <label class="fld">Our initial rate<input id="f-our-initial" value="${escAttr(l.rate_our_initial || '')}"></label>
    <label class="fld">Our final rate<input id="f-our-final" value="${escAttr(l.rate_our_final || '')}"></label>`;
}
function readRates() {
  return {
    their_initial: $('f-their-initial').value.trim(),
    their_final: $('f-their-final').value.trim(),
    our_initial: $('f-our-initial').value.trim(),
    our_final: $('f-our-final').value.trim(),
  };
}

function openStatusModal(key, editing) {
  const l = currentLead();
  const st = statusByKey(key);
  if (!l || !st) return;
  $('sd-title').textContent = `${st.label} — details`;
  const fields = $('sd-fields');

  if (st.form === 'deal') {
    fields.innerHTML = `
      <label class="fld">Number of videos<input id="f-videos" value="${escAttr(l.deal_videos || '')}"></label>
      <label class="fld">Budget<input id="f-budget" value="${escAttr(l.deal_budget || '')}"></label>
      <label class="fld">Other deliverables<textarea id="f-deliverables">${esc(l.deal_deliverables || '')}</textarea></label>`;
    $('sd-save').onclick = () => {
      closeStatusModal();
      saveStatus(key, {
        videos: $('f-videos').value.trim(),
        budget: $('f-budget').value.trim(),
        deliverables: $('f-deliverables').value.trim(),
      });
    };
  } else if (st.form === 'rates') {
    fields.innerHTML = rateFields(l);
    $('sd-save').onclick = () => { closeStatusModal(); saveStatus(key, readRates()); };
  } else if (st.form === 'failure') {
    const reason = l.fail_reason || 'out_of_budget';
    fields.innerHTML = `
      <label class="fld">Reason for failure
        <select id="f-reason">
          <option value="out_of_budget" ${reason === 'out_of_budget' ? 'selected' : ''}>Out of budget</option>
          <option value="other" ${reason === 'other' ? 'selected' : ''}>Other reasons</option>
        </select>
      </label>
      <div id="f-reason-extra"></div>`;
    const renderExtra = () => {
      const r = $('f-reason').value;
      $('f-reason-extra').innerHTML = r === 'out_of_budget'
        ? rateFields(l)
        : `<label class="fld">What happened?<textarea id="f-notes">${esc(l.fail_notes || '')}</textarea></label>`;
    };
    renderExtra();
    $('f-reason').onchange = renderExtra;
    $('sd-save').onclick = () => {
      const r = $('f-reason').value;
      const data = { fail_reason: r };
      if (r === 'out_of_budget') Object.assign(data, readRates());
      else data.fail_notes = ($('f-notes') ? $('f-notes').value.trim() : '');
      closeStatusModal();
      saveStatus(key, data);
    };
  }
  $('status-bg').style.display = 'flex';
  $('status-bg').dataset.editing = editing ? '1' : '';
}

function closeStatusModal() {
  $('status-bg').style.display = 'none';
}

// Cut a message at the first sign of quoted reply history, so each message
// shows only its own new text.
function stripQuotedText(text) {
  text = String(text || '').replace(/\r/g, '');
  const cutRes = [
    /\n\s*On\b[^\n]*\bwrote:\s*(\n|$)/i,        // Gmail/Apple "On <date> X wrote:"
    /\n-{2,}\s*Original Message\s*-{2,}/i,       // Outlook
    /\n_{5,}/,                                    // Outlook divider line
    /\nFrom:\s?[^\n]+\n(?:Sent|Date|To):\s?[^\n]+/i, // Outlook header block
    /\n\s*>{1,}\s?[^\n]*/,                        // plain-text quote (> ...)
    /\nSent from my [^\n]*/i,
    /\nGet Outlook for [^\n]*/i,
  ];
  let cut = text.length;
  for (const re of cutRes) {
    const m = text.match(re);
    if (m && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).replace(/\n{3,}/g, '\n\n').trim();
}

// Extract just the new content of one email (HTML → text, quotes removed).
function cleanMessage(m) {
  let text;
  if (m.body_html) {
    const html = m.body_html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('blockquote, .gmail_quote, .gmail_extra, #appendonsend, #divRplyFwdMsg, style, script')
      .forEach(n => n.remove());
    // Preserve link targets: taking textContent alone drops <a> hrefs, so a
    // "media kit HERE" link becomes bare text. Inline the URL so it survives
    // and linkifyText can make it clickable.
    doc.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href') || '';
      const t = (a.textContent || '').trim();
      if (/^https?:\/\//i.test(href)) {
        a.textContent = (!t || t === href) ? href : (t.includes(href) ? t : `${t} (${href})`);
      } else if (/^mailto:/i.test(href)) {
        const email = href.slice(7);
        if (t && !t.includes('@')) a.textContent = `${t} (${email})`;
      }
    });
    text = doc.body ? doc.body.textContent : '';
  } else {
    text = m.body_text || m.preview || '';
  }
  return stripQuotedText(text) || '(no new text)';
}

// Escape text and turn bare URLs into clickable links, for the thread display.
// (cleanMessage strips the sent HTML down to text, so we re-link it here.)
function linkifyText(text) {
  const urlRe = /(https?:\/\/[^\s<]+)/g;
  let out = '', last = 0, m;
  while ((m = urlRe.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    let url = m[0], trail = '';
    const tm = url.match(/[.,;:!?)\]]+$/);
    if (tm) { trail = tm[0]; url = url.slice(0, url.length - trail.length); }
    out += `<a href="${escAttr(url)}" target="_blank" rel="noopener">${esc(url)}</a>` + esc(trail);
    last = m.index + m[0].length;
  }
  out += esc(text.slice(last));
  return out.replace(/\n/g, '<br>');
}

// Render one email as a chat bubble (shared by the current thread and the
// "Older campaigns" panel).
function renderMsg(m) {
  const them = m.ue_type === 2;
  const who = them ? esc(m.from_email || 'Lead') : `You (${esc(m.from_email || m.eaccount)})`;
  const clean = linkifyText(cleanMessage(m));
  return `<div class="msg ${them ? 'them' : 'us'}">
      <div class="meta"><b>${them ? '📩 ' : '↩️ '}${who}</b> · ${fmtDate(m.timestamp_email)}</div>
      <div class="bubble"><div class="msg-text">${clean}</div></div>
    </div>`;
}

async function loadThread(key, silent) {
  let data;
  try { data = await api('/api/thread?key=' + encodeURIComponent(key)); }
  catch (e) { if (!silent) toast(e.message, true); return; }
  if (key !== openLeadKey) return;
  renderDrawerHead();

  let html = '';
  // Newest reply first.
  const emails = [...data.emails].reverse();
  for (const m of emails) html += renderMsg(m);

  // "Older campaigns" — prior conversations with the same creator in other
  // campaigns. Collapsed by default; the button only shows when they exist.
  const others = data.other_threads || [];
  if (others.length) {
    html += `<button id="older-toggle" class="older-btn" aria-expanded="false">📁 Older campaigns (${others.length})</button>`;
    html += '<div id="older-wrap" class="older-wrap" hidden>';
    for (const t of others) {
      const first = fmtDate(t.emails[0].timestamp_email);
      const last = fmtDate(t.emails[t.emails.length - 1].timestamp_email);
      html += `<div class="older-camp">
        <div class="older-camp-head">📣 ${esc(t.campaign_name)} · ${t.emails.length} msg · ${first} – ${last}</div>`;
      for (const m of [...t.emails].reverse()) html += renderMsg(m);
      html += '</div>';
    }
    html += '</div>';
  }

  html += `<div class="section-title">Notes</div>`;
  html += data.notes.length
    ? data.notes.map(n => `<div class="note">${esc(n.text)}
        <div class="meta">${esc(n.author)} · ${fmtDate(n.created_at)}</div></div>`).join('')
    : '<div class="activity-row">No notes yet.</div>';

  if (data.activity.length) {
    html += `<div class="section-title">Activity</div>`;
    html += data.activity.map(a =>
      `<div class="activity-row">${fmtDate(a.created_at)} — <b>${esc(a.author)}</b> ${esc(a.kind.replace('_', ' '))}: ${esc(a.detail)}</div>`
    ).join('');
  }

  $('thread').innerHTML = html;
  const tgl = document.getElementById('older-toggle');
  if (tgl) tgl.onclick = () => {
    const w = document.getElementById('older-wrap');
    const show = w.hidden;
    w.hidden = !show;
    tgl.classList.toggle('open', show);
    tgl.setAttribute('aria-expanded', String(show));
  };
  if (!silent) $('thread').scrollTop = 0; // newest is at the top
}

// Ctrl/Cmd+K in the reply box: wrap the selected text in a link. Stored as
// [label](url) markdown, which the send path renders as a real <a> tag.
function insertLinkShortcut(e) {
  if (!((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K'))) return;
  e.preventDefault();
  const ta = $('reply-text');
  const s = ta.selectionStart, en = ta.selectionEnd;
  const sel = ta.value.slice(s, en);
  let url = window.prompt('Link URL:', 'https://');
  if (url === null) return;
  url = url.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const label = sel || window.prompt('Link text:', url) || url;
  const md = `[${label}](${url})`;
  ta.value = ta.value.slice(0, s) + md + ta.value.slice(en);
  const pos = s + md.length;
  ta.setSelectionRange(pos, pos);
  ta.focus();
}

async function sendReply() {
  const text = $('reply-text').value.trim();
  if (!text || !openLeadKey) return;
  const btn = $('send-btn');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    await api('/api/lead/reply', { key: openLeadKey, text });
    $('reply-text').value = '';
    toast('Reply sent ✓');
  } catch (e) {
    toast(e.message, true);
  }
  btn.disabled = false; btn.textContent = 'Send reply';
}

async function addNote() {
  const text = $('reply-text').value.trim();
  if (!text || !openLeadKey) return;
  try {
    await api('/api/lead/note', { key: openLeadKey, text });
    $('reply-text').value = '';
    toast('Note added ✓');
  } catch (e) { toast(e.message, true); }
}

/* ── Manage labels & statuses ───────────────────────── */
async function openManage() {
  $('manage-bg').style.display = 'flex';
  renderManage();
}
function renderManage() {
  $('label-list').innerHTML = state.labels.length
    ? state.labels.map(l => `<div class="manage-row"><span>${esc(l.name)}</span>
        <button class="row-x" data-del-label="${escAttr(l.name)}">✕</button></div>`).join('')
    : '<div class="activity-row">No labels yet.</div>';
  $('status-list').innerHTML = state.statuses.map(s => `<div class="manage-row">
      <span>${esc(s.label)}${s.builtin ? ' <span class="tagmini">built-in</span>' : ''}</span>
      ${s.builtin ? '' : `<button class="row-x" data-del-status="${escAttr(s.key)}">✕</button>`}
    </div>`).join('');

  $('label-list').querySelectorAll('[data-del-label]').forEach(b => b.onclick = async () => {
    if (!confirm(`Delete label "${b.dataset.delLabel}"? It will be removed from any leads that have it.`)) return;
    try { await api('/api/labels', { name: b.dataset.delLabel }, 'DELETE'); await refresh(); renderManage(); toast('Label deleted ✓'); }
    catch (e) { toast(e.message, true); }
  });
  $('status-list').querySelectorAll('[data-del-status]').forEach(b => b.onclick = async () => {
    if (!confirm(`Delete status "${statusLabel(b.dataset.delStatus)}"? Leads with it will be cleared.`)) return;
    try { await api('/api/statuses', { key: b.dataset.delStatus }, 'DELETE'); await refresh(); renderManage(); toast('Status deleted ✓'); }
    catch (e) { toast(e.message, true); }
  });
}

/* ── Stats ──────────────────────────────────────────── */
function openStats() {
  $('stats-bg').style.display = 'flex';
  const total = state.leads.length || 1;
  const statusRows = [['', 'No status'], ...state.statuses.map(s => [s.key, s.label])]
    .map(([k, lbl]) => [lbl, state.status_counts[k] || 0])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const labelRows = Object.entries(state.label_counts).sort((a, b) => b[1] - a[1]);

  const bar = (n) => `<div class="bar"><div class="bar-fill" style="width:${Math.round(n / total * 100)}%"></div></div>`;
  const section = (title, rows) => `<div class="stats-sec"><div class="manage-title">${title}</div>` +
    (rows.length ? rows.map(([lbl, n]) =>
      `<div class="stat-row"><span>${esc(lbl)}</span>${bar(n)}<b>${n}</b></div>`).join('')
      : '<div class="activity-row">Nothing yet.</div>') + '</div>';

  $('stats-body').innerHTML =
    `<div class="stat-total">${state.leads.length} leads in view</div>` +
    rateStatsHtml() +
    section('By status', statusRows) +
    section('By label', labelRows);
}

// Rate distribution (per-unit USD) + summary + a by-unit breakdown, over the
// leads currently in view.
function rateStatsHtml() {
  const withq = state.leads.filter(l => l.quoted_usd != null);
  if (!withq.length) return '';
  const pu = withq.map(l => l.quoted_per_unit_usd).sort((a, b) => a - b);
  const n = pu.length;
  const sum = pu.reduce((a, b) => a + b, 0);
  const median = n % 2 ? pu[(n - 1) / 2] : (pu[n / 2 - 1] + pu[n / 2]) / 2;
  const max = n || 1;
  const bar = c => `<div class="bar"><div class="bar-fill" style="width:${Math.round(c / max * 100)}%"></div></div>`;
  const summary = `<div class="rate-summary">
      <span><b>${n}</b> quoted</span>
      <span>min <b>${fmtUsd(pu[0])}</b></span>
      <span>median <b>${fmtUsd(median)}</b></span>
      <span>avg <b>${fmtUsd(sum / n)}</b></span>
      <span>max <b>${fmtUsd(pu[n - 1])}</b></span>
    </div>`;
  const dist = RATE_RANGES.map(([k, lbl]) => {
    const c = pu.filter(v => rateBucket(v) === k).length;
    return `<div class="stat-row"><span>${lbl}</span>${bar(c)}<b>${c}</b></div>`;
  }).join('');
  const byUnit = {};
  for (const l of withq) { const u = l.quoted_unit || 'flat'; byUnit[u] = (byUnit[u] || 0) + 1; }
  const unitRows = Object.entries(byUnit).sort((a, b) => b[1] - a[1]).map(([u, c]) =>
    `<div class="stat-row"><span>${esc(u === 'flat' ? 'flat / unspecified' : 'per ' + u)}</span>${bar(c)}<b>${c}</b></div>`).join('');
  return `<div class="stats-sec"><div class="manage-title">Rate per unit (USD)</div>${summary}${dist}</div>` +
    `<div class="stats-sec"><div class="manage-title">Quotes by unit</div>${unitRows}</div>`;
}

/* ── Member activity (admin) ────────────────────────── */
function openActivity() {
  $('activity-bg').style.display = 'flex';
  renderActivity();
}

async function renderActivity() {
  const p = new URLSearchParams();
  if ($('act-from').value) p.set('from', $('act-from').value);
  if ($('act-to').value) p.set('to', $('act-to').value);
  let d;
  try { d = await api('/api/activity/summary?' + p.toString()); }
  catch (e) { toast(e.message, true); return; }
  if (!d.rows.length) { $('activity-body').innerHTML = '<div class="activity-row">No activity in this range.</div>'; return; }
  const cols = [['replies', 'Replies'], ['statuses', 'Statuses'], ['notes', 'Notes'],
    ['labels', 'Labels'], ['poc', 'POC'], ['rates', 'Rates'], ['total', 'Total']];
  let html = '<table class="act-table"><thead><tr><th>Member</th>' +
    cols.map(c => `<th class="num">${c[1]}</th>`).join('') + '</tr></thead><tbody>';
  for (const r of d.rows) {
    html += `<tr><td>${esc(r.author)}</td>` +
      cols.map(c => `<td class="num ${c[0] === 'replies' ? 'strong' : ''}">${r[c[0]]}</td>`).join('') + '</tr>';
  }
  html += '</tbody></table>';
  $('activity-body').innerHTML = html;
}

/* ── Workspaces (multiple Instantly accounts) ───────── */
async function loadWorkspaces() {
  try { workspaces = (await api('/api/workspaces')).workspaces || []; }
  catch (e) { workspaces = []; }
  if (!workspaces.length) workspaces = [{ id: 1, name: 'SuperProfile' }];
  const stored = Number(localStorage.getItem('activeWs'));
  activeWs = workspaces.some(w => w.id === stored) ? stored : workspaces[0].id;
  renderWsSelect();
}

function renderWsSelect() {
  const sel = $('ws-select');
  sel.innerHTML = workspaces.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('');
  sel.value = String(activeWs);
  // Hide the switcher entirely if there's only one workspace and no admin controls.
  sel.style.display = workspaces.length > 1 || (me && me.is_admin) ? '' : 'none';
}

function onWorkspaceChange() {
  activeWs = Number($('ws-select').value) || 1;
  localStorage.setItem('activeWs', String(activeWs));
  selectedCampaigns.clear();
  refresh();
  if (activeView === 'campaigns') renderCampaignsView();
  if (activeView === 'analytics') loadAnalytics();
}

function openWsModal() {
  $('ws-msg').textContent = '';
  $('ws-name').value = ''; $('ws-key').value = '';
  renderWsList();
  $('ws-bg').style.display = 'flex';
}

function renderWsList() {
  $('ws-list').innerHTML = workspaces.map(w => `
    <div class="ws-row"><span class="ws-nm">${esc(w.name)}</span>
      ${workspaces.length > 1 ? `<button class="ws-del" data-del="${w.id}">Remove</button>` : ''}
    </div>`).join('');
  $('ws-list').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const w = workspaces.find(x => x.id === Number(b.dataset.del));
    if (!confirm(`Remove workspace "${w ? w.name : ''}"?\n\nThis deletes its synced campaigns, leads and conversations from the CRM (the Instantly account itself is untouched).`)) return;
    try {
      await api('/api/workspaces', { id: Number(b.dataset.del) }, 'DELETE');
      if (activeWs === Number(b.dataset.del)) { activeWs = 1; localStorage.setItem('activeWs', '1'); }
      await loadWorkspaces(); renderWsList(); refresh(); toast('Workspace removed');
    } catch (e) { toast(e.message, true); }
  });
}

async function addWorkspace() {
  const name = $('ws-name').value.trim();
  const api_key = $('ws-key').value.trim();
  if (!name || !api_key) { $('ws-msg').textContent = 'Enter a name and API key.'; return; }
  $('ws-msg').textContent = 'Checking the API key & importing…';
  try {
    const res = await api('/api/workspaces', { name, api_key });
    await loadWorkspaces();
    activeWs = res.id; localStorage.setItem('activeWs', String(res.id));
    renderWsSelect(); renderWsList();
    $('ws-name').value = ''; $('ws-key').value = '';
    $('ws-msg').textContent = '';
    $('ws-bg').style.display = 'none';
    refresh();
    toast(`Workspace "${res.name}" added ✓`);
  } catch (e) { $('ws-msg').textContent = e.message; }
}

/* ── Sidebar views: Home / Campaigns / Analytics ────── */
function switchView(view) {
  activeView = view;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('view-home').style.display = view === 'home' ? 'flex' : 'none';
  $('view-campaigns').style.display = view === 'campaigns' ? 'block' : 'none';
  $('view-analytics').style.display = view === 'analytics' ? 'block' : 'none';
  if (view === 'campaigns') renderCampaignsView();
  if (view === 'analytics') loadAnalytics();
}

function campStatusLabel(s) {
  return ({ '1': 'Active', '2': 'Paused', '3': 'Completed', '4': 'Subsequences', '0': 'Draft', '-99': 'Draft' })[String(s)] || 'Campaign';
}

async function renderCampaignsView() {
  const el = $('campaigns-list');
  el.innerHTML = '<div class="empty">Loading campaigns…</div>';
  let camps;
  try { camps = (await api('/api/campaigns?ws=' + activeWs)).campaigns || []; }
  catch (e) { el.innerHTML = `<div class="empty">Couldn't load campaigns: ${esc(e.message)}</div>`; return; }
  if (!camps.length) { el.innerHTML = '<div class="empty">No campaigns found.</div>'; return; }
  campaignNameCache = Object.fromEntries(camps.map(c => [c.id, c.name]));
  el.innerHTML = camps.map(c => `
    <div class="camp-card">
      <span class="cc-name" title="${escAttr(c.name || '')}">${esc(c.name || '(unnamed)')}</span>
      <span class="cc-status ${String(c.status) === '1' ? 'active' : ''}">${campStatusLabel(c.status)}</span>
      <button class="hbtn" data-add="${escAttr(c.id)}">⬆ Add Leads (CSV)</button>
    </div>`).join('');
  el.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
    csvTargetCampaign = b.dataset.add;
    $('csv-input').value = '';
    $('csv-input').click();
  });
}

// Minimal RFC-4180-ish CSV parser (handles quotes, commas, newlines).
function parseCSV(text) {
  text = String(text).replace(/^﻿/, '');
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') { inQ = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') { field += c; }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows.shift().map(h => h.trim());
  return { headers, rows: rows.filter(r => r.some(v => (v || '').trim() !== '')) };
}

const CSV_NATIVE = {
  first_name: ['first_name', 'firstname', 'first name', 'fname'],
  last_name: ['last_name', 'lastname', 'last name', 'lname'],
  company_name: ['company', 'company_name', 'company name', 'organization'],
  phone: ['phone', 'phone_number', 'phone number', 'mobile'],
  website: ['website', 'url', 'site'],
};
function csvNativeField(header) {
  const k = header.trim().toLowerCase();
  for (const [field, aliases] of Object.entries(CSV_NATIVE)) if (aliases.includes(k)) return field;
  return null;
}
// Turn CSV text into Instantly lead objects. email is required; recognised
// headers map to native fields, everything else becomes a custom variable.
function csvToLeads(text) {
  const { headers, rows } = parseCSV(text);
  if (!headers.length) throw new Error('The CSV appears to be empty.');
  const emailIdx = headers.findIndex(h => /e-?mail/i.test(h));
  if (emailIdx < 0) throw new Error('The CSV needs a column named "email".');
  const leads = [];
  for (const r of rows) {
    const email = (r[emailIdx] || '').trim();
    if (!email) continue;
    const lead = { email };
    const cv = {};
    headers.forEach((h, i) => {
      if (i === emailIdx) return;
      const val = (r[i] || '').trim();
      if (!val) return;
      const nf = csvNativeField(h);
      if (nf) lead[nf] = val; else cv[h.trim()] = val;
    });
    if (Object.keys(cv).length) lead.custom_variables = cv;
    leads.push(lead);
  }
  return leads;
}

async function handleCsvUpload(e) {
  const file = e.target.files && e.target.files[0];
  if (!file || !csvTargetCampaign) return;
  let leads;
  try { leads = csvToLeads(await file.text()); }
  catch (err) { toast(err.message, true); return; }
  if (!leads.length) { toast('No rows with an email found in the CSV.', true); return; }
  const name = campaignNameCache[csvTargetCampaign] || 'this campaign';
  if (!confirm(`Upload ${leads.length} lead(s) to "${name}"?\n\nThey enter the Instantly campaign and will be emailed per its sequence. This cannot be undone.`)) return;
  toast(`Uploading ${leads.length} lead(s) to Instantly…`);
  try {
    const res = await api('/api/campaigns/add-leads', { campaign_id: csvTargetCampaign, leads });
    toast(`✓ Sent ${res.sent} lead(s) to "${name}"`);
  } catch (err) { toast(err.message, true); }
}

let analyticsRows = [];   // last-fetched analytics, re-rendered on search

async function loadAnalytics() {
  const el = $('analytics-body');
  el.innerHTML = '<div class="empty">Loading analytics from Instantly…</div>';
  try { analyticsRows = (await api('/api/analytics?ws=' + activeWs)).campaigns || []; }
  catch (e) { el.innerHTML = `<div class="empty">Couldn't load analytics: ${esc(e.message)}</div>`; return; }
  renderAnalytics();
}

function renderAnalytics() {
  const el = $('analytics-body');
  const q = ($('analytics-search').value || '').trim().toLowerCase();
  let rows = analyticsRows.filter(r => !q || (r.campaign_name || '').toLowerCase().includes(q));
  if (!rows.length) { el.innerHTML = '<div class="empty">No campaigns match.</div>'; return; }
  const n = v => (v || 0).toLocaleString();
  // Rates capped at 100% — Apple Mail Privacy / bots can push raw opens above
  // the number contacted, which would otherwise read as a nonsensical >100%.
  const pct = (a, b) => b ? Math.min(100, Math.round(a / b * 1000) / 10) + '%' : '—';
  const reply = r => (r.reply_count_unique != null ? r.reply_count_unique : r.reply_count) || 0;
  const open = r => (r.open_count_unique != null ? r.open_count_unique : r.open_count) || 0;
  // Unique leads emailed at least once (Instantly's contacted_count counts send
  // events, ~= emails sent). Leads uploaded = active + already completed.
  const sends = r => r.new_leads_contacted_count || 0;
  const uploaded = r => (r.leads_count || 0) + (r.completed_count || 0);
  // Newest campaigns first (by Instantly creation time); unknown dates sort last.
  rows = rows.slice().sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  const cols = [
    ['Campaign', r => `<span title="${escAttr(r.campaign_name || '')}">${esc(r.campaign_name || '—')}</span>`],
    ['Leads uploaded', r => n(uploaded(r)), 'Total leads that entered the campaign (currently active + already completed the sequence).'],
    ['Contacted', r => n(sends(r)), 'Unique leads emailed at least once — each lead counted once, not per follow-up. ("Sent" is the total email count.)'],
    ['Sent', r => n(r.emails_sent_count), 'Total emails sent, including follow-ups.'],
    ['Replies', r => n(reply(r))],
    ['Reply %', r => pct(reply(r), sends(r)), 'Unique replies ÷ unique leads contacted.'],
    ['Opens', r => n(open(r))],
    ['Open %', r => pct(open(r), sends(r)), 'Unique opens ÷ unique leads contacted (capped at 100%; opens are inflated by Apple Mail Privacy & bots).'],
    ['Bounced', r => n(r.bounced_count)],
    ['Unsub', r => n(r.unsubscribed_count)],
  ];
  const t = rows.reduce((a, r) => {
    a.leads += uploaded(r); a.contacted += sends(r); a.sent += r.emails_sent_count || 0;
    a.replies += reply(r); a.opens += open(r); a.bounced += r.bounced_count || 0; a.unsub += r.unsubscribed_count || 0;
    return a;
  }, { leads: 0, contacted: 0, sent: 0, replies: 0, opens: 0, bounced: 0, unsub: 0 });
  let html = '<div class="table-wrap"><table class="analytics-table"><thead><tr>' +
    cols.map(c => `<th${c[2] ? ` title="${escAttr(c[2])}"` : ''}>${c[0]}</th>`).join('') + '</tr></thead><tbody>';
  html += rows.map(r => '<tr>' + cols.map(c => `<td>${c[1](r)}</td>`).join('') + '</tr>').join('');
  html += `</tbody><tfoot><tr><td>All campaigns (${rows.length})</td><td>${n(t.leads)}</td><td>${n(t.contacted)}</td>` +
    `<td>${n(t.sent)}</td><td>${n(t.replies)}</td><td>${pct(t.replies, t.contacted)}</td>` +
    `<td>${n(t.opens)}</td><td>${pct(t.opens, t.contacted)}</td><td>${n(t.bounced)}</td><td>${n(t.unsub)}</td></tr></tfoot>`;
  html += '</table></div>';
  el.innerHTML = html;
}

/* ── CSV export ─────────────────────────────────────── */
// The leads currently visible = filters (already applied server-side in
// state.leads) narrowed to the active bucket tab.
function visibleLeads() {
  const groups = new Set(activeTab === 'all' ? REAL_BUCKETS.map(b => b[0]) : tabBuckets(activeTab));
  let ls = state.leads.filter(l => groups.has(l.bucket));
  if (rateFilter && $('status-filter').value === 'rates_quoted') {
    ls = ls.filter(l => rateBucket(l.quoted_per_unit_usd) === rateFilter);
  }
  return ls;
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportCsv() {
  const leads = visibleLeads();
  if (!leads.length) { toast('No leads to export', true); return; }
  const cols = [
    ['Name', l => l.first_name || l.email.split('@')[0]],
    ['Email', l => l.email],
    ['Action Required', l => ACTION_LABEL[l.bucket] || l.bucket],
    ['Status', l => statusLabel(l.status)],
    ['Label', l => l.label],
    ['POC', l => l.poc],
    ['Campaign', l => l.campaign_name],
    ['Instagram / Social', l => l.social_url],
    ['Per-unit rate (USD)', l => l.quoted_per_unit_usd != null ? Math.round(l.quoted_per_unit_usd) : ''],
    ['Unit', l => l.quoted_unit && l.quoted_unit !== 'flat' ? l.quoted_unit : ''],
    ['Quantity', l => l.quoted_qty != null ? l.quoted_qty : ''],
    ['Quote total (USD)', l => l.quoted_usd != null ? Math.round(l.quoted_usd) : ''],
    ['Quote total (original)', l => l.quoted_usd != null && l.quoted_currency && l.quoted_currency !== '$'
      ? l.quoted_currency + Number(l.quoted_amount).toLocaleString() : ''],
    ['Other deliverables', l => l.quoted_other],
    ['Days waiting', l => l.days_waiting],
    ['Messages', l => l.msg_count],
    ['Last message', l => l.last_msg_at ? new Date(l.last_msg_at).toLocaleString() : ''],
    ['Videos (Closed)', l => l.deal_videos],
    ['Budget (Closed)', l => l.deal_budget],
    ['Deliverables (Closed)', l => l.deal_deliverables],
    ['Fail reason', l => l.fail_reason === 'out_of_budget' ? 'Out of budget' : (l.fail_reason ? 'Other' : '')],
    ['Their initial rate', l => l.rate_their_initial],
    ['Their final rate', l => l.rate_their_final],
    ['Our initial rate', l => l.rate_our_initial],
    ['Our final rate', l => l.rate_our_final],
  ];
  const lines = [cols.map(c => csvCell(c[0])).join(',')];
  for (const l of leads) lines.push(cols.map(c => csvCell(c[1](l))).join(','));
  // Leading BOM so Excel reads UTF-8 (₹, accents) correctly.
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const tag = activeTab === 'all' ? 'all' : activeTab;
  a.href = url;
  a.download = `crm-leads-${tag}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast(`Exported ${leads.length} leads ✓`);
}

/* ── Reply templates ────────────────────────────────── */
async function loadTemplates() {
  try { templates = (await api('/api/templates')).templates; }
  catch (e) { templates = []; }
}

// Fill the auto-substituted placeholders for the open lead + current user.
function applyTemplate(bodyText) {
  const l = currentLead();
  const leadName = l ? (l.first_name || (l.email || '').split('@')[0]) : '';
  const yourName = me ? (me.display_name || me.username) : '';
  const booking = (me && me.booking_link) || '';
  return bodyText
    .replace(/\{\{\s*(lead\s*name|firstname|first\s*name)\s*\}\}/gi, leadName)
    .replace(/\{\{\s*your\s*name\s*\}\}/gi, yourName)
    .replace(/\*{0,2}\{{1,2}\s*meeting\s*link\s*\}{1,2}\*{0,2}/gi, booking || '{{MEETING LINK}}');
}

function pasteTemplate(t) {
  if (!openLeadKey) { toast('Open a lead first', true); return; }
  $('reply-text').value = applyTemplate(t.body);
  $('reply-text').focus();
  $('tpl-menu').classList.remove('open');
  if ((!me || !me.booking_link) && /meeting\s*link/i.test(t.body)) {
    toast('Tip: set your booking link in Templates to auto-fill {{MEETING LINK}}');
  } else {
    toast(`Pasted "${t.name}" — edit and send`);
  }
}

function renderTplMenu() {
  const menu = $('tpl-menu');
  menu.innerHTML =
    (templates.length
      ? templates.map(t => `<button class="tpl-item" data-id="${t.id}">${esc(t.name)}</button>`).join('')
      : '<div class="activity-row" style="padding:6px 8px">No templates yet.</div>') +
    `<button class="tpl-item manage" id="tpl-manage-open">✏️ Manage templates…</button>`;
  menu.querySelectorAll('.tpl-item[data-id]').forEach(b => b.onclick = () => {
    const t = templates.find(x => x.id == b.dataset.id);
    if (t) pasteTemplate(t);
  });
  $('tpl-manage-open').onclick = openTplManage;
}

function openTplManage() {
  $('tpl-menu').classList.remove('open');
  $('tpl-manage-bg').style.display = 'flex';
  $('booking-link').value = (me && me.booking_link) || '';
  $('tpl-editor').style.display = 'none';
  renderTplList();
}

function renderTplList() {
  $('tpl-list').innerHTML = templates.length
    ? templates.map(t => `<div class="manage-row"><span>${esc(t.name)}</span>
        <span><button class="mini-edit" data-edit="${t.id}">Edit</button>
        <button class="row-x" data-del="${t.id}">✕</button></span></div>`).join('')
    : '<div class="activity-row">No templates yet.</div>';
  $('tpl-list').querySelectorAll('[data-edit]').forEach(b => b.onclick = () =>
    openTplEditor(templates.find(x => x.id == b.dataset.edit)));
  $('tpl-list').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this template? This affects the whole team.')) return;
    try { await api('/api/templates', { id: +b.dataset.del }, 'DELETE'); await loadTemplates(); renderTplList(); renderTplMenu(); toast('Template deleted ✓'); }
    catch (e) { toast(e.message, true); }
  });
}

function openTplEditor(t) {
  $('tpl-editor').style.display = 'block';
  $('tpl-editor-title').textContent = t ? 'Edit template' : 'New template';
  $('tpl-name').value = t ? t.name : '';
  $('tpl-body').value = t ? t.body : '';
  $('tpl-editor').dataset.id = t ? t.id : '';
  $('tpl-name').focus();
}

/* ── Quick-copy links ───────────────────────────────── */
async function loadLinks() {
  try { links = (await api('/api/links')).links || []; }
  catch (e) { links = []; }
}

async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (_) { return false; }
  }
}

async function copyLink(link) {
  $('links-menu').classList.remove('open');
  const ok = await copyToClipboard(link.url);
  toast(ok ? `Copied "${link.name}" link ✓ — paste anywhere` : link.url, !ok);
}

function renderLinksMenu() {
  const menu = $('links-menu');
  menu.innerHTML =
    (links.length
      ? links.map(l => `<button class="tpl-item" data-id="${l.id}" title="${escAttr(l.url)}">${esc(l.name)}</button>`).join('')
      : '<div class="activity-row" style="padding:6px 8px">No links yet.</div>') +
    `<button class="tpl-item manage" id="links-manage-open">✏️ Manage links…</button>`;
  menu.querySelectorAll('.tpl-item[data-id]').forEach(b => b.onclick = () => {
    const l = links.find(x => x.id == b.dataset.id);
    if (l) copyLink(l);
  });
  $('links-manage-open').onclick = openLinksManage;
}

function openLinksManage() {
  $('links-menu').classList.remove('open');
  $('links-manage-bg').style.display = 'flex';
  $('link-editor').style.display = 'none';
  renderLinksList();
}

function renderLinksList() {
  $('links-list').innerHTML = links.length
    ? links.map(l => `<div class="manage-row"><span title="${escAttr(l.url)}">${esc(l.name)}</span>
        <span><button class="mini-edit" data-edit="${l.id}">Edit</button>
        <button class="row-x" data-del="${l.id}">✕</button></span></div>`).join('')
    : '<div class="activity-row">No links yet.</div>';
  $('links-list').querySelectorAll('[data-edit]').forEach(b => b.onclick = () =>
    openLinkEditor(links.find(x => x.id == b.dataset.edit)));
  $('links-list').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this link? This affects the whole team.')) return;
    try { await api('/api/links', { id: +b.dataset.del }, 'DELETE'); await loadLinks(); renderLinksList(); renderLinksMenu(); toast('Link deleted ✓'); }
    catch (e) { toast(e.message, true); }
  });
}

function openLinkEditor(l) {
  $('link-editor').style.display = 'block';
  $('link-editor-title').textContent = l ? 'Edit link' : 'New link';
  $('link-name').value = l ? l.name : '';
  $('link-url').value = l ? l.url : '';
  $('link-editor').dataset.id = l ? l.id : '';
  $('link-name').focus();
}

/* ── Team modal ─────────────────────────────────────── */
async function openTeam() {
  $('modal-bg').style.display = 'flex';
  try {
    const d = await api('/api/users');
    $('user-list').innerHTML = d.users.map(u =>
      `<div class="user-row"><span>${esc(u.display_name || u.username)} (${esc(u.username)})</span>
       <span>${u.is_admin ? 'admin' : 'member'}</span></div>`).join('');
  } catch (e) { $('user-list').innerHTML = ''; }
}

async function addUser() {
  try {
    await api('/api/users', {
      username: $('nu-user').value.trim(),
      password: $('nu-pass').value,
      display_name: $('nu-display').value.trim(),
      is_admin: $('nu-admin').checked,
    });
    $('nu-user').value = $('nu-pass').value = $('nu-display').value = '';
    $('nu-admin').checked = false;
    toast('Teammate added ✓');
    try { team = (await api('/api/team')).team; } catch (e) {}
    renderPocFilter();
    openTeam();
  } catch (e) { toast(e.message, true); }
}

/* ── Live updates (poll the version counter — cheap) ── */
function startEvents() {
  const check = async () => {
    if (document.hidden) return;
    try {
      const d = await api('/api/version');
      if (d.last_sync) { state.last_sync = d.last_sync; renderSync(); }
      if (d.version !== undefined && d.version !== state.version) refresh();
    } catch (e) { /* transient network error — next tick retries */ }
  };
  setInterval(check, 8000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}

/* ── Init ───────────────────────────────────────────── */
async function init() {
  const info = await api('/api/me');
  if (!info.user) { showLogin(info.needs_setup); return; }
  me = info.user;
  $('login-view').style.display = 'none';
  $('app').style.display = 'flex';
  $('who').textContent = me.display_name || me.username;
  $('team-btn').style.display = me.is_admin ? 'inline-block' : 'none';
  $('activity-btn').style.display = me.is_admin ? 'inline-block' : 'none';
  $('ws-manage').style.display = me.is_admin ? 'inline-block' : 'none';

  try { team = (await api('/api/team')).team; } catch (e) { team = []; }
  await loadWorkspaces();
  await loadTemplates();
  renderTplMenu();
  await loadLinks();
  renderLinksMenu();
  renderPocFilter();
  await refresh();
  startEvents();
  setInterval(renderSync, 30000);

  // Deep link: /?lead=<email> opens that lead's conversation directly (used by
  // the lead-gen platform's "view conversation" link).
  const wanted = new URLSearchParams(location.search).get('lead');
  if (wanted) openLeadByEmail(wanted);
}

// Open the conversation for a lead by email (most recent campaign if several).
function openLeadByEmail(email) {
  const want = String(email).trim().toLowerCase();
  if (!want) return;
  const matches = state.leads.filter(l => (l.email || '').toLowerCase() === want);
  if (!matches.length) { toast('No conversation in the CRM for ' + want, true); return; }
  const lead = matches.sort((a, b) => (b.last_msg_at || '').localeCompare(a.last_msg_at || ''))[0];
  openDrawer(lead.key);
}

document.addEventListener('DOMContentLoaded', () => {
  $('login-btn').onclick = submitLogin;
  $('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') submitLogin(); });
  ['date-from', 'date-to', 'poc-filter', 'status-filter', 'label-filter'].forEach(id => $(id).onchange = refresh);
  $('sort-order').onchange = () => { sortOrder = $('sort-order').value; renderList(); };
  document.querySelectorAll('.nav-item').forEach(b => b.onclick = () => switchView(b.dataset.view));
  $('analytics-refresh').onclick = loadAnalytics;
  $('analytics-search').oninput = renderAnalytics;
  $('csv-input').onchange = handleCsvUpload;
  $('ws-select').onchange = onWorkspaceChange;
  $('ws-manage').onclick = openWsModal;
  $('ws-save').onclick = addWorkspace;
  $('ws-close').onclick = () => { $('ws-bg').style.display = 'none'; };
  $('clear-filters').onclick = () => {
    selectedCampaigns.clear();
    ['poc-filter', 'status-filter', 'label-filter', 'search', 'date-from', 'date-to'].forEach(id => { $(id).value = ''; });
    rateFilter = '';
    sortOrder = 'newest';
    $('sort-order').value = 'newest';
    refresh();
  };
  $('campaign-btn').onclick = (e) => {
    e.stopPropagation();
    $('campaign-menu').classList.toggle('open');
  };
  $('campaign-menu').onclick = (e) => e.stopPropagation();
  $('tpl-btn').onclick = (e) => { e.stopPropagation(); $('tpl-menu').classList.toggle('open'); $('links-menu').classList.remove('open'); };
  $('tpl-menu').onclick = (e) => e.stopPropagation();
  $('links-btn').onclick = (e) => { e.stopPropagation(); $('links-menu').classList.toggle('open'); $('tpl-menu').classList.remove('open'); };
  $('links-menu').onclick = (e) => e.stopPropagation();
  document.addEventListener('click', () => {
    $('campaign-menu').classList.remove('open');
    $('tpl-menu').classList.remove('open');
    $('links-menu').classList.remove('open');
  });
  let t;
  $('search').oninput = () => { clearTimeout(t); t = setTimeout(refresh, 300); };
  $('overlay').onclick = closeDrawer;
  $('d-close').onclick = closeDrawer;
  $('send-btn').onclick = sendReply;
  $('note-btn').onclick = addNote;
  $('reply-text').addEventListener('keydown', insertLinkShortcut);
  $('sync-now').onclick = async () => { await api('/api/sync', { ws: activeWs }); toast('Sync started…'); };
  $('logout').onclick = async () => { await api('/api/logout', {}); location.reload(); };
  $('team-btn').onclick = openTeam;
  $('modal-close').onclick = () => { $('modal-bg').style.display = 'none'; };
  $('nu-add').onclick = addUser;

  $('export-btn').onclick = exportCsv;
  $('stats-btn').onclick = openStats;
  $('stats-close').onclick = () => { $('stats-bg').style.display = 'none'; };
  $('activity-btn').onclick = openActivity;
  $('activity-close').onclick = () => { $('activity-bg').style.display = 'none'; };
  $('act-apply').onclick = renderActivity;
  $('manage-btn').onclick = openManage;
  $('manage-close').onclick = () => { $('manage-bg').style.display = 'none'; };
  $('add-label').onclick = async () => {
    const name = $('new-label').value.trim();
    if (!name) return;
    try { await api('/api/labels', { name }); $('new-label').value = ''; await refresh(); renderManage(); toast('Label added ✓'); }
    catch (e) { toast(e.message, true); }
  };
  $('add-status').onclick = async () => {
    const label = $('new-status').value.trim();
    if (!label) return;
    try { await api('/api/statuses', { label }); $('new-status').value = ''; await refresh(); renderManage(); toast('Status added ✓'); }
    catch (e) { toast(e.message, true); }
  };
  $('sd-cancel').onclick = () => { closeStatusModal(); revertStatusSelect(); };

  // Manual quoted-rate modal
  $('r-save').onclick = saveRate;
  $('r-auto').onclick = clearRate;
  $('r-cancel').onclick = () => { $('rate-bg').style.display = 'none'; };
  $('r-add-line').onclick = () => { syncRateLines(); rateLines.push({ qty: 1, unit: 'reel' }); renderRateLines(); updateRatePreview(); };
  ['r-amount', 'r-cur'].forEach(id => {
    $(id).oninput = updateRatePreview;
    $(id).onchange = updateRatePreview;
  });

  $('tpl-manage-close').onclick = () => { $('tpl-manage-bg').style.display = 'none'; };
  $('tpl-new').onclick = () => openTplEditor(null);
  $('tpl-cancel').onclick = () => { $('tpl-editor').style.display = 'none'; };
  $('links-manage-close').onclick = () => { $('links-manage-bg').style.display = 'none'; };
  $('link-new').onclick = () => openLinkEditor(null);
  $('link-cancel').onclick = () => { $('link-editor').style.display = 'none'; };
  $('link-save').onclick = async () => {
    const name = $('link-name').value.trim();
    let urlv = $('link-url').value.trim();
    if (!name) { toast('Link name required', true); return; }
    if (!urlv) { toast('Link URL required', true); return; }
    if (!/^https?:\/\//i.test(urlv)) urlv = 'https://' + urlv;
    const id = $('link-editor').dataset.id;
    try {
      await api('/api/links', id ? { id: +id, name, url: urlv } : { name, url: urlv });
      await loadLinks(); renderLinksList(); renderLinksMenu();
      $('link-editor').style.display = 'none';
      toast('Link saved ✓');
    } catch (e) { toast(e.message, true); }
  };
  $('tpl-save').onclick = async () => {
    const name = $('tpl-name').value.trim();
    const bodyText = $('tpl-body').value;
    if (!name) { toast('Template name required', true); return; }
    const id = $('tpl-editor').dataset.id;
    try {
      await api('/api/templates', id ? { id: +id, name, body: bodyText } : { name, body: bodyText });
      await loadTemplates(); renderTplList(); renderTplMenu();
      $('tpl-editor').style.display = 'none';
      toast('Template saved ✓');
    } catch (e) { toast(e.message, true); }
  };
  $('booking-save').onclick = async () => {
    const bl = $('booking-link').value.trim();
    try {
      await api('/api/account/booking', { booking_link: bl });
      if (me) me.booking_link = bl;
      toast('Booking link saved ✓');
    } catch (e) { toast(e.message, true); }
  };

  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
  init();
});
