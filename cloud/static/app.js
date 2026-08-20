'use strict';

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
  if (!state.lookupConfigured) {
    // Make it obvious the CRM check is offline until the secret is set.
    $('refresh-crm-btn').title = 'CRM lookup not configured (LOOKUP_KEY missing on the worker)';
  }
  loadCategories();
  loadTeam();
  loadPipeline().then(() => switchTab('leads'));
  injectCountries();
  startPolling();
  // Warm the Unibox iframe in the background (hidden) so it's already booted
  // and authed via the shared lg_session before the first switch — no flash,
  // no perceived second login. switchView only toggles its visibility after.
  const uf = $('unibox-frame');
  if (uf && !uf.getAttribute('src')) uf.setAttribute('src', '/unibox/');
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
    cf.innerHTML = '<option value="">Any category</option>' + state.categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
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
  try { await api('/api/categories', { method: 'POST', body: { name } }); $('cat-new').value = ''; await loadCategories(); renderCatList(); }
  catch (e) { msg.className = 'add-msg err'; msg.textContent = e.message; }
}
async function deleteCat(name) {
  try { await api('/api/categories', { method: 'DELETE', body: { name } }); await loadCategories(); renderCatList(); }
  catch (e) { toast(e.message); }
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
  renderNodeLists();
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
    } else {
      box.appendChild(sig('green', '✨', `<b>New username.</b> Not in the master sheet or prior entries.`));
    }
  }
  // Signal 2 — prior Instantly conversation (via the CRM), independent of #1.
  renderCrmSignal(box, res.crm, res.email);
}

function renderCrmSignal(box, crm, email) {
  if (!state.lookupConfigured) {
    box.appendChild(sig('muted', '💤', `CRM prior-conversation check is not configured.`));
    return;
  }
  if (!crm) return;
  if (crm.error) { box.appendChild(sig('muted', '⚠️', `CRM check unavailable<small>${esc(crm.error)}</small>`)); return; }
  const s = crm.signal;
  if (!s || !s.known) {
    box.appendChild(sig('green', '📭', `<b>No prior conversation.</b> Not found in the CRM — safe to pursue.`));
    return;
  }
  const camps = (s.campaigns || []).join(', ');
  const link = email && state.crmUrl ? `${state.crmUrl.replace(/\/+$/, '')}/?lead=${encodeURIComponent(email)}` : '';
  const view = link ? ` · <a href="${esc(link)}" target="_blank" rel="noopener">View conversation ↗</a>` : '';
  if (s.replied) {
    box.appendChild(sig('red', '💬',
      `<b>Prior conversation — do NOT re-pitch.</b>${view}` +
      `<small>${s.status ? 'Status: ' + esc(s.status) + ' · ' : ''}${s.poc ? 'POC: ' + esc(s.poc) + ' · ' : ''}` +
      `${s.last_reply_at ? 'Last reply ' + esc(fmtDate(s.last_reply_at)) : ''}${camps ? ' · ' + esc(camps) : ''}</small>`));
  } else {
    box.appendChild(sig('orange', '📨',
      `<b>Contacted before, never replied.</b> Still OK to reach out.${view}` +
      `<small>${s.status ? 'Status: ' + esc(s.status) + ' · ' : ''}${camps ? esc(camps) : ''}` +
      `${s.last_contact_at ? ' · Last contact ' + esc(fmtDate(s.last_contact_at)) : ''}</small>`));
  }
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
  try { data = await api('/api/entries?' + filterParams().toString()); }
  catch (e) { $('list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  state.entries = data.entries; state.version = data.version;
  state.owners = data.owners || [];
  state.statuses = data.statuses || [];
  state.labels = data.labels || [];
  state.grandTotal = data.grand_total;
  renderEntries();
  refreshOwnerFilter();
  refreshClassifyFilters();
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
  const stageSel = $('stage-filter');
  if (stageSel) {
    stageSel.innerHTML = '<option value="">Any stage</option>'
      + [['leads', 'Leads'], ['responses', 'Responses'], ['closed', 'Closed'], ['failed', 'Failed']]
        .map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
    stageSel.value = STAGE_OF_TAB[state.tab] ? state.tab : '';
  }
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

function refreshOwnerFilter() {
  const sel = $('owner-filter');
  const cur = sel.value;
  const owners = (state.owners && state.owners.length)
    ? state.owners
    : [...new Set(state.entries.map(e => e.lead_owner).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">Any owner</option>' + owners.map(o => `<option>${esc(o)}</option>`).join('');
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
  { f: 'lead_owner', h: 'Lead Owner', e: 'owner' },
  { f: 'category',   h: 'Category',   e: 'category', cls: 'cat' },
  { f: 'stage',      h: 'Stage',      e: 'stage', cls: 'stg' },
  { f: 'status',     h: 'Status',     e: 'status', cls: 'stt' },
  { f: 'label',      h: 'Label',      e: 'label', cls: 'lbl' },
  { f: 'notes',      h: 'Notes',      e: 'notes', cls: 'notes' },
  { h: 'CRM',        status: true, cls: 'st' },
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
function cellDisplay(e, c) {
  if (c.link) return e.social_url ? `<a href="${esc(e.social_url)}" target="_blank" rel="noopener">${esc(e.social_url.replace(/^https?:\/\//, ''))}</a>` : ph;
  if (c.status) return statusChipHtml(e);
  if (c.f === 'status') { const l = statusLabel(e.status); return l ? `<span class="crumb">${esc(l)}</span>` : '<span class="ph">— set —</span>'; }
  if (c.f === 'label') return e.label ? `<span class="crumb">${esc(e.label)}</span>` : '<span class="ph">— set —</span>';
  if (c.e === 'delivery' || c.e === 'reason') { const l = subNodeLabel(e.position); return l ? `<span class="crumb">${esc(l)}</span>` : '<span class="ph">— set —</span>'; }
  if (c.uname) return '@' + esc(e.handle);
  if (c.f === 'date') { const d = fmtDay(e.created_at); return d ? esc(d) : ph; }
  if (c.e === 'date') { const v = cellValue(e, c); return v ? esc(fmtDMY(v)) : ph; }
  return cellTxt(cellValue(e, c));
}

function ownerOptions() {
  return [...new Set([...(state.owners || []), ...(state.team || [])])].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function renderEntries() {
  const list = $('list');
  const sc = list.scrollTop, sl = list.scrollLeft;
  const shown = state.entries.length;
  const total = state.grandTotal != null ? state.grandTotal : shown;
  $('entry-count').textContent = total ? (shown < total ? `(${shown} of ${total})` : `(${total})`) : '';
  if (!shown) { list.innerHTML = '<div class="empty">No leads match. Try clearing filters or a different search.</div>'; return; }
  const capped = shown >= 1000 && shown < total;
  const note = capped ? `<div class="cap-note">Showing the most recent <b>${shown}</b> of <b>${total}</b> leads — use search or filters to reach any specific lead.</div>` : '';
  const cols = activeCols();
  const head = '<thead><tr>' + cols.map(c => `<th class="${c.cls || ''}">${esc(c.h)}</th>`).join('') + '<th class="act"></th></tr></thead>';
  const body = state.entries.map(e => rowHtml(e, cols)).join('');
  list.innerHTML = note + `<table class="grid">${head}<tbody>${body}</tbody></table>`;
  list.scrollTop = sc; list.scrollLeft = sl;
  wireGrid();
}

function statusChipHtml(e) {
  let tone = 'green', label = 'New';
  if (e.crm && e.crm.replied) { tone = 'red'; label = 'Prior convo'; }
  else if (e.crm && e.crm.contacted) { tone = 'orange'; label = 'No reply'; }
  else if (e.in_master) { tone = 'blue'; label = 'In records'; }
  const view = e.view_conversation ? ` <a class="vc" href="${esc(e.view_conversation)}" target="_blank" rel="noopener" title="View conversation">↗</a>` : '';
  const st = (e.crm && e.crm.status) ? ` <span class="stx" title="CRM status">${esc(e.crm.status)}</span>` : '';
  const poc = (e.crm && e.crm.poc) ? `<span class="pocmini">POC: ${esc(e.crm.poc)}</span>` : '';
  return `<span class="chip ${tone}">${label}</span>${view}${st}${poc}`;
}

function rowHtml(e, cols) {
  cols = cols || activeCols();
  const tds = cols.map(c => c.e
    ? `<td class="c ${c.cls || ''}" data-f="${c.f}" data-e="${c.e}" data-v="${esc(cellValue(e, c))}" title="${esc(cellValue(e, c))}">${cellDisplay(e, c)}</td>`
    : `<td class="${c.cls || ''}">${cellDisplay(e, c)}</td>`).join('');
  // Move-to-Closed / Move-to-Failed buttons on the movable lead tabs.
  const mv = ['leads', 'responses', 'all'].includes(state.tab)
    ? `<button class="mv close-btn" title="Mark Closed">✔</button><button class="mv fail-btn" title="Mark Failed">✘</button>` : '';
  return `<tr data-id="${e.id}">${tds}<td class="act">${mv}<button class="exp" title="Open full editor">⤢</button><button class="del" title="Delete">×</button></td></tr>`;
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
  if (ev.target.closest('.exp')) return openEdit(e);
  if (ev.target.closest('a')) return; // let links through
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
  if (tr) tr.outerHTML = rowHtml(entry, activeCols());
}

/* ── top-level view switch (CRM pipeline ｜ Unibox email replies) ── */
function switchView(view, deepLink) {
  const frame = $('unibox-frame');
  document.querySelectorAll('#sidebar .sb-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'unibox') {
    const target = '/unibox/' + (deepLink ? deepLink : '');
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
function switchTab(k) {
  state.tab = k;
  renderTabs();
  const isVideos = k === 'videos';
  $('lead-controls').style.display = isVideos ? 'none' : '';
  $('video-controls').style.display = isVideos ? '' : 'none';
  const db = document.querySelector('.date-bar'); if (db) db.style.display = isVideos ? 'none' : '';
  const t = TABS.find(x => x.k === k);
  $('list-title').innerHTML = esc(t.h) + ' <span class="count" id="entry-count"></span>';
  // Keep the Stage dropdown in sync with the active tab.
  const sf = $('stage-filter'); if (sf) sf.value = STAGE_OF_TAB[k] ? k : '';
  // Delivery-status filter shows only on the Closed tab.
  const dfEl = $('delivery-filter');
  if (dfEl) { dfEl.style.display = (k === 'closed') ? '' : 'none'; if (k === 'closed') fillDeliveryFilter(); else dfEl.value = ''; }
  const rfEl = $('reason-filter');
  if (rfEl) { rfEl.style.display = (k === 'failed') ? '' : 'none'; if (k === 'failed') fillReasonFilter(); else rfEl.value = ''; }
  loadEntries();
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
const VIDEO_COLS = [
  { f: 'handle', h: 'Lead', leadlink: true, cls: 'uname' },
  { f: 'lead_name', h: 'Lead name', e: 'text' },
  { f: 'url', h: 'Video URL', e: 'text', cls: 'lnk' },
  { f: 'date_posted', h: 'Date posted', e: 'date', cls: 'dt' },
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
  const sc = list.scrollTop, sl = list.scrollLeft;
  const q = ($('video-search').value || '').trim().toLowerCase();
  let vids = state.videos;
  if (q) vids = vids.filter(v => `${v.handle} ${v.lead_name || ''} ${v.country} ${v.video_type} ${v.language} ${v.url} ${v.referral || ''} ${v.saas || ''}`.toLowerCase().includes(q));
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
  if (!state.lookupConfigured) { toast('CRM lookup not configured'); return; }
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

const HANDLE_COLS = ['username', 'handle', 'instagram', 'insta', 'ig', 'profile', 'social', 'url', 'link', 'account'];
const EMAIL_COLS = ['email', 'e-mail', 'mail'];
const NAME_COLS = ['first_name', 'firstname', 'first name', 'name', 'fname'];
const CAT_COLS = ['category', 'categories', 'type', 'segment', 'label'];

function extractMaster(text) {
  const rows = parseDelimited(text);
  if (!rows.length) return { rows: [], note: 'Empty file.' };
  // Detect header.
  const header = rows[0].map(h => h.trim().toLowerCase());
  const looksHeader = header.some(h => HANDLE_COLS.includes(h) || EMAIL_COLS.includes(h));
  let hIdx = -1, eIdx = -1, body = rows;
  if (looksHeader) {
    body = rows.slice(1);
    hIdx = header.findIndex(h => HANDLE_COLS.includes(h));
    eIdx = header.findIndex(h => EMAIL_COLS.includes(h));
    // Prefer an explicit instagram/username/handle column over a generic url.
    const pref = header.findIndex(h => ['username', 'handle', 'instagram', 'insta', 'ig'].includes(h));
    if (pref >= 0) hIdx = pref;
  }
  const out = [];
  for (const r of body) {
    let handleCell = hIdx >= 0 ? r[hIdx] : '';
    if (!handleCell) {
      // Single-column file or no header: take the first cell that looks like a handle/URL.
      handleCell = r.find(c => /instagram\.com/i.test(c)) || r.find(c => c && c.trim()) || '';
    }
    const email = eIdx >= 0 ? (r[eIdx] || '') : (r.find(c => /@/.test(c) && !/instagram/i.test(c)) || '');
    if (handleCell && handleCell.trim()) out.push({ handle: handleCell.trim(), email: (email || '').trim() });
  }
  return { rows: out, header: looksHeader ? header : null, handleCol: hIdx >= 0 ? header[hIdx] : '(auto)', emailCol: eIdx >= 0 ? header[eIdx] : '' };
}

function handleFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const res = extractMaster(String(reader.result || ''));
    parsedMaster = res.rows;
    if (!res.rows.length) { $('master-preview').innerHTML = '<span style="color:var(--red)">No handles found in that file.</span>'; $('master-import').disabled = true; return; }
    $('master-preview').innerHTML =
      `Parsed <b>${res.rows.length}</b> rows from <b>${esc(file.name)}</b>` +
      (res.handleCol ? ` · handle column: <b>${esc(res.handleCol)}</b>` : '') +
      (res.emailCol ? ` · email column: <b>${esc(res.emailCol)}</b>` : '') +
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
  const out = [];
  for (const r of body) {
    let social = hIdx >= 0 ? r[hIdx] : (r.find(c => /instagram\.com/i.test(c)) || r.find(c => c && !/@/.test(c)) || r[0] || '');
    let email = eIdx >= 0 ? (r[eIdx] || '') : (r.find(c => /@/.test(c) && !/instagram/i.test(c)) || '');
    social = (social || '').trim(); email = (email || '').trim();
    const row = { social_url: social, email };
    if (nIdx >= 0 && r[nIdx]) row.first_name = r[nIdx].trim();
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
  const from = $('date-from').value, to = $('date-to').value;
  $('act-range').textContent = (from || to) ? `Range: ${from || '…'} → ${to || '…'} (IST)` : 'Range: all time';
  $('activity-body').innerHTML = '<div class="act-empty">Loading…</div>';
  $('activity-totals').innerHTML = '';
  const p = new URLSearchParams();
  if (from) p.set('from', from); if (to) p.set('to', to);
  let s;
  try { s = await api('/api/stats?' + p.toString()); }
  catch (e) { $('activity-body').innerHTML = `<div class="act-empty">${esc(e.message)}</div>`; return; }
  renderActivity(s);
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

  const cell = (o) => o && o.leads ? `${o.leads}<span class="we"> / ${o.with_email}</span>` : '<span class="we">–</span>';
  const head = `<tr><th>Day (IST)</th>${s.members.map(m => `<th>${esc(m)}</th>`).join('')}<th class="total-col">Total</th></tr>`;
  const rows = s.by_day.map(d => {
    const cells = s.members.map(m => `<td>${cell(md[d.day + '|' + m])}</td>`).join('');
    return `<tr><td>${esc(d.day || '(no date)')}</td>${cells}<td class="total-col">${d.leads}<span class="we"> / ${d.with_email}</span></td></tr>`;
  }).join('');
  const totalRow = `<tr class="total-row"><td>All</td>${s.members.map(m =>
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
  $('owner-filter').onchange = loadEntries;
  $('cat-filter').onchange = loadEntries;
  $('status-filter').onchange = loadEntries;
  $('label-filter').onchange = loadEntries;
  $('delivery-filter').onchange = loadEntries;
  $('reason-filter').onchange = loadEntries;
  // Stage dropdown = the tabs: switch to that tab (or All when cleared).
  $('stage-filter').onchange = e => switchTab(e.target.value || 'all');

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
  $('activity-close').onclick = () => $('activity-bg').classList.remove('open');

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
  $('team-btn').onclick = openTeam;
  $('team-close').onclick = () => $('team-bg').classList.remove('open');
  $('nu-add').onclick = addUser;

  // Close modals on backdrop click
  for (const id of ['master-bg', 'team-bg', 'bulk-bg', 'activity-bg', 'edit-bg', 'cat-bg', 'classify-bg', 'pipe-bg', 'funnel-bg', 'video-bg', 'add-bg', 'close-bg', 'fail-bg']) {
    $(id).addEventListener('click', e => { if (e.target.id === id) $(id).classList.remove('open'); });
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') for (const id of ['master-bg', 'team-bg', 'bulk-bg', 'activity-bg', 'edit-bg', 'cat-bg', 'classify-bg', 'pipe-bg', 'funnel-bg', 'video-bg', 'add-bg', 'close-bg', 'fail-bg']) $(id).classList.remove('open');
  });
}

wire();
boot().catch(e => { $('login-error').textContent = e.message; $('login-view').style.display = 'flex'; });
