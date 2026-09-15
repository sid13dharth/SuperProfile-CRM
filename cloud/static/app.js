'use strict';

/* ── theme ─────────────────────────────────────────────────
   The saved theme is applied by an inline script in index.html before first
   paint; this only handles the toggle. Presentation only — nothing here
   touches data. Storage is wrapped because it throws in some privacy modes,
   where the theme simply does not persist between visits. */
function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}
function setTheme(t) {
  if (t === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('lg_theme', t); } catch (e) {}
  // Unibox renders in an iframe on this page; tell it so the two panes match.
  const uf = $('unibox-frame');
  try { if (uf && uf.contentWindow) uf.contentWindow.postMessage({ type: 'lg-theme', theme: t }, '*'); } catch (e) {}
}

// The Unibox pane has its own switch; a toggle there should move this page too.
addEventListener('message', e => {
  const d = e && e.data;
  if (!d || d.type !== 'lg-theme' || (d.theme !== 'dark' && d.theme !== 'light')) return;
  if (d.theme === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('lg_theme', d.theme); } catch (e2) {}
});

/* The iframe needs the theme on its very first paint, before any message can
   reach it — otherwise it flashes light inside a dark page. */
function uniboxSrc(deep) {
  const base = '/unibox/' + (deep || '');
  return base + (base.includes('?') ? '&' : '?') + 'theme=' + currentTheme();
}

/* ── tiny helpers ──────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const method = opts.method || 'GET';
  // Only GETs are safe to auto-retry (mutations could double-apply). The worker
  // occasionally returns a transient 502/503/504/429 under cron load — retry
  // those a couple of times with a short backoff so the UI doesn't flash an error.
  const retriable = method === 'GET';
  const TRANSIENT = [429, 502, 503, 504];
  let lastErr;
  for (let attempt = 0; attempt < (retriable ? 3 : 1); attempt++) {
    if (attempt) await new Promise(res => setTimeout(res, 400 * attempt));
    let r;
    try {
      r = await fetch(path, {
        method,
        headers: opts.body ? { 'Content-Type': 'application/json' } : {},
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) { lastErr = e; continue; }          // network hiccup → retry
    if (retriable && TRANSIENT.includes(r.status)) { lastErr = new Error('HTTP ' + r.status); continue; }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || ('HTTP ' + r.status));
    return data;
  }
  throw lastErr || new Error('Request failed');
}

let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ── state ─────────────────────────────────────────────────── */
const state = { me: null, crmUrl: '', lookupConfigured: false, entries: [], videos: [], version: -1, categories: [], team: [], stats: null, tab: 'leads',
  // Virtualised grid bookkeeping (see renderEntries).
  grid: { colW: null, rowH: 26, sig: '', tbody: null, win: null, cols: null, head: '', note: '' },
  page: 1, pageSize: 100, lastQs: null,
  // Grid sort. key '' = the server's default order (data-rich first, newest first).
  sort: { key: '', dir: 'desc' },
  linkDomains: [],
  pipeline: { stages: ['Leads', 'Responses', 'Closed', 'Failed'], nodes: [], byKey: {}, children: {} } };

/* ── auth / boot ───────────────────────────────────────────── */
async function boot() {
  const me = await api('/api/me');
  state.crmUrl = me.crm_url || '';
  state.lookupConfigured = !!me.lookup_configured;
  if (me.user) { state.me = me.user; showApp(); return; }
  showLogin(me.needs_setup);
}

function showLogin(needsSetup) {
  $('login-view').style.display = 'flex';
  $('app').style.display = 'none';
  const btn = $('login-btn');
  if (needsSetup) {
    $('login-title').textContent = 'Create the first account';
    $('login-sub').textContent = 'This account will be the admin.';
    $('login-display').style.display = 'block';
    btn.textContent = 'Create account'; btn.dataset.mode = 'setup';
  } else {
    $('login-title').textContent = 'Sign in';
    $('login-sub').textContent = 'SuperProfile Lead-Gen';
    $('login-display').style.display = 'none';
    btn.textContent = 'Sign in'; btn.dataset.mode = 'login';
  }
}

async function doLogin() {
  const mode = $('login-btn').dataset.mode;
  const username = $('login-user').value.trim();
  const password = $('login-pass').value;
  const err = $('login-error'); err.textContent = '';
  try {
    if (mode === 'setup') {
      await api('/api/setup', { method: 'POST', body: { username, password, display_name: $('login-display').value.trim() } });
    } else {
      await api('/api/login', { method: 'POST', body: { username, password } });
    }
    await boot();
  } catch (e) { err.textContent = e.message; }
}

function showApp() {
  $('login-view').style.display = 'none';
  $('app').style.display = 'flex';
  $('sidebar').style.display = 'flex';
  document.body.classList.add('has-sidebar');
  $('who').textContent = state.me.display_name || state.me.username;
  $('owner-name').textContent = state.me.display_name || state.me.username;
  if (state.me.is_admin) $('team-btn').style.display = '';
  loadCategories();
  loadTeam();
  loadPipeline().then(() => (deepLink ? runDeepLink() : switchTab('leads')));
  injectCountries();
  startPolling();
  // Warm the Unibox iframe in the background (hidden) so it's already booted
  // and authed via the shared lg_session before the first switch — no flash,
  // no perceived second login. switchView only toggles its visibility after.
  const uf = $('unibox-frame');
  if (uf && !uf.getAttribute('src')) uf.setAttribute('src', uniboxSrc(''));
}

/* ── pipeline classification tree ──────────────────────────── */
async function loadPipeline() {
  try {
    const r = await api('/api/pipeline');
    const p = { stages: r.stages || ['Leads', 'Responses', 'Closed', 'Failed'], nodes: r.nodes || [], byKey: {}, children: {} };
    for (const n of p.nodes) {
      p.byKey[n.key] = n;
      (p.children[n.parent || n.stage] = p.children[n.parent || n.stage] || []).push(n);
    }
    for (const k in p.children) p.children[k].sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label));
    state.pipeline = p;
  } catch { /* keep whatever we have */ }
}
// Top-level nodes of a stage, in order.
function pipeRoots(stage) { return state.pipeline.children[stage] || []; }
function pipeKids(key) { return state.pipeline.children[key] || []; }
// Breadcrumb of labels for a position key, e.g. "Interested › Relevant › Call Booked".
function pipeCrumb(key) {
  const out = [];
  let n = state.pipeline.byKey[key];
  let guard = 0;
  while (n && guard++ < 12) { out.unshift(n.label); n = n.parent ? state.pipeline.byKey[n.parent] : null; }
  return out.join(' › ');
}
// Indented <option> list of a stage's whole sub-tree (value = node key).
function pipeOptionsHtml(stage, cur) {
  let html = '<option value="">— set position —</option>';
  const walk = (nodes, depth) => nodes.forEach(n => {
    const pad = '  '.repeat(depth) + (depth ? '└ ' : '');
    html += `<option value="${esc(n.key)}"${n.key === cur ? ' selected' : ''}>${pad}${esc(n.label)}</option>`;
    walk(pipeKids(n.key), depth + 1);
  });
  walk(pipeRoots(stage), 0);
  // Keep an unknown/stale key visible so it isn't silently lost.
  if (cur && !state.pipeline.byKey[cur]) html += `<option value="${esc(cur)}" selected>${esc(cur)} (removed)</option>`;
  return html;
}

async function loadTeam() {
  try { const r = await api('/api/team'); state.team = r.team || []; } catch { state.team = []; }
}

/* ── categories (shared, editable) ─────────────────────────── */
async function loadCategories() {
  try { const r = await api('/api/categories'); state.categories = r.categories || []; }
  catch { state.categories = []; }
  fillCategorySelects();
}

function fillCategorySelects() {
  const opts = '<option value="">— none —</option>' + state.categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  for (const id of ['f-category', 'e-category']) {
    const s = $(id); if (!s) continue; const cur = s.value; s.innerHTML = opts; s.value = cur;
  }
  const cf = $('cat-filter'); if (cf) {
    const cur = cf.value;
    /* The curated list says what you can ASSIGN; the filter has to reach what
       is actually stored, or categories that predate the list (Beauty &
       Fashion, 1,541 leads) would be unfilterable. Union of both. */
    const all = [...new Set([...(state.categories || []), ...(state.categoriesInUse || [])])]
      .sort((x, y) => x.localeCompare(y));
    cf.innerHTML = '<option value="">Any category</option>' + all.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    cf.value = cur;
  }
}

function openCat() {
  $('cat-bg').classList.add('open'); $('cat-msg').textContent = ''; renderCatList();
}
function renderCatList() {
  $('cat-list').innerHTML = state.categories.length
    ? state.categories.map(c => `<div class="cat-item"><span>${esc(c)}</span><button data-cat="${esc(c)}" title="Delete">🗑</button></div>`).join('')
    : '<div class="foot-hint">No categories yet.</div>';
  $('cat-list').querySelectorAll('button[data-cat]').forEach(b => { b.onclick = () => deleteCat(b.dataset.cat); });
}
async function addCat() {
  const name = $('cat-new').value.trim();
  const msg = $('cat-msg'); msg.className = 'add-msg'; msg.textContent = '';
  if (!name) return;
  try { await api('/api/categories', { method: 'POST', body: { name } }); $('cat-new').value = ''; await loadCategories(); renderCatList(); renderCatListIn('cl-cat-list'); }
  catch (e) { msg.className = 'add-msg err'; msg.textContent = e.message; }
}
async function deleteCat(name) {
  try {
    await api('/api/categories', { method: 'DELETE', body: { name } });
    await loadCategories();
    renderCatList();
    renderCatListIn('cl-cat-list');
  } catch (e) { toast(e.message); }
}

/* ── manage statuses & labels (add / delete, anyone) ───────────── */
function openClassify() {
  $('classify-bg').classList.add('open'); $('cl-msg').textContent = ''; loadClassify();
}
async function loadClassify() {
  try {
    const [st, lb] = await Promise.all([api('/api/statuses'), api('/api/labels')]);
    state.classify = { statuses: st.statuses || [], labels: lb.labels || [] };
    renderClassifyLists();
  } catch (e) { $('cl-msg').className = 'add-msg err'; $('cl-msg').textContent = e.message; }
}
function renderClassifyLists() {
  const c = state.classify || { statuses: [], labels: [] };
  const item = (text, delAttr, builtin) => `<div class="cat-item"><span>${esc(text)}</span>${builtin ? '<span class="foot-hint">built-in</span>' : `<button ${delAttr} title="Delete">🗑</button>`}</div>`;
  $('cl-status-list').innerHTML = c.statuses.length
    ? c.statuses.map(s => item(s.label, `data-skey="${esc(s.key)}"`, s.builtin)).join('')
    : '<div class="foot-hint">No statuses yet.</div>';
  $('cl-label-list').innerHTML = c.labels.length
    ? c.labels.map(l => item(l.name, `data-lname="${esc(l.name)}"`, l.builtin)).join('')
    : '<div class="foot-hint">No labels yet.</div>';
  $('cl-status-list').querySelectorAll('button[data-skey]').forEach(b => { b.onclick = () => deleteStatus(b.dataset.skey); });
  $('cl-label-list').querySelectorAll('button[data-lname]').forEach(b => { b.onclick = () => deleteLabel(b.dataset.lname); });
  renderCatListIn('cl-cat-list');
  renderNodeLists();
}

/* The Categories list appears in two places — the Manage modal and the small
   gear beside the Category dropdown — so the rendering is shared. */
function renderCatListIn(id) {
  const el = $(id); if (!el) return;
  el.innerHTML = (state.categories || []).length
    ? state.categories.map(c => `<div class="cat-item"><span>${esc(c)}</span><button data-cat="${esc(c)}" title="Delete">\u{1F5D1}</button></div>`).join('')
    : '<div class="foot-hint">No categories yet.</div>';
  el.querySelectorAll('button[data-cat]').forEach(b => { b.onclick = () => deleteCat(b.dataset.cat); });
}
// Delivery statuses (Closed) + Failure reasons (Failed) are pipeline sub-nodes.
function renderNodeLists() {
  const item = n => `<div class="cat-item"><span>${esc(n.label)}</span><span><button data-rn="${esc(n.key)}" title="Rename">✎</button> <button data-dn="${esc(n.key)}" title="Delete">🗑</button></span></div>`;
  const fill = (id, stage) => {
    const el = $(id); if (!el) return;
    const roots = pipeRoots(stage);
    el.innerHTML = roots.length ? roots.map(item).join('') : '<div class="foot-hint">None yet.</div>';
  };
  fill('cl-deliv-list', 'Closed');
  fill('cl-reason-list', 'Failed');
  document.querySelectorAll('#cl-deliv-list button[data-rn], #cl-reason-list button[data-rn]').forEach(b => { b.onclick = () => renameNode(b.dataset.rn); });
  document.querySelectorAll('#cl-deliv-list button[data-dn], #cl-reason-list button[data-dn]').forEach(b => { b.onclick = () => deleteNode(b.dataset.dn); });
}
async function addNode(stage, inputId) {
  const label = $(inputId).value.trim();
  const msg = $('cl-msg'); msg.className = 'add-msg'; msg.textContent = '';
  if (!label) return;
  try { await api('/api/pipeline', { method: 'POST', body: { stage, parent: '', label } }); $(inputId).value = ''; await pipeReload(); renderNodeLists(); loadEntries(); }
  catch (e) { msg.className = 'add-msg err'; msg.textContent = e.message; }
}
async function renameNode(key) {
  const label = prompt('Rename to:', subNodeLabel(key));
  if (label == null || !label.trim()) return;
  try { await api('/api/pipeline', { method: 'PATCH', body: { key, label: label.trim() } }); await pipeReload(); renderNodeLists(); loadEntries(); }
  catch (e) { toast(e.message); }
}
async function deleteNode(key) {
  if (!confirm(`Delete "${subNodeLabel(key)}"? Leads tagged with it move up to the stage.`)) return;
  try { await api('/api/pipeline', { method: 'DELETE', body: { key } }); await pipeReload(); renderNodeLists(); loadEntries(); }
  catch (e) { toast(e.message); }
}
async function addStatus() {
  const label = $('cl-status-new').value.trim();
  const msg = $('cl-msg'); msg.className = 'add-msg'; msg.textContent = '';
  if (!label) return;
  try { await api('/api/statuses', { method: 'POST', body: { label } }); $('cl-status-new').value = ''; await loadClassify(); await loadEntries(); }
  catch (e) { msg.className = 'add-msg err'; msg.textContent = e.message; }
}
async function deleteStatus(key) {
  try { await api('/api/statuses', { method: 'DELETE', body: { key } }); await loadClassify(); await loadEntries(); }
  catch (e) { toast(e.message); }
}
async function addLabel() {
  const name = $('cl-label-new').value.trim();
  const msg = $('cl-msg'); msg.className = 'add-msg'; msg.textContent = '';
  if (!name) return;
  try { await api('/api/labels', { method: 'POST', body: { name } }); $('cl-label-new').value = ''; await loadClassify(); await loadEntries(); }
  catch (e) { msg.className = 'add-msg err'; msg.textContent = e.message; }
}
async function deleteLabel(name) {
  try { await api('/api/labels', { method: 'DELETE', body: { name } }); await loadClassify(); await loadEntries(); }
  catch (e) { toast(e.message); }
}

/* ── manage pipeline tree (add / rename / delete nodes, anyone) ─ */
function openPipeline() {
  $('pipe-bg').classList.add('open'); $('pipe-msg').textContent = '';
  renderPipeTree();
  $('pipe-stage-sel').innerHTML = state.pipeline.stages.map(s => `<option>${esc(s)}</option>`).join('');
  updatePipeParents();
}
function renderPipeTree() {
  let html = '';
  for (const stage of state.pipeline.stages) {
    html += `<div class="pipe-stage">${esc(stage)}</div>`;
    const walk = (nodes, depth) => nodes.forEach(n => {
      html += `<div class="pipe-node" style="padding-left:${6 + depth * 18}px">` +
        `<span class="pn-label">${esc(n.label)}</span>` +
        `<span class="pn-acts">` +
        `<button data-add="${esc(n.key)}" title="Add sub-label">＋</button>` +
        `<button data-ren="${esc(n.key)}" data-cur="${esc(n.label)}" title="Rename">✎</button>` +
        `<button data-del="${esc(n.key)}" title="Delete">🗑</button></span></div>`;
      walk(pipeKids(n.key), depth + 1);
    });
    walk(pipeRoots(stage), 0);
  }
  const box = $('pipe-tree'); box.innerHTML = html || '<div class="foot-hint">No nodes.</div>';
  box.querySelectorAll('button[data-add]').forEach(b => b.onclick = () => quickAddChild(b.dataset.add));
  box.querySelectorAll('button[data-ren]').forEach(b => b.onclick = () => renamePipeNode(b.dataset.ren, b.dataset.cur));
  box.querySelectorAll('button[data-del]').forEach(b => b.onclick = () => deletePipeNode(b.dataset.del));
}
function updatePipeParents() {
  const stage = $('pipe-stage-sel').value;
  let html = `<option value="">(top level of ${esc(stage)})</option>`;
  const walk = (nodes, depth) => nodes.forEach(n => { html += `<option value="${esc(n.key)}">${'— '.repeat(depth + 1)}${esc(n.label)}</option>`; walk(pipeKids(n.key), depth + 1); });
  walk(pipeRoots(stage), 0);
  $('pipe-parent-sel').innerHTML = html;
}
async function pipeReload() { await loadPipeline(); renderPipeTree(); updatePipeParents(); refreshPositionFilter(); }
async function addPipeNode() {
  const stage = $('pipe-stage-sel').value, parent = $('pipe-parent-sel').value, label = $('pipe-new').value.trim();
  const msg = $('pipe-msg'); msg.className = 'add-msg'; msg.textContent = '';
  if (!label) return;
  try { await api('/api/pipeline', { method: 'POST', body: { stage, parent, label } }); $('pipe-new').value = ''; await pipeReload(); msg.className = 'add-msg ok'; msg.textContent = '✓ Added.'; }
  catch (e) { msg.className = 'add-msg err'; msg.textContent = e.message; }
}
async function quickAddChild(parentKey) {
  const node = state.pipeline.byKey[parentKey]; if (!node) return;
  const label = prompt(`New sub-label under "${pipeCrumb(parentKey)}":`);
  if (!label || !label.trim()) return;
  try { await api('/api/pipeline', { method: 'POST', body: { stage: node.stage, parent: parentKey, label: label.trim() } }); await pipeReload(); toast('Added'); }
  catch (e) { toast(e.message); }
}
async function renamePipeNode(key, cur) {
  const label = prompt('Rename:', cur);
  if (!label || !label.trim() || label.trim() === cur) return;
  try { await api('/api/pipeline', { method: 'PATCH', body: { key, label: label.trim() } }); await pipeReload(); loadEntries(); toast('Renamed'); }
  catch (e) { toast(e.message); }
}
async function deletePipeNode(key) {
  const kids = pipeKids(key).length;
  if (!confirm(`Delete "${pipeCrumb(key)}"${kids ? ` and its ${kids} sub-label(s)` : ''}?\nLeads sitting here move up to the parent.`)) return;
  try { await api('/api/pipeline', { method: 'DELETE', body: { key } }); await pipeReload(); loadEntries(); toast('Deleted'); }
  catch (e) { toast(e.message); }
}

/* ── add-a-lead form + live preview ────────────────────────── */
function currentForm() {
  return {
    social_url: $('f-social').value.trim(),
    email: $('f-email').value.trim(),
    first_name: $('f-firstname').value.trim(),
    notes: $('f-notes').value.trim(),
    category: $('f-category').value,
  };
}

const runPreview = debounce(async () => {
  const f = currentForm();
  const box = $('preview');
  if (!f.social_url && !f.email) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="spin">Checking…</div>';
  let res;
  try { res = await api('/api/check', { method: 'POST', body: f }); }
  catch (e) { box.innerHTML = `<div class="sig red"><span class="ic">⚠️</span><span class="tx">${esc(e.message)}</span></div>`; return; }
  renderSignals(box, res);
}, 350);

function renderSignals(box, res) {
  box.innerHTML = '';
  // Signal 1 — duplicate by username (our own dedup).
  if (res.handle) {
    if (res.dup && res.dup.source === 'master') {
      box.appendChild(sig('blue', '📄',
        `<b>Already in the master sheet.</b> Owner: <b>${esc(res.dup.owner || '—')}</b>` +
        `<small>${res.dup.email ? esc(res.dup.email) + ' · ' : ''}open it in the list to edit — no need to re-add.</small>`));
    } else if (res.dup) {
      box.appendChild(sig('red', '🚫',
        `<b>Duplicate username.</b> Already added by <b>${esc(res.dup.owner || res.dup.created_by)}</b>` +
        `<small>on ${esc(fmtDate(res.dup.created_at))}${res.dup.email ? ' · ' + esc(res.dup.email) : ''}</small>`));
    } else if (!res.email_dup) {
      box.appendChild(sig('green', '✨', `<b>New username.</b> Not in the master sheet or prior entries.`));
    }
  }
  // Signal 1b — same email already a lead in our DB (independent of username).
  if (res.email_dup) {
    const e = res.email_dup;
    box.appendChild(sig(e.source === 'master' ? 'blue' : 'red', '📧',
      `<b>Email already in our database.</b> This lead already exists` +
      (e.owner || e.created_by ? ` — added by <b>${esc(e.owner || e.created_by)}</b>` : '') + '.' +
      `<small>${e.handle ? '@' + esc(e.handle) + ' · ' : ''}${e.created_at ? esc(fmtDate(e.created_at)) : ''}${e.source === 'master' ? ' · master sheet' : ''}</small>`));
  }
  // Signal 2 — prior Instantly conversation (via the CRM), independent of #1.
  renderCrmSignal(box, res.crm, res.email);
}

function renderCrmSignal(box, crm, email) {
  if (!crm) return;
  if (crm.error) { box.appendChild(sig('muted', '⚠️', `Prior-conversation check unavailable<small>${esc(crm.error)}</small>`)); return; }
  const s = crm.signal;
  if (!s || !s.known) {
    box.appendChild(sig('green', '📭', `<b>No prior conversation.</b> No replies from this lead in our records — safe to pursue.`));
    return;
  }
  const camps = (s.campaigns || []).join(', ');
  if (s.replied) {
    box.appendChild(sig('red', '💬',
      `<b>Prior conversation — do NOT re-pitch.</b>` +
      `<small>${s.status ? 'Status: ' + esc(s.status) + ' · ' : ''}${s.poc ? 'POC: ' + esc(s.poc) + ' · ' : ''}` +
      `${s.last_reply_at ? 'Last reply ' + esc(fmtDate(s.last_reply_at)) : ''}${camps ? ' · ' + esc(camps) : ''}</small>`));
  } else {
    box.appendChild(sig('orange', '📨',
      `<b>Contacted before, never replied.</b> Still OK to reach out.` +
      `<small>${s.status ? 'Status: ' + esc(s.status) + ' · ' : ''}${camps ? esc(camps) : ''}` +
      `${s.last_contact_at ? ' · Last contact ' + esc(fmtDate(s.last_contact_at)) : ''}</small>`));
  }
}

/* ── read-only conversation popup (Responses tab) ─────────────── */
function convDateTime(ts) {
  if (!ts) return '';
  try { const d = new Date(ts); return isNaN(d) ? esc(ts) : esc(d.toLocaleString()); } catch (e) { return esc(ts); }
}
// Trim the trailing quoted reply-chain ("On <date> … wrote:", ">" lines,
// original-message headers) — it just repeats the previous message, which is
// already shown as its own bubble. Falls back to full text if it strips all.
function convStripQuoted(t) {
  if (!t) return t;
  const lines = t.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const nextTwo = lines.slice(i, i + 3).join(' ');
    if (/^\s*>/.test(ln)) break;
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(ln)) break;
    if (/^\s*From:\s?.+/i.test(ln) && /\b(Sent|To|Date):/i.test(nextTwo)) break;
    if (/^\s*On\b.+/i.test(ln) && /(wrote:|<[^\s>]+@[^\s>]+>)/i.test(nextTwo)) break;
    out.push(ln);
  }
  const r = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return r || t.trim();
}
function convMsgHtml(m) {
  const them = m.ue_type === 2;                 // 2 = lead reply; 1/3 = our send
  const who = them ? (m.from_email || 'Lead') : 'You';
  let text = (m.body_text || '').trim();
  if (!text && m.body_html) text = m.body_html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim();
  if (!text) text = m.preview || '';
  text = convStripQuoted(text);
  const body = esc(text) || '<i>(no content)</i>';
  return `<div class="cmsg ${them ? 'them' : 'us'}">`
    + `<div class="cmsg-h"><b>${esc(who)}</b> · ${convDateTime(m.timestamp_email)}${m.campaign_name ? ' · ' + esc(m.campaign_name) : ''}</div>`
    + `<div class="cmsg-b">${body}</div></div>`;
}
async function openConvModal(e) {
  const bg = $('conv-bg'); bg.classList.add('open');
  if (!bg._wired) {
    bg._wired = true;
    $('conv-close').onclick = () => bg.classList.remove('open');
    bg.addEventListener('click', ev => { if (ev.target === bg) bg.classList.remove('open'); });
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && bg.classList.contains('open')) bg.classList.remove('open'); });
  }
  $('conv-title').textContent = e.first_name ? `${e.first_name} · @${e.handle || ''}` : (e.handle ? '@' + e.handle : (e.email || 'Lead'));
  $('conv-body').innerHTML = '<div class="empty">Loading conversation…</div>';
  let d;
  try { d = await api('/api/lead/detail?entry_id=' + encodeURIComponent(e.id)); }
  catch (err) { $('conv-body').innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
  const en = d.entry || e, dl = en.deal || {};
  const det = [];
  const row = (k, v) => { if (v) det.push(`<span class="cd"><span class="k">${esc(k)}</span> <span class="v">${v}</span></span>`); };
  row('Email', en.email ? esc(en.email) : '');
  row('Handle', en.handle ? `<a href="${esc(en.social_url || ('https://instagram.com/' + en.handle))}" target="_blank" rel="noopener">@${esc(en.handle)}</a>` : '');
  row('Stage', [en.stage, en.position].filter(Boolean).map(esc).join(' › '));
  row('Status', en.status ? esc(en.status) : '');
  row('Label', en.label ? esc(en.label) : '');
  row('POC', (en.crm && en.crm.poc) ? esc(en.crm.poc) : '');
  row('Added by', en.lead_owner ? esc(en.lead_owner) : '');
  row('Category', en.category ? esc(en.category) : '');
  row('Quoted rate', (dl.final_rate || dl.initial_rate) ? esc(dl.final_rate || dl.initial_rate) : '');
  row('Deliverables', dl.deliverables ? esc(dl.deliverables) : '');
  row('Notes', en.notes ? esc(en.notes).replace(/\n/g, '<br>') : '');
  const emails = d.emails || [];
  /* A lead can sit in Responses because Instantly counted a reply while we hold
     none of that thread's messages — the bodies were never ingested, and for old
     threads Instantly no longer serves them at all. Without this the popup showed
     only our outbound mail and looked broken. Say what is actually going on. */
  const convs = d.conversations || [];
  const claimed = convs.reduce((t, c) => t + (c.lead_reply_count || 0), 0);
  const held = emails.filter(m => Number(m.ue_type) === 2).length;
  let gap = '';
  if (claimed > held) {
    const missing = claimed - held;
    const otherAddr = convs
      .filter(c => (c.lead_reply_count || 0) > 0 && c.email && c.email.toLowerCase() !== String(en.email || '').toLowerCase())
      .map(c => c.email);
    const when = convs.map(c => c.last_lead_msg_at).filter(Boolean).sort().pop();
    gap = '<div class="conv-gap">⚠️ <b>' + missing + ' repl' + (missing === 1 ? 'y' : 'ies')
      + ' on record' + (when ? ' (last ' + esc(fmtDate(when)) + ')' : '')
      + ', but the message text is not stored.</b>'
      + (otherAddr.length ? '<br>The reply came from <b>' + esc(otherAddr.join(', ')) + '</b>, a different address to the one on this lead.' : '')
      + '<br><span class="muted">Instantly no longer returns that thread, so it cannot be re-fetched. The lead is correctly in Responses.</span></div>';
  }
  const thread = emails.length ? emails.slice().reverse().map(convMsgHtml).join('') : '<div class="empty">No emails on record for this lead.</div>';
  const sec = (title, items, fn) => items && items.length ? `<div class="conv-sec"><h4>${esc(title)} (${items.length})</h4>${items.map(fn).join('')}</div>` : '';
  const vids = sec('Videos', d.videos, v => `<div>${v.url ? `<a href="${esc(v.url)}" target="_blank" rel="noopener">${esc((v.url || '').replace(/^https?:\/\//, '').slice(0, 55))}</a>` : esc(v.lead_name || '—')}${v.budget ? ' · ' + esc(v.budget) : ''}${v.date_posted ? ' · ' + esc(fmtDate(v.date_posted)) : ''}</div>`);
  const notes = sec('Notes', d.notes, n => `<div><b>${esc(n.author || '')}</b> <span class="muted">${esc(fmtDate(n.created_at))}</span><br>${esc(n.text || '').replace(/\n/g, '<br>')}</div>`);
  const act = sec('Activity', d.activity, a => `<div class="muted small">${esc(fmtDate(a.created_at))} · ${esc(a.author || '')} · ${esc(a.kind || '')}${a.detail ? ': ' + esc(a.detail) : ''}</div>`);
  const extras = [vids, notes, act].filter(Boolean).join('');
  $('conv-body').innerHTML =
    `<div class="conv-top">${det.join('') || '<span class="muted">—</span>'}</div>`
    + (extras ? `<div class="conv-extras">${extras}</div>` : '')
    + `<div class="conv-thread full"><div class="conv-thread-h">Conversation (${emails.length})</div>${gap}${thread}</div>`;
}

function sig(tone, ic, html) {
  const e = el('div', 'sig ' + tone);
  e.innerHTML = `<span class="ic">${ic}</span><span class="tx">${html}</span>`;
  return e;
}

async function addLead() {
  const f = currentForm();
  const msg = $('add-msg'); msg.className = 'add-msg'; msg.textContent = '';
  if (!f.social_url) { msg.className = 'add-msg err'; msg.textContent = 'Enter an Instagram link or handle.'; return; }
  $('add-btn').disabled = true;
  try {
    const res = await api('/api/entries', { method: 'POST', body: f });
    if (res.saved) {
      msg.className = 'add-msg ok'; msg.textContent = '✓ Lead added.';
      $('f-social').value = ''; $('f-email').value = ''; $('f-firstname').value = ''; $('f-notes').value = ''; $('f-category').value = ''; $('preview').innerHTML = '';
      toast('Lead added — @' + res.entry.handle);
      await loadEntries();
    } else {
      const d = res.duplicate || {};
      msg.className = 'add-msg err';
      msg.textContent = d.source === 'master'
        ? `Already in the master sheet (owner ${d.owner || '—'}). Find @${d.handle || ''} in the list to edit it.`
        : d.matched_on === 'email'
          ? `Not added — this email already exists in our database${d.handle ? ` (@${d.handle})` : ''}, added by ${d.owner || d.created_by || 'someone'} on ${fmtDate(d.created_at)}.`
          : `Not added — @${d.handle || ''} already added by ${d.owner || d.created_by || 'someone'} on ${fmtDate(d.created_at)}.`;
    }
  } catch (e) { msg.className = 'add-msg err'; msg.textContent = e.message; }
  finally { $('add-btn').disabled = false; }
}

/* ── entries list ──────────────────────────────────────────── */
function filterParams() {
  const p = new URLSearchParams();
  const q = $('search').value.trim(); if (q) p.set('q', q);
  const of = $('owner-filter').value; if (of) p.set('owner', of);
  const mf = $('manager-filter') ? $('manager-filter').value : ''; if (mf) p.set('manager', mf);
  const lf = $('link-filter') ? $('link-filter').value : ''; if (lf) p.set('link_domain', lf);
  const cf = $('cat-filter').value; if (cf) p.set('category', cf);
  const stt = $('status-filter') ? $('status-filter').value : ''; if (stt) p.set('status', stt);
  const lbl = $('label-filter') ? $('label-filter').value : ''; if (lbl) p.set('label', lbl);
  // Delivery-status filter applies only on the Closed tab (it's the lead's
  // Closed sub-node / position).
  if (state.tab === 'closed') { const dv = $('delivery-filter') ? $('delivery-filter').value : ''; if (dv) p.set('position', dv); }
  if (state.tab === 'failed') { const rv = $('reason-filter') ? $('reason-filter').value : ''; if (rv) p.set('position', rv); }
  if (state.tab && state.tab !== 'all' && state.tab !== 'videos') p.set('tab', state.tab);
  const from = $('date-from').value; if (from) p.set('from', from);
  const to = $('date-to').value; if (to) p.set('to', to);
  return p;
}

async function loadEntries() {
  if (state.tab === 'videos') return loadVideos();
  let data;
  // limit=100000 pulls the FULL filtered set into the grid (the server caps at
  // 100k; the table has ~22k rows). The user opted to load everything on-screen.
  const qs = filterParams(); qs.set('limit', '100000');
  // A changed filter / tab / search is a new result set, so jump back to page 1.
  // The 12s background refresh sends the SAME query, so it keeps your page.
  const qsKey = qs.toString();
  if (state.lastQs !== null && qsKey !== state.lastQs) state.page = 1;
  state.lastQs = qsKey;
  try { data = await api('/api/entries?' + qs.toString()); }
  catch (e) { $('list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  state.entries = data.entries; state.version = data.version;
  state.owners = data.owners || [];
  state.statuses = data.statuses || [];
  state.labels = data.labels || [];
  state.grandTotal = data.grand_total;
  // Exact count matching the current filter (falls back to grand total if the
  // server is on an older build that doesn't send it).
  state.filteredTotal = data.filtered_total != null ? data.filtered_total : data.grand_total;
  applySort();
  renderEntries();
  // Categories present in the data, so the filter can reach values that predate
  // the curated list (Beauty & Fashion is on 1,541 leads but not on the list).
  state.categoriesInUse = data.categories_in_use || [];
  fillCategorySelects();
  refreshOwnerFilter();
  refreshManagerFilter();
  refreshClassifyFilters();
  refreshLinkFilter();
  loadStats();
}

// The Position filter lists the current tab's stage sub-tree (all stages on the
// All/Videos tabs). Rolls up: picking a node also matches everything under it.
function refreshPositionFilter() {
  const sel = $('pos-filter'); if (!sel) return;
  const cur = sel.value;
  const stage = STAGE_OF_TAB[state.tab];
  let html = '<option value="">Any position</option>';
  const walk = (nodes, depth) => nodes.forEach(n => {
    html += `<option value="${esc(n.key)}">${'  '.repeat(depth) + (depth ? '└ ' : '')}${esc(n.label)}</option>`;
    walk(pipeKids(n.key), depth + 1);
  });
  if (stage) { walk(pipeRoots(stage), 0); }
  else { state.pipeline.stages.forEach(s => { html += `<option value="" disabled>── ${esc(s)} ──</option>`; walk(pipeRoots(s), 0); }); }
  sel.innerHTML = html; sel.value = cur;
}
const STAGE_OF_TAB = { leads: 'Leads', responses: 'Responses', closed: 'Closed', failed: 'Failed' };

// Delivery status (Closed sub-nodes) and Reason for failure (Failed sub-nodes)
// are both stored as the lead's `position`. One label lookup covers both.
function subNodeLabel(pos) {
  if (!pos) return '';
  const n = pipeRoots('Closed').concat(pipeRoots('Failed')).find(x => x.key === pos);
  return n ? n.label : (pipeCrumb(pos) || pos);
}
// Fill a stage-scoped sub-node filter (delivery on Closed, reason on Failed).
function fillSubFilter(selId, stage, anyLabel) {
  const sel = $(selId); if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = `<option value="">${esc(anyLabel)}</option>`
    + pipeRoots(stage).map(n => `<option value="${esc(n.key)}">${esc(n.label)}</option>`).join('')
    + '<option value="__unset">— not set —</option>';
  sel.value = cur;
}
function fillDeliveryFilter() { fillSubFilter('delivery-filter', 'Closed', 'Any delivery status'); }
function fillReasonFilter() { fillSubFilter('reason-filter', 'Failed', 'Any reason'); }

// Fill the Stage / Status / Label filter dropdowns from the loaded vocabulary.
// Stage mirrors the active tab (picking it switches tab); Status/Label narrow
// the current view. Existing Status/Label selections survive a reload.
function refreshClassifyFilters() {
  // (The Stage dropdown was removed — the tab bar already selects the stage.)
  const stSel = $('status-filter');
  if (stSel) {
    const cur = stSel.value;
    stSel.innerHTML = '<option value="">Any status</option>'
      + (state.statuses || []).map(o => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join('');
    stSel.value = cur;
  }
  const lbSel = $('label-filter');
  if (lbSel) {
    const cur = lbSel.value;
    lbSel.innerHTML = '<option value="">Any label</option>'
      + (state.labels || []).map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')
      // Two computed pseudo-labels that replaced the old signal filter.
      + '<option value="__contacted">Contacted — no reply</option>'
      + '<option value="__no_email">No email on file</option>';
    lbSel.value = cur;
  }
}

// Summary line for the current date range (authoritative counts, not capped by
// the list limit).
async function loadStats() {
  const p = new URLSearchParams();
  const from = $('date-from').value; if (from) p.set('from', from);
  const to = $('date-to').value; if (to) p.set('to', to);
  try {
    const s = await api('/api/stats?' + p.toString());
    state.stats = s;
    const span = (from || to) ? `${from || '…'} → ${to || '…'}` : 'all time';
    $('date-summary').innerHTML =
      `<b>${s.totals.leads}</b> leads · <b>${s.totals.with_email}</b> with email · <span class="foot-hint">${esc(span)}</span>`;
  } catch (e) { $('date-summary').textContent = ''; }
}

// The link-in-bio dropdown lists the platforms actually present in the data,
// with counts, so you pick rather than guess at spellings.
async function refreshLinkFilter() {
  const sel = $('link-filter'); if (!sel) return;
  let d;
  try { d = await api('/api/entries/ig-domains'); } catch { return; }
  state.linkDomains = d.domains || [];
  const cur = sel.value;
  sel.innerHTML = '<option value="">Any link in bio</option>'
    + (d.with_link ? `<option value="__any__">— Has a link (${d.with_link.toLocaleString()}) —</option>` : '')
    + (d.without_link ? `<option value="__none__">— No link (${d.without_link.toLocaleString()}) —</option>` : '')
    + state.linkDomains.map(x => `<option value="${esc(x.domain)}">${esc(x.domain)} (${x.n.toLocaleString()})</option>`).join('');
  sel.value = cur;
}

// A Lead Owner is always a CRM teammate, so this list comes from the team
// rather than from whatever names happen to be in the data. (The field is
// still lead_manager in the database and API — this is a label change only.)
function refreshManagerFilter() {
  const sel = $('manager-filter'); if (!sel) return;
  const cur = sel.value;
  const team = (state.team || []).slice().sort((a, b) => a.localeCompare(b));
  sel.innerHTML = '<option value="">Lead owner: anyone</option>'
    + '<option value="__none__">— No lead owner —</option>'
    + team.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  sel.value = cur;
}

function refreshOwnerFilter() {
  const sel = $('owner-filter');
  const cur = sel.value;
  const owners = (state.owners && state.owners.length)
    ? state.owners
    : [...new Set(state.entries.map(e => e.lead_owner).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">Added by: anyone</option>' + owners.map(o => `<option>${esc(o)}</option>`).join('');
  sel.value = cur;
}

// IST calendar date (yyyy-mm-dd) of a UTC timestamp — used for the Date cell.
function istYmd(iso) { const t = Date.parse(iso); return isNaN(t) ? '' : new Date(t + 330 * 60000).toISOString().slice(0, 10); }
function fmtDay(iso) { const y = istYmd(iso); if (!y) return ''; const [Y, M, D] = y.split('-'); return `${D}/${M}/${Y}`; }
// yyyy-mm-dd → dd/mm/yyyy (for date-field cells like closing_date, retainer_start, video date)
function fmtDMY(ymd) { const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : (ymd || ''); }
const ph = '<span class="ph">—</span>';
const cellTxt = v => v ? esc(v) : ph;

const VIDEO_TYPES = ['Reel', 'Story', 'Post', 'YouTube', 'Short', 'TikTok', 'Facebook Video'];

// Dropdown option lists, keyed by edit-type.
// Status is stored as a key (e.g. call_pitched); show its friendly label.
function statusLabel(key) {
  if (!key) return '';
  const s = (state.statuses || []).find(o => o.key === key);
  return s ? s.label : key;
}
const SELECT_OPTS = {
  category: () => state.categories,
  owner: () => ownerOptions(),
  // Owner can be anyone (contractors, agencies, ex-teammates). Manager is the
  // accountable person INSIDE the CRM, so it only ever offers actual users.
  manager: () => (state.team || []).slice().sort((a, b) => a.localeCompare(b)),
  stage: () => state.pipeline.stages,
  label: () => state.labels || [],
  video_type: () => VIDEO_TYPES,
  contract_signed: () => ['Yes', 'No', 'Pending'],
  on_retainer: () => ['Yes', 'No'],
  partnership_status: () => ['Active', 'Completed', 'Paused', 'Cancelled'],
  fail_reason: () => ['Poor Quality Lead', 'Out of budget', 'Ghosted', 'Not agreeing for deliverables'],
  retainer_months: () => Array.from({ length: 24 }, (_, i) => String(i + 1)),
  interested: () => ['Yes', 'No'],
  not_interested_reason: () => ['Competitor partner', 'Too busy', 'Content misaligned', 'Not specified'],
  outcome: () => ['Closed', 'Failed', 'In progress', 'No response'],
};

// Column model. `e` = edit type ('' / undefined = read-only cell).
const CORE_COLS = [
  { f: 'date',       h: 'Date',       e: 'date', cls: 'dt' },
  { f: 'first_name', h: 'First Name', e: 'text' },
  { f: 'social_url', h: 'Username',   e: 'text', cls: 'uname', uname: true },
  { h: 'Primary Social Profile', link: true, cls: 'lnk' },
  { f: 'email',      h: 'Email',      e: 'text' },
  { f: 'lead_owner', h: 'Added by', e: 'owner' },
  // Manager is a CRM teammate; owner often is not one, so the two are separate.
  { f: 'lead_manager', h: 'Lead Owner', e: 'manager' },
  { f: 'category',   h: 'Category',   e: 'category', cls: 'cat' },
  { f: 'stage',      h: 'Stage',      e: 'stage', cls: 'stg' },
  { f: 'status',     h: 'Status',     e: 'status', cls: 'stt' },
  { f: 'label',      h: 'Label',      e: 'label', cls: 'lbl' },
  { f: 'notes',      h: 'Notes',      e: 'notes', cls: 'notes' },
  { h: 'CRM',        status: true, cls: 'st' },
  // Instagram, filled from HikerAPI. Not editable — they are fetched values,
  // so there is no `e:` and the grid renders them read-only.
  { f: 'ig_followers',    h: 'Followers',        ig: 'num',  cls: 'ig', sortable: true },
  { f: 'ig_last_post_at', h: 'Last Post',        ig: 'date', cls: 'ig igdate' },
  { f: 'ig_avg_views_10', h: 'Avg Views (10)',   ig: 'num',  cls: 'ig', sortable: true },
  { f: 'ig_bio',          h: 'Bio',              ig: 'text', cls: 'igbio' },
  { f: 'ig_link',         h: 'Link in bio',      ig: 'link', cls: 'iglink' },
  { f: 'ig_checked_at',   h: 'Last enriched',    ig: 'ago',  cls: 'ig igago', sortable: true },
];
// Extra columns per tab (appended to CORE).
const TAB_EXTRA = {
  leads: [],
  responses: [
    { f: 'interested', h: 'Interested in collab', e: 'interested' },
    { f: 'not_interested_reason', h: 'Reason for Not Interested', e: 'not_interested_reason' },
  ],
  all: [
    { f: 'interested',   h: 'Interested?',  e: 'interested' },
    { f: 'initial_rate', h: 'Initial Rate', e: 'text', deal: true },
    { f: 'outcome',      h: 'Outcome',      e: 'outcome' },
    { f: 'closing_rate', h: 'Closing Rate', e: 'text', deal: true },
    { f: 'fail_reason',  h: 'Fail Reason',  e: 'fail_reason' },
    { f: 'signups',      h: 'Signups',      e: 'text' },
    { f: 'saas',         h: 'SAAS',         e: 'text' },
  ],
  closed: [
    { f: 'position',            h: 'Delivery Status', e: 'delivery', cls: 'dlv' },
    { f: 'closing_rate',        h: 'Closing Rate',   e: 'text', deal: true },
    { f: 'closing_date',        h: 'Closing Date',   e: 'date' },
    { f: 'deliverables',        h: 'Deliverables',   e: 'text', deal: true },
    { f: 'contract_signed',     h: 'Contract Signed', e: 'contract_signed' },
    { f: 'on_retainer',         h: 'On Retainer',    e: 'on_retainer' },
    { f: 'retainer_start_date', h: 'Retainer Start', e: 'date' },
    { f: 'retainer_months',     h: 'Retainer (mo)',  e: 'text' },
    { f: 'partnership_status',  h: 'Status',         e: 'partnership_status' },
  ],
  failed: [
    { f: 'position',     h: 'Reason for Failure', e: 'reason', cls: 'dlv' },
    { f: 'fail_details', h: 'Details', e: 'notes' },
  ],
};
const activeCols = () => CORE_COLS.concat(TAB_EXTRA[state.tab] || []);

function cellValue(e, c) {
  if (c.uname) return e.handle || '';
  if (c.f === 'date') return istYmd(e.created_at);
  if (c.deal) return (e.deal && e.deal[c.f]) || '';
  return c.f && e[c.f] != null ? e[c.f] : '';
}
// Compact counts: 12,300 -> 12.3K. Keeps the columns narrow without hiding
// the real number, which stays in the title attribute.
function fmtCount(n) {
  if (n === null || n === undefined) return '';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'K';
  return (n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, '') + 'M';
}

// A never-fetched value is a dash, NOT a zero — the difference matters when
// you are judging a lead. A checked-but-empty value says why.
function igCell(e, c) {
  const v = e[c.f];
  if (v === null || v === undefined || v === '') {
    if (!e.ig_checked_at) return '<span class="ph" title="Not fetched yet">—</span>';
    const why = e.ig_status === 'private' ? 'Private account'
      : e.ig_status === 'notfound' ? 'Handle not found on Instagram'
      : e.ig_status === 'error' ? 'Fetch failed — try refreshing'
      : c.f === 'ig_avg_views_10' ? 'No reels found'
      : c.f === 'ig_checked_at' ? 'Never enriched'
      : 'No data';
    return '<span class="ph" title="' + esc(why) + '">—</span>';
  }
  if (c.ig === 'text') {
    // One line + ellipsis like every other column; the full bio is the tooltip.
    return '<span class="igv" title="' + esc(v) + '">' + esc(v) + '</span>';
  }
  if (c.ig === 'link') {
    // Show it without the scheme so the platform reads first; the anchor keeps
    // the real URL. Not opened from the grid by accident — needs a click.
    const shown = String(v).replace(/^https?:\/\//i, '').replace(/^www\./i, '');
    return '<a class="igv iglink-a" href="' + esc(v) + '" target="_blank" rel="noopener" title="' + esc(v) + '">' + esc(shown) + '</a>';
  }
  if (c.ig === 'ago') {
    const d = new Date(v); if (isNaN(d)) return ph;
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    const label = days <= 0 ? 'today' : days === 1 ? '1d ago' : days + 'd ago';
    // Same 90-day threshold as Last Post: past that, followers and view
    // counts have usually moved enough to be worth re-fetching.
    const cls = days > 90 ? ' stale' : '';
    return '<span class="igv' + cls + '" title="Enriched ' + esc(fmtDMY(d.toISOString().slice(0, 10))) + '">' + esc(label) + '</span>';
  }
  if (c.ig === 'date') {
    const d = new Date(v); if (isNaN(d)) return ph;
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    const label = fmtDMY(d.toISOString().slice(0, 10));
    // Flag leads who have gone quiet — that is the point of the column.
    const cls = days > 90 ? ' stale' : '';
    return '<span class="igv' + cls + '" title="' + esc(days + ' days ago') + '">' + esc(label) + '</span>';
  }
  return '<span class="igv" title="' + esc(Number(v).toLocaleString()) + '">' + esc(fmtCount(Number(v))) + '</span>';
}

function cellDisplay(e, c) {
  if (c.link) return e.social_url ? `<a href="${esc(e.social_url)}" target="_blank" rel="noopener">${esc(e.social_url.replace(/^https?:\/\//, ''))}</a>` : ph;
  if (c.status) return statusChipHtml(e);
  if (c.f === 'status') { const l = statusLabel(e.status); return l ? `<span class="crumb">${esc(l)}</span>` : '<span class="ph">— set —</span>'; }
  if (c.f === 'label') return e.label ? `<span class="crumb">${esc(e.label)}</span>` : '<span class="ph">— set —</span>';
  if (c.e === 'delivery' || c.e === 'reason') { const l = subNodeLabel(e.position); return l ? `<span class="crumb">${esc(l)}</span>` : '<span class="ph">— set —</span>'; }
  if (c.uname) {
    // Someone who has already made a video for us is a different kind of
    // contact from a cold lead, and that is worth seeing without opening
    // anything. Sits in the username cell rather than costing a column.
    const tag = e.partner ? ' <span class="ptag" title="Has posted a video for us">\u2605 Partner</span>' : '';
    return '@' + esc(e.handle) + tag;
  }
  if (c.ig) return igCell(e, c);
  if (c.f === 'date') { const d = fmtDay(e.created_at); return d ? esc(d) : ph; }
  if (c.e === 'date') { const v = cellValue(e, c); return v ? esc(fmtDMY(v)) : ph; }
  return cellTxt(cellValue(e, c));
}

function ownerOptions() {
  return [...new Set([...(state.owners || []), ...(state.team || [])])].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

/* ── paged grid ─────────────────────────────────────
   The grid can match ~22k leads x 20 columns; rendering them all was ~568k
   DOM nodes and 5-11s of blocking layout, which is what made scrolling
   stutter. We now render one page at a time (100 rows by default).
   Column widths are still measured once from a sample spread across the WHOLE
   filtered set and pinned via <colgroup> + table-layout:fixed — otherwise
   every page would size its columns to its own content and they would jump
   around as you paged.                                                     */
const PAGE_SIZES = [100, 250, 500, 1000];

function pageCount() {
  return Math.max(1, Math.ceil(state.entries.length / state.pageSize));
}

// Page numbers to show: always first and last, a run around the current page,
// and '…' for the gaps.
function pageNumbers(cur, total) {
  if (total <= 9) return Array.from({ length: total }, (_, i) => i + 1);
  const out = [1];
  let lo = Math.max(2, cur - 2), hi = Math.min(total - 1, cur + 2);
  if (cur <= 4) { lo = 2; hi = 6; }
  if (cur >= total - 3) { lo = total - 5; hi = total - 1; }
  if (lo > 2) out.push('...');
  for (let i = lo; i <= hi; i++) out.push(i);
  if (hi < total - 1) out.push('...');
  out.push(total);
  return out;
}

// Sample rows from across the whole set, lay them out with the normal
// auto-sizing table, and read back the column widths + row height.
function measureGrid(list, cols, head) {
  const n = state.entries.length;
  const step = Math.max(1, Math.floor(n / 300));
  let sample = '';
  for (let i = 0; i < n; i += step) sample += rowHtml(state.entries[i], cols, i);
  // Measure against content width ONLY. The live rule is width:max-content +
  // min-width:100%, and that stretch dumps all the surplus into one column —
  // pinning those widths would give a 1600px Date column.
  list.innerHTML = `<table class="grid" style="width:max-content;min-width:0">${head}<tbody>${sample}</tbody></table>`;
  const tbl = list.querySelector('table');
  const w = [...tbl.querySelectorAll('thead th')].map(th => Math.max(1, Math.ceil(th.getBoundingClientRect().width)));
  const tr = tbl.querySelector('tbody tr');
  const rowH = tr ? tr.getBoundingClientRect().height : 0;
  return { w, rowH: rowH || 26 };
}

// (Re)build the table shell: colgroup + header + an empty tbody we then fill
// with the current page.
function buildGridShell(list, g) {
  const colg = '<colgroup>' + g.colW.map(w => `<col style="width:${w}px">`).join('') + '</colgroup>';
  const width = g.colW.reduce((a, b) => a + b, 0);
  list.innerHTML = g.note + `<table class="grid gfixed" style="width:${width}px">${colg}${g.head}<tbody></tbody></table>`;
  list.scrollTop = 0; list.scrollLeft = 0;
  g.tbody = list.querySelector('tbody');
  g.win = null;
  wireGrid();
  const thead = list.querySelector('thead');
  if (thead && !thead._sortWired) {
    thead._sortWired = true;
    thead.addEventListener('click', ev => {
      const th = ev.target.closest('th[data-sort]');
      if (th) toggleSort(th.dataset.sort);
    });
  }
}

// Render the current page into the existing tbody.
function paintPage() {
  const g = state.grid; if (!g.tbody) return;
  const from = (state.page - 1) * state.pageSize;
  const rows = state.entries.slice(from, from + state.pageSize);
  let body = '';
  for (let i = 0; i < rows.length; i++) body += rowHtml(rows[i], g.cols, i);
  if (body === g.win) return;                              // nothing changed — leave the DOM alone
  const open = $('list').querySelector('.celled');         // an inline editor commits on blur
  if (open) { open.blur(); return; }                       // that commit repaints; don't fight it
  g.win = body;
  g.tbody.innerHTML = body;
}

function renderPager() {
  const bar = $('pager');
  const n = state.entries.length;
  if (!n) { bar.style.display = 'none'; return; }
  const total = pageCount(), cur = state.page;
  const from = (cur - 1) * state.pageSize;
  const to = Math.min(n, from + state.pageSize);
  const btn = (act, label, dis, extra) =>
    `<button class="pg-btn${extra || ''}" data-pg="${act}"${dis ? ' disabled' : ''}>${label}</button>`;
  let nums = '';
  for (const x of pageNumbers(cur, total)) {
    nums += x === '...'
      ? '<span class="pg-gap">…</span>'
      : btn(String(x), String(x), false, x === cur ? ' cur' : '');
  }
  bar.innerHTML =
    `<div class="pg-info">Showing <b>${(from + 1).toLocaleString()}</b>–<b>${to.toLocaleString()}</b> of <b>${n.toLocaleString()}</b></div>` +
    '<div class="pg-nav">' +
      btn('first', '« First', cur === 1) + btn('prev', '‹ Prev', cur === 1) +
      nums +
      btn('next', 'Next ›', cur === total) + btn('last', 'Last »', cur === total) +
    '</div>' +
    `<div class="pg-tools"><span>Go to</span><input id="pg-jump" type="number" min="1" max="${total}" placeholder="${cur}"><span>of ${total.toLocaleString()}</span>` +
    `<select id="pg-size">${PAGE_SIZES.map(v => `<option value="${v}"${v === state.pageSize ? " selected" : ""}>${v} / page</option>`).join('')}</select></div>`;
  bar.style.display = 'flex';
}

function goToPage(n) {
  const total = pageCount();
  const next = Math.min(total, Math.max(1, n | 0));
  if (next === state.page) return;
  state.page = next;
  paintPage();
  renderPager();
  $('list').scrollTop = 0;   // a new page always starts at the top
}

function wirePager() {
  const bar = $('pager');
  if (bar._wired) return;
  bar._wired = true;
  bar.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-pg]'); if (!b || b.disabled) return;
    const a = b.dataset.pg;
    if (a === 'first') return goToPage(1);
    if (a === 'prev') return goToPage(state.page - 1);
    if (a === 'next') return goToPage(state.page + 1);
    if (a === 'last') return goToPage(pageCount());
    goToPage(parseInt(a, 10));
  });
  bar.addEventListener('change', ev => {
    if (ev.target.id !== 'pg-size') return;
    const size = parseInt(ev.target.value, 10) || 100;
    // Keep the first visible row visible when the page size changes.
    const anchor = (state.page - 1) * state.pageSize;
    state.pageSize = size;
    state.page = Math.floor(anchor / size) + 1;
    state.grid.win = null;
    paintPage(); renderPager(); $('list').scrollTop = 0;
  });
  const jump = ev => {
    if (ev.target.id !== 'pg-jump') return;
    if (ev.type === 'keydown' && ev.key !== 'Enter') return;
    const v = parseInt(ev.target.value, 10);
    if (v) { goToPage(v); ev.target.value = ''; }
  };
  bar.addEventListener('keydown', jump);
  bar.addEventListener('change', jump);
  // ←/→ page through the grid, but never while typing or editing a cell.
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    if (state.tab === 'videos' || $('pager').style.display === 'none') return;
    const t = ev.target;
    if (t instanceof Element && (t.matches('input, select, textarea') || t.isContentEditable)) return;
    if (document.querySelector('.modal-bg.open')) return;
    ev.preventDefault();
    goToPage(state.page + (ev.key === 'ArrowRight' ? 1 : -1));
  });
}

/* Sorts the WHOLE filtered set, not just the visible page, so page 1 really is
   the top of the list. Leads with no value sink to the bottom in both
   directions — an un-enriched lead is not "0 followers". */
function applySort() {
  const key = state.sort.key;
  if (!key) return;
  const mul = state.sort.dir === 'asc' ? 1 : -1;
  const blank = x => x === null || x === undefined || x === '';
  state.entries.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (blank(av) && blank(bv)) return 0;
    if (blank(av)) return 1;
    if (blank(bv)) return -1;
    if (av === bv) return 0;
    return av > bv ? mul : -mul;
  });
}

function toggleSort(key) {
  if (state.sort.key === key) {
    // desc -> asc -> off, so a third click restores the default order.
    if (state.sort.dir === 'desc') state.sort.dir = 'asc';
    else { state.sort.key = ''; state.sort.dir = 'desc'; }
  } else { state.sort.key = key; state.sort.dir = 'desc'; }
  if (!state.sort.key) return loadEntries();      // refetch to restore server order
  applySort();
  state.page = 1;                                  // a new order means a new page 1
  state.grid.win = null;
  paintPage(); renderPager(); markSortHeaders();
  $('list').scrollTop = 0;
}

// Toggle the header classes in place — rebuilding the shell would re-measure
// every column width and make them twitch on each sort click.
function markSortHeaders() {
  const ths = $('list').querySelectorAll('thead th[data-sort]');
  for (const th of ths) {
    const on = th.dataset.sort === state.sort.key;
    th.classList.toggle('sort-desc', on && state.sort.dir === 'desc');
    th.classList.toggle('sort-asc', on && state.sort.dir === 'asc');
  }
}

function renderEntries() {
  const list = $('list');
  const g = state.grid;
  const shown = state.entries.length;
  // Denominator = exact count matching the CURRENT filter (not the whole table).
  const total = state.filteredTotal != null ? state.filteredTotal : (state.grandTotal != null ? state.grandTotal : shown);
  $('entry-count').textContent = total ? (shown < total ? `(${shown} of ${total})` : `(${total})`) : '';
  if (!shown) {
    g.tbody = null; g.sig = ''; g.win = null; state.page = 1;
    $('pager').style.display = 'none';
    list.innerHTML = '<div class="empty">No leads match. Try clearing filters or a different search.</div>';
    return;
  }
  // A note only shows if we somehow hit the 100k server ceiling.
  const capped = shown < total;
  g.note = capped ? `<div class="cap-note">Showing <b>${shown}</b> of <b>${total}</b> matching leads — narrow the filter to load the rest.</div>` : '';
  g.cols = activeCols();
  g.head = '<thead><tr>' + g.cols.map(c => `<th class="${c.cls || ''}${c.sortable ? " sortable" : ""}"${c.sortable ? ` data-sort="${c.f}"` : ""}>${esc(c.h)}</th>`).join('') + '<th class="act"></th></tr></thead>';
  // A shrinking result set can leave us past the end.
  if (state.page > pageCount()) state.page = pageCount();
  // Re-measure only when the shape of the grid changes (tab, columns, or how
  // many rows matched) — not on every data refresh, and never on a page flip.
  const sig = state.tab + '|' + g.cols.length + '|' + shown + '|' + (capped ? 'c' : '');
  if (sig !== g.sig || !g.colW || !g.tbody || !list.querySelector('table.grid')) {
    const m = measureGrid(list, g.cols, g.head);
    g.colW = m.w; g.rowH = m.rowH; g.sig = sig;
    buildGridShell(list, g);
  }
  paintPage();
  renderPager();
  wirePager();
  markSortHeaders();
}

function statusChipHtml(e) {
  let tone = 'green', label = 'New';
  if (e.crm && e.crm.replied) { tone = 'red'; label = 'Prior convo'; }
  else if (e.crm && e.crm.contacted) { tone = 'orange'; label = 'No reply'; }
  else if (e.in_master) { tone = 'blue'; label = 'In records'; }
  const view = e.view_conversation ? ` <a class="vc" href="${esc(e.view_conversation)}" target="_blank" rel="noopener" title="View conversation">↗</a>` : '';
  const st = (e.crm && e.crm.status) ? ` <span class="stx" title="CRM status">${esc(e.crm.status)}</span>` : '';
  const poc = (e.crm && e.crm.poc) ? `<span class="pocmini">POC: ${esc(e.crm.poc)}</span>` : '';
  return `<span class="chip ${tone}">${label}</span>${st}${poc}`;
}

function rowHtml(e, cols, idx) {
  cols = cols || activeCols();
  const tds = cols.map(c => c.e
    ? `<td class="c ${c.cls || ''}" data-f="${c.f}" data-e="${c.e}" data-v="${esc(cellValue(e, c))}" title="${esc(cellValue(e, c))}">${cellDisplay(e, c)}</td>`
    : `<td class="${c.cls || ''}">${cellDisplay(e, c)}</td>`).join('');
  // Move-to-Closed / Move-to-Failed buttons on the movable lead tabs.
  const mv = ['leads', 'responses', 'all'].includes(state.tab)
    ? `<button class="mv close-btn" title="Mark Closed">✔</button><button class="mv fail-btn" title="Mark Failed">✘</button>` : '';
  // View-conversation popup — Responses tab only.
  const vc = state.tab === 'responses' ? `<button class="mv viewconv" title="View conversation">💬</button>` : '';
  // Zebra striping keys off the absolute row index: the virtual spacer rows
  // would otherwise flip :nth-child parity as you scroll.
  // NB: no generic class name here — .row is already a flex form-layout
  // utility in style.css and would turn every table row into a flex box.
  const stripe = (idx % 2) ? ' class="odd"' : '';
  return `<tr${stripe} data-id="${e.id}">${tds}<td class="act">${mv}${vc}<button class="exp" title="Open full editor">⤢</button><button class="del" title="Delete">×</button></td></tr>`;
}

function wireGrid() {
  const tb = $('list').querySelector('tbody');
  if (tb && !tb._wired) { tb.addEventListener('click', onGridClick); tb._wired = true; }
}

function onGridClick(ev) {
  const tr = ev.target.closest('tr[data-id]'); if (!tr) return;
  const id = +tr.dataset.id;
  const e = state.entries.find(x => x.id === id); if (!e) return;
  if (ev.target.closest('.del')) return deleteEntry(e);
  if (ev.target.closest('.close-btn')) return openClosePopup(e);
  if (ev.target.closest('.fail-btn')) return openFailPopup(e);
  if (ev.target.closest('.viewconv')) return openConvModal(e);
  if (ev.target.closest('.exp')) return openEdit(e);
  if (ev.target.closest('a')) return; // let links through
  // Bio is read-only but often several lines long; clicking it expands the cell
  // in place (preserving the line breaks Instagram actually stores) instead of
  // making you hover for a tooltip.
  const bioTd = ev.target.closest('td.igbio');
  if (bioTd) { if ((bioTd.textContent || '').trim() !== '—') bioTd.classList.toggle('open'); return; }
  const td = ev.target.closest('td.c'); if (!td || td.querySelector('input,select,textarea')) return;
  beginEdit(td, e);
}

// Build the right input element for an edit-type. Reused by leads + videos grids.
function makeCellInput(etype, cur) {
  let input;
  if (etype === 'status') {
    // Status options are {key,label}: show the label, keep the key as the value.
    const opts = state.statuses || [];
    const has = opts.some(o => o.key === cur);
    input = document.createElement('select');
    input.innerHTML = '<option value="">—</option>'
      + opts.map(o => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join('')
      + (cur && !has ? `<option value="${esc(cur)}">${esc(cur)}</option>` : '');
    input.value = cur; input.className = 'celled';
    return input;
  }
  if (etype === 'delivery' || etype === 'reason') {
    // Delivery status = Closed sub-nodes; Reason for failure = Failed sub-nodes
    // (value = node key, shown as its label).
    const opts = pipeRoots(etype === 'delivery' ? 'Closed' : 'Failed');
    const has = opts.some(o => o.key === cur);
    input = document.createElement('select');
    input.innerHTML = '<option value="">—</option>'
      + opts.map(o => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join('')
      + (cur && !has ? `<option value="${esc(cur)}">${esc(subNodeLabel(cur))}</option>` : '');
    input.value = cur; input.className = 'celled';
    return input;
  }
  if (SELECT_OPTS[etype]) {
    const opts = SELECT_OPTS[etype]() || [];
    input = document.createElement('select');
    const extra = (cur && !opts.includes(cur)) ? `<option value="${esc(cur)}">${esc(cur)}</option>` : '';
    input.innerHTML = '<option value="">—</option>' + opts.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('') + extra;
    input.value = cur; input.className = 'celled';
  } else if (etype === 'date') {
    input = document.createElement('input'); input.type = 'date'; input.value = cur; input.className = 'celled';
  } else if (etype === 'country') {
    input = document.createElement('input'); input.type = 'text'; input.value = cur; input.className = 'celled'; input.setAttribute('list', 'country-list');
  } else if (etype === 'notes') {
    input = document.createElement('textarea'); input.value = cur; input.className = 'celled cellta';
    const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 240) + 'px'; };
    input.addEventListener('input', grow); setTimeout(grow, 0);
  } else {
    input = document.createElement('input'); input.type = 'text'; input.value = cur; input.className = 'celled';
  }
  return input;
}

// Generic inline cell editor. onSave(value) returns the updated row (or throws);
// reRender(row) repaints. cancels/no-change repaint from the original.
function editCell(td, etype, cur, original, onSave, reRender) {
  const input = makeCellInput(etype, cur);
  td.textContent = ''; td.appendChild(input); input.focus();
  if (input.select) { try { input.select(); } catch { /* selects can't */ } }
  let done = false;
  const commit = async () => {
    if (done) return;
    const val = input.value;
    if ((val || '').trim() === (cur || '').trim()) { done = true; return reRender(original); }
    done = true;
    try { const updated = await onSave(val.trim ? val.trim() : val); reRender(updated || original); toast('Saved'); }
    catch (err) { toast(err.message); reRender(original); }
  };
  input.addEventListener('keydown', k => {
    if (k.key === 'Enter' && !k.shiftKey) { k.preventDefault(); input.blur(); }
    else if (k.key === 'Escape') { done = true; reRender(original); }
  });
  input.addEventListener('blur', commit);
}

function beginEdit(td, e) {
  const field = td.dataset.f, etype = td.dataset.e, cur = td.dataset.v || '';
  editCell(td, etype, cur, e,
    async val => {
      const body = { id: e.id };
      if (field === 'social_url') { if (!val) throw new Error('Handle required'); body.social_url = val; }
      else if (field === 'date') body.date = val;
      else if (field === 'stage') { body.stage = val; body.position = ''; }   // new bucket → position resets
      else body[field] = val;
      const res = await api('/api/entries', { method: 'PATCH', body });
      const i = state.entries.findIndex(x => x.id === e.id); if (i >= 0 && res.entry) state.entries[i] = res.entry;
      return res.entry;
    },
    entry => replaceRow(e.id, entry || e));
}

// Dedicated inline editor for the Pipeline Position — a grouped picker of the
// lead's current-stage sub-tree, showing the breadcrumb once chosen.
function editPositionCell(td, e, cur) {
  const sel = document.createElement('select');
  sel.className = 'celled';
  sel.innerHTML = pipeOptionsHtml(e.stage, cur);
  td.textContent = ''; td.appendChild(sel); sel.focus();
  let done = false;
  const commit = async () => {
    if (done) return; done = true;
    const val = sel.value;
    if (val === cur) return replaceRow(e.id, e);
    try {
      const res = await api('/api/entries', { method: 'PATCH', body: { id: e.id, position: val } });
      const i = state.entries.findIndex(x => x.id === e.id); if (i >= 0 && res.entry) state.entries[i] = res.entry;
      toast('Saved'); replaceRow(e.id, res.entry || e);
    } catch (err) { toast(err.message); replaceRow(e.id, e); }
  };
  sel.addEventListener('change', commit);
  sel.addEventListener('blur', commit);
  sel.addEventListener('keydown', k => { if (k.key === 'Escape') { done = true; replaceRow(e.id, e); } });
}

function replaceRow(id, entry) {
  const tr = $('list').querySelector(`tr[data-id="${id}"]`);
  // Striping is page-relative, so translate the absolute index.
  const abs = state.entries.findIndex(x => x.id === id);
  if (tr) tr.outerHTML = rowHtml(entry, activeCols(), abs - (state.page - 1) * state.pageSize);
  // The DOM no longer matches the cached window — force the next paint through.
  state.grid.win = null;
}

/* ── Instagram enrichment (HikerAPI) ─────────────────────────
   Every call costs credits (2 per lead), so nothing here runs on its own:
   the user picks a batch and watches it go.                              */
let igBusy = false;

async function openIgModal() {
  $('ig-bg').classList.add('open');
  $('ig-body').innerHTML = '<div class="spin">Checking…</div>';
  let st;
  try { st = await api('/api/entries/ig-status'); }
  catch (e) { $('ig-body').innerHTML = `<div class="sig red"><span class="ic">⚠️</span><span class="tx">${esc(e.message)}</span></div>`; return; }
  const pageIds = igPageIds();
  const keyWarn = st.key_set ? '' :
    '<div class="sig red"><span class="ic">⚠️</span><span class="tx"><b>No HikerAPI key set.</b>' +
    '<small>Run <code>wrangler secret put HIKER_API_KEY</code> on the leadgen worker first.</small></span></div>';
  $('ig-body').innerHTML = keyWarn +
    `<p class="ig-note">Each lead costs <b>2</b> HikerAPI calls (profile + reels). <b>${st.enriched.toLocaleString()}</b> leads already have data.</p>` +
    `<div class="ig-act"><div><b>This page</b><small>${pageIds.length} lead${pageIds.length === 1 ? "" : "s"} shown — about ${(pageIds.length * 2).toLocaleString()} calls</small></div>` +
    `<button class="hbtn" id="ig-page"${pageIds.length ? "" : " disabled"}>Fetch</button></div>` +
    (state.me && state.me.is_admin ?
      `<div class="ig-act"><div><b>All engaged leads</b><small>Responses + Closed · ${st.engaged_pending.toLocaleString()} still unfetched — about ${(st.engaged_pending * 2).toLocaleString()} calls</small></div>` +
      `<button class="hbtn" id="ig-engaged"${st.engaged_pending ? "" : " disabled"}>Backfill</button></div>` +
      `<div class="ig-act"><div><b>Every lead</b><small>${st.all_pending.toLocaleString()} still unfetched — about ${(st.all_pending * 2).toLocaleString()} calls</small></div>` +
      `<button class="hbtn" id="ig-all"${st.all_pending ? "" : " disabled"}>Backfill</button></div>` : '') +
    '<div id="ig-prog" class="ig-prog"></div>';
  if ($('ig-page')) $('ig-page').onclick = () => igRefreshPage();
  if ($('ig-engaged')) $('ig-engaged').onclick = () => igBackfill('engaged');
  if ($('ig-all')) $('ig-all').onclick = () => igBackfill('all');
}

// The leads currently rendered — the page is the unit of spend.
function igPageIds() {
  return [...$('list').querySelectorAll('tbody tr[data-id]')].map(tr => +tr.dataset.id);
}

async function igRefreshPage() {
  if (igBusy) return; igBusy = true;
  const ids = igPageIds();
  const prog = $('ig-prog');
  try {
    let done = 0;
    // Chunked to the server's per-request cap.
    for (let i = 0; i < ids.length; i += 50) {
      prog.textContent = `Fetching ${done} / ${ids.length}…`;
      const r = await api('/api/entries/ig-refresh', { method: 'POST', body: { ids: ids.slice(i, i + 50) } });
      done += r.done || 0;
      for (const en of r.entries || []) {
        const k = state.entries.findIndex(x => x.id === en.id);
        if (k >= 0) { state.entries[k] = en; replaceRow(en.id, en); }
      }
    }
    prog.textContent = `Done — ${done} lead${done === 1 ? '' : 's'} updated.`;
    toast('Instagram data updated');
  } catch (e) { prog.innerHTML = `<span class="pg-err">${esc(e.message)}</span>`; }
  finally { igBusy = false; }
}

async function igBackfill(scope) {
  if (igBusy) return; igBusy = true;
  const prog = $('ig-prog');
  let done = 0;
  try {
    for (;;) {
      const r = await api('/api/entries/ig-backfill', { method: 'POST', body: { scope } });
      done += r.done || 0;
      prog.textContent = `Fetched ${done}… ${r.remaining.toLocaleString()} left.`;
      if (r.finished || !r.done) break;
      if (!$('ig-bg').classList.contains('open')) break;   // closing the modal stops the spend
    }
    prog.textContent = `Done — ${done} lead${done === 1 ? '' : 's'} enriched.`;
    await loadEntries();
  } catch (e) { prog.innerHTML = `<span class="pg-err">${esc(e.message)}</span>`; }
  finally { igBusy = false; }
}

/* ── top-level view switch (CRM pipeline ｜ Unibox email replies) ── */
function switchView(view, deepLink) {
  const frame = $('unibox-frame');
  document.querySelectorAll('#sidebar .sb-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.body.classList.toggle('view-unibox', view === 'unibox');
  if (view === 'unibox') {
    const target = uniboxSrc(deepLink || '');
    // (Re)point the frame if it's not loaded, or a specific lead was requested.
    if (!frame.getAttribute('src')) frame.setAttribute('src', target);
    else if (deepLink) frame.setAttribute('src', target);
    frame.style.display = 'block';
  } else {
    frame.style.display = 'none';
  }
}

/* ── tabs ──────────────────────────────────────────────────── */
const TABS = [
  { k: 'leads', h: 'Leads' }, { k: 'responses', h: 'Responses' },
  { k: 'closed', h: 'Closed' }, { k: 'failed', h: 'Failed' },
  { k: 'all', h: 'All Leads' }, { k: 'videos', h: 'Videos' },
];
function renderTabs() {
  $('tab-bar').innerHTML = TABS.map(t => `<button class="tab ${state.tab === t.k ? 'active' : ''}" data-tab="${t.k}">${esc(t.h)}</button>`).join('');
}
/* ── deep links (the Chrome extension links straight into a lead) ──
   ?lead=<handle>   open that lead's conversation popup
   ?email=<handle>  open that lead's editor, focused on the email field
   ?add=<handle>    open the Add-lead modal with the username prefilled
   Parsed once at boot and HELD: if the user is logged out they hit the login
   screen first, and the intent has to survive that instead of being dropped. */
const deepLink = (() => {
  const q = new URLSearchParams(location.search);
  for (const kind of ['lead', 'email', 'add', 'videos']) {
    const v = (q.get(kind) || '').trim().toLowerCase().replace(/^@+/, '');
    if (v) return { kind, handle: v };
  }
  return null;
})();

async function runDeepLink() {
  const { kind, handle } = deepLink;
  // One-shot: drop the query string so a refresh doesn't reopen the modal.
  history.replaceState({}, '', location.pathname);

  /* Straight to this creator's posts. The Videos tab filters client-side on
     its own search box, and handle is one of the fields it matches, so
     seeding it is all that is needed — and it stays visible, so it is obvious
     why the list is short and how to clear it. */
  if (kind === 'videos') {
    $('video-search').value = handle;
    await switchTab('videos');
    return;
  }

  if (kind === 'add') {
    await switchTab('leads');
    $('add-bg').classList.add('open');
    $('f-social').value = 'https://instagram.com/' + handle;
    // Fire the live duplicate/CRM preview the form does as you type.
    $('f-social').dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(() => $('f-email').focus(), 60);
    return;
  }

  // Surface the row behind the modal, so closing it leaves you on that lead
  // rather than back in a list of 23k.
  $('search').value = handle;
  await switchTab('all');
  const e = state.entries.find(x => String(x.handle || '').toLowerCase() === handle);
  if (!e) { toast('@' + handle + ' is not in the CRM'); return; }
  if (kind === 'email') {
    openEdit(e);
    setTimeout(() => { const f = $('e-email'); if (f) { f.focus(); f.select(); } }, 80);
  } else {
    openConvModal(e);
  }
}

function switchTab(k) {
  state.tab = k;
  renderTabs();
  const isVideos = k === 'videos';
  $('lead-controls').style.display = isVideos ? 'none' : '';
  // Search and Add lead live on the tab line now, but they are still lead
  // controls — Videos has its own search and its own add button.
  $('tab-tools').style.display = isVideos ? 'none' : '';
  // It left #lead-controls, so it no longer hides with that group.
  $('open-add-btn').style.display = isVideos ? 'none' : '';
  $('video-controls').style.display = isVideos ? '' : 'none';
  const db = document.querySelector('.date-bar'); if (db) db.style.display = isVideos ? 'none' : '';
  const t = TABS.find(x => x.k === k);
  $('list-title').innerHTML = esc(t.h) + ' <span class="count" id="entry-count"></span>';

  // Delivery-status filter shows only on the Closed tab.
  const dfEl = $('delivery-filter');
  if (dfEl) { dfEl.style.display = (k === 'closed') ? '' : 'none'; if (k === 'closed') fillDeliveryFilter(); else dfEl.value = ''; }
  const rfEl = $('reason-filter');
  if (rfEl) { rfEl.style.display = (k === 'failed') ? '' : 'none'; if (k === 'failed') fillReasonFilter(); else rfEl.value = ''; }
  // Returned so a deep link can wait for the rows before opening a modal on one.
  return loadEntries();
}

/* ── move to Closed / Failed (popup forms) ─────────────────── */
function openClosePopup(e) {
  $('close-bg').classList.add('open'); $('close-msg').textContent = '';
  $('cl-id').value = e.id; $('close-who').textContent = '@' + e.handle;
  // Delivery status = the Closed-stage sub-nodes (Deliverables Met / Partially… etc.).
  const ds = $('cl-delivstatus');
  ds.innerHTML = '<option value="">— select —</option>' +
    pipeRoots('Closed').map(n => `<option value="${esc(n.key)}">${esc(n.label)}</option>`).join('');
  ds.value = (e.stage === 'Closed' && e.position) ? e.position : '';
  $('cl-date').value = e.closing_date || '';
  $('cl-rate').value = (e.deal && e.deal.closing_rate) || '';
  $('cl-retainer').value = e.on_retainer || '';
  $('cl-rstart').value = e.retainer_start_date || '';
  $('cl-rmonths').value = e.retainer_months || '';
  $('cl-deliv').value = (e.deal && e.deal.deliverables) || '';
}
async function saveClose() {
  const msg = $('close-msg'); msg.className = 'add-msg'; msg.textContent = '';
  const body = {
    id: parseInt($('cl-id').value, 10), stage: 'Closed', position: $('cl-delivstatus').value,
    closing_date: $('cl-date').value, closing_rate: $('cl-rate').value.trim(),
    on_retainer: $('cl-retainer').value, retainer_start_date: $('cl-rstart').value,
    retainer_months: $('cl-rmonths').value, deliverables: $('cl-deliv').value.trim(),
  };
  const btn = $('cl-save'); btn.disabled = true;
  try { await api('/api/entries', { method: 'PATCH', body }); $('close-bg').classList.remove('open'); toast('Lead marked Closed'); await loadEntries(); }
  catch (e) { msg.className = 'add-msg err'; msg.textContent = e.message; }
  finally { btn.disabled = false; }
}
function openFailPopup(e) {
  $('fail-bg').classList.add('open'); $('fail-msg').textContent = '';
  $('fl-id').value = e.id; $('fail-who').textContent = '@' + e.handle;
  // Reason for failure = the Failed-stage sub-nodes (editable in Statuses & Labels).
  const rs = $('fl-reason');
  rs.innerHTML = '<option value="">— select —</option>' +
    pipeRoots('Failed').map(n => `<option value="${esc(n.key)}">${esc(n.label)}</option>`).join('');
  rs.value = (e.stage === 'Failed' && e.position) ? e.position : '';
  $('fl-tinit').value = (e.deal && e.deal.initial_rate) || '';
  $('fl-tfinal').value = (e.deal && e.deal.final_rate) || '';
  $('fl-ofinal').value = (e.deal && e.deal.our_final_offer) || '';
  $('fl-details').value = e.fail_details || '';
  updateFailBudget();
}
function updateFailBudget() { $('fl-budget').style.display = ($('fl-reason').value === 'Failed/out_of_budget') ? '' : 'none'; }
async function saveFail() {
  const msg = $('fail-msg'); msg.className = 'add-msg'; msg.textContent = '';
  const position = $('fl-reason').value;
  if (!position) { msg.className = 'add-msg err'; msg.textContent = 'Pick a reason for failure.'; return; }
  const body = { id: parseInt($('fl-id').value, 10), stage: 'Failed', position, fail_details: $('fl-details').value.trim() };
  if (position === 'Failed/out_of_budget') {
    body.initial_rate = $('fl-tinit').value.trim();
    body.final_rate = $('fl-tfinal').value.trim();
    body.our_final_offer = $('fl-ofinal').value.trim();
  }
  const btn = $('fl-save'); btn.disabled = true;
  try { await api('/api/entries', { method: 'PATCH', body }); $('fail-bg').classList.remove('open'); toast('Lead marked Failed'); await loadEntries(); }
  catch (e) { msg.className = 'add-msg err'; msg.textContent = e.message; }
  finally { btn.disabled = false; }
}

/* ── videos view ───────────────────────────────────────────── */
/* Order follows the export: who posted it, then the post and its numbers.
   The collaboration fields we fill in ourselves (country, budget, referral…)
   keep their place after those, so nothing that was editable stops being so.
   'Type' is the Instagram format from the export; 'Video type' below is our
   own categorisation — different questions, so both are shown. */
const VIDEO_COLS = [
  { f: 'handle', h: 'Username', leadlink: true, cls: 'uname' },
  { f: 'lead_name', h: 'First name', e: 'text' },
  { f: 'url', h: 'Video URL', e: 'text', cls: 'lnk' },
  { f: 'views', h: 'Views', e: 'text', cls: 'ig' },
  { f: 'comments', h: 'Comments', e: 'text', cls: 'ig' },
  { f: 'likes', h: 'Likes', e: 'text', cls: 'ig' },
  { f: 'date_posted', h: 'Date', e: 'date', cls: 'dt' },
  { f: 'post_type', h: 'Type', e: 'text' },
  { f: 'post_status', h: 'Status', e: 'text' },
  { f: 'country', h: 'Country', e: 'country' },
  { f: 'language', h: 'Language', e: 'text' },
  { f: 'video_type', h: 'Video type', e: 'video_type' },
  { f: 'budget', h: 'Budget', e: 'text' },
  { f: 'referral', h: 'Referral', e: 'text' },
  { f: 'saas', h: 'SAAS', e: 'text' },
  { f: 'notes', h: 'Notes', e: 'notes', cls: 'notes' },
];
async function loadVideos() {
  let d;
  try { d = await api('/api/videos'); } catch (e) { $('list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  state.videos = d.videos || [];
  renderVideos();
}
function vVal(v, c) { return v[c.f] != null ? v[c.f] : ''; }
function vDisplay(v, c) {
  if (c.leadlink) return v.handle ? '@' + esc(v.handle) : ph;
  if (c.f === 'url') return v.url ? `<a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.url.replace(/^https?:\/\//, '').slice(0, 48))}</a>` : ph;
  if (c.e === 'date') return v[c.f] ? esc(fmtDMY(v[c.f])) : ph;
  return cellTxt(vVal(v, c));
}
function videoRowHtml(v) {
  const tds = VIDEO_COLS.map(c => (c.e && !c.leadlink)
    ? `<td class="c ${c.cls || ''}" data-f="${c.f}" data-e="${c.e}" data-v="${esc(vVal(v, c))}" title="${esc(vVal(v, c))}">${vDisplay(v, c)}</td>`
    : `<td class="${c.cls || ''}">${vDisplay(v, c)}</td>`).join('');
  return `<tr data-vid="${v.id}">${tds}<td class="act"><button class="del" title="Delete">×</button></td></tr>`;
}
function renderVideos() {
  const list = $('list');
  // The Videos grid is its own (unpaged) render path — hide the leads pager,
  // and drop the grid shell so the leads tabs re-measure on the way back.
  $('pager').style.display = 'none';
  state.grid.sig = ''; state.grid.tbody = null; state.grid.win = null;
  const sc = list.scrollTop, sl = list.scrollLeft;
  const q = ($('video-search').value || '').trim().toLowerCase();
  let vids = state.videos;
  if (q) vids = vids.filter(v => `${v.handle} ${v.lead_name || ''} ${v.country} ${v.video_type} ${v.language} ${v.url} ${v.referral || ''} ${v.saas || ''} ${v.post_type || ''} ${v.post_status || ''}`.toLowerCase().includes(q));
  $('entry-count').textContent = vids.length ? `(${vids.length})` : '';
  if (!vids.length) { list.innerHTML = '<div class="empty">No videos yet. Click ＋ Add video.</div>'; return; }
  const head = '<thead><tr>' + VIDEO_COLS.map(c => `<th class="${c.cls || ''}">${esc(c.h)}</th>`).join('') + '<th class="act"></th></tr></thead>';
  list.innerHTML = `<table class="grid">${head}<tbody>${vids.map(videoRowHtml).join('')}</tbody></table>`;
  list.scrollTop = sc; list.scrollLeft = sl;
  const tb = list.querySelector('tbody');
  if (tb && !tb._vwired) { tb.addEventListener('click', onVideoClick); tb._vwired = true; }
}
function onVideoClick(ev) {
  const tr = ev.target.closest('tr[data-vid]'); if (!tr) return;
  const v = state.videos.find(x => x.id === +tr.dataset.vid); if (!v) return;
  if (ev.target.closest('.del')) return deleteVideo(v);
  if (ev.target.closest('a')) return;
  const td = ev.target.closest('td.c'); if (!td || td.querySelector('input,select,textarea')) return;
  editCell(td, td.dataset.e, td.dataset.v || '', v,
    async val => { const res = await api('/api/videos', { method: 'PATCH', body: { id: v.id, [td.dataset.f]: val } }); const i = state.videos.findIndex(x => x.id === v.id); if (i >= 0 && res.video) state.videos[i] = res.video; return res.video; },
    vid => { const tr2 = $('list').querySelector(`tr[data-vid="${v.id}"]`); if (tr2) tr2.outerHTML = videoRowHtml(vid || v); });
}
async function deleteVideo(v) {
  if (!confirm('Delete this video?')) return;
  try { await api('/api/videos', { method: 'DELETE', body: { id: v.id } }); toast('Deleted'); await loadVideos(); }
  catch (e) { toast(e.message); }
}
function openAddVideo() {
  $('video-bg').classList.add('open'); $('video-msg').textContent = '';
  ['v-handle', 'v-lead-name', 'v-url', 'v-date', 'v-country', 'v-language', 'v-budget', 'v-referral', 'v-saas', 'v-notes'].forEach(id => $(id).value = '');
  $('v-type').innerHTML = '<option value="">—</option>' + VIDEO_TYPES.map(t => `<option>${esc(t)}</option>`).join('');
}
async function saveVideo() {
  const msg = $('video-msg'); msg.className = 'add-msg'; msg.textContent = '';
  const body = {
    handle: $('v-handle').value.trim(), lead_name: $('v-lead-name').value.trim(),
    url: $('v-url').value.trim(), date_posted: $('v-date').value,
    country: $('v-country').value.trim(), language: $('v-language').value.trim(), video_type: $('v-type').value,
    budget: $('v-budget').value.trim(), referral: $('v-referral').value.trim(), saas: $('v-saas').value.trim(),
    notes: $('v-notes').value.trim(),
  };
  if (!body.handle && !body.lead_name) { msg.className = 'add-msg err'; msg.textContent = 'Enter the lead handle or a lead name.'; return; }
  const btn = $('v-save'); btn.disabled = true;
  try { await api('/api/videos', { method: 'POST', body }); $('video-bg').classList.remove('open'); toast('Video added'); await loadVideos(); }
  catch (e) { msg.className = 'add-msg err'; msg.textContent = e.message; }
  finally { btn.disabled = false; }
}

/* ── videos CSV import ─────────────────────────────────────── */
// Header aliases → our fields. Any subset of columns is accepted.
const VIMPORT_COLS = {
  date_posted: ['date posted', 'date_posted', 'date', 'posted', 'posted on', 'post date'],
  lead_name:   ['lead name', 'lead_name', 'lead', 'name', 'creator', 'client'],
  url:         ['url', 'video url', 'video_url', 'link', 'video link', 'video'],
  budget:      ['budget', 'deal', 'amount', 'price', 'value'],
  referral:    ['referral', 'referral source', 'referred by', 'source', 'ref'],
  saas:        ['saas', 'saas product', 'software', 'tool', 'product'],
};
let parsedVideos = null;

function extractVideos(text) {
  const rows = parseDelimited(text);
  if (!rows.length) return { rows: [] };
  const header = rows[0].map(h => h.trim().toLowerCase());
  // A header is expected (six named columns). Map each of our fields to a column index.
  const idx = {};
  for (const [field, aliases] of Object.entries(VIMPORT_COLS)) {
    idx[field] = header.findIndex(h => aliases.includes(h));
  }
  const matched = Object.entries(idx).filter(([, i]) => i >= 0).map(([f]) => f);
  const body = rows.slice(1);
  const out = [];
  for (const r of body) {
    const rec = {};
    for (const [field, i] of Object.entries(idx)) rec[field] = i >= 0 ? (r[i] || '').trim() : '';
    if (Object.values(rec).some(v => v)) out.push(rec);
  }
  return { rows: out, matched };
}

function openVideoImport() {
  $('vimport-bg').classList.add('open');
  parsedVideos = null; $('vimport-run').disabled = true;
  $('vimport-file').value = ''; $('vimport-preview').innerHTML = ''; $('vimport-msg').textContent = '';
}
function handleVideoFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const res = extractVideos(String(reader.result || ''));
    parsedVideos = res.rows;
    if (!res.rows.length) {
      $('vimport-preview').innerHTML = '<span style="color:var(--red)">No rows found. Expected a header row with columns like: date posted, lead name, url, budget, referral, SAAS.</span>';
      $('vimport-run').disabled = true; return;
    }
    const first = res.rows[0];
    $('vimport-preview').innerHTML =
      `Parsed <b>${res.rows.length}</b> videos from <b>${esc(file.name)}</b>` +
      (res.matched.length ? ` · columns: <b>${res.matched.map(esc).join(', ')}</b>` : '') +
      `<br><span class="foot-hint">e.g. ${esc([first.lead_name, first.url, first.budget].filter(Boolean).join(' · ') || '(row 1)')}…</span>`;
    $('vimport-run').disabled = false;
  };
  reader.readAsText(file);
}
async function runVideoImport() {
  if (!parsedVideos || !parsedVideos.length) return;
  const btn = $('vimport-run'); btn.disabled = true; const old = btn.textContent; btn.textContent = 'Importing…';
  const msg = $('vimport-msg'); msg.className = 'add-msg'; msg.textContent = '';
  try {
    const r = await api('/api/videos/import', { method: 'POST', body: { rows: parsedVideos } });
    msg.className = 'add-msg ok';
    msg.textContent = `✓ Imported ${r.imported} videos${r.skipped ? ` (${r.skipped} empty rows skipped)` : ''}.`;
    toast('Videos imported');
    $('vimport-bg').classList.remove('open');
    await loadVideos();
  } catch (e) { msg.className = 'add-msg err'; msg.textContent = e.message; btn.disabled = false; }
  finally { btn.textContent = old; }
}

function injectCountries() {
  const dl = $('country-list'); if (!dl || dl.children.length) return;
  dl.innerHTML = COUNTRIES.map(c => `<option value="${esc(c)}"></option>`).join('');
}
const COUNTRIES = ['United States', 'United Kingdom', 'Canada', 'Australia', 'India', 'Germany', 'France', 'Spain', 'Italy', 'Netherlands', 'Ireland', 'New Zealand', 'Singapore', 'United Arab Emirates', 'Brazil', 'Mexico', 'Argentina', 'Portugal', 'Sweden', 'Norway', 'Denmark', 'Finland', 'Poland', 'Switzerland', 'Austria', 'Belgium', 'Greece', 'Turkey', 'Israel', 'South Africa', 'Nigeria', 'Kenya', 'Egypt', 'Saudi Arabia', 'Qatar', 'Japan', 'South Korea', 'China', 'Hong Kong', 'Taiwan', 'Thailand', 'Vietnam', 'Philippines', 'Indonesia', 'Malaysia', 'Pakistan', 'Bangladesh', 'Sri Lanka', 'Nepal', 'Colombia', 'Chile', 'Peru', 'Russia', 'Ukraine', 'Romania', 'Czech Republic', 'Hungary', 'Other'];

function openEdit(e) {
  $('edit-bg').classList.add('open');
  $('edit-msg').textContent = '';
  $('e-id').value = e.id;
  $('e-owner').value = e.lead_owner || '';
  $('e-crm-poc').textContent = (e.crm && e.crm.poc) ? e.crm.poc : '—';
  $('e-firstname').value = e.first_name || '';
  $('e-social').value = e.handle || '';
  $('e-email').value = e.email || '';
  $('e-notes').value = e.notes || '';
  fillCategorySelects();
  // If the lead's category isn't in the current list (deleted), keep showing it.
  const sel = $('e-category');
  if (e.category && !state.categories.includes(e.category)) {
    sel.insertAdjacentHTML('beforeend', `<option value="${esc(e.category)}">${esc(e.category)} (removed)</option>`);
  }
  sel.value = e.category || '';
}

async function saveEdit() {
  const msg = $('edit-msg'); msg.className = 'add-msg'; msg.textContent = '';
  const body = {
    id: parseInt($('e-id').value, 10),
    social_url: $('e-social').value.trim(),
    email: $('e-email').value.trim(),
    first_name: $('e-firstname').value.trim(),
    notes: $('e-notes').value.trim(),
    category: $('e-category').value,
    lead_owner: $('e-owner').value.trim(),
  };
  const btn = $('edit-save'); btn.disabled = true;
  try {
    await api('/api/entries', { method: 'PATCH', body });
    $('edit-bg').classList.remove('open');
    toast('Lead updated');
    await loadEntries();
  } catch (e) { msg.className = 'add-msg err'; msg.textContent = e.message; }
  finally { btn.disabled = false; }
}

async function deleteEntry(e) {
  if (!confirm(`Delete @${e.handle}?`)) return;
  try { await api('/api/entries', { method: 'DELETE', body: { id: e.id } }); toast('Deleted'); await loadEntries(); }
  catch (err) { toast(err.message); }
}

async function refreshCrm() {
  // Prior-conversation data is now sourced from the local merged conversations —
  // no external CRM / LOOKUP_KEY needed, so no configuration gate here.
  const btn = $('refresh-crm-btn'); btn.disabled = true; const old = btn.textContent;
  let afterId = 0, processed = 0, matched = 0, total = 0, done = false, guard = 0;
  try {
    while (!done && guard++ < 300) {
      const r = await api('/api/entries/refresh-crm', { method: 'POST', body: { after_id: afterId } });
      processed += r.processed; matched += (r.matched || 0); total = r.total; afterId = r.after_id; done = r.done;
      btn.textContent = `Syncing ${processed}/${total}…`;
      if (r.processed === 0) break;
    }
    toast(`CRM sync complete — ${matched} matched of ${processed} checked`);
    await loadEntries();
  } catch (e) { toast('CRM sync stopped: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = old; }
}

/* ── real-time polling (dedup set is always current) ───────── */
let pollTimer;
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const v = await api('/api/version');
      if (v.version !== state.version) await loadEntries();
    } catch { /* offline blip — try again next tick */ }
  }, 12000);
}

/* ── master list upload ────────────────────────────────────── */
let parsedMaster = null;

function openMaster() {
  $('master-bg').classList.add('open');
  parsedMaster = null; $('master-import').disabled = true;
  $('master-preview').innerHTML = ''; $('master-mode-row').style.display = 'none'; $('master-msg').textContent = '';
  api('/api/master/stats').then(s => {
    $('master-stats').innerHTML = `Currently <b>${s.count}</b> handles on record` +
      (s.last_upload ? ` · last upload ${esc(fmtDate(s.last_upload))}` : '');
  }).catch(() => { $('master-stats').textContent = ''; });
}

// Minimal CSV/TSV parser (handles quoted fields, commas/tabs, CRLF).
function parseDelimited(text) {
  const rows = []; let row = [], field = '', i = 0, inQ = false;
  const delim = (text.split('\t').length > text.split(',').length) ? '\t' : ',';
  const push = () => { row.push(field); field = ''; };
  const eol = () => { push(); rows.push(row); row = []; };
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) push();
    else if (c === '\n') eol();
    else if (c === '\r') { /* skip */ }
    else field += c;
    i++;
  }
  if (field.length || row.length) eol();
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

const HANDLE_COLS = ['username', 'handle', 'instagram', 'insta', 'ig', 'profile', 'social', 'url', 'link', 'account',
  'ig user name', 'ig username', 'instagram handle', 'instagram username', 'ig handle'];
const EMAIL_COLS = ['email', 'e-mail', 'mail'];
const NAME_COLS = ['first_name', 'firstname', 'first name', 'name', 'fname'];
const CAT_COLS = ['category', 'categories', 'type', 'segment', 'niche'];
const DATE_COLS = ['date', 'date added', 'date_added', 'added', 'added on', 'found', 'date found', 'created', 'created at'];

/* Sheets date leads two ways: 'DD/MM/YYYY' (our Instantly sheet) and
   'YYYY-MM-DD' (the exports). Returns YYYY-MM-DD, or '' if it is neither —
   the server falls back to the upload time only when this is blank.
   Day-first is not a guess: 7,593 rows in the Instantly sheet have a first
   field above 12 and not one row has a second field above 12. */
function normSheetDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (!m) return '';
  const d = +m[1], mo = +m[2];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  return m[3] + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
const OWNER_COLS = ['lead owner', 'lead_owner', 'owner', 'poc', 'assigned to', 'assigned'];
const NOTE_COLS = ['notes', 'note', 'comment', 'comments'];

/* Reads a pasted/dropped master sheet.
   NB: this used to return only {handle, email} while declaring column lists for
   name and category — so owner, name and category were silently dropped on every
   upload even though /api/master/upload accepts all of them. That is what left
   ~10k leads with no owner and ~11.9k with no name or category. Send everything. */
function extractMaster(text) {
  const rows = parseDelimited(text);
  if (!rows.length) return { rows: [], note: 'Empty file.' };
  const header = rows[0].map(h => h.trim().toLowerCase());
  const looksHeader = header.some(h => HANDLE_COLS.includes(h) || EMAIL_COLS.includes(h));
  const find = list => header.findIndex(h => list.includes(h));
  let hIdx = -1, eIdx = -1, nIdx = -1, cIdx = -1, oIdx = -1, noIdx = -1, dIdx = -1, body = rows;
  if (looksHeader) {
    body = rows.slice(1);
    hIdx = find(HANDLE_COLS); eIdx = find(EMAIL_COLS);
    nIdx = find(NAME_COLS); cIdx = find(CAT_COLS); oIdx = find(OWNER_COLS); noIdx = find(NOTE_COLS);
    dIdx = find(DATE_COLS);
    // Prefer an explicit instagram/username/handle column over a generic url.
    const pref = header.findIndex(h => ['username', 'handle', 'instagram', 'insta', 'ig'].includes(h));
    if (pref >= 0) hIdx = pref;
  }
  const cell = (r, i) => (i >= 0 ? String(r[i] || '').trim() : '');
  const out = [];
  for (const r of body) {
    let handleCell = hIdx >= 0 ? r[hIdx] : '';
    if (!handleCell) {
      handleCell = r.find(c => /instagram\.com/i.test(c)) || r.find(c => c && c.trim()) || '';
    }
    if (!handleCell || !handleCell.trim()) continue;
    const email = eIdx >= 0 ? cell(r, eIdx) : (r.find(c => /@/.test(c) && !/instagram/i.test(c)) || '').trim();
    out.push({
      handle: handleCell.trim(),
      email,
      first_name: cell(r, nIdx),
      category: cell(r, cIdx),
      lead_owner: cell(r, oIdx),
      notes: cell(r, noIdx),
      date: normSheetDate(cell(r, dIdx)),
    });
  }
  return {
    rows: out, header: looksHeader ? header : null,
    handleCol: hIdx >= 0 ? header[hIdx] : '(auto)',
    emailCol: eIdx >= 0 ? header[eIdx] : '',
    ownerCol: oIdx >= 0 ? header[oIdx] : '',
    nameCol: nIdx >= 0 ? header[nIdx] : '',
    catCol: cIdx >= 0 ? header[cIdx] : '',
    dateCol: dIdx >= 0 ? header[dIdx] : '',
  };
}
function handleFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const res = extractMaster(String(reader.result || ''));
    parsedMaster = res.rows;
    if (!res.rows.length) { $('master-preview').innerHTML = '<span style="color:var(--red)">No handles found in that file.</span>'; $('master-import').disabled = true; return; }
    $('master-preview').innerHTML =
      `Parsed <b>${res.rows.length}</b> rows from <b>${esc(file.name)}</b>` +
      (res.handleCol ? ` · handle: <b>${esc(res.handleCol)}</b>` : '') +
      (res.emailCol ? ` · email: <b>${esc(res.emailCol)}</b>` : '') +
      (res.ownerCol ? ` · owner: <b>${esc(res.ownerCol)}</b>` : ' · <span style="color:var(--orange)">no owner column</span>') +
      (res.nameCol ? ` · name: <b>${esc(res.nameCol)}</b>` : '') +
      (res.catCol ? ` · category: <b>${esc(res.catCol)}</b>` : '') +
      (res.dateCol ? ` · date: <b>${esc(res.dateCol)}</b>` : ' · <span style="color:var(--orange)">no date column — today&rsquo;s date will be used</span>') +
      `<br><span class="foot-hint">e.g. ${res.rows.slice(0, 3).map(r => esc(r.handle)).join(', ')}…</span>`;
    $('master-mode-row').style.display = 'flex';
    $('master-import').disabled = false;
  };
  reader.readAsText(file);
}

async function importMaster() {
  if (!parsedMaster || !parsedMaster.length) return;
  const mode = document.querySelector('input[name=mmode]:checked').value;
  const btn = $('master-import'); btn.disabled = true; const old = btn.textContent; btn.textContent = 'Importing…';
  const msg = $('master-msg'); msg.className = 'add-msg'; msg.textContent = '';
  try {
    const r = await api('/api/master/upload', { method: 'POST', body: { rows: parsedMaster, mode } });
    msg.className = 'add-msg ok';
    msg.textContent = `✓ Imported ${r.imported} handles (${r.skipped} skipped). Master now has ${r.total}.`;
    toast('Master list updated');
    openMaster(); // refresh stats
    await loadEntries();
  } catch (e) { msg.className = 'add-msg err'; msg.textContent = e.message; }
  finally { btn.textContent = old; }
}

/* ── bulk add ──────────────────────────────────────────────── */
function openBulk() {
  $('bulk-bg').classList.add('open');
  $('bulk-owner').textContent = state.me.display_name || state.me.username;
  $('bulk-report').innerHTML = ''; $('bulk-parsed').textContent = '';
}

// Turn pasted text OR a CSV/TSV into [{social_url, email}]. Reuses the same
// column detection as the master upload, falling back to "handle[,email]" lines.
function parseBulk(text) {
  const rows = parseDelimited(text);
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim().toLowerCase());
  const looksHeader = header.some(h => HANDLE_COLS.includes(h) || EMAIL_COLS.includes(h) || NAME_COLS.includes(h) || CAT_COLS.includes(h) || h === 'notes');
  let hIdx = -1, eIdx = -1, nIdx = -1, noteIdx = -1, cIdx = -1, body = rows;
  if (looksHeader) {
    body = rows.slice(1);
    hIdx = header.findIndex(h => ['username', 'handle', 'instagram', 'insta', 'ig', 'profile', 'social', 'url', 'link', 'account'].includes(h));
    eIdx = header.findIndex(h => EMAIL_COLS.includes(h));
    nIdx = header.findIndex(h => NAME_COLS.includes(h));
    noteIdx = header.findIndex(h => h === 'notes' || h === 'note' || h === 'comment' || h === 'comments');
    cIdx = header.findIndex(h => CAT_COLS.includes(h));
    const pref = header.findIndex(h => ['username', 'handle', 'instagram', 'insta', 'ig'].includes(h));
    if (pref >= 0) hIdx = pref;
  }
  /* "contains an @" is not enough to call something an email — @megwilde has
     one. Require a dot-bearing domain after it. */
  const isEmail = c => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(String(c || '').trim());
  const isHandleish = c => /instagram\.com/i.test(c) || /^@[A-Za-z0-9._]+$/.test(String(c || '').trim());

  const out = [];
  for (const r of body) {
    const cells = r.map(c => String(c || '').trim());
    let social = hIdx >= 0 ? cells[hIdx] : (cells.find(isHandleish) || cells.find(c => c && !isEmail(c)) || cells[0] || '');
    let email = eIdx >= 0 ? (cells[eIdx] || '') : (cells.find(isEmail) || '');
    social = (social || '').trim(); email = (email || '').trim();
    const row = { social_url: social, email };
    if (nIdx >= 0 && r[nIdx]) row.first_name = r[nIdx].trim();
    /* No header, but the row gave up a real email AND a handle — then the one
       cell left over is the name. Narrow on purpose: only when both of the
       other two were positively identified, so a "handle, notes" paste is
       never mistaken for a name. */
    if (!row.first_name && hIdx < 0 && email && social && cells.length >= 3) {
      const leftover = cells.filter(c => c && c !== social && c !== email && !isEmail(c) && !isHandleish(c));
      if (leftover.length === 1) row.first_name = leftover[0];
    }
    if (noteIdx >= 0 && r[noteIdx]) row.notes = r[noteIdx].trim();
    if (cIdx >= 0 && r[cIdx]) row.category = r[cIdx].trim();
    if (social) out.push(row);
  }
  return out;
}

let bulkRows = [];
function setBulkFromText() {
  bulkRows = parseBulk($('bulk-text').value);
  $('bulk-parsed').textContent = bulkRows.length ? `${bulkRows.length} rows parsed` : '';
}

async function runBulk() {
  setBulkFromText();
  if (!bulkRows.length) { $('bulk-parsed').textContent = 'Nothing to add.'; return; }
  const btn = $('bulk-run'); btn.disabled = true; const old = btn.textContent; btn.textContent = 'Checking…';
  try {
    const res = await api('/api/entries/bulk', { method: 'POST', body: { rows: bulkRows } });
    renderBulkReport(res);
    toast(`Added ${res.added} · ${res.duplicate} dupes`);
    await loadEntries();
  } catch (e) { $('bulk-report').innerHTML = `<div style="color:var(--red)">${esc(e.message)}</div>`; }
  finally { btn.disabled = false; btn.textContent = old; }
}

function renderBulkReport(res) {
  const box = $('bulk-report');
  const summary = `<div class="bulk-summary">` +
    `<span class="badge green">${res.added} added</span>` +
    `<span class="badge orange">${res.duplicate} duplicate</span>` +
    (res.invalid ? `<span class="badge red">${res.invalid} invalid</span>` : '') +
    (res.crm_error ? `<span class="badge grey">CRM check unavailable</span>` : '') + `</div>`;
  const rows = res.report.map(r => {
    let note = '';
    if (r.status === 'duplicate' && r.dup) {
      note = r.dup.within_batch ? 'repeated in paste'
           : r.dup.owner ? `already added by ${esc(r.dup.owner)}${r.dup.created_at ? ' on ' + esc(fmtDate(r.dup.created_at)) : ''}`
           : 'already in records';
    } else if (r.status === 'added' && r.verdict) {
      note = esc(r.verdict.label);
    } else if (r.status === 'invalid') { note = 'no valid handle'; }
    return `<div class="br-row"><span class="h">${esc(r.handle || r.raw || '—')}${r.email ? ' · <span class="note">' + esc(r.email) + '</span>' : ''}</span>` +
           `<span class="note">${note}</span><span class="st ${r.status}">${r.status}</span></div>`;
  }).join('');
  box.innerHTML = summary + rows;
}

/* ── date presets (IST) ────────────────────────────────────── */
function istDateStr(daysBack) {
  return new Date(Date.now() + 330 * 60000 - (daysBack || 0) * 86400000).toISOString().slice(0, 10);
}
function setPreset(range) {
  const df = $('date-from'), dt = $('date-to');
  if (range === 'all') { df.value = ''; dt.value = ''; }
  else if (range === 'today') { df.value = istDateStr(0); dt.value = istDateStr(0); }
  else { df.value = istDateStr(parseInt(range, 10) - 1); dt.value = istDateStr(0); }
  markPreset(range);
  loadEntries();
}
function markPreset(range) {
  document.querySelectorAll('.date-presets .chip').forEach(c => c.classList.toggle('active', c.dataset.range === range));
}

/* ── activity dashboard ────────────────────────────────────── */
async function openActivity() {
  $('activity-bg').classList.add('open');
  // Seed the modal's own date range from the leads page the first time it opens;
  // after that the modal keeps whatever range the user last picked here.
  if (!$('act-from').value && !$('act-to').value) {
    $('act-from').value = $('date-from').value;
    $('act-to').value = $('date-to').value;
  }
  runActivity();
}

async function runActivity() {
  const from = $('act-from').value, to = $('act-to').value;
  $('act-range').textContent = (from || to) ? `${from || '…'} → ${to || '…'} (IST)` : 'all time';
  $('activity-body').innerHTML = '<div class="act-empty">Loading…</div>';
  $('activity-totals').innerHTML = '';
  const p = new URLSearchParams();
  if (from) p.set('from', from); if (to) p.set('to', to);
  let s;
  // /api/activity = teammate-ADDED leads only, attributed to the adder.
  try { s = await api('/api/activity?' + p.toString()); }
  catch (e) { $('activity-body').innerHTML = `<div class="act-empty">${esc(e.message)}</div>`; return; }
  renderActivity(s);
}

function setActPreset(range) {
  const df = $('act-from'), dt = $('act-to');
  if (range === 'all') { df.value = ''; dt.value = ''; }
  else if (range === 'today') { df.value = istDateStr(0); dt.value = istDateStr(0); }
  else { df.value = istDateStr(parseInt(range, 10) - 1); dt.value = istDateStr(0); }
  document.querySelectorAll('.act-presets .chip').forEach(c => c.classList.toggle('active', c.dataset.arange === range));
  runActivity();
}

function renderActivity(s) {
  $('activity-totals').innerHTML =
    tile('blue', s.totals.leads, 'Total leads') +
    tile('green', s.totals.with_email, 'With email') +
    tile('', s.totals.without_email, 'No email');

  if (!s.by_day.length) { $('activity-body').innerHTML = '<div class="act-empty">No leads in this range.</div>'; return; }

  const md = {};
  for (const r of s.by_member_day) md[r.day + '|' + r.owner] = r;
  const memTot = {};
  s.members.forEach(m => memTot[m] = { leads: 0, with_email: 0 });
  for (const r of s.by_member_day) { memTot[r.owner].leads += r.leads; memTot[r.owner].with_email += r.with_email; }
  // Now that the master sheet feeds this, a wide range can list twenty-odd
  // people. Busiest first so the ones that matter are visible before the
  // table has to be scrolled sideways; alphabetical settles ties.
  const members = s.members.slice().sort((x, y) =>
    (memTot[y].leads - memTot[x].leads) || x.localeCompare(y));

  const cell = (o) => o && o.leads ? `${o.leads}<span class="we"> / ${o.with_email}</span>` : '<span class="we">–</span>';
  const head = `<tr><th>Day (IST)</th>${members.map(m => `<th>${esc(m)}</th>`).join('')}<th class="total-col">Total</th></tr>`;
  const rows = s.by_day.map(d => {
    const cells = members.map(m => `<td>${cell(md[d.day + '|' + m])}</td>`).join('');
    return `<tr><td>${esc(d.day || '(no date)')}</td>${cells}<td class="total-col">${d.leads}<span class="we"> / ${d.with_email}</span></td></tr>`;
  }).join('');
  const totalRow = `<tr class="total-row"><td>All</td>${members.map(m =>
    `<td>${memTot[m].leads}<span class="we"> / ${memTot[m].with_email}</span></td>`).join('')}` +
    `<td class="total-col">${s.totals.leads}<span class="we"> / ${s.totals.with_email}</span></td></tr>`;
  $('activity-body').innerHTML =
    `<div class="foot-hint" style="margin-bottom:8px">Each cell: <b>leads found</b> / <span class="we">with email</span></div>` +
    `<table class="act-table"><thead>${head}</thead><tbody>${rows}${totalRow}</tbody></table>`;
}
function tile(tone, n, label) {
  return `<div class="stat-tile ${tone}"><div class="n">${n}</div><div class="l">${esc(label)}</div></div>`;
}

/* ── funnel analytics ──────────────────────────────────────── */
const FUNNEL_STAGES = [
  { k: 'collected', label: 'Leads collected' },
  { k: 'reached', label: 'Reached out' },
  { k: 'replied', label: 'Replied' },
  { k: 'quoted', label: 'Price quoted' },
  { k: 'closed', label: 'Closed' },
];
const pct = (n, d) => d ? Math.round(n / d * 100) : 0;

async function openFunnel() {
  $('funnel-bg').classList.add('open');
  $('funnel-overall').innerHTML = '<div class="act-empty">Loading…</div>';
  $('funnel-campaigns').innerHTML = '';
  await loadFunnel();
}
async function loadFunnel() {
  const from = $('fn-from').value, to = $('fn-to').value;
  const p = new URLSearchParams();
  if (from) p.set('from', from); if (to) p.set('to', to);
  let d;
  try { d = await api('/api/funnel?' + p.toString()); }
  catch (e) { $('funnel-overall').innerHTML = `<div class="act-empty">${esc(e.message)}</div>`; return; }
  $('fn-note').textContent = `${d.total_known.toLocaleString()} CRM-known leads` + ((from || to) ? ` · ${from || '…'} → ${to || '…'}` : ' · all time');
  $('funnel-overall').innerHTML = renderFunnelOverall(d.overall);
  $('funnel-categories').innerHTML = renderFunnelGroup(d.by_category || [], 'Category');
  $('funnel-campaigns').innerHTML = renderFunnelGroup(d.campaigns, 'Campaign');
}
function renderFunnelOverall(o) {
  const base = o.collected || 1;
  let html = '', prev = 0;
  FUNNEL_STAGES.forEach((s, i) => {
    const n = o[s.k] || 0;
    const w = pct(n, base);
    const conv = i === 0 ? '' : `<span class="fconv">${pct(n, prev)}% of prev</span>`;
    html += `<div class="frow"><div class="flabel">${s.label}</div>` +
      `<div class="fbar"><div class="ffill" style="width:${Math.max(w, 2)}%"></div><span class="fn">${n.toLocaleString()}</span><span class="fpct">${w}%</span></div>${conv}</div>`;
    if (s.k === 'replied') {
      const unc = n - o.positive - o.negative;
      html += `<div class="fsub"><span class="pchip pos">▲ Positive ${o.positive.toLocaleString()}</span>` +
        `<span class="pchip neg">▼ Negative ${o.negative.toLocaleString()}</span>` +
        (unc > 0 ? `<span class="foot-hint">${unc.toLocaleString()} unclassified</span>` : '') + `</div>`;
    }
    prev = n;
  });
  html += `<div class="fsummary">Close rate: <b>${pct(o.closed, o.collected)}%</b> · Reply rate: <b>${pct(o.replied, o.reached)}%</b> · Quote→Close: <b>${pct(o.closed, o.quoted)}%</b></div>`;
  return html;
}
function renderFunnelGroup(rows0, firstCol) {
  if (!rows0.length) return `<div class="act-empty">No ${esc(firstCol.toLowerCase())} data in range.</div>`;
  const head = `<tr><th>${esc(firstCol)}</th><th>Collected</th><th>Reached</th><th>Replied</th><th>+ve</th><th>−ve</th><th>Quoted</th><th>Closed</th><th>Reply%</th><th>Close%</th></tr>`;
  const rows = rows0.map(c => `<tr><td class="cname" title="${esc(c.name)}">${esc(c.name)}</td>` +
    `<td>${c.collected}</td><td>${c.reached}</td><td>${c.replied}</td>` +
    `<td class="pos">${c.positive}</td><td class="neg">${c.negative}</td>` +
    `<td>${c.quoted}</td><td>${c.closed}</td>` +
    `<td>${pct(c.replied, c.reached)}%</td><td class="total-col">${pct(c.closed, c.collected)}%</td></tr>`).join('');
  return `<table class="act-table funnel-table"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

/* ── team management ───────────────────────────────────────── */
async function openTeam() {
  $('team-bg').classList.add('open');
  $('team-msg').textContent = '';
  try {
    const { users } = await api('/api/users');
    $('user-list').innerHTML = users.map(u =>
      `<div class="user-row"><span>${esc(u.display_name || u.username)} <span class="foot-hint">@${esc(u.username)}</span></span>` +
      `${u.is_admin ? '<span class="tag">admin</span>' : ''}</div>`).join('');
  } catch (e) { $('user-list').innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`; }
}

async function addUser() {
  const msg = $('team-msg'); msg.className = 'add-msg'; msg.textContent = '';
  try {
    await api('/api/users', { method: 'POST', body: {
      username: $('nu-user').value.trim(), password: $('nu-pass').value,
      display_name: $('nu-display').value.trim(), is_admin: $('nu-admin').checked ? 1 : 0,
    } });
    $('nu-user').value = ''; $('nu-pass').value = ''; $('nu-display').value = ''; $('nu-admin').checked = false;
    msg.className = 'add-msg ok'; msg.textContent = '✓ Teammate added.';
    await openTeam();
  } catch (e) { msg.className = 'add-msg err'; msg.textContent = e.message; }
}

/* ── wiring ────────────────────────────────────────────────── */
function wire() {
  $('login-btn').onclick = doLogin;
  $('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('login-user').addEventListener('keydown', e => { if (e.key === 'Enter') $('login-pass').focus(); });

  $('logout').onclick = async () => { await api('/api/logout', { method: 'POST', body: {} }); location.reload(); };
  $('refresh-crm-btn').onclick = refreshCrm;

  $('f-social').addEventListener('input', runPreview);
  $('f-email').addEventListener('input', runPreview);
  $('add-btn').onclick = addLead;
  $('f-email').addEventListener('keydown', e => { if (e.key === 'Enter') addLead(); });

  const relist = debounce(loadEntries, 250);
  $('search').addEventListener('input', relist);
  /* Reset everything that narrows the list — the selects, the search box and
     the date range — then reload. The tab (stage) is not a filter here: it is
     which list you are looking at, so it deliberately stays put. */
  $('clear-filters').onclick = () => {
    ['search', 'status-filter', 'label-filter', 'delivery-filter', 'reason-filter',
     'cat-filter', 'owner-filter', 'manager-filter', 'link-filter',
     'date-from', 'date-to'].forEach(id => { const e = $(id); if (e) e.value = ''; });
    markPreset('all');
    loadEntries();
  };
  $('owner-filter').onchange = loadEntries;
  if ($('link-filter')) $('link-filter').onchange = loadEntries;
  $('cat-filter').onchange = loadEntries;
  $('status-filter').onchange = loadEntries;
  $('label-filter').onchange = loadEntries;
  $('delivery-filter').onchange = loadEntries;
  $('reason-filter').onchange = loadEntries;
  if ($('manager-filter')) $('manager-filter').onchange = loadEntries;

  // Add-lead modal
  $('open-add-btn').onclick = () => { $('add-bg').classList.add('open'); setTimeout(() => $('f-social').focus(), 60); };
  $('add-close').onclick = () => $('add-bg').classList.remove('open');

  // Close / Fail popups
  $('cl-save').onclick = saveClose;
  $('cl-cancel').onclick = () => $('close-bg').classList.remove('open');
  $('fl-save').onclick = saveFail;
  $('fl-cancel').onclick = () => $('fail-bg').classList.remove('open');
  $('fl-reason').onchange = updateFailBudget;

  // Tabs
  $('tab-bar').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) switchTab(b.dataset.tab); };

  // Sidebar: CRM ｜ Unibox
  $('sidebar').addEventListener('click', e => { const b = e.target.closest('.sb-item'); if (b) switchView(b.dataset.view); });

  // Videos
  $('add-video-btn').onclick = openAddVideo;
  $('video-search').addEventListener('input', debounce(() => { if (state.tab === 'videos') renderVideos(); }, 200));
  $('v-save').onclick = saveVideo;
  $('v-cancel').onclick = () => $('video-bg').classList.remove('open');
  // Videos CSV import
  $('import-video-btn').onclick = openVideoImport;
  $('vimport-file').onchange = () => { if ($('vimport-file').files[0]) handleVideoFile($('vimport-file').files[0]); };
  $('vimport-run').onclick = runVideoImport;
  $('vimport-close').onclick = () => $('vimport-bg').classList.remove('open');

  // Edit lead
  $('edit-save').onclick = saveEdit;
  $('edit-cancel').onclick = () => $('edit-bg').classList.remove('open');

  // Categories management
  $('cat-manage-btn').onclick = openCat;
  $('cl-cat-add').onclick = async () => {
    const name = $('cl-cat-new').value.trim(); if (!name) return;
    const msg = $('cl-msg'); msg.className = 'add-msg'; msg.textContent = '';
    try {
      await api('/api/categories', { method: 'POST', body: { name } });
      $('cl-cat-new').value = '';
      await loadCategories();
      renderCatListIn('cl-cat-list');
    } catch (e) { msg.className = 'add-msg err'; msg.textContent = e.message; }
  };
  $('e-cat-manage-btn').onclick = openCat;
  $('cat-add').onclick = addCat;
  $('cat-new').addEventListener('keydown', e => { if (e.key === 'Enter') addCat(); });
  $('cat-close').onclick = () => $('cat-bg').classList.remove('open');

  // Statuses & Labels management
  $('classify-btn').onclick = openClassify;
  $('cl-status-add').onclick = addStatus;
  $('cl-label-add').onclick = addLabel;
  $('cl-deliv-add').onclick = () => addNode('Closed', 'cl-deliv-new');
  $('cl-reason-add').onclick = () => addNode('Failed', 'cl-reason-new');
  $('cl-status-new').addEventListener('keydown', e => { if (e.key === 'Enter') addStatus(); });
  $('cl-label-new').addEventListener('keydown', e => { if (e.key === 'Enter') addLabel(); });
  $('cl-deliv-new').addEventListener('keydown', e => { if (e.key === 'Enter') addNode('Closed', 'cl-deliv-new'); });
  $('cl-reason-new').addEventListener('keydown', e => { if (e.key === 'Enter') addNode('Failed', 'cl-reason-new'); });
  $('cl-close').onclick = () => $('classify-bg').classList.remove('open');

  // Pipeline management
  $('pipe-btn').onclick = openPipeline;
  $('pipe-stage-sel').onchange = updatePipeParents;
  $('pipe-add').onclick = addPipeNode;
  $('pipe-new').addEventListener('keydown', e => { if (e.key === 'Enter') addPipeNode(); });
  $('pipe-close').onclick = () => $('pipe-bg').classList.remove('open');

  // Date range + presets
  $('date-from').onchange = () => { markPreset(''); loadEntries(); };
  $('date-to').onchange = () => { markPreset(''); loadEntries(); };
  document.querySelectorAll('.date-presets .chip').forEach(c => { c.onclick = () => setPreset(c.dataset.range); });

  // Activity
  $('activity-btn').onclick = openActivity;
  $('theme-btn').onclick = () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  $('activity-close').onclick = () => $('activity-bg').classList.remove('open');
  // Activity modal's own date controls (independent of the leads-page filter).
  $('act-from').onchange = runActivity;
  $('act-to').onchange = runActivity;
  document.querySelectorAll('.act-presets .chip').forEach(c => { c.onclick = () => setActPreset(c.dataset.arange); });

  // Funnel
  $('funnel-btn').onclick = openFunnel;
  $('funnel-close').onclick = () => $('funnel-bg').classList.remove('open');
  $('fn-from').onchange = loadFunnel;
  $('fn-to').onchange = loadFunnel;
  $('fn-all').onclick = () => { $('fn-from').value = ''; $('fn-to').value = ''; loadFunnel(); };

  // Master modal
  $('master-btn').onclick = openMaster;
  $('master-close').onclick = () => $('master-bg').classList.remove('open');
  $('master-import').onclick = importMaster;
  const drop = $('drop'), fi = $('file-input');
  drop.onclick = () => fi.click();
  fi.onchange = () => { if (fi.files[0]) handleFile(fi.files[0]); };
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('hot'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('hot'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('hot'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

  // Bulk modal
  $('bulk-btn').onclick = openBulk;
  $('bulk-close').onclick = () => $('bulk-bg').classList.remove('open');
  $('bulk-text').addEventListener('input', debounce(setBulkFromText, 300));
  $('bulk-run').onclick = runBulk;
  $('bulk-file-btn').onclick = () => $('bulk-file').click();
  $('bulk-file').onchange = () => {
    const f = $('bulk-file').files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { $('bulk-text').value = String(reader.result || ''); setBulkFromText(); };
    reader.readAsText(f);
  };

  // Team modal
  $('ig-btn').onclick = openIgModal;
  $('ig-close').onclick = () => $('ig-bg').classList.remove('open');
  $('team-btn').onclick = openTeam;
  $('team-close').onclick = () => $('team-bg').classList.remove('open');
  $('nu-add').onclick = addUser;

  // Close modals on backdrop click
  for (const id of ['master-bg', 'team-bg', 'bulk-bg', 'activity-bg', 'edit-bg', 'cat-bg', 'classify-bg', 'pipe-bg', 'funnel-bg', 'video-bg', 'add-bg', 'close-bg', 'fail-bg', 'ig-bg']) {
    $(id).addEventListener('click', e => { if (e.target.id === id) $(id).classList.remove('open'); });
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') for (const id of ['master-bg', 'team-bg', 'bulk-bg', 'activity-bg', 'edit-bg', 'cat-bg', 'classify-bg', 'pipe-bg', 'funnel-bg', 'video-bg', 'add-bg', 'close-bg', 'fail-bg', 'ig-bg']) $(id).classList.remove('open');
  });
}

wire();
boot().catch(e => { $('login-error').textContent = e.message; $('login-view').style.display = 'flex'; });
