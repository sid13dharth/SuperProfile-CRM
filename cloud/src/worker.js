/**
 * SuperProfile Lead-Gen Dedup Platform — Cloudflare Worker.
 *
 * A real-time lead data-entry tool. Teammates add leads (Instagram handle +
 * email); every entry is stored live. Two INDEPENDENT signals per lead:
 *   1. Duplicate-by-Instagram-username — checked against an uploaded master
 *      list AND every prior entry, enforced atomically by a UNIQUE index so two
 *      simultaneous adds of the same handle can't both slip through.
 *   2. Prior Instantly conversation — fetched from the CRM over HTTPS via
 *      POST /api/lookup (keyed on email, reliable), surfaced separately.
 *
 * Auth mirrors the CRM: PBKDF2 + cookie sessions, one account per teammate.
 *
 * MERGE: the Instantly outreach engine (sync/enrichment/auto-status/reply) lives
 * in ./sync.js and runs on the scheduled() cron below, keeping conversations +
 * the pipeline live in the same DB.
 */

import {
  runFullSync, runManualSync, ensureDefaultWorkspace, listWorkspaces, wsKey,
  recomputeConversations, linkConversations, emailUpsertStmt, instantlyPost, instantlyGet,
  runRateExtraction, runBodyBackfill, runReplyReconcile, fetchLeadEmails, USD_PER, AUTO_POC_NAMES,
} from './sync.js';
import { enrichRows, IG_STEP_LEADS } from './hiker.js';

const SESSION_TTL_DAYS = 30;
const PBKDF2_ITERATIONS = 100000; // Workers cap PBKDF2 at 100k iterations.

/* ── small helpers ─────────────────────────────────────────── */

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');

function isoPlus(days) {
  return new Date(Date.now() + days * 86400_000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// Find the LEAD's email in a webhook payload of unknown shape. Prefers keys that
// mention "lead"; avoids our own sending-account addresses (eaccount/from/...).
function findLeadEmail(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return '';
  const isEmail = v => typeof v === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());
  const bad = k => /account|eaccount|from|sender|reply_to|owner/i.test(k);
  for (const [k, v] of Object.entries(obj)) if (isEmail(v) && /lead/i.test(k) && !bad(k)) return v.toLowerCase().trim();
  for (const [k, v] of Object.entries(obj)) if (isEmail(v) && /email|mail|contact/i.test(k) && !bad(k)) return v.toLowerCase().trim();
  for (const v of Object.values(obj)) { if (v && typeof v === 'object') { const r = findLeadEmail(v, depth + 1); if (r) return r; } }
  return '';
}

class ApiError extends Error {
  constructor(status, detail) { super(detail); this.status = status; }
}

function readCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : '';
}

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(nBytes) {
  const a = new Uint8Array(nBytes);
  crypto.getRandomValues(a);
  return hex(a.buffer);
}

function randomToken() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ── identifier normalisation (the dedup key) ──────────────── */

// Instagram paths that are never a profile handle.
const IG_RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'tv', 'accounts', 'directory']);

// Turn a full instagram.com URL, an "@handle", or a bare handle into a single
// canonical lower-case handle. Returns '' if nothing usable.
function normHandle(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return '';
  const m = s.match(/instagram\.com\/@?([^/?#\s]+)/i);
  if (m) {
    s = m[1];
  } else {
    // Strip any protocol/host noise from non-instagram URL-ish input.
    s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  }
  s = s.replace(/^@+/, '');       // leading @
  s = s.split(/[/?#\s]/)[0];      // keep only the first segment
  s = s.replace(/\/+$/, '');      // trailing slash (paranoia)
  s = s.trim().toLowerCase();
  if (IG_RESERVED.has(s)) return '';
  return s;
}

function normEmail(input) {
  return String(input == null ? '' : input).trim().toLowerCase();
}

function canonicalUrl(handle) {
  return handle ? `https://instagram.com/${handle}` : '';
}

/* ── IST day handling (all "per day" grouping uses UTC+5:30) ── */

const IST_OFFSET_MIN = 330; // UTC+05:30

// Convert an IST calendar-date range (YYYY-MM-DD) into UTC ISO bounds, so we can
// filter the UTC-stored created_at column. Missing/invalid bounds → null.
function istRange(from, to) {
  const startIso = (from && /^\d{4}-\d{2}-\d{2}$/.test(from))
    ? new Date(Date.parse(from + 'T00:00:00.000+05:30')).toISOString() : null;
  const endIso = (to && /^\d{4}-\d{2}-\d{2}$/.test(to))
    ? new Date(Date.parse(to + 'T23:59:59.999+05:30')).toISOString() : null;
  return { from: from || '', to: to || '', startIso, endIso };
}

// The IST calendar day (YYYY-MM-DD) a UTC timestamp falls on.
function istDay(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t + IST_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

/* ── auth (same scheme as the CRM) ─────────────────────────── */

async function hashPassword(password, salt) {
  salt = salt || randomHex(16);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt),
      iterations: PBKDF2_ITERATIONS },
    key, 256);
  return `${salt}$${hex(bits)}`;
}

async function verifyPassword(password, stored) {
  const i = (stored || '').indexOf('$');
  if (i < 0) return false;
  const salt = stored.slice(0, i);
  return (await hashPassword(password, salt)) === stored;
}

async function getUser(env, request) {
  /* The cookie is SameSite=Lax, so it is never sent on a request that starts on
     instagram.com. The Chrome extension reads the SAME token via chrome.cookies
     and presents it here instead. A custom header cannot be set by a plain
     cross-site form or image, so this carries the CSRF protection the SameSite
     attribute was giving us — it does not weaken it. */
  const token = readCookie(request, 'lg_session') || (request.headers.get('x-lg-session') || '').trim();
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, u.is_admin, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`)
    .bind(token).first();
  if (!row || row.expires_at < nowIso()) return null;
  return row;
}

async function requireUser(env, request) {
  const user = await getUser(env, request);
  if (!user) throw new ApiError(401, 'Not logged in');
  return user;
}

/* The teammate accountable for a lead. Sheets and forms carry bare first
   names while a user may be stored in full ("Adi" vs "Aditya Ray"), so match
   exactly first, then on first name. An owner who is not a CRM user gets no
   manager — we leave it blank rather than invent an accountable person.
   Returns an (owner) => name function so the users table is read once. */
async function managerResolver(env) {
  const team = await teamNames(env);
  const byFirst = {};
  for (const t of team) byFirst[String(t).trim().split(/\s+/)[0].toLowerCase()] = t;
  return owner => {
    const v = String(owner || '').trim();
    if (!v) return '';
    return team.find(t => t.toLowerCase() === v.toLowerCase()) || byFirst[v.toLowerCase()] || '';
  };
}

/* A GLOB pattern matching `term` anywhere, ignoring case in a way SQLite
   cannot manage on its own: its lower() and LIKE fold ASCII only, so "É"
   and "é" were different searches. JavaScript does real Unicode case
   mapping, so each character becomes a [lower upper] class.
   GLOB metacharacters (* ? [ ]) are wrapped so they match literally. */
function globCI(term) {
  const body = [...String(term || '')].map(ch => {
    if (ch === '*' || ch === '?' || ch === '[' || ch === ']') return '[' + ch + ']';
    const lo = ch.toLowerCase(), up = ch.toUpperCase();
    // Some characters expand when cased (ß -> SS); those stay literal.
    return (lo !== up && lo.length === 1 && up.length === 1) ? '[' + lo + up + ']' : ch;
  }).join('');
  return '*' + body + '*';
}

function ownerName(user) {
  return user.display_name || user.username;
}

function sessionCookie(token) {
  return `lg_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_DAYS * 86400}; Secure`;
}

async function loginResponse(env, username, password) {
  const row = await env.DB.prepare('SELECT * FROM users WHERE username=?')
    .bind(username).first();
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    throw new ApiError(401, 'Invalid username or password');
  }
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
      .bind(token, row.id, nowIso(), isoPlus(SESSION_TTL_DAYS)),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowIso()),
  ]);
  return json({ ok: true, username, display_name: row.display_name || username, is_admin: row.is_admin },
    200, { 'Set-Cookie': sessionCookie(token) });
}

/* ── meta / version (drives real-time polling on the client) ── */

async function metaGet(env, key, dflt = '') {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key=?').bind(key).first();
  return row ? row.value : dflt;
}

function metaSetStmt(env, key, value) {
  return env.DB.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .bind(key, String(value));
}

async function bumpVersion(env) {
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES ('version', '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`).run();
}

async function teamNames(env) {
  const { results } = await env.DB.prepare(
    'SELECT username, display_name FROM users ORDER BY display_name').all();
  return results.map(r => r.display_name || r.username);
}

/* ── CRM integration (prior-conversation check) ────────────── */

// Call the CRM's read-only POST /api/lookup with our LOOKUP_KEY secret. The key
// lives only on this worker — the browser never sees it. Returns the results
// array, or { error } on failure, or null if the lookup isn't configured.
async function crmLookup(env, emails, handles) {
  const key = env.LOOKUP_KEY || '';
  if (!key) return null;
  const headers = { 'Content-Type': 'application/json', 'x-lookup-key': key };
  const payload = JSON.stringify({ emails: emails || [], handles: handles || [] });
  try {
    let r;
    if (env.CRM && typeof env.CRM.fetch === 'function') {
      // Same-account service binding: direct dispatch, no public hostname. The
      // host part of the URL is ignored — only the path routes inside the CRM.
      r = await env.CRM.fetch('https://crm.internal/api/lookup', { method: 'POST', headers, body: payload });
    } else {
      const base = (env.CRM_URL || '').replace(/\/+$/, '');
      if (!base) return { error: 'CRM_URL not set' };
      r = await fetch(base + '/api/lookup', { method: 'POST', headers, body: payload });
    }
    if (!r.ok) return { error: `CRM lookup returned ${r.status}` };
    const data = await r.json().catch(() => ({}));
    return Array.isArray(data.results) ? data.results : [];
  } catch (e) {
    return { error: e.message };
  }
}

// From a lookup results array, pick the single best signal for one lead.
// Email match is reliable (handoff §5), so prefer an email hit, then a handle
// hit, then any known row.
function pickCrmSignal(results) {
  if (!Array.isArray(results)) return null;
  return results.find(r => r.type === 'email' && r.known)
      || results.find(r => r.type === 'handle' && r.known)
      || results.find(r => r.known)
      || results[0] || null;
}

// Flatten a chosen CRM signal into the columns we snapshot onto an entry.
function crmSnapshot(sig) {
  if (!sig || !sig.known) {
    return {
      crm_known: 0, crm_contacted: 0, crm_replied: 0, crm_status: '', crm_poc: '',
      crm_campaigns: '[]', crm_last_contact_at: '', crm_last_reply_at: '', crm_checked_at: nowIso(),
      crm_label: '', crm_deal: '', crm_first_name: '',
    };
  }
  return {
    crm_known: sig.known ? 1 : 0,
    crm_contacted: sig.contacted ? 1 : 0,
    crm_replied: sig.replied ? 1 : 0,
    crm_status: sig.status || '',
    crm_poc: sig.poc || '',
    crm_campaigns: JSON.stringify(sig.campaigns || []),
    crm_last_contact_at: sig.last_contact_at || '',
    crm_last_reply_at: sig.last_reply_at || '',
    crm_checked_at: nowIso(),
    crm_label: sig.label || '',
    crm_deal: sig.rates ? JSON.stringify(sig.rates) : '',
    crm_first_name: sig.first_name || '',
  };
}

// Manual status/label overrides stored in stage_data (empty → fall back to CRM).
// The grid's Status/Label dropdowns write here so a human pick survives the sync.
function manualSD(row, field) {
  try { return JSON.parse(row.stage_data || '{}')[field] || ''; } catch { return ''; }
}
function manualLabel(row) { return manualSD(row, 'label'); }

// Pure-manual per-lead fields (Closed / Failed / All-Leads detail), all stored in
// the stage_data JSON so no per-field DB columns are needed.
const SD_FIELDS = ['closing_date', 'contract_signed', 'on_retainer', 'retainer_start_date', 'retainer_months', 'partnership_status',
  'fail_reason', 'fail_details', 'interested', 'not_interested_reason', 'outcome', 'signups', 'saas'];
function stageDataFields(row) {
  let m = {}; try { m = JSON.parse(row.stage_data || '{}'); } catch { m = {}; }
  const out = {};
  for (const f of SD_FIELDS) out[f] = m[f] || '';
  return out;
}

// Build the effective deal fields shown in the grid: manual (stage_data) wins,
// else fall back to the CRM-pulled value.
function dealFields(row) {
  let m = {}, c = {};
  try { m = JSON.parse(row.stage_data || '{}'); } catch { m = {}; }
  try { c = JSON.parse(row.crm_deal || '{}'); } catch { c = {}; }
  return {
    initial_rate: m.initial_rate || c.their_initial || '',
    closing_rate: m.closing_rate || c.their_final || '',
    counter_offer: m.counter_offer || c.our_initial || c.our_final || '',
    final_rate: m.final_rate || c.their_final || '',
    our_final_offer: m.our_final_offer || c.our_final || '',
    deliverables: m.deliverables || c.deliverables || '',
    deliverables_status: m.deliverables_status || '',
  };
}

/* ── pipeline classification tree (Stage → Status → Label → sub-labels) ── */
// The 4 top-level stages (buckets / tabs). A lead's `stage` is one of these; its
// `position` is a node KEY somewhere inside that stage's sub-tree (or '' = unset).
// Node keys encode the path from the stage, e.g.
//   Responses/interested/relevant/call_booked/did_not_show
// so a node's parent is just its key minus the last segment.
const PIPE_STAGES = ['Leads', 'Responses', 'Closed', 'Failed'];

// Reusable funnel sub-tree, attached under each Relevant / Not Relevant that can progress.
const PIPE_FUNNEL = [
  ['rates_quoted', 'Rates Quoted'],
  ['call_pitched', 'Call Pitched', [['did_not_book', 'Did Not Book']]],
  ['call_booked', 'Call Booked', [['not_made_decision', 'Not Made a Decision'], ['did_not_show', 'Did Not Show Up']]],
  ['negotiating', 'Negotiating'],
  ['follow_up', 'Follow Up'],
  ['ghosted', 'Ghosted'],
];
const PIPE_REL = [['relevant', 'Relevant', PIPE_FUNNEL], ['notrelevant', 'Not Relevant', PIPE_FUNNEL]];
const PIPE_REL_DEAD = [['relevant', 'Relevant'], ['notrelevant', 'Not Relevant']]; // dead-ends (editable)
const PIPE_SEED = {
  Leads: [['awaiting', 'Awaiting Reply'], ['bounced', 'Bounced'], ['notcontacted', 'Not Contacted']],
  Responses: [['interested', 'Interested', PIPE_REL], ['notinterested', 'Not Interested', PIPE_REL_DEAD], ['automated', 'Automated', PIPE_REL]],
  Closed: [['deliv_met', 'Deliverables Met'], ['deliv_partial', 'Partially Met'], ['deliv_yet', 'Yet to Deliver'], ['backed_out', 'Backed Out / Ghosting']],
  Failed: [['out_of_budget', 'Out of Budget'], ['other', 'Other Reasons']],
};
function pipeSeedRows() {
  const rows = [];
  for (const stage of PIPE_STAGES) {
    const walk = (list, parent) => (list || []).forEach(([role, label, kids], i) => {
      const key = (parent || stage) + '/' + role;
      rows.push({ key, parent: parent || '', stage, label, sort: i });
      if (kids) walk(kids, key);
    });
    walk(PIPE_SEED[stage], '');
  }
  return rows;
}
async function ensurePipeline(env) {
  const c = await env.DB.prepare('SELECT COUNT(*) n FROM pipeline_nodes').first();
  if (c && c.n > 0) return;
  const stmts = pipeSeedRows().map(r => env.DB.prepare(
    'INSERT OR IGNORE INTO pipeline_nodes (key, parent, stage, label, sort, deletable, created_at) VALUES (?,?,?,?,?,1,?)')
    .bind(r.key, r.parent, r.stage, r.label, r.sort, nowIso()));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'node';
}
// CRM status/label → a suggested {stage, position} for the automatic pre-fill.
// Applied only when a lead has no manual position yet (never clobbers a human).
function crmSuggest(status, label) {
  const s = (status || '').toLowerCase(), l = (label || '').toLowerCase();
  if (s === 'closed') return { stage: 'Closed', position: '' };
  if (s === 'failed' || s === 'partner_of_competitor') return { stage: 'Failed', position: 'Failed/other' };
  if (l === 'out of budget') return { stage: 'Failed', position: 'Failed/out_of_budget' };
  if (s === 'rates_quoted') return { stage: 'Responses', position: 'Responses/interested/relevant/rates_quoted' };
  if (s === 'call_booked') return { stage: 'Responses', position: 'Responses/interested/relevant/call_booked' };
  if (s === 'call_pitched') return { stage: 'Responses', position: 'Responses/interested/relevant/call_pitched' };
  // moved_to_wa: no dedicated node (per spec) — it's a replied+relevant lead, nothing more specific.
  if (s === 'moved_to_wa') return { stage: 'Responses', position: 'Responses/interested/relevant' };
  if (s === 'not_relevant' || l === 'not relevant' || l === 'dnd (remove lead)') return { stage: 'Responses', position: 'Responses/interested/notrelevant' };
  // Any other reply with no CRM status detail → just Responses (bucket), position left for the team.
  return null;
}

/* ── funnel classification (+ve/-ve auto from CRM status/label) ── */
const FUNNEL_POS = new Set(['moved_to_wa', 'call_pitched', 'call_booked', 'rates_quoted', 'closed']);
const FUNNEL_NEG_STATUS = new Set(['not_relevant', 'partner_of_competitor', 'failed']);
const FUNNEL_NEG_LABEL = new Set(['not relevant', 'dnd (remove lead)', 'out of budget']);

// Which pipeline-position roles count as "price quoted or further".
const POS_QUOTED_RE = /\/(rates_quoted|call_pitched|call_booked|did_not_book|not_made_decision|did_not_show|negotiating|follow_up|ghosted)$/;
function funnelFlags(row) {
  const status = (row.crm_status || '').toLowerCase();
  const label = (row.crm_label || '').toLowerCase();
  const stage = (row.stage || '');            // Leads | Responses | Closed | Failed
  const pos = row.position || '';
  let deal = {}; try { deal = JSON.parse(row.crm_deal || '{}'); } catch { deal = {}; }
  const replied = row.crm_replied ? 1 : 0;
  const posNeg = /\/notrelevant/.test(pos) || /\/notinterested/.test(pos) || stage === 'Failed';
  const posPos = /\/(relevant|rates_quoted|call_pitched|call_booked|negotiating|follow_up)$/.test(pos) || stage === 'Closed';
  return {
    collected: 1,
    reached: row.crm_contacted ? 1 : 0,
    replied,
    positive: replied && (FUNNEL_POS.has(status) || posPos) ? 1 : 0,
    negative: replied && (FUNNEL_NEG_STATUS.has(status) || FUNNEL_NEG_LABEL.has(label) || posNeg) ? 1 : 0,
    quoted: (status === 'rates_quoted' || (deal && (deal.their_initial || deal.their_final))
             || POS_QUOTED_RE.test(pos) || stage === 'Closed' || stage === 'Failed') ? 1 : 0,
    closed: (status === 'closed' || stage === 'Closed') ? 1 : 0,
  };
}
const blankFunnel = () => ({ collected: 0, reached: 0, replied: 0, positive: 0, negative: 0, quoted: 0, closed: 0 });
function accFunnel(acc, f) { for (const k in f) acc[k] = (acc[k] || 0) + f[k]; }

/* ── row shaping ───────────────────────────────────────────── */

function entryDict(row, crmUrl) {
  let campaigns = [];
  try { campaigns = JSON.parse(row.crm_campaigns || '[]'); } catch { campaigns = []; }
  const crm = {
    known: !!row.crm_known,
    contacted: !!row.crm_contacted,
    replied: !!row.crm_replied,
    status: row.crm_status || '',
    poc: row.crm_poc || '',
    campaigns,
    last_contact_at: row.crm_last_contact_at || '',
    last_reply_at: row.crm_last_reply_at || '',
    checked_at: row.crm_checked_at || '',
  };
  return {
    id: row.id,
    handle: row.handle_norm,
    handle_raw: row.handle_raw,
    social_url: row.social_url,
    email: row.email,
    first_name: row.first_name || '',
    notes: row.notes || '',
    category: row.category || '',
    lead_owner: row.lead_owner,
    lead_manager: row.lead_manager || '',
    created_by: row.created_by,
    created_at: row.created_at,
    source: row.source || 'added',
    in_master: (row.source === 'master') || !!row.in_master,
    stage: row.stage || '',
    position: row.position || '',
    // Effective Status/Label the grid dropdowns show and filter on: a manual
    // pick (stage_data) wins, else the CRM-synced value.
    status: manualSD(row, 'status') || row.crm_status || '',
    label: manualLabel(row) || row.crm_label || '',
    deal: dealFields(row),
    ...stageDataFields(row),
    crm,
    // Instagram enrichment (HikerAPI). null = never fetched, which the grid
    // shows as a dash rather than a misleading 0.
    ig_followers: row.ig_followers === null || row.ig_followers === undefined ? null : row.ig_followers,
    ig_last_post_at: row.ig_last_post_at || '',
    ig_avg_views_10: row.ig_avg_views_10 === null || row.ig_avg_views_10 === undefined ? null : row.ig_avg_views_10,
    ig_checked_at: row.ig_checked_at || '',
    ig_status: row.ig_status || '',
    ig_bio: row.ig_bio || '',
    ig_link: row.ig_link || '',
    ig_link_domain: row.ig_link_domain || '',
    // Combined verdict for the UI (kept independent of the dup signal).
    verdict: verdictFor({ in_master: (row.source === 'master') || !!row.in_master, dup: false }, crm),
    view_conversation: (crm.known && row.email && crmUrl)
      ? `${crmUrl.replace(/\/+$/, '')}/?lead=${encodeURIComponent(row.email)}` : '',
  };
}

// The point-4 rule: username-dup and prior-conversation are DIFFERENT signals.
// Prior conversation dominates the "should we reach out" verdict; being in our
// records without a reply is still reachable.
function verdictFor(dup, crm) {
  if (crm && crm.replied) return { code: 'prior_convo', label: 'Prior conversation — do not re-pitch', tone: 'red' };
  if (crm && crm.contacted) return { code: 'contacted_no_reply', label: 'Contacted before, never replied — OK to reach out', tone: 'orange' };
  if (dup && (dup.dup || dup.in_master)) return { code: 'in_db', label: 'In our records, never contacted — OK to reach out', tone: 'blue' };
  return { code: 'new', label: 'New — pursue', tone: 'green' };
}

/* ── conversation helpers (ported from the CRM: inbox buckets, replies) ── */
const FOLLOWUP_DUE_DAYS = 3;
const TERMINAL_STATUSES = new Set(['closed', 'failed', 'not_relevant', 'partner_of_competitor']);
const RATE_CURRENCIES = ['$', '₹', '€', '£', 'C$', 'A$'];

function daysSince(ts) {
  if (!ts) return null;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (Date.now() - t) / 86400_000);
}

// Build the HTML body for an outgoing reply: escape, linkify [label](url) + bare
// URLs, keep line breaks.
function replyToHtml(text) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const anchor = (url, label) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`;
  const token = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)/g;
  let out = '', last = 0, m;
  while ((m = token.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    if (m[1] !== undefined) out += anchor(m[2], m[1]);
    else {
      let url = m[3], trail = '';
      const tm = url.match(/[.,;:!?)\]]+$/);
      if (tm) { trail = tm[0]; url = url.slice(0, url.length - trail.length); }
      out += anchor(url, url) + esc(trail);
    }
    last = m.index + m[0].length;
  }
  out += esc(text.slice(last));
  return out.replace(/\n/g, '<br>');
}
function replyToPlain(text) {
  return text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)');
}

// The inbox bucket a conversation falls in (their turn vs ours, follow-up due…).
function computeBucket(c) {
  if (TERMINAL_STATUSES.has(c.status)) return ['closed', null];
  const now = nowIso();
  if (c.last_msg_ue_type === 2) {
    const d = daysSince(c.last_lead_msg_at);
    if (c.snoozed_until && c.snoozed_until > now) return ['snoozed', d];
    return [(c.lead_reply_count || 0) >= 2 ? 'in_conversation' : 'first_reply', d];
  }
  const d = daysSince(c.last_our_msg_at || c.last_msg_at);
  if (c.snoozed_until && c.snoozed_until > now) return ['snoozed', d];
  if (d !== null && d >= FOLLOWUP_DUE_DAYS) return ['followup_due', d];
  return ['waiting', d];
}
function convDict(row, campaignNames) {
  const [bucket, days] = computeBucket(row);
  return {
    key: row.key, entry_id: row.entry_id || 0, email: row.email, first_name: row.first_name,
    handle: row.handle_norm || '', campaign_id: row.campaign_id,
    campaign_name: campaignNames[row.campaign_id] || '(no campaign)',
    subject: row.subject, preview: (row.preview || '').slice(0, 120),
    last_lead_msg_at: row.last_lead_msg_at, last_our_msg_at: row.last_our_msg_at,
    last_msg_at: row.last_msg_at, first_reply_at: row.first_reply_at, msg_count: row.msg_count,
    status: row.status, status_source: row.status_source, label: row.label,
    snoozed_until: row.snoozed_until, social_url: row.social_url, lead_owner: row.lead_owner, poc: row.poc,
    lead_category: row.lead_category || '',
    deal_videos: row.deal_videos, deal_budget: row.deal_budget, deal_deliverables: row.deal_deliverables,
    fail_reason: row.fail_reason, fail_notes: row.fail_notes,
    rate_their_initial: row.rate_their_initial, rate_their_final: row.rate_their_final,
    rate_our_initial: row.rate_our_initial, rate_our_final: row.rate_our_final,
    quoted_usd: row.quoted_usd, quoted_currency: row.quoted_currency, quoted_amount: row.quoted_amount,
    quoted_all: row.quoted_all, quoted_qty: row.quoted_qty, quoted_unit: row.quoted_unit,
    quoted_per_unit_usd: row.quoted_per_unit_usd, quoted_source: row.quoted_source, quoted_other: row.quoted_other,
    bucket, days_waiting: days !== null ? Math.round(days * 10) / 10 : null,
  };
}
async function touchConv(env, key, user, kind, detail) {
  await env.DB.prepare('INSERT INTO activity (lead_key, author, kind, detail, created_at) VALUES (?,?,?,?,?)')
    .bind(key, user.display_name || user.username, kind, detail, nowIso()).run();
  await bumpVersion(env);
}
// Re-sync the person (entry) behind a conversation after a manual change.
async function relinkConv(env, key) { try { await linkConversations(env, [key]); } catch (e) { /* best effort */ } }

// Two-way sync: push a CRM (pipeline) edit down onto the lead's MOST RECENT
// conversation so the Unibox reflects it. Maps the pipeline fields onto the
// conversation's status/label/deal/fail columns, then returns the conversation
// key so the caller can re-project (relinkConv). Returns '' if the lead has no
// conversation (cold lead) — nothing to reflect. Fields the Unibox has no home
// for (closing date, contract signed, retainer, partnership status) stay CRM-only.
async function pushEntryToConversation(env, entryId, body) {
  const conv = await env.DB.prepare(
    'SELECT key, status FROM conversations WHERE entry_id=? ORDER BY last_msg_at DESC, updated_at DESC LIMIT 1').bind(entryId).first();
  if (!conv) return '';
  const sets = [], args = [];
  const set = (col, val) => { sets.push(`${col}=?`); args.push(val); };
  let statusTouched = false;
  const setStatus = s => { set('status', s); set('status_source', 'manual'); statusTouched = true; };

  if ('status' in body) setStatus(String(body.status || ''));
  if ('label' in body) set('label', String(body.label || ''));
  // Stage → conversation status (Closed/Failed map to terminal; moving back to
  // an active stage clears a terminal status).
  if ('stage' in body && !statusTouched) {
    const st = String(body.stage || '');
    if (st === 'Closed') setStatus('closed');
    else if (st === 'Failed') setStatus('failed');
    else if (conv.status === 'closed' || conv.status === 'failed') setStatus('');
  }
  if ('fail_reason' in body) {
    const fr = String(body.fail_reason || '');
    set('fail_reason', fr === 'Out of budget' ? 'out_of_budget' : (fr ? 'other' : ''));
    if (fr && !statusTouched) setStatus('failed');
  }
  if ('fail_details' in body) set('fail_notes', String(body.fail_details || ''));
  // Reason for failure = a Failed sub-node (position). Map it back to the
  // conversation's fail_reason so the Unibox reflects it. (Closed positions are
  // handled by the stage→closed mapping above and don't touch fail_reason.)
  if ('position' in body && String(body.position || '').startsWith('Failed/')) {
    set('fail_reason', body.position === 'Failed/out_of_budget' ? 'out_of_budget' : 'other');
    if (!statusTouched) setStatus('failed');
  }
  // Deal fields that have a conversation counterpart.
  if ('deliverables' in body) set('deal_deliverables', String(body.deliverables || ''));
  if ('initial_rate' in body) set('rate_their_initial', String(body.initial_rate || ''));
  if ('final_rate' in body) set('rate_their_final', String(body.final_rate || ''));
  if ('our_final_offer' in body) set('rate_our_final', String(body.our_final_offer || ''));

  if (!sets.length) return '';
  set('updated_at', nowIso());
  args.push(conv.key);
  await env.DB.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE key=?`).bind(...args).run();
  return conv.key;
}

/* ── API ───────────────────────────────────────────────────── */

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const body = (method === 'POST' || method === 'DELETE' || method === 'PUT' || method === 'PATCH')
    ? await request.json().catch(() => ({})) : {};

  /* — Instantly webhook: instant reply reflection (no session; shared secret) — */
  if (path === '/api/webhook/instantly' && method === 'POST') {
    const secret = url.searchParams.get('secret') || request.headers.get('x-webhook-secret') || '';
    if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) return new Response('unauthorized', { status: 401 });
    // Keep the last raw payload for shape inspection/debugging.
    try { await metaSetStmt(env, 'last_webhook', JSON.stringify(body).slice(0, 3000)).run(); } catch (e) { /* noop */ }
    // Pull the lead email + campaign out of whatever shape Instantly sends.
    const lead = (String(body.lead_email || body.email || body.lead || (body.lead_data && body.lead_data.email) || (body.data && (body.data.lead_email || body.data.email)) || '').toLowerCase().trim()) || findLeadEmail(body);
    const campaign = String(body.campaign_id || body.campaign || (body.campaign_data && body.campaign_data.id) || (body.data && (body.data.campaign_id || body.data.campaign)) || '').trim();
    if (!lead) return json({ ok: true, ignored: 'no lead email in payload' });
    // Which workspace's Instantly key to use for the authoritative re-fetch.
    let ws = Number(url.searchParams.get('ws') || 0) || 0;
    if (!ws && campaign) { const c = await env.DB.prepare('SELECT ws FROM campaigns WHERE id=?').bind(campaign).first(); if (c) ws = c.ws; }
    if (!ws) { const cv = await env.DB.prepare('SELECT ws FROM conversations WHERE email=? LIMIT 1').bind(lead).first(); ws = (cv && cv.ws) || 1; }
    const apiKey = await wsKey(env, ws);
    try {
      // Authoritative: re-fetch this lead's thread from Instantly, upsert, recompute.
      const mails = await fetchLeadEmails(env, apiKey, lead);
      const ups = mails.filter(e => e.id).map(e => emailUpsertStmt(env, e, ws));
      for (let i = 0; i < ups.length; i += 50) await env.DB.batch(ups.slice(i, i + 50));
      const pairs = [...new Set(mails.map(e => `${e.campaign_id || campaign || ''}|${lead}`).filter(p => p.split('|')[1]))];
      if (pairs.length) { await recomputeConversations(env, pairs); await linkConversations(env, pairs); }
      await bumpVersion(env);
      return json({ ok: true, lead, ws, emails: mails.length, updated: pairs.length });
    } catch (e) { return json({ ok: false, error: e.message }, 502); }
  }

  /* — session / setup — */

  if (path === '/api/me' && method === 'GET') {
    const row = await env.DB.prepare('SELECT COUNT(*) c FROM users').first();
    const user = await getUser(env, request);
    return json({
      user: user ? { username: user.username, display_name: user.display_name, is_admin: user.is_admin } : null,
      needs_setup: row.c === 0,
      crm_url: env.CRM_URL || '',
      lookup_configured: !!env.LOOKUP_KEY,
    });
  }

  if (path === '/api/setup' && method === 'POST') {
    const username = (body.username || '').trim().toLowerCase();
    const password = body.password || '';
    const display = (body.display_name || username).trim();
    if (username.length < 3 || password.length < 8) {
      throw new ApiError(400, 'Username min 3 chars, password min 8 chars');
    }
    const row = await env.DB.prepare('SELECT COUNT(*) c FROM users').first();
    if (row.c > 0) throw new ApiError(403, 'Setup already completed');
    await env.DB.prepare(
      'INSERT INTO users (username, password_hash, display_name, is_admin, created_at) VALUES (?,?,?,1,?)')
      .bind(username, await hashPassword(password), display, nowIso()).run();
    return loginResponse(env, username, password);
  }

  if (path === '/api/login' && method === 'POST') {
    return loginResponse(env, (body.username || '').trim().toLowerCase(), body.password || '');
  }

  if (path === '/api/logout' && method === 'POST') {
    const token = readCookie(request, 'lg_session');
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(token).run();
    return json({ ok: true }, 200, { 'Set-Cookie': 'lg_session=; HttpOnly; Path=/; Max-Age=0' });
  }

  /* — team / users (admin) — */

  if (path === '/api/team' && method === 'GET') {
    await requireUser(env, request);
    return json({ team: await teamNames(env) });
  }

  if (path === '/api/users' && method === 'GET') {
    const user = await requireUser(env, request);
    if (!user.is_admin) throw new ApiError(403, 'Admins only');
    const { results } = await env.DB.prepare(
      'SELECT username, display_name, is_admin, created_at FROM users ORDER BY id').all();
    return json({ users: results });
  }

  if (path === '/api/users' && method === 'POST') {
    const user = await requireUser(env, request);
    if (!user.is_admin) throw new ApiError(403, 'Admins only');
    const username = (body.username || '').trim().toLowerCase();
    const password = body.password || '';
    const display = (body.display_name || username).trim();
    if (username.length < 3 || password.length < 8) {
      throw new ApiError(400, 'Username min 3 chars, password min 8 chars');
    }
    const exists = await env.DB.prepare('SELECT 1 x FROM users WHERE username=?').bind(username).first();
    if (exists) throw new ApiError(400, 'Username already exists');
    await env.DB.prepare(
      'INSERT INTO users (username, password_hash, display_name, is_admin, created_at) VALUES (?,?,?,?,?)')
      .bind(username, await hashPassword(password), display, body.is_admin ? 1 : 0, nowIso()).run();
    return json({ ok: true });
  }

  /* — version (client polls this for real-time refresh) — */

  if (path === '/api/version' && method === 'GET') {
    await requireUser(env, request);
    return json({ version: parseInt(await metaGet(env, 'version', '0'), 10) });
  }

  /* — categories (shared list; anyone can add/remove) — */

  if (path === '/api/categories' && method === 'GET') {
    await requireUser(env, request);
    await ensureCategories(env);
    const { results } = await env.DB.prepare('SELECT name FROM categories ORDER BY sort, name').all();
    return json({ categories: results.map(r => r.name) });
  }

  if (path === '/api/categories' && method === 'POST') {
    await requireUser(env, request);
    const name = (body.name || '').trim();
    if (!name) throw new ApiError(400, 'Category name required');
    if (name.length > 40) throw new ApiError(400, 'Category name too long (max 40)');
    const max = await env.DB.prepare('SELECT MAX(sort) m FROM categories').first();
    await env.DB.prepare(
      'INSERT INTO categories (name, sort, created_at) VALUES (?,?,?) ON CONFLICT(name) DO NOTHING')
      .bind(name, ((max && max.m) || 0) + 1, nowIso()).run();
    await bumpVersion(env);
    return json({ ok: true });
  }

  if (path === '/api/categories' && method === 'DELETE') {
    await requireUser(env, request);
    const name = (body.name || '').trim();
    if (!name) throw new ApiError(400, 'Category name required');
    await env.DB.prepare('DELETE FROM categories WHERE name=?').bind(name).run();
    // Existing entries keep their category text; it just leaves the dropdown.
    await bumpVersion(env);
    return json({ ok: true });
  }

  /* — pipeline classification tree (shared, editable by anyone) — */

  if (path === '/api/pipeline' && method === 'GET') {
    await requireUser(env, request);
    await ensurePipeline(env);
    const { results } = await env.DB.prepare(
      'SELECT key, parent, stage, label, sort, deletable FROM pipeline_nodes ORDER BY stage, sort, key').all();
    return json({ stages: PIPE_STAGES, nodes: results });
  }

  if (path === '/api/pipeline' && method === 'POST') {
    await requireUser(env, request);
    await ensurePipeline(env);
    const stage = (body.stage || '').trim();
    if (!PIPE_STAGES.includes(stage)) throw new ApiError(400, 'Pick a valid stage');
    const parent = (body.parent || '').trim();
    const label = (body.label || '').trim();
    if (!label) throw new ApiError(400, 'Label required');
    if (label.length > 48) throw new ApiError(400, 'Label too long (max 48)');
    if (parent) {
      const p = await env.DB.prepare('SELECT stage FROM pipeline_nodes WHERE key=?').bind(parent).first();
      if (!p) throw new ApiError(400, 'Parent node not found');
      if (p.stage !== stage) throw new ApiError(400, 'Parent is in a different stage');
    }
    const base = (parent || stage) + '/' + slugify(label);
    let key = base, i = 2;
    while (await env.DB.prepare('SELECT 1 x FROM pipeline_nodes WHERE key=?').bind(key).first()) key = base + '_' + (i++);
    const mx = await env.DB.prepare('SELECT MAX(sort) m FROM pipeline_nodes WHERE parent=? AND stage=?').bind(parent, stage).first();
    await env.DB.prepare('INSERT INTO pipeline_nodes (key, parent, stage, label, sort, deletable, created_at) VALUES (?,?,?,?,?,1,?)')
      .bind(key, parent, stage, label, ((mx && mx.m) || 0) + 1, nowIso()).run();
    await bumpVersion(env);
    return json({ ok: true, key });
  }

  if (path === '/api/pipeline' && method === 'PATCH') {
    await requireUser(env, request);
    const key = (body.key || '').trim();
    const label = (body.label || '').trim();
    if (!key || !label) throw new ApiError(400, 'key and label required');
    if (label.length > 48) throw new ApiError(400, 'Label too long (max 48)');
    const res = await env.DB.prepare('UPDATE pipeline_nodes SET label=? WHERE key=?').bind(label, key).run();
    if (!res.meta.changes) throw new ApiError(404, 'Node not found');
    await bumpVersion(env);
    return json({ ok: true });
  }

  if (path === '/api/pipeline' && method === 'DELETE') {
    await requireUser(env, request);
    const key = (body.key || '').trim();
    if (!key) throw new ApiError(400, 'key required');
    const node = await env.DB.prepare('SELECT parent FROM pipeline_nodes WHERE key=?').bind(key).first();
    if (!node) throw new ApiError(404, 'Node not found');
    // Remove the node + all descendants; re-point any leads sitting on them to the parent.
    await env.DB.batch([
      env.DB.prepare('UPDATE entries SET position=? WHERE position=? OR position LIKE ?').bind(node.parent || '', key, key + '/%'),
      env.DB.prepare('DELETE FROM pipeline_nodes WHERE key=? OR key LIKE ?').bind(key, key + '/%'),
    ]);
    await bumpVersion(env);
    return json({ ok: true });
  }

  /* — edit a lead (open to any logged-in teammate) — */

  if (path === '/api/entries' && method === 'PATCH') {
    const user = await requireUser(env, request);
    return json(await editEntry(env, user, body));
  }

  /* — funnel analytics (CRM-known leads; overall + per campaign) — */

  if (path === '/api/funnel' && method === 'GET') {
    await requireUser(env, request);
    const p = url.searchParams;
    const { from, to, startIso, endIso } = istRange(p.get('from'), p.get('to'));
    let sql = 'SELECT category, crm_contacted, crm_replied, crm_status, crm_label, crm_deal, stage, position, crm_campaigns FROM entries WHERE crm_known = 1';
    const args = [];
    if (startIso) { sql += ' AND created_at >= ?'; args.push(startIso); }
    if (endIso) { sql += ' AND created_at <= ?'; args.push(endIso); }
    const { results } = await env.DB.prepare(sql).bind(...args).all();

    const overall = blankFunnel();
    const byCamp = {}, byCat = {};
    for (const r of results) {
      const f = funnelFlags(r);
      accFunnel(overall, f);
      // Campaigns — a lead counts in every campaign it belongs to.
      let camps = []; try { camps = JSON.parse(r.crm_campaigns || '[]'); } catch { camps = []; }
      camps = camps.filter(Boolean);
      if (!camps.length) camps = ['(no campaign)'];
      for (const c of camps) { if (!byCamp[c]) byCamp[c] = blankFunnel(); accFunnel(byCamp[c], f); }
      // Category — one per lead.
      const cat = (r.category || '').trim() || '(no category)';
      if (!byCat[cat]) byCat[cat] = blankFunnel(); accFunnel(byCat[cat], f);
    }
    const shape = m => Object.entries(m).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.collected - a.collected);
    return json({ from, to, overall, campaigns: shape(byCamp), by_category: shape(byCat), total_known: results.length });
  }

  /* — stats + activity (leads found / with-email, per IST day & member) — */

  if (path === '/api/stats' && method === 'GET') {
    await requireUser(env, request);
    const p = url.searchParams;
    const { from, to, startIso, endIso } = istRange(p.get('from'), p.get('to'));
    let sql = 'SELECT created_at, email_norm, lead_owner FROM entries WHERE 1=1';
    const args = [];
    if (startIso) { sql += ' AND created_at >= ?'; args.push(startIso); }
    if (endIso) { sql += ' AND created_at <= ?'; args.push(endIso); }
    const { results } = await env.DB.prepare(sql).bind(...args).all();

    let totLeads = 0, totEmail = 0;
    const members = new Set();
    const byDay = {};          // day -> { leads, with_email }
    const byMemberDay = {};    // "day|owner" -> { day, owner, leads, with_email }
    for (const r of results) {
      const d = istDay(r.created_at);
      const has = r.email_norm ? 1 : 0;
      const owner = r.lead_owner || '(unknown)';
      members.add(owner);
      totLeads++; totEmail += has;
      (byDay[d] = byDay[d] || { leads: 0, with_email: 0 }).leads++;
      byDay[d].with_email += has;
      const k = d + '|' + owner;
      (byMemberDay[k] = byMemberDay[k] || { day: d, owner, leads: 0, with_email: 0 }).leads++;
      byMemberDay[k].with_email += has;
    }
    const days = Object.keys(byDay).sort().reverse();
    return json({
      from, to,
      totals: { leads: totLeads, with_email: totEmail, without_email: totLeads - totEmail },
      members: [...members].sort((a, b) => a.localeCompare(b)),
      by_day: days.map(d => ({ day: d, leads: byDay[d].leads, with_email: byDay[d].with_email })),
      by_member_day: Object.values(byMemberDay),
    });
  }

  /* — lead-sourcing activity (leads each person found, per IST day) —
       Distinct from /api/stats, which counts by lead_owner over everything.

       This used to be restricted to source='added' because every master-sheet
       row carried the IMPORT timestamp, so including them would have piled
       23k leads onto a handful of days and told you nothing. The date column
       in each sheet is now honoured, so a master row dates the day the
       lead was actually found and belongs here — that is the bulk of the
       real sourcing work.

       Still excluded: source='crm', which is the Instantly sync discovering a
       replier who was never in our list. Nobody found those, and their
       created_at is the sync time, not a find date.

       Attribution: created_by when a teammate added it through the app,
       otherwise lead_owner — master rows have no created_by. */

  if (path === '/api/activity' && method === 'GET') {
    await requireUser(env, request); // visible to everyone
    const p = url.searchParams;
    const { from, to, startIso, endIso } = istRange(p.get('from'), p.get('to'));
    let sql = "SELECT created_at, email_norm, created_by, lead_owner FROM entries WHERE source IN ('added','master')";
    const args = [];
    if (startIso) { sql += ' AND created_at >= ?'; args.push(startIso); }
    if (endIso) { sql += ' AND created_at <= ?'; args.push(endIso); }
    const [{ results }, usersRes] = await Promise.all([
      env.DB.prepare(sql).bind(...args).all(),
      env.DB.prepare('SELECT username, display_name FROM users').all(),
    ]);
    // Map the stored adder (username) to a friendly display name.
    const disp = {};
    for (const u of usersRes.results) disp[u.username] = u.display_name || u.username;

    let totLeads = 0, totEmail = 0;
    const members = new Set();
    const byDay = {};          // day -> { leads, with_email }
    const byMemberDay = {};    // "day|who" -> { day, owner, leads, with_email }
    for (const r of results) {
      const d = istDay(r.created_at);
      const has = r.email_norm ? 1 : 0;
      const who = disp[r.created_by] || r.created_by || r.lead_owner || '(unknown)';
      members.add(who);
      totLeads++; totEmail += has;
      (byDay[d] = byDay[d] || { leads: 0, with_email: 0 }).leads++;
      byDay[d].with_email += has;
      const k = d + '|' + who;
      (byMemberDay[k] = byMemberDay[k] || { day: d, owner: who, leads: 0, with_email: 0 }).leads++;
      byMemberDay[k].with_email += has;
    }
    const days = Object.keys(byDay).sort().reverse();
    return json({
      from, to,
      totals: { leads: totLeads, with_email: totEmail, without_email: totLeads - totEmail },
      members: [...members].sort((a, b) => a.localeCompare(b)),
      by_day: days.map(d => ({ day: d, leads: byDay[d].leads, with_email: byDay[d].with_email })),
      by_member_day: Object.values(byMemberDay),
    });
  }

  /* — live check (no insert): powers the form's as-you-type preview — */

  // Read-only batch lookup against OUR lead database (the `entries` table).
  // Keyed with LOOKUP_KEY (same key the CRM uses) so other tools — e.g. the
  // comment-scraper — can dedup against leads already in this database. Falls
  // back to a logged-in session for manual browser testing. Mirrors the CRM's
  // POST /api/lookup shape, but reports `in_db` (present in our lead database).
  if (path === '/api/lookup' && method === 'POST') {
    const lk = request.headers.get('x-lookup-key') || '';
    const authed = env.LOOKUP_KEY && lk === env.LOOKUP_KEY;
    if (!authed) await requireUser(env, request);

    const emails = Array.isArray(body.emails)
      ? [...new Set(body.emails.map(e => normEmail(e)).filter(Boolean))] : [];
    const handles = Array.isArray(body.handles)
      ? [...new Set(body.handles.map(h => normHandle(h)).filter(Boolean))] : [];
    if (emails.length > 1000 || handles.length > 1000) throw new ApiError(400, 'Max 1000 identifiers per call');

    const CHUNK = 90; // D1 caps bound parameters per query near 100
    const results = [];

    const byHandle = {};
    for (let i = 0; i < handles.length; i += CHUNK) {
      const part = handles.slice(i, i + CHUNK);
      const { results: rows } = await env.DB.prepare(
        `SELECT handle_norm, email, lead_owner, created_by, created_at, source, id
         FROM entries WHERE handle_norm IN (${part.map(() => '?').join(',')})`).bind(...part).all();
      for (const r of rows) byHandle[r.handle_norm] = r;
    }
    for (const h of handles) {
      const r = byHandle[h];
      results.push(r
        ? { query: h, type: 'handle', in_db: true, owner: r.lead_owner || '', created_by: r.created_by || '',
            source: r.source || 'added', email: r.email || '', created_at: r.created_at || '', id: r.id }
        : { query: h, type: 'handle', in_db: false });
    }

    const byEmail = {};
    for (let i = 0; i < emails.length; i += CHUNK) {
      const part = emails.slice(i, i + CHUNK);
      const { results: rows } = await env.DB.prepare(
        `SELECT handle_norm, email_norm, lead_owner, created_by, created_at, source, id
         FROM entries WHERE email_norm IN (${part.map(() => '?').join(',')})`).bind(...part).all();
      for (const r of rows) if (!byEmail[r.email_norm]) byEmail[r.email_norm] = r;
    }
    for (const e of emails) {
      const r = byEmail[e];
      results.push(r
        ? { query: e, type: 'email', in_db: true, owner: r.lead_owner || '', created_by: r.created_by || '',
            source: r.source || 'added', handle: r.handle_norm || '', created_at: r.created_at || '', id: r.id }
        : { query: e, type: 'email', in_db: false });
    }
    return json({ results });
  }

  if (path === '/api/check' && method === 'POST') {
    await requireUser(env, request);
    return json(await checkLead(env, body));
  }

  /* — add a lead (atomic dedup on the normalised handle) — */

  if (path === '/api/entries' && method === 'POST') {
    const user = await requireUser(env, request);
    const handle = normHandle(body.social_url || body.handle || '');
    if (!handle) throw new ApiError(400, 'Enter a valid Instagram profile link or handle');
    const email = normEmail(body.email);
    const emailRaw = (body.email || '').trim();
    const firstName = (body.first_name || '').trim();
    const notes = (body.notes || '').trim();
    const category = (body.category || '').trim();

    // Duplicate-by-username: already in the leads DB (teammate-added OR master)?
    const existing = await env.DB.prepare('SELECT * FROM entries WHERE handle_norm=?').bind(handle).first();

    if (existing) {
      return json({
        saved: false,
        duplicate: { handle, owner: existing.lead_owner, created_by: existing.created_by,
                     created_at: existing.created_at, email: existing.email, id: existing.id,
                     source: existing.source || 'added' },
        in_master: existing.source === 'master',
        crm: await localCrm(env, email, handle),
      });
    }

    // Duplicate-by-email: the same email is already a lead (possibly under a
    // different handle). Treat as existing instead of double-storing the person.
    if (email) {
      const byEmail = await env.DB.prepare('SELECT * FROM entries WHERE email_norm=? ORDER BY id LIMIT 1').bind(email).first();
      if (byEmail) {
        return json({
          saved: false,
          duplicate: { handle: byEmail.handle_norm || handle, owner: byEmail.lead_owner, created_by: byEmail.created_by,
                       created_at: byEmail.created_at, email: byEmail.email, id: byEmail.id,
                       source: byEmail.source || 'added', matched_on: 'email' },
          in_master: byEmail.source === 'master',
          crm: await localCrm(env, email, handle),
        });
      }
    }

    // Prior-conversation snapshot from the LOCAL merged conversations (retired the
    // external CRM lookup — never blocks the save).
    const local = await localCrm(env, email, handle);
    const sig = local.signal;
    const crmResults = local.results;
    const snap = crmSnapshot(sig);
    const created = nowIso();
    const manager = (await managerResolver(env))(ownerName(user));
    // Initial pipeline placement: a fresh lead is in "Leads"; if the CRM already
    // shows a reply/status, pre-fill the stage + position (still fully editable).
    const sug = crmSuggest(snap.crm_status, snap.crm_label);
    const initStage = sug ? sug.stage : (snap.crm_replied ? 'Responses' : 'Leads');
    const initPos = sug ? sug.position : '';

    // Atomic insert. If a concurrent add won the race, changes===0 → report it
    // as a duplicate instead of double-storing.
    const res = await env.DB.prepare(
      `INSERT INTO entries
        (handle_norm, handle_raw, social_url, email, email_norm, first_name, notes, category, lead_owner, lead_manager, created_by, created_at, source, in_master, stage, position,
         crm_known, crm_contacted, crm_replied, crm_status, crm_poc, crm_campaigns,
         crm_last_contact_at, crm_last_reply_at, crm_checked_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'added',0,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(handle_norm) DO NOTHING`)
      .bind(handle, (body.social_url || body.handle || '').trim(), canonicalUrl(handle),
            emailRaw, email, firstName, notes, category, ownerName(user), manager, user.username, created, initStage, initPos,
            snap.crm_known, snap.crm_contacted, snap.crm_replied, snap.crm_status, snap.crm_poc,
            snap.crm_campaigns, snap.crm_last_contact_at, snap.crm_last_reply_at, snap.crm_checked_at)
      .run();

    if (!res.meta.changes) {
      const other = await env.DB.prepare('SELECT * FROM entries WHERE handle_norm=?').bind(handle).first();
      return json({
        saved: false,
        duplicate: other ? { handle, owner: other.lead_owner, created_by: other.created_by,
                             created_at: other.created_at, email: other.email, id: other.id,
                             source: other.source || 'added' } : { handle },
        in_master: other ? other.source === 'master' : false,
        crm: { results: crmResults, signal: sig, error: crmError(crmResults) },
      });
    }

    await bumpVersion(env);
    // Best-effort Instagram enrichment for the lead just added (2 HikerAPI
    // calls). Deliberately swallowed on failure — a missing follower count must
    // never cost someone the save.
    try {
      const fresh = await env.DB.prepare('SELECT id, handle_norm, ig_user_id FROM entries WHERE handle_norm=?').bind(handle).first();
      if (fresh) await enrichRows(env, [fresh]);
    } catch (e) { console.log('ig enrich on add failed:', e && e.message); }
    const row = await env.DB.prepare('SELECT * FROM entries WHERE handle_norm=?').bind(handle).first();
    return json({
      saved: true,
      entry: entryDict(row, env.CRM_URL || ''),
      in_master: false,
      crm: { results: crmResults, signal: sig, error: crmError(crmResults) },
    });
  }

  /* — bulk add (paste / CSV): same dedup + CRM check, per-row results — */

  if (path === '/api/entries/bulk' && method === 'POST') {
    const user = await requireUser(env, request);
    return json(await bulkAdd(env, user, Array.isArray(body.rows) ? body.rows : []));
  }

  /* — list entries — */

  if (path === '/api/entries' && method === 'GET') {
    await requireUser(env, request);
    const p = url.searchParams;
    let sql = 'SELECT * FROM entries WHERE 1=1';
    const args = [];
    const owner = p.get('owner') || '';
    if (owner) { sql += ' AND lead_owner = ?'; args.push(owner); }
    const cat = p.get('category') || '';
    if (cat) { sql += ' AND category = ?'; args.push(cat); }
    const stg = p.get('stage') || '';
    if (stg) { sql += ' AND stage = ?'; args.push(stg); }
    if (stg === 'Leads') sql += " AND email_norm != ''";
    // Pipeline position filter — matches the node itself AND everything nested under it.
    // `__unset` = leads with no position (e.g. Closed/Failed leads missing a
    // delivery status / reason).
    const pos = p.get('position') || '';
    if (pos === '__unset') sql += " AND COALESCE(position, '') = ''";
    else if (pos) { sql += ' AND (position = ? OR position LIKE ?)'; args.push(pos, pos + '/%'); }
    // Effective Status/Label = manual pick (stage_data) if set, else the CRM
    // value. json_valid guards legacy rows whose stage_data is '' (not JSON).
    const effSD = f => `COALESCE(NULLIF(json_extract(CASE WHEN json_valid(stage_data) THEN stage_data ELSE '{}' END,'$.${f}'),''), crm_${f})`;
    const stf = p.get('status') || '';
    if (stf) { sql += ` AND ${effSD('status')} = ?`; args.push(stf); }
    const lbf = p.get('label') || '';
    // Two computed pseudo-labels folded into the Label dropdown (replacing the
    // old signal filter); everything else is a real label match.
    if (lbf === '__contacted') sql += " AND email_norm != '' AND crm_replied = 0";
    else if (lbf === '__no_email') sql += " AND email_norm = ''";
    else if (lbf) { sql += ` AND ${effSD('label')} = ?`; args.push(lbf); }
    // Tab views map straight onto the Stage bucket (Leads / Responses / Closed / Failed).
    const TAB_STAGE = { leads: 'Leads', responses: 'Responses', closed: 'Closed', failed: 'Failed' };
    const tab = p.get('tab') || '';
    if (TAB_STAGE[tab]) { sql += ' AND stage = ?'; args.push(TAB_STAGE[tab]); }
    const q = (p.get('q') || '').trim();
    if (q) {
      sql += ' AND (handle_norm GLOB ? OR email_norm GLOB ? OR first_name GLOB ?)';
      const g = globCI(q);
      args.push(g, g, g);
    }
    // Link-in-bio platform filter ("show me everyone on stan.store").
    // Matches the stored host exactly, so it uses the index rather than a LIKE scan.
    const linkDom = (p.get('link_domain') || '').trim().toLowerCase();
    if (linkDom === '__none__') sql += " AND ig_link_domain = ''";
    else if (linkDom === '__any__') sql += " AND ig_link_domain != ''";
    else if (linkDom) { sql += ' AND ig_link_domain = ?'; args.push(linkDom); }
    // Lead manager filter. '__none__' finds leads with nobody accountable —
    // which is the useful query, since an owner who is not a CRM user gets none.
    const mgr = (p.get('manager') || '').trim();
    if (mgr === '__none__') sql += " AND lead_manager = ''";
    else if (mgr) { sql += ' AND lead_manager = ?'; args.push(mgr); }
    /* Bio keyword search. Split on commas and whitespace; ANY matches a bio
       containing at least one word, ALL requires every one. Wildcards in the
       user's own text match literally — a stray * or ? must not turn into a
       wildcard. See globCI. */
    const bioRaw = (p.get('bio') || '').trim();
    if (bioRaw) {
      const words = bioRaw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 10);
      if (words.length) {
        const joiner = (p.get('bio_mode') || 'any').toLowerCase() === 'all' ? ' AND ' : ' OR ';
        sql += ' AND (' + words.map(() => 'ig_bio GLOB ?').join(joiner) + ')';
        for (const word of words) args.push(globCI(word));
      }
    }
    /* Demonstrably active: posted in the last 30 days. A blank date fails this
       comparison, which is intended — 2,893 leads are private, gone, or have
       no posts, and none of those can be shown to be active. */
    if ((p.get('active30') || '') === '1') sql += " AND ig_last_post_at >= date('now','-30 day')";
    const signal = p.get('signal') || '';
    if (signal === 'prior') sql += ' AND crm_replied = 1';
    else if (signal === 'contacted') sql += " AND email_norm != '' AND crm_replied = 0";
    else if (signal === 'master') sql += " AND source = 'master'";
    else if (signal === 'added') sql += " AND source = 'added'";
    else if (signal === 'new') sql += " AND source = 'added' AND crm_contacted = 0";
    else if (signal === 'no_email') sql += " AND email_norm = ''";
    const { startIso, endIso } = istRange(p.get('from'), p.get('to'));
    if (startIso) { sql += ' AND created_at >= ?'; args.push(startIso); }
    if (endIso) { sql += ' AND created_at <= ?'; args.push(endIso); }
    // Capture the WHERE-only query (before ORDER BY / LIMIT) so we can count the
    // exact number of rows matching the CURRENT filter — the denominator the UI
    // shows must reflect the filter, not the whole table.
    const countSql = sql.replace('SELECT * FROM entries', 'SELECT COUNT(*) n FROM entries');
    // Surface data-rich leads (with a real first name) first, so the blank
    // handle+email-only imports don't dominate the top of the list.
    sql += " ORDER BY (first_name != '') DESC, created_at DESC, id DESC";
    // The client loads the full filtered set into the grid, so allow a large
    // page. Still bounded so a pathological caller can't ask for unbounded rows.
    const limit = Math.min(parseInt(p.get('limit') || '1000', 10) || 1000, 100000);
    sql += ' LIMIT ' + limit;
    const [{ results }, ownersRes, statusRes, labelRes, totalRes, filteredRes] = await Promise.all([
      env.DB.prepare(sql).bind(...args).all(),
      env.DB.prepare("SELECT DISTINCT lead_owner FROM entries WHERE lead_owner != '' ORDER BY lead_owner").all(),
      // Status dropdown = the editable statuses vocabulary ({key,label}).
      env.DB.prepare('SELECT key, label FROM statuses ORDER BY sort, label').all(),
      // Label dropdown = the editable crm_labels vocabulary (seeded from the
      // values in use; managed via the Unibox). Kept as a tiny indexed read so
      // /api/entries doesn't full-scan entries on every load.
      env.DB.prepare('SELECT name FROM crm_labels ORDER BY sort, name').all(),
      env.DB.prepare('SELECT COUNT(*) n FROM entries').first(),
      env.DB.prepare(countSql).bind(...args).first(),
    ]);
    const crmUrl = env.CRM_URL || '';
    // Handles that have posted for us, so the grid can badge them.
    const { results: pv } = await env.DB.prepare("SELECT DISTINCT handle FROM videos WHERE handle != ''").all();
    const partners = new Set(pv.map(r => r.handle));
    return json({
      entries: results.map(r => ({ ...entryDict(r, crmUrl), partner: partners.has(r.handle_norm) })),
      owners: ownersRes.results.map(o => o.lead_owner),
      // {key,label} pairs — the grid shows label, filters/saves by key.
      statuses: statusRes.results.map(o => ({ key: o.key, label: o.label })),
      labels: labelRes.results.map(o => o.name),
      version: parseInt(await metaGet(env, 'version', '0'), 10),
      total: results.length,
      grand_total: totalRes ? totalRes.n : results.length,
      // Exact count matching the current filter (drives the "X of N" header).
      filtered_total: filteredRes ? filteredRes.n : results.length,
    });
  }

  /* Extension auth: prefer the caller's own CRM session, fall back to the
     shared key. Teammates with an account get attributed access and nothing to
     paste; the key stays for anyone not logged in on that browser. */
  const extAuth = async () => {
    const u = await getUser(env, request);
    if (u) return u;
    const want = (env.EXT_KEY || '').trim();
    if (want && (request.headers.get('x-ext-key') || '') === want) return null;   // key-only caller
    throw new ApiError(401, 'Log in to the CRM in this browser, or set the team key in the extension');
  };

  /* — Chrome extension: set a lead's email —
       The one write the extension can do. Same shared-key auth as the lookup.
       Refuses to clobber an email that is already there, and refuses an address
       already used by a different lead, because the app dedupes on email and a
       duplicate would create two records for one person. */
  if (path === '/api/ext/set-email' && method === 'POST') {
    await extAuth();
    const handle = normHandle(body.handle || '');
    const email = normEmail(body.email || '');
    if (!handle) throw new ApiError(400, 'handle required');
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) throw new ApiError(400, 'That does not look like an email address');
    const row = await env.DB.prepare('SELECT id, email_norm FROM entries WHERE handle_norm=?').bind(handle).first();
    if (!row) throw new ApiError(404, '@' + handle + ' is not in the CRM');
    if (row.email_norm) throw new ApiError(409, 'That lead already has an email (' + row.email_norm + ')');
    const clash = await env.DB.prepare('SELECT handle_norm FROM entries WHERE email_norm=? AND id!=?').bind(email, row.id).first();
    if (clash) throw new ApiError(409, 'That email already belongs to @' + clash.handle_norm);
    await env.DB.prepare('UPDATE entries SET email=?, email_norm=? WHERE id=?').bind(email, email, row.id).run();
    await bumpVersion(env);
    return json({ ok: true, handle, email });
  }

  /* Videos a handle has posted for us, newest first. Drives the extension's
     partner banner, and is cheap enough to run on every profile view because
     of idx_videos_handle. */
  const videosFor = async handle => {
    if (!handle) return [];
    const { results } = await env.DB.prepare(
      "SELECT url, date_posted, views, comments, likes, post_type, post_status FROM videos"
      + " WHERE handle = ? ORDER BY (date_posted != '') DESC, date_posted DESC, id DESC LIMIT 25")
      .bind(handle).all();
    return results;
  };

  /* — Chrome extension lookup —
       Deliberately NOT cookie-authenticated: the app session is SameSite=Lax, so
       the browser will never send it on a request originating from instagram.com,
       and loosening that would drop the CSRF protection for the whole CRM. A
       shared header key instead, mirroring the CRM's own /api/lookup.
       No CORS headers on purpose either — the extension fetches from its
       background service worker (exempt from CORS via host_permissions), so
       adding Access-Control-Allow-Origin would only widen who can read lead PII
       if the key ever leaked. */
  if (path === '/api/ext/lead' && method === 'GET') {
    await extAuth();
    const handle = normHandle(url.searchParams.get('handle') || '');
    if (!handle) throw new ApiError(400, 'handle required');
    const row = await env.DB.prepare('SELECT * FROM entries WHERE handle_norm=?').bind(handle).first();
    const vids = await videosFor(handle);
    // Someone can have posted for us without ever being a lead row, so the
    // partner block is returned either way.
    if (!row) return json({ found: false, handle, videos: vids });
    const e = entryDict(row, env.CRM_URL || '');
    // Breadcrumb: walk pipeline_nodes up from the lead's position. The table is
    // tiny, so one read and an in-memory walk beats a query per level.
    let crumb = [];
    if (row.position) {
      const { results: nodes } = await env.DB.prepare('SELECT key, parent, label FROM pipeline_nodes').all();
      const byKey = Object.fromEntries(nodes.map(n => [n.key, n]));
      let cur = byKey[row.position], guard = 0;
      while (cur && guard++ < 12) { crumb.unshift(cur.label); cur = cur.parent ? byKey[cur.parent] : null; }
    }
    /* contacted/replied on the entry are a SNAPSHOT, only refreshed when a human
       clicks Refresh CRM — and it is badly stale: 51k outbound emails on record
       but crm_contacted=1 for only the 4.6k who replied, so the panel would tell
       you "Never Contacted" about people you have mailed repeatedly. Derive it
       live from the mail we actually hold, across the entry's own address AND
       any address on a conversation linked to this handle (leads often reply
       from a different address than the one on the record). */
    const addrs = [...new Set([
      (row.email_norm || '').toLowerCase(),
      ...(await env.DB.prepare("SELECT email FROM conversations WHERE handle_norm=? OR (? != '' AND email=?)")
        .bind(handle, row.email_norm || '', row.email_norm || '').all()).results.map(c => (c.email || '').toLowerCase()),
    ].filter(Boolean))];
    let sentAt = '', gotAt = '';
    if (addrs.length) {
      const ph = addrs.map(() => '?').join(',');
      const m = await env.DB.prepare(
        `SELECT MAX(CASE WHEN ue_type IN (1,3) THEN timestamp_email END) AS sent,
                MAX(CASE WHEN ue_type = 2 THEN timestamp_email END) AS got
           FROM emails WHERE lead_email IN (${ph})`).bind(...addrs).first();
      sentAt = (m && m.sent) || ''; gotAt = (m && m.got) || '';
    }
    // Fall back to the snapshot only where we hold no mail of our own.
    const contacted = !!sentAt || !!(e.crm && e.crm.contacted);
    const replied = !!gotAt || !!(e.crm && e.crm.replied);
    return json({
      found: true, handle, id: row.id,
      stage: e.stage, breadcrumb: crumb, position: row.position || '',
      status: e.status || '', label: e.label || '',
      first_name: e.first_name || '', email: e.email || '', category: e.category || '',
      lead_owner: e.lead_owner || '', lead_manager: e.lead_manager || '', poc: (e.crm && e.crm.poc) || '',
      contacted, replied,
      last_contact_at: sentAt || (e.crm && e.crm.last_contact_at) || '',
      last_reply_at: gotAt || (e.crm && e.crm.last_reply_at) || '',
      campaigns: (e.crm && e.crm.campaigns) || [],
      created_at: row.created_at || '', source: row.source || '',
      videos: vids,
      ig: {
        followers: e.ig_followers, last_post_at: e.ig_last_post_at,
        avg_views_10: e.ig_avg_views_10, link: e.ig_link, checked_at: e.ig_checked_at,
      },
    });
  }

  // Distinct link-in-bio hosts with counts — populates the filter dropdown so
  // you pick a platform instead of guessing what to type.
  if (path === '/api/entries/ig-domains' && method === 'GET') {
    await requireUser(env, request);
    const { results } = await env.DB.prepare(
      `SELECT ig_link_domain AS domain, COUNT(*) AS n FROM entries
        WHERE ig_link_domain != '' GROUP BY ig_link_domain ORDER BY n DESC, domain LIMIT 60`).all();
    const totals = await env.DB.prepare(
      `SELECT SUM(CASE WHEN ig_link_domain != '' THEN 1 ELSE 0 END) AS with_link,
              SUM(CASE WHEN ig_checked_at != '' AND ig_link_domain = '' THEN 1 ELSE 0 END) AS without_link
         FROM entries`).first();
    return json({
      domains: results.map(r => ({ domain: r.domain, n: r.n })),
      with_link: totals ? (totals.with_link || 0) : 0,
      without_link: totals ? (totals.without_link || 0) : 0,
    });
  }

  /* — Instagram enrichment (HikerAPI) —
       Two calls per lead, so every path here is explicitly bounded and only
       ever runs when a human asks for it. There is no background refresh. */

  // Refresh an explicit set of leads (the grid's "IG data" action).
  if (path === '/api/entries/ig-refresh' && method === 'POST') {
    await requireUser(env, request);
    const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map(Number).filter(Boolean);
    if (!ids.length) throw new ApiError(400, 'No leads given');
    if (ids.length > IG_STEP_LEADS) throw new ApiError(400, `At most ${IG_STEP_LEADS} leads per request`);
    const qs = ids.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT id, handle_norm, ig_user_id FROM entries WHERE id IN (${qs})`).bind(...ids).all();
    if (!results.length) return json({ done: 0, entries: [] });
    const outcomes = await enrichRows(env, results);
    await bumpVersion(env);
    const { results: rows } = await env.DB.prepare(
      `SELECT * FROM entries WHERE id IN (${qs})`).bind(...ids).all();
    const crmUrl = env.CRM_URL || '';
    return json({ done: outcomes.length, outcomes, entries: rows.map(r => entryDict(r, crmUrl)) });
  }

  // One bounded step of the never-enriched backlog. The client polls this so
  // the spend is visible and stoppable rather than hidden in a cron.
  if (path === '/api/entries/ig-backfill' && method === 'POST') {
    const user = await requireUser(env, request);
    if (!user.is_admin) throw new ApiError(403, 'Admins only');
    // 'engaged' = leads actually in play; 'all' = the whole table.
    const engagedOnly = (body.scope || 'engaged') !== 'all';
    const where = `ig_checked_at = ''` + (engagedOnly ? ` AND stage IN ('Responses','Closed')` : '');
    const remainingOf = async () => (await env.DB.prepare(
      `SELECT COUNT(*) c FROM entries WHERE ${where}`).first()).c || 0;
    const before = await remainingOf();
    if (!before) return json({ done: 0, remaining: 0, finished: true });
    const { results } = await env.DB.prepare(
      `SELECT id, handle_norm, ig_user_id FROM entries WHERE ${where} ORDER BY id LIMIT ?`)
      .bind(IG_STEP_LEADS).all();
    const outcomes = await enrichRows(env, results);
    await bumpVersion(env);
    const remaining = await remainingOf();
    return json({ done: outcomes.length, outcomes, remaining, finished: remaining === 0, scope: engagedOnly ? 'engaged' : 'all' });
  }

  // How much backlog is left, for the confirm dialog's call estimate.
  if (path === '/api/entries/ig-status' && method === 'GET') {
    await requireUser(env, request);
    const row = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM entries WHERE ig_checked_at = '' AND stage IN ('Responses','Closed')) AS engaged_pending,
         (SELECT COUNT(*) FROM entries WHERE ig_checked_at = '') AS all_pending,
         (SELECT COUNT(*) FROM entries WHERE ig_status = 'ok') AS enriched`).first();
    return json({
      engaged_pending: row ? row.engaged_pending : 0,
      all_pending: row ? row.all_pending : 0,
      enriched: row ? row.enriched : 0,
      per_lead_calls: 2, step: IG_STEP_LEADS,
      key_set: !!(env.HIKER_API_KEY || '').trim(),
    });
  }

  /* — delete an entry (owner or admin) — */

  if (path === '/api/entries' && method === 'DELETE') {
    const user = await requireUser(env, request);
    const id = parseInt(body.id, 10);
    if (!id) throw new ApiError(400, 'id required');
    const row = await env.DB.prepare('SELECT * FROM entries WHERE id=?').bind(id).first();
    if (!row) throw new ApiError(404, 'Entry not found');
    if (!user.is_admin && row.created_by !== user.username) {
      throw new ApiError(403, 'You can only delete your own entries');
    }
    await env.DB.prepare('DELETE FROM entries WHERE id=?').bind(id).run();
    await bumpVersion(env);
    return json({ ok: true });
  }

  /* — refresh CRM snapshots — paged, so it can cover the whole DB (~21k)
       across many small requests driven by the client (avoids per-request limits). —*/

  if (path === '/api/entries/refresh-crm' && method === 'POST') {
    await requireUser(env, request);

    const afterId = parseInt(body.after_id, 10) || 0;
    const batch = Math.min(parseInt(body.batch, 10) || 1000, 3000);
    const total = (await env.DB.prepare('SELECT COUNT(*) n FROM entries').first()).n;

    // One page of leads, ordered by id (stable cursor).
    const { results: rows } = await env.DB.prepare(
      'SELECT id, email_norm, handle_norm, position_source FROM entries WHERE id > ? ORDER BY id LIMIT ?')
      .bind(afterId, batch).all();
    if (!rows.length) return json({ ok: true, processed: 0, updated: 0, after_id: afterId, total, done: true });

    // Batch the CRM lookups in small chunks — the CRM resolves emails via a
    // `email IN (…)` query and D1 caps bound parameters per query, so keep each
    // call well under that limit.
    // Re-derive each lead's prior-conversation signal from the LOCAL merged
    // conversations (retired the external CRM). Batched by email + handle.
    const CHUNK = 90; // D1 caps bound parameters per query near 100
    const emails = [...new Set(rows.map(r => r.email_norm).filter(Boolean))];
    const handles = [...new Set(rows.map(r => r.handle_norm).filter(Boolean))];
    const groupsByEmail = {}, groupsByHandle = {};
    for (let i = 0; i < emails.length; i += CHUNK) {
      const chunk = emails.slice(i, i + CHUNK);
      const { results } = await env.DB.prepare(
        `SELECT email, handle_norm, ${CONV_SIG_COLS} FROM conversations WHERE email IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
      for (const r of results) if (r.email) (groupsByEmail[r.email] = groupsByEmail[r.email] || []).push(r);
    }
    for (let i = 0; i < handles.length; i += CHUNK) {
      const chunk = handles.slice(i, i + CHUNK);
      const { results } = await env.DB.prepare(
        `SELECT email, handle_norm, ${CONV_SIG_COLS} FROM conversations WHERE handle_norm IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
      for (const r of results) if (r.handle_norm) (groupsByHandle[r.handle_norm] = groupsByHandle[r.handle_norm] || []).push(r);
    }
    const byEmail = {}, byHandle = {};
    for (const em of emails) { const s = sigFromConvRows(groupsByEmail[em], em); if (s) byEmail[em] = s; }
    for (const h of handles) { const s = sigFromConvRows(groupsByHandle[h], h); if (s) byHandle[h] = s; }

    /* A `conversations` row only exists once a lead REPLIES, so everyone we
       emailed who never answered produced no signal above and was written back
       as "never contacted" — 8,594 leads, against 51k outbound emails on record.
       The single-lead path (localCrm) already falls back to the emails table;
       this bulk path never did. Same fallback, batched. */
    const sentByEmail = {};
    for (let i = 0; i < emails.length; i += CHUNK) {
      const chunk = emails.slice(i, i + CHUNK);
      const { results } = await env.DB.prepare(
        `SELECT lead_email, MAX(timestamp_email) AS last_sent FROM emails
          WHERE lead_email IN (${chunk.map(() => '?').join(',')}) AND ue_type IN (1,3)
          GROUP BY lead_email`).bind(...chunk).all();
      for (const r of results) if (r.lead_email) sentByEmail[r.lead_email] = r.last_sent || '';
    }

    let updated = 0;
    const stmts = [];
    for (const row of rows) {
      let sig = (row.email_norm && byEmail[row.email_norm] && byEmail[row.email_norm].known)
        ? byEmail[row.email_norm]
        : (row.handle_norm && byHandle[row.handle_norm] && byHandle[row.handle_norm].known)
          ? byHandle[row.handle_norm]
          : (byEmail[row.email_norm] || byHandle[row.handle_norm] || null);
      // Contacted, never replied. Deliberately leaves status/label/campaigns
      // empty and replied=0, so the stage logic below does NOT move the lead.
      if ((!sig || !sig.known) && row.email_norm && sentByEmail[row.email_norm] !== undefined) {
        sig = {
          type: 'local', query: row.email_norm, known: true, contacted: true, replied: false,
          status: '', poc: '', label: '', first_name: '', campaigns: [],
          last_contact_at: sentByEmail[row.email_norm] || '', last_reply_at: '',
        };
      }
      const s = crmSnapshot(sig);
      if (sig && sig.known) updated++;
      // Keep CRM-derived leads in SYNC with the CRM: for leads the team hasn't
      // manually moved (position_source != 'manual'), re-derive Stage + position
      // from the current CRM status every sync. Manual classifications are frozen.
      const manual = row.position_source === 'manual';
      let setStage = 0, autoStage = '', setPos = 0, autoPos = '';
      if (!manual && sig && sig.known) {
        const sug = crmSuggest(s.crm_status, s.crm_label);
        if (sug) { setStage = 1; autoStage = sug.stage; setPos = 1; autoPos = sug.position; }
        else if (s.crm_replied) { setStage = 1; autoStage = 'Responses'; } // reply, no status detail → Responses bucket
      }
      // NOTE: crm_deal is deliberately NOT written here — the local signal carries
      // no rate data (that lives in conversations and is maintained by the sync's
      // syncEntriesFromConversations). Writing it would blank the grid deal columns.
      stmts.push(env.DB.prepare(
        `UPDATE entries SET crm_known=?, crm_contacted=?, crm_replied=?, crm_status=?, crm_poc=?,
           crm_campaigns=?, crm_last_contact_at=?, crm_last_reply_at=?, crm_checked_at=?,
           crm_label=?,
           stage=CASE WHEN ?=1 THEN ? ELSE stage END,
           position=CASE WHEN ?=1 THEN ? ELSE position END,
           first_name=CASE WHEN first_name='' THEN ? ELSE first_name END WHERE id=?`)
        .bind(s.crm_known, s.crm_contacted, s.crm_replied, s.crm_status, s.crm_poc,
              s.crm_campaigns, s.crm_last_contact_at, s.crm_last_reply_at, s.crm_checked_at,
              s.crm_label, setStage, autoStage, setPos, autoPos, s.crm_first_name, row.id));
    }
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    await bumpVersion(env);

    const lastId = rows[rows.length - 1].id;
    return json({ ok: true, processed: rows.length, matched: updated, after_id: lastId, total, done: rows.length < batch });
  }

  /* — master list upload (re-uploadable) — */

  if (path === '/api/master/stats' && method === 'GET') {
    await requireUser(env, request);
    const c = await env.DB.prepare("SELECT COUNT(*) n FROM entries WHERE source='master'").first();
    return json({ count: c ? c.n : 0, last_upload: await metaGet(env, 'master_last_upload', '') });
  }

  // Master upload → imports rows as source='master' leads directly into the
  // unified list. Auto-detected columns: handle/url, email, first_name/name,
  // category, notes, lead owner. Existing teammate-added leads are never
  // overwritten; existing master rows are refreshed with any new non-empty data.
  if (path === '/api/master/upload' && method === 'POST') {
    const user = await requireUser(env, request);
    if (!user.is_admin) throw new ApiError(403, 'Only admins can upload the master list');
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) throw new ApiError(400, 'No rows to import');
    const mode = body.mode === 'replace' ? 'replace' : 'merge';

    const seen = new Map();
    let skipped = 0;
    for (const r of rows) {
      const raw = typeof r === 'string' ? r : (r.handle || r.url || r.username || r.value || '');
      const handle = normHandle(raw);
      if (!handle) { skipped++; continue; }
      const socialUrl = /instagram\.com/i.test(String(raw)) ? String(raw).trim() : canonicalUrl(handle);
      const rec = {
        handle, raw: String(raw).trim(), socialUrl,
        email: normEmail(typeof r === 'object' ? (r.email || '') : ''),
        firstName: String((typeof r === 'object' && (r.first_name || r.name)) || '').trim(),
        category: String((typeof r === 'object' && r.category) || '').trim(),
        notes: String((typeof r === 'object' && r.notes) || '').trim(),
        owner: String((typeof r === 'object' && (r.lead_owner || r.owner)) || '').trim(),
        // The sheet's own "date found" column, already normalised to
        // YYYY-MM-DD by the parser. Blank when the sheet has no date.
        date: String((typeof r === 'object' && r.date) || '').trim(),
      };
      if (!seen.has(handle)) seen.set(handle, rec);
    }
    const uniq = [...seen.values()];
    if (!uniq.length) throw new ApiError(400, 'No valid Instagram handles found in the upload');

    const added = nowIso();
    /* created_at is the day the lead was FOUND, which the sheet knows and we
       do not — stamping the upload time is what collapsed 15,000 leads onto
       the import date. Noon IST keeps the day stable when rendered in IST. */
    const stampOf = d => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d + 'T06:30:00.000Z' : added);
    // Manager defaults to the owner, but ONLY when that owner is a CRM user.
    // Sheets carry bare first names while a user may be stored in full
    // ("Aditya" vs "Aditya Ray"), so match exact first, then on first name.
    const managerFor = await managerResolver(env);
    const stmts = [];
    if (mode === 'replace') stmts.push(env.DB.prepare("DELETE FROM entries WHERE source='master'"));
    for (const u of uniq) {
      stmts.push(env.DB.prepare(
        `INSERT INTO entries
           (handle_norm, handle_raw, social_url, email, email_norm, first_name, notes, category, lead_owner, lead_manager, created_by, created_at, source, in_master, crm_campaigns)
         VALUES (?,?,?,?,?,?,?,?,?,?,'',?, 'master',1,'[]')
         ON CONFLICT(handle_norm) DO UPDATE SET
           email      = CASE WHEN entries.source='master' AND excluded.email!=''     THEN excluded.email      ELSE entries.email END,
           email_norm = CASE WHEN entries.source='master' AND excluded.email_norm!='' THEN excluded.email_norm ELSE entries.email_norm END,
           first_name = CASE WHEN entries.source='master' AND excluded.first_name!='' THEN excluded.first_name ELSE entries.first_name END,
           notes      = CASE WHEN entries.source='master' AND excluded.notes!=''      THEN excluded.notes      ELSE entries.notes END,
           category   = CASE WHEN entries.source='master' AND excluded.category!=''   THEN excluded.category   ELSE entries.category END,
           lead_owner = CASE WHEN entries.source='master' AND excluded.lead_owner!='' THEN excluded.lead_owner ELSE entries.lead_owner END,
           lead_manager = CASE WHEN entries.source='master' AND excluded.lead_manager!='' THEN excluded.lead_manager ELSE entries.lead_manager END,
           social_url = CASE WHEN entries.source='master' THEN excluded.social_url ELSE entries.social_url END,
           -- Two sheets can date the same lead differently (one records when it
           -- was found, another when it was actioned). The earlier one is the
           -- find, so keep it.
           created_at = CASE WHEN excluded.created_at < entries.created_at THEN excluded.created_at ELSE entries.created_at END`)
        .bind(u.handle, u.raw, u.socialUrl, u.email, u.email, u.firstName, u.notes, u.category, u.owner, managerFor(u.owner), stampOf(u.date)));
    }
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));

    const c = await env.DB.prepare("SELECT COUNT(*) n FROM entries WHERE source='master'").first();
    await env.DB.batch([metaSetStmt(env, 'master_last_upload', added)]);
    await bumpVersion(env);
    return json({ ok: true, mode, imported: uniq.length, skipped, total: c ? c.n : 0 });
  }

  /* — videos (linked to a lead; many per lead) — */

  if (path === '/api/videos' && method === 'GET') {
    await requireUser(env, request);
    const eid = parseInt(url.searchParams.get('entry_id'), 10) || 0;
    let sql = 'SELECT * FROM videos';
    const args = [];
    if (eid) { sql += ' WHERE entry_id = ?'; args.push(eid); }
    sql += ' ORDER BY (date_posted != "") DESC, date_posted DESC, id DESC LIMIT 5000';
    const { results } = await env.DB.prepare(sql).bind(...args).all();
    return json({ videos: results });
  }

  if (path === '/api/videos' && method === 'POST') {
    const user = await requireUser(env, request);
    // Resolve the lead by entry_id or handle. Both optional: a video may be a
    // standalone record carrying only a free-text lead_name (e.g. CSV import).
    let entryId = parseInt(body.entry_id, 10) || 0, handle = '';
    const leadName = (body.lead_name || '').trim();
    if (entryId) {
      const e = await env.DB.prepare('SELECT handle_norm FROM entries WHERE id=?').bind(entryId).first();
      if (!e) throw new ApiError(404, 'Lead not found');
      handle = e.handle_norm;
    } else if (body.handle) {
      const h = normHandle(body.handle);
      const e = await env.DB.prepare('SELECT id, handle_norm FROM entries WHERE handle_norm=?').bind(h).first();
      if (!e) throw new ApiError(404, `No lead with handle @${h} — add the lead first`);
      entryId = e.id; handle = e.handle_norm;
    } else if (!leadName) {
      throw new ApiError(400, 'A lead (handle) or lead name is required for a video');
    }
    const r = await env.DB.prepare(
      `INSERT INTO videos (entry_id, handle, url, date_posted, country, language, video_type, budget, notes, lead_name, referral, saas, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(entryId, handle, (body.url || '').trim(), (body.date_posted || '').trim(), (body.country || '').trim(),
            (body.language || '').trim(), (body.video_type || '').trim(), (body.budget || '').trim(),
            (body.notes || '').trim(), leadName, (body.referral || '').trim(), (body.saas || '').trim(),
            nowIso(), user.username).run();
    await bumpVersion(env);
    const row = await env.DB.prepare('SELECT * FROM videos WHERE id=?').bind(r.meta.last_row_id).first();
    return json({ ok: true, video: row });
  }

  // Bulk CSV import: standalone video rows (lead name stored as free text).
  if (path === '/api/videos/import' && method === 'POST') {
    const user = await requireUser(env, request);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) throw new ApiError(400, 'No rows to import');
    const added = nowIso();
    const clean = s => String(s == null ? '' : s).trim();
    const stmts = [];
    let skipped = 0;
    for (const r of rows) {
      const rec = {
        date_posted: clean(r.date_posted), lead_name: clean(r.lead_name), url: clean(r.url),
        budget: clean(r.budget), referral: clean(r.referral), saas: clean(r.saas),
      };
      // Skip fully-empty rows.
      if (!Object.values(rec).some(v => v)) { skipped++; continue; }
      stmts.push(env.DB.prepare(
        `INSERT INTO videos (entry_id, handle, url, date_posted, country, language, video_type, budget, notes, lead_name, referral, saas, created_at, created_by)
         VALUES (0,'',?,?,'','','',?,'',?,?,?,?,?)`)
        .bind(rec.url, rec.date_posted, rec.budget, rec.lead_name, rec.referral, rec.saas, added, user.username));
    }
    if (!stmts.length) throw new ApiError(400, 'No usable rows in the file');
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    await bumpVersion(env);
    return json({ ok: true, imported: stmts.length, skipped });
  }

  if (path === '/api/videos' && method === 'PATCH') {
    await requireUser(env, request);
    const id = parseInt(body.id, 10);
    if (!id) throw new ApiError(400, 'id required');
    const sets = [], args = [];
    for (const f of ['url', 'date_posted', 'country', 'language', 'video_type', 'budget', 'notes', 'lead_name', 'referral', 'saas', 'views', 'comments', 'likes', 'post_type', 'post_status']) {
      if (f in body) { sets.push(`${f}=?`); args.push(String(body[f] || '').trim()); }
    }
    if (!sets.length) throw new ApiError(400, 'Nothing to update');
    args.push(id);
    const res = await env.DB.prepare(`UPDATE videos SET ${sets.join(', ')} WHERE id=?`).bind(...args).run();
    if (!res.meta.changes) throw new ApiError(404, 'Video not found');
    await bumpVersion(env);
    const row = await env.DB.prepare('SELECT * FROM videos WHERE id=?').bind(id).first();
    return json({ ok: true, video: row });
  }

  if (path === '/api/videos' && method === 'DELETE') {
    await requireUser(env, request);
    const id = parseInt(body.id, 10);
    if (!id) throw new ApiError(400, 'id required');
    await env.DB.prepare('DELETE FROM videos WHERE id=?').bind(id).run();
    await bumpVersion(env);
    return json({ ok: true });
  }

  /* ══ CONVERSATIONS / reply handling (ported from the CRM) ══════════════ */

  // Inbox: replied conversations, bucketed, with filters + counts.
  if (path === '/api/state' && method === 'GET') {
    await requireUser(env, request);
    const p = url.searchParams;
    const ws = Number(p.get('ws') || 1) || 1;
    /* The lead's category lives on entries, matched by email. A scalar
       subquery rather than a JOIN: entries holds junk "emails" from the old
       sheets ("dm" on 56 rows, "dmed" on 50), so joining duplicated a
       conversation once per matching row — 5,973 rows for 5,539 conversations
       when measured.

       ORDER BY makes the pick deterministic, and the SAME expression drives
       both the displayed value and the filter. 153 addresses sit on several
       leads with different categories (shared agency inboxes such as
       talent@pontefirm.com), so without that a row could show one category
       while having matched another, and the filter would look broken. */
    const CAT_PICK = "(SELECT e.category FROM entries e WHERE e.email_norm = c.email"
      + " AND e.category != '' ORDER BY e.id LIMIT 1)";
    let sql = 'SELECT c.*, COALESCE(' + CAT_PICK + ", '') AS lead_category"
      + ' FROM conversations c WHERE c.ws=?';
    const args = [ws];
    const catF = p.get('category') || '';
    // Conversations whose lead has no category drop out, like every other
    // filter here.
    if (catF) { sql += ' AND ' + CAT_PICK + ' = ?'; args.push(catF); }
    const campaign = p.get('campaign') || '';
    if (campaign) { const ids = campaign.split(',').filter(Boolean); sql += ` AND campaign_id IN (${ids.map(() => '?').join(',')})`; args.push(...ids); }
    const poc = p.get('poc') || '';
    if (poc === 'unassigned') sql += " AND poc=''"; else if (poc) { sql += ' AND poc=?'; args.push(poc); }
    const statusF = p.get('status') || '';
    if (statusF === 'none') sql += " AND status=''"; else if (statusF) { sql += ' AND status=?'; args.push(statusF); }
    const labelF = p.get('label') || '';
    if (labelF === 'none') sql += " AND label=''"; else if (labelF) { sql += ' AND label=?'; args.push(labelF); }
    const q = p.get('q') || '';
    if (q) {
      sql += ' AND (c.email GLOB ? OR c.first_name GLOB ? OR c.subject GLOB ?)';
      const g = globCI(q);
      args.push(g, g, g);
    }
    if (p.get('date_from')) { sql += ' AND last_lead_msg_at >= ?'; args.push(p.get('date_from')); }
    if (p.get('date_to')) { sql += ' AND last_lead_msg_at <= ?'; args.push(p.get('date_to') + 'T23:59:59.999Z'); }
    const [convRes, campRes, countRes, statusRes, labelRes, catListRes] = await env.DB.batch([
      env.DB.prepare(sql).bind(...args),
      env.DB.prepare('SELECT id, name FROM campaigns WHERE ws=?').bind(ws),
      env.DB.prepare('SELECT campaign_id, COUNT(*) c FROM conversations WHERE ws=? GROUP BY campaign_id').bind(ws),
      env.DB.prepare('SELECT key, label, form, terminal, builtin, sort FROM statuses ORDER BY sort, label'),
      env.DB.prepare('SELECT name, builtin, sort FROM crm_labels ORDER BY sort, name'),
      // The same curated list the CRM offers, so the two agree on what a
      // category is. Managed in the CRM under Manage > Categories.
      env.DB.prepare('SELECT name AS category FROM categories ORDER BY sort, name'),
    ]);
    const campaignNames = Object.fromEntries(campRes.results.map(r => [r.id, r.name]));
    const leads = convRes.results.map(r => convDict(r, campaignNames));
    const counts = {}, statusCounts = {}, labelCounts = {};
    for (const l of leads) {
      counts[l.bucket] = (counts[l.bucket] || 0) + 1;
      statusCounts[l.status || ''] = (statusCounts[l.status || ''] || 0) + 1;
      if (l.label) labelCounts[l.label] = (labelCounts[l.label] || 0) + 1;
    }
    const campCounts = Object.fromEntries(countRes.results.map(r => [r.campaign_id, r.c]));
    const campaignList = Object.entries(campaignNames)
      .map(([id, name]) => ({ id, name, leads: campCounts[id] || 0 }))
      .sort((a, b) => b.leads - a.leads || a.name.localeCompare(b.name));
    return json({
      leads, counts, campaigns: campaignList, statuses: statusRes.results, labels: labelRes.results,
      categories: catListRes.results.map(r => r.category),
      status_counts: statusCounts, label_counts: labelCounts,
      last_sync: await metaGet(env, `last_sync:${ws}`, '') || await metaGet(env, 'last_sync', ''),
      version: parseInt(await metaGet(env, 'version', '0'), 10), followup_due_days: FOLLOWUP_DUE_DAYS,
    });
  }

  // Full email thread for one conversation (+ notes, activity, older campaigns).
  if (path === '/api/thread' && method === 'GET') {
    await requireUser(env, request);
    const key = url.searchParams.get('key') || '';
    const i = key.indexOf('|');
    const campaignId = key.slice(0, i), leadEmail = key.slice(i + 1);
    const [emailsRes, notesRes, actRes, otherRes, campRes] = await env.DB.batch([
      env.DB.prepare(`SELECT id, ue_type, from_email, to_email, subject, preview, body_html, body_text, timestamp_email, eaccount
         FROM emails WHERE campaign_id=? AND lead_email=? ORDER BY timestamp_email ASC`).bind(campaignId, leadEmail),
      env.DB.prepare('SELECT author, text, created_at FROM notes WHERE lead_key=? ORDER BY id').bind(key),
      env.DB.prepare('SELECT author, kind, detail, created_at FROM activity WHERE lead_key=? ORDER BY id DESC LIMIT 30').bind(key),
      env.DB.prepare(`SELECT campaign_id, ue_type, from_email, subject, preview, body_html, body_text, timestamp_email, eaccount
         FROM emails WHERE lead_email=? AND campaign_id<>? ORDER BY timestamp_email ASC`).bind(leadEmail, campaignId),
      env.DB.prepare('SELECT id, name FROM campaigns'),
    ]);
    const cur = emailsRes.results;
    const currentLatest = cur.length ? cur[cur.length - 1].timestamp_email : '';
    const names = Object.fromEntries(campRes.results.map(r => [r.id, r.name]));
    const grouped = new Map();
    for (const m of otherRes.results) { if (!grouped.has(m.campaign_id)) grouped.set(m.campaign_id, []); grouped.get(m.campaign_id).push(m); }
    const other_threads = [...grouped.entries()]
      .map(([cid, emails]) => ({ campaign_id: cid, campaign_name: names[cid] || '(no campaign)', emails, last_msg_at: emails[emails.length - 1].timestamp_email }))
      .filter(t => !currentLatest || t.last_msg_at < currentLatest)
      .sort((a, b) => (a.last_msg_at < b.last_msg_at ? 1 : -1));
    return json({ emails: cur, notes: notesRes.results, activity: actRes.results, other_threads });
  }

  // Full lead detail for the in-app conversation popup (READ-ONLY): the entire
  // email thread across all campaigns + notes + activity + linked videos + every
  // lead field. Sourced entirely from the LOCAL merged data (no external CRM).
  if (path === '/api/lead/detail' && method === 'GET') {
    await requireUser(env, request);
    const entryId = parseInt(url.searchParams.get('entry_id'), 10) || 0;
    const emailParam = normEmail(url.searchParams.get('email') || '');
    let entry = null;
    if (entryId) entry = await env.DB.prepare('SELECT * FROM entries WHERE id=?').bind(entryId).first();
    else if (emailParam) entry = await env.DB.prepare('SELECT * FROM entries WHERE email_norm=? ORDER BY id LIMIT 1').bind(emailParam).first();
    if (!entry) throw new ApiError(404, 'Lead not found');
    const em = entry.email_norm || normEmail(entry.email);
    const h = entry.handle_norm || '';
    const [convRes, campRes, vidRes] = await env.DB.batch([
      env.DB.prepare(`SELECT key, campaign_id, email, status, last_msg_at, lead_reply_count, last_lead_msg_at FROM conversations WHERE (? != '' AND email=?) OR (? != '' AND handle_norm=?)`).bind(em, em, h, h),
      env.DB.prepare('SELECT id, name FROM campaigns'),
      env.DB.prepare("SELECT * FROM videos WHERE entry_id=? ORDER BY (date_posted!='') DESC, date_posted DESC, id DESC").bind(entry.id),
    ]);
    const names = Object.fromEntries(campRes.results.map(r => [r.id, r.name]));
    // Thread = every email for the entry's own address PLUS every address seen on
    // its matched conversations (covers handle-only leads whose email lives on the
    // linked conversation, not the entry).
    const mailAddrs = [...new Set([em, ...convRes.results.map(c => (c.email || '').toLowerCase())].filter(Boolean))];
    let emailsOut = [];
    if (mailAddrs.length) {
      const eph = mailAddrs.map(() => '?').join(',');
      const { results: er } = await env.DB.prepare(
        `SELECT id, campaign_id, ue_type, from_email, to_email, subject, preview, body_html, body_text, timestamp_email, eaccount
         FROM emails WHERE lead_email IN (${eph}) ORDER BY timestamp_email ASC`).bind(...mailAddrs).all();
      emailsOut = er.map(m => ({ ...m, campaign_name: names[m.campaign_id] || '' }));
    }
    const keys = convRes.results.map(c => c.key);
    let notes = [], activity = [];
    if (keys.length) {
      const ph = keys.map(() => '?').join(',');
      const [nRes, aRes] = await env.DB.batch([
        env.DB.prepare(`SELECT author, text, created_at FROM notes WHERE lead_key IN (${ph}) ORDER BY id`).bind(...keys),
        env.DB.prepare(`SELECT author, kind, detail, created_at FROM activity WHERE lead_key IN (${ph}) ORDER BY id DESC LIMIT 50`).bind(...keys),
      ]);
      notes = nRes.results; activity = aRes.results;
    }
    return json({
      entry: entryDict(entry, ''),
      emails: emailsOut, notes, activity, videos: vidRes.results,
      // lead_reply_count comes from Instantly's per-lead counters, which is how
      // a conversation row gets created at all. Surfacing it lets the popup say
      // "they replied, but we do not hold the message" instead of silently
      // showing a one-sided thread that looks like a bug.
      conversations: convRes.results.map(c => ({
        campaign_id: c.campaign_id, campaign_name: names[c.campaign_id] || '', status: c.status,
        email: c.email || '', lead_reply_count: c.lead_reply_count || 0, last_lead_msg_at: c.last_lead_msg_at || '',
      })),
    });
  }

  // Outreach status vocabulary (drives the pipeline auto-map + inbox forms).
  if (path === '/api/statuses' && method === 'GET') {
    await requireUser(env, request);
    const { results } = await env.DB.prepare('SELECT key, label, form, terminal, builtin, sort FROM statuses ORDER BY sort, label').all();
    return json({ statuses: results });
  }
  if (path === '/api/statuses' && method === 'POST') {
    await requireUser(env, request);
    const label = (body.label || '').trim();
    if (!label) throw new ApiError(400, 'Status name required');
    const key = slugify(label);
    if (!key) throw new ApiError(400, 'Invalid status name');
    if (await env.DB.prepare('SELECT 1 x FROM statuses WHERE key=?').bind(key).first()) throw new ApiError(400, 'That status already exists');
    const max = await env.DB.prepare('SELECT MAX(sort) m FROM statuses').first();
    await env.DB.prepare("INSERT INTO statuses (key, label, form, terminal, builtin, sort) VALUES (?,?,'none',0,0,?)").bind(key, label, ((max && max.m) || 0) + 1).run();
    await bumpVersion(env);
    return json({ ok: true, key });
  }
  if (path === '/api/statuses' && method === 'DELETE') {
    await requireUser(env, request);
    const key = body.key || '';
    const row = await env.DB.prepare('SELECT builtin FROM statuses WHERE key=?').bind(key).first();
    if (!row) throw new ApiError(404, 'Status not found');
    if (row.builtin) throw new ApiError(400, 'Built-in statuses cannot be deleted');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM statuses WHERE key=?').bind(key),
      env.DB.prepare("UPDATE conversations SET status='', status_source='' WHERE status=?").bind(key),
    ]);
    await bumpVersion(env);
    return json({ ok: true });
  }

  // CRM/interest labels (distinct from the pipeline nodes).
  if (path === '/api/labels' && method === 'GET') {
    await requireUser(env, request);
    const { results } = await env.DB.prepare('SELECT name, builtin, sort FROM crm_labels ORDER BY sort, name').all();
    return json({ labels: results });
  }
  if (path === '/api/labels' && method === 'POST') {
    await requireUser(env, request);
    const name = (body.name || '').trim();
    if (!name) throw new ApiError(400, 'Label name required');
    if (await env.DB.prepare('SELECT 1 x FROM crm_labels WHERE name=?').bind(name).first()) throw new ApiError(400, 'That label already exists');
    const max = await env.DB.prepare('SELECT MAX(sort) m FROM crm_labels').first();
    await env.DB.prepare('INSERT INTO crm_labels (name, builtin, sort) VALUES (?,0,?)').bind(name, ((max && max.m) || 0) + 1).run();
    await bumpVersion(env);
    return json({ ok: true });
  }
  if (path === '/api/labels' && method === 'DELETE') {
    await requireUser(env, request);
    const name = body.name || '';
    if (!(await env.DB.prepare('SELECT name FROM crm_labels WHERE name=?').bind(name).first())) throw new ApiError(404, 'Label not found');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM crm_labels WHERE name=?').bind(name),
      env.DB.prepare("UPDATE conversations SET label='' WHERE label=?").bind(name),
    ]);
    await bumpVersion(env);
    return json({ ok: true });
  }

  if (path === '/api/lead/label' && method === 'POST') {
    const user = await requireUser(env, request);
    const label = (body.label || '').trim();
    if (label && !(await env.DB.prepare('SELECT 1 x FROM crm_labels WHERE name=?').bind(label).first())) throw new ApiError(400, 'Unknown label');
    const r = await env.DB.prepare('UPDATE conversations SET label=?, updated_at=? WHERE key=?').bind(label, nowIso(), body.key || '').run();
    if (!r.meta.changes) throw new ApiError(404, 'Conversation not found');
    await touchConv(env, body.key, user, 'label_change', label || 'cleared');
    await relinkConv(env, body.key);
    return json({ ok: true });
  }

  if (path === '/api/lead/status' && method === 'POST') {
    const user = await requireUser(env, request);
    const status = body.status || '';
    if (status && !(await env.DB.prepare('SELECT form FROM statuses WHERE key=?').bind(status).first())) throw new ApiError(400, 'Invalid status');
    const d = body.data || {};
    const dealV = status === 'closed' ? String(d.videos || '') : '';
    const dealB = status === 'closed' ? String(d.budget || '') : '';
    const dealD = status === 'closed' ? String(d.deliverables || '') : '';
    const failR = status === 'failed' ? String(d.fail_reason || '') : '';
    const failN = status === 'failed' ? String(d.fail_notes || '') : '';
    const wantRates = status === 'rates_quoted' || (status === 'failed' && failR === 'out_of_budget');
    const rTi = wantRates ? String(d.their_initial || '') : '';
    const rTf = wantRates ? String(d.their_final || '') : '';
    const rOi = wantRates ? String(d.our_initial || '') : '';
    const rOf = wantRates ? String(d.our_final || '') : '';
    const r = await env.DB.prepare(
      `UPDATE conversations SET status=?, status_source='manual', deal_videos=?, deal_budget=?, deal_deliverables=?,
         fail_reason=?, fail_notes=?, rate_their_initial=?, rate_their_final=?, rate_our_initial=?, rate_our_final=?,
         updated_at=? WHERE key=?`)
      .bind(status, dealV, dealB, dealD, failR, failN, rTi, rTf, rOi, rOf, nowIso(), body.key || '').run();
    if (!r.meta.changes) throw new ApiError(404, 'Conversation not found');
    // NOTE: "out of budget" is a Failed REASON, not a label — it flows to the
    // pipeline's Failed "Reason" column via syncEntriesFromConversations. We
    // deliberately do NOT stamp it onto conversations.label here.
    const st = status ? (await env.DB.prepare('SELECT label FROM statuses WHERE key=?').bind(status).first()) : null;
    await touchConv(env, body.key, user, 'status_change', st ? st.label : 'cleared');
    // Most-recent-edit-wins: an explicit Unibox status change supersedes any
    // earlier hand-set CRM stage, so unfreeze the lead before re-projecting.
    await env.DB.prepare("UPDATE entries SET position_source='auto' WHERE id=(SELECT entry_id FROM conversations WHERE key=? AND entry_id!=0)").bind(body.key).run();
    await relinkConv(env, body.key);
    return json({ ok: true });
  }

  if (path === '/api/lead/snooze' && method === 'POST') {
    const user = await requireUser(env, request);
    const days = Number(body.days || 0);
    const until = days > 0 ? isoPlus(days) : '';
    const r = await env.DB.prepare('UPDATE conversations SET snoozed_until=?, updated_at=? WHERE key=?').bind(until, nowIso(), body.key || '').run();
    if (!r.meta.changes) throw new ApiError(404, 'Conversation not found');
    await touchConv(env, body.key, user, 'snooze', days > 0 ? `${days} days` : 'unsnoozed');
    return json({ ok: true });
  }

  if (path === '/api/lead/note' && method === 'POST') {
    const user = await requireUser(env, request);
    const text = (body.text || '').trim();
    if (!text) throw new ApiError(400, 'Empty note');
    await env.DB.prepare('INSERT INTO notes (lead_key, author, text, created_at) VALUES (?,?,?,?)')
      .bind(body.key || '', user.display_name || user.username, text, nowIso()).run();
    await touchConv(env, body.key, user, 'note', text.slice(0, 80));
    return json({ ok: true });
  }

  if (path === '/api/lead/poc' && method === 'POST') {
    const user = await requireUser(env, request);
    const poc = (body.poc || '').trim();
    const valid = poc ? ((await teamNames(env)).includes(poc) || AUTO_POC_NAMES.includes(poc)) : true;
    if (!valid) throw new ApiError(400, 'Unknown team member');
    const r = await env.DB.prepare('UPDATE conversations SET poc=?, updated_at=? WHERE key=?').bind(poc, nowIso(), body.key || '').run();
    if (!r.meta.changes) throw new ApiError(404, 'Conversation not found');
    await touchConv(env, body.key, user, 'poc_change', poc || 'unassigned');
    await relinkConv(env, body.key);
    return json({ ok: true });
  }

  // Send a reply out through Instantly, store it, recompute the conversation.
  if (path === '/api/lead/reply' && method === 'POST') {
    const user = await requireUser(env, request);
    const text = (body.text || '').trim();
    if (!text) throw new ApiError(400, 'Empty reply');
    const key = body.key || '';
    const i = key.indexOf('|');
    const campaignId = key.slice(0, i), leadEmail = key.slice(i + 1);
    const last = await env.DB.prepare(`SELECT id, subject, eaccount FROM emails WHERE campaign_id=? AND lead_email=? ORDER BY timestamp_email DESC LIMIT 1`).bind(campaignId, leadEmail).first();
    if (!last) throw new ApiError(404, 'No conversation found');
    let subject = last.subject || '';
    if (!subject.toLowerCase().startsWith('re:')) subject = 'Re: ' + subject;
    const convRow = await env.DB.prepare('SELECT eaccount, ws FROM conversations WHERE key=?').bind(key).first();
    const eaccount = (convRow && convRow.eaccount) || last.eaccount;
    if (!eaccount) throw new ApiError(400, 'No sending account known for this thread');
    const wsId = (convRow && convRow.ws) || 1;
    const wsApiKey = await wsKey(env, wsId);
    let sent;
    try {
      sent = await instantlyPost(env, '/emails/reply', {
        reply_to_uuid: last.id, eaccount, subject,
        body: { html: `<div>${replyToHtml(text)}</div>`, text: replyToPlain(text) },
      }, wsApiKey);
    } catch (e) { throw new ApiError(502, `Instantly reply failed: ${e.message}`); }
    if (sent && sent.id) {
      if (!sent.campaign_id) sent.campaign_id = campaignId;
      if (!sent.lead) sent.lead = leadEmail;
      sent.ue_type = 3; // a reply sent from the Unibox is a MANUAL reply — mark it so bucketing counts it as answered
      await emailUpsertStmt(env, sent, wsId).run();
    }
    await recomputeConversations(env, [`${campaignId}|${leadEmail}`]);
    await touchConv(env, key, user, 'reply_sent', text.slice(0, 80));
    await relinkConv(env, key);
    return json({ ok: true });
  }

  // Manually register / override a conversation's quoted rate (or clear → auto).
  if (path === '/api/lead/rate' && method === 'POST') {
    const user = await requireUser(env, request);
    const key = body.key || '';
    if (!key.includes('|')) throw new ApiError(400, 'Bad conversation key');
    if (body.clear) {
      await env.DB.prepare(`UPDATE conversations SET quoted_currency='', quoted_amount=NULL, quoted_usd=NULL, quoted_all='',
          quoted_qty=NULL, quoted_unit='', quoted_per_unit_usd=NULL, quoted_source='', quoted_other='' WHERE key=?`).bind(key).run();
      await touchConv(env, key, user, 'rate_manual', 'cleared');
      await relinkConv(env, key);
      return json({ ok: true });
    }
    const amount = Number(body.amount);
    if (!isFinite(amount) || amount <= 0) throw new ApiError(400, 'Amount must be greater than 0');
    const cur = RATE_CURRENCIES.includes(body.currency) ? body.currency : '$';
    const MANUAL_UNITS = new Set(['reel', 'carousel', 'story']);
    let lines = Array.isArray(body.lines) ? body.lines : [{ qty: body.qty, unit: body.unit }];
    lines = lines.map(l => ({ qty: Math.max(1, Math.round(Number(l && l.qty) || 1)), unit: MANUAL_UNITS.has(l && l.unit) ? l.unit : 'reel' })).slice(0, 10);
    if (!lines.length) lines = [{ qty: 1, unit: 'reel' }];
    const totalQty = lines.reduce((s, l) => s + l.qty, 0);
    const other = (body.other || '').toString().slice(0, 500);
    const fx = USD_PER[cur] || 1;
    const totalUsd = Math.round(amount * fx);
    const perUnitUsd = Math.round((amount / totalQty) * fx);
    const unit = lines.length === 1 ? lines[0].unit : 'mixed';
    const all = JSON.stringify(lines.map(l => ({ q: l.qty, u: l.unit })));
    await env.DB.prepare(`UPDATE conversations SET quoted_currency=?, quoted_amount=?, quoted_usd=?, quoted_all=?,
        quoted_qty=?, quoted_unit=?, quoted_per_unit_usd=?, quoted_source='manual', quoted_other=?, updated_at=? WHERE key=?`)
      .bind(cur, amount, totalUsd, all, totalQty, unit, perUnitUsd, other, nowIso(), key).run();
    await touchConv(env, key, user, 'rate_manual', `${cur}${amount} for ${lines.map(l => `${l.qty} ${l.unit}`).join(' + ')}`);
    await relinkConv(env, key);
    return json({ ok: true });
  }

  // Shared reply templates.
  if (path === '/api/templates' && method === 'GET') {
    await requireUser(env, request);
    const { results } = await env.DB.prepare('SELECT id, name, body FROM templates ORDER BY sort, id').all();
    return json({ templates: results });
  }
  if (path === '/api/templates' && method === 'POST') {
    await requireUser(env, request);
    const name = (body.name || '').trim(); const text = body.body || '';
    if (!name) throw new ApiError(400, 'Template name required');
    if (body.id) {
      const r = await env.DB.prepare('UPDATE templates SET name=?, body=?, updated_at=? WHERE id=?').bind(name, text, nowIso(), body.id).run();
      if (!r.meta.changes) throw new ApiError(404, 'Template not found');
    } else {
      const max = await env.DB.prepare('SELECT MAX(sort) m FROM templates').first();
      await env.DB.prepare('INSERT INTO templates (name, body, sort, updated_at) VALUES (?,?,?,?)').bind(name, text, ((max && max.m) || 0) + 1, nowIso()).run();
    }
    return json({ ok: true });
  }
  if (path === '/api/templates' && method === 'DELETE') {
    await requireUser(env, request);
    const r = await env.DB.prepare('DELETE FROM templates WHERE id=?').bind(body.id || 0).run();
    if (!r.meta.changes) throw new ApiError(404, 'Template not found');
    return json({ ok: true });
  }

  // Shared quick-copy links.
  if (path === '/api/links' && method === 'GET') {
    await requireUser(env, request);
    const { results } = await env.DB.prepare('SELECT id, name, url FROM links ORDER BY sort, id').all();
    return json({ links: results });
  }
  if (path === '/api/links' && method === 'POST') {
    await requireUser(env, request);
    const name = (body.name || '').trim(); const linkUrl = (body.url || '').trim();
    if (!name) throw new ApiError(400, 'Link name required');
    if (!linkUrl) throw new ApiError(400, 'Link URL required');
    if (body.id) {
      const r = await env.DB.prepare('UPDATE links SET name=?, url=?, updated_at=? WHERE id=?').bind(name, linkUrl, nowIso(), body.id).run();
      if (!r.meta.changes) throw new ApiError(404, 'Link not found');
    } else {
      const max = await env.DB.prepare('SELECT MAX(sort) m FROM links').first();
      await env.DB.prepare('INSERT INTO links (name, url, sort, updated_at) VALUES (?,?,?,?)').bind(name, linkUrl, ((max && max.m) || 0) + 1, nowIso()).run();
    }
    return json({ ok: true });
  }
  if (path === '/api/links' && method === 'DELETE') {
    await requireUser(env, request);
    const r = await env.DB.prepare('DELETE FROM links WHERE id=?').bind(body.id || 0).run();
    if (!r.meta.changes) throw new ApiError(404, 'Link not found');
    return json({ ok: true });
  }

  // Personal booking link (used in reply templates).
  if (path === '/api/account/booking' && method === 'POST') {
    const user = await requireUser(env, request);
    await env.DB.prepare('UPDATE users SET booking_link=? WHERE id=?').bind((body.booking_link || '').trim(), user.id).run();
    return json({ ok: true });
  }

  // Instantly campaigns (for the inbox filter + campaign view).
  if (path === '/api/campaigns' && method === 'GET') {
    await requireUser(env, request);
    const ws = Number(url.searchParams.get('ws') || 1) || 1;
    const { results } = await env.DB.prepare('SELECT id, name, status, created FROM campaigns WHERE ws=? ORDER BY created DESC, name').bind(ws).all();
    return json({ campaigns: results });
  }

  // Live per-campaign analytics, straight from Instantly. Enriched with the
  // locally-synced campaign name + created date (for name fallback + newest-first
  // sort in the UI).
  if (path === '/api/analytics' && method === 'GET') {
    await requireUser(env, request);
    const ws = Number(url.searchParams.get('ws') || 1) || 1;
    const apiKey = await wsKey(env, ws);
    if (!apiKey) throw new ApiError(400, 'Instantly is not configured (no API key for this workspace)');
    let data;
    try { data = await instantlyGet(env, '/campaigns/analytics', {}, apiKey); }
    catch (e) { throw new ApiError(502, `Instantly analytics failed: ${e.message}`); }
    const list = Array.isArray(data) ? data : (data.items || data.data || []);
    const { results: locals } = await env.DB.prepare('SELECT id, name, created FROM campaigns WHERE ws=?').bind(ws).all();
    const meta = new Map((locals || []).map(c => [c.id, c]));
    const campaigns = list.map(a => {
      const id = a.campaign_id || a.id || '';
      const m = meta.get(id) || {};
      return { ...a, campaign_id: id, campaign_name: a.campaign_name || m.name || '', created: a.created || m.created || '' };
    });
    return json({ campaigns });
  }

  // Manual Instantly sync (one workspace).
  if (path === '/api/sync' && method === 'POST') {
    await requireUser(env, request);
    if (!(env.INSTANTLY_API_KEY) && !(await env.DB.prepare('SELECT 1 x FROM workspaces LIMIT 1').first())) {
      throw new ApiError(400, 'Instantly is not configured (no API key / workspace)');
    }
    await ensureDefaultWorkspace(env);
    const ws = Number(body.ws || 1) || 1;
    const synced = await runManualSync(env, ws);
    return json({ ok: true, synced });
  }

  // One-time paged relink: link migrated conversations → entries (auto-create
  // missing people), fixing pipeline counts. Paged by rowid to stay under the
  // Workers subrequest cap. Driver loops until {done:true}.
  if (path === '/api/admin/relink' && method === 'POST') {
    await requireUser(env, request);
    const after = Number(body.after || 0) || 0;
    const limit = Math.min(Number(body.limit || 100) || 100, 200);
    const { results } = await env.DB.prepare(
      'SELECT rowid AS rid, key FROM conversations WHERE rowid > ? ORDER BY rowid LIMIT ?').bind(after, limit).all();
    if (!results.length) return json({ done: true, processed: 0, next: after });
    await linkConversations(env, results.map(r => r.key));
    return json({ done: results.length < limit, processed: results.length, next: results[results.length - 1].rid });
  }

  // One-time full reconciliation sweep: catch straggler replies the watermark
  // skipped. Cursor-based (reconcile_cursor:{ws}); call repeatedly until
  // {wrapped:true}. Admin only.
  if (path === '/api/admin/reconcile' && method === 'POST') {
    const user = await requireUser(env, request);
    if (!user.is_admin) throw new ApiError(403, 'Only admins can run reconciliation');
    const ws = Number(body.ws || 1) || 1;
    const batch = Math.min(Number(body.batch || 300) || 300, 500);
    const apiKey = await wsKey(env, ws);
    if (!apiKey) throw new ApiError(400, 'Instantly is not configured for this workspace');
    const res = await runReplyReconcile(env, ws, apiKey, batch);
    return json(res);
  }

  // Instantly accounts (workspaces) — list only for now.
  if (path === '/api/workspaces' && method === 'GET') {
    await requireUser(env, request);
    await ensureDefaultWorkspace(env);
    const ws = await listWorkspaces(env);
    return json({ workspaces: ws.map(w => ({ id: w.id, name: w.name })) });
  }

  throw new ApiError(404, 'Not found');
}

/* ── shared check logic (used by /api/check and add preview) ── */

function crmError(results) {
  return (results && !Array.isArray(results)) ? (results.error || 'CRM lookup failed') : '';
}

async function liveCrm(env, email, handle) {
  const results = await crmLookup(env, email ? [email] : [], handle ? [handle] : []);
  return { results: Array.isArray(results) ? results : [], signal: pickCrmSignal(results), error: crmError(results) };
}

// Prior-conversation signal sourced from the LOCAL merged conversations table
// (post-merge replacement for the retired external-CRM lookup). A conversation
// row only exists once a lead has replied, so its presence means the lead is
// known + contacted + replied. Same { results, signal, error } shape as liveCrm.
// Build a prior-conversation signal from a lead's conversation rows. A row only
// exists once the lead has replied → known + contacted + replied.
const CONV_SIG_COLS = 'campaign_id, status, last_lead_msg_at, last_our_msg_at, last_msg_at, first_reply_at, lead_reply_count, poc, label, first_name';
function sigFromConvRows(rows, query) {
  if (!rows || !rows.length) return null;
  const sorted = rows.slice().sort((a, b) => (a.last_msg_at || '') < (b.last_msg_at || '') ? 1 : -1); // most recent first
  const replied = rows.some(r => (r.lead_reply_count || 0) > 0 || r.first_reply_at);
  return {
    type: 'local', query: query || '', known: true, contacted: true, replied: !!replied,
    status: sorted[0].status || '', poc: (rows.find(r => r.poc) || {}).poc || '',
    label: (rows.find(r => r.label) || {}).label || '', first_name: (rows.find(r => r.first_name) || {}).first_name || '',
    campaigns: [...new Set(rows.map(r => r.campaign_id).filter(Boolean))],
    last_contact_at: rows.map(r => r.last_our_msg_at || r.last_msg_at || '').filter(Boolean).sort().pop() || '',
    last_reply_at: rows.map(r => r.last_lead_msg_at || '').filter(Boolean).sort().pop() || '',
  };
}
async function localCrm(env, email, handle) {
  const em = normEmail(email), h = normHandle(handle || '');
  if (!em && !h) return { results: [], signal: null, error: '' };
  const { results: rows } = await env.DB.prepare(
    `SELECT ${CONV_SIG_COLS} FROM conversations WHERE (? != '' AND email = ?) OR (? != '' AND handle_norm = ?)`)
    .bind(em, em, h, h).all();
  let signal = sigFromConvRows(rows, em || h);
  // No conversation (= no reply). Best-effort "contacted, never replied": did we
  // ever send this address an email? (Send coverage in `emails` is partial, so
  // this can under-report, but a real reply would have created a conversation.)
  if (!signal && em) {
    const r = await env.DB.prepare(
      "SELECT COUNT(*) n, MAX(timestamp_email) last_at FROM emails WHERE lead_email=? AND ue_type IN (1,3)").bind(em).first();
    if (r && r.n > 0) {
      signal = { type: 'local', query: em, known: true, contacted: true, replied: false,
        status: '', poc: '', label: '', first_name: '', campaigns: [], last_contact_at: r.last_at || '', last_reply_at: '' };
    }
  }
  return { results: signal ? [signal] : [], signal, error: '' };
}

// Add many leads at once (paste or CSV). Runs each row through the SAME dedup
// (entries + master) and CRM check as the single-add path, but batches the
// lookups so a 500-row paste is a handful of queries, not 1500. Returns a
// per-row report plus a summary so the teammate sees exactly what happened.
async function bulkAdd(env, user, rawRows) {
  if (!rawRows.length) throw new ApiError(400, 'No rows to add');
  if (rawRows.length > 500) throw new ApiError(400, 'Max 500 rows per bulk add');

  const rows = rawRows.map(r => {
    const social = typeof r === 'string' ? r : (r.social_url || r.handle || r.url || r.value || '');
    const emailRaw = (typeof r === 'object' && r) ? (r.email || '') : '';
    const firstName = (typeof r === 'object' && r) ? (r.first_name || r.name || '') : '';
    const notes = (typeof r === 'object' && r) ? (r.notes || '') : '';
    const category = (typeof r === 'object' && r) ? (r.category || '') : '';
    return { handle: normHandle(social), raw: String(social || '').trim(),
             email: normEmail(emailRaw), emailRaw: String(emailRaw || '').trim(),
             firstName: String(firstName || '').trim(), notes: String(notes || '').trim(),
             category: String(category || '').trim() };
  });

  const uniqueHandles = [...new Set(rows.map(r => r.handle).filter(Boolean))];

  // Batched existence lookup (entries now includes any master rows).
  const existMap = {};
  for (let i = 0; i < uniqueHandles.length; i += 100) {
    const chunk = uniqueHandles.slice(i, i + 100);
    const ph = chunk.map(() => '?').join(',');
    const { results: ex } = await env.DB.prepare(
      `SELECT handle_norm, lead_owner, created_by, created_at, email, id, source FROM entries WHERE handle_norm IN (${ph})`).bind(...chunk).all();
    for (const e of ex) existMap[e.handle_norm] = e;
  }

  // Prior-conversation signals for the whole paste, from the LOCAL merged
  // conversations (retired the external CRM), batched by email + handle.
  const emails = [...new Set(rows.map(r => r.email).filter(Boolean))].slice(0, 1000);
  const handles = uniqueHandles.slice(0, 1000);
  const byEmail = {}, byHandle = {}, gE = {}, gH = {};
  for (let i = 0; i < emails.length; i += 90) { // D1 caps bound params near 100
    const chunk = emails.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT email, handle_norm, ${CONV_SIG_COLS} FROM conversations WHERE email IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
    for (const r of results) if (r.email) (gE[r.email] = gE[r.email] || []).push(r);
  }
  for (let i = 0; i < handles.length; i += 90) { // D1 caps bound params near 100
    const chunk = handles.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT email, handle_norm, ${CONV_SIG_COLS} FROM conversations WHERE handle_norm IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
    for (const r of results) if (r.handle_norm) (gH[r.handle_norm] = gH[r.handle_norm] || []).push(r);
  }
  for (const em of emails) { const s = sigFromConvRows(gE[em], em); if (s) byEmail[em] = s; }
  for (const h of handles) { const s = sigFromConvRows(gH[h], h); if (s) byHandle[h] = s; }
  const crmErr = '';

  const pickSig = (email, handle) =>
    (email && byEmail[email] && byEmail[email].known) ? byEmail[email]
      : (byHandle[handle] && byHandle[handle].known) ? byHandle[handle]
      : (byEmail[email] || byHandle[handle] || null);

  const created = nowIso();
  const managerOf = await managerResolver(env);
  const seen = new Set();
  const report = [];
  const inserts = [];
  let added = 0, duplicate = 0, invalid = 0;

  for (const r of rows) {
    if (!r.handle) { invalid++; report.push({ raw: r.raw, email: r.emailRaw, status: 'invalid' }); continue; }
    if (existMap[r.handle]) {
      duplicate++;
      const e = existMap[r.handle];
      report.push({ handle: r.handle, email: r.emailRaw, status: 'duplicate',
                    dup: { owner: e.lead_owner, created_by: e.created_by, created_at: e.created_at, source: e.source || 'added' } });
      continue;
    }
    if (seen.has(r.handle)) { duplicate++; report.push({ handle: r.handle, email: r.emailRaw, status: 'duplicate', dup: { within_batch: true } }); continue; }
    seen.add(r.handle);

    const sig = pickSig(r.email, r.handle);
    const snap = crmSnapshot(sig);
    inserts.push({ r, snap, sig });
  }

  // Batched inserts (teammate-added → source='added').
  const stmts = inserts.map(({ r, snap }) => {
    const sug = crmSuggest(snap.crm_status, snap.crm_label);
    const initStage = sug ? sug.stage : (snap.crm_replied ? 'Responses' : 'Leads');
    const initPos = sug ? sug.position : '';
    return env.DB.prepare(
      `INSERT INTO entries
        (handle_norm, handle_raw, social_url, email, email_norm, first_name, notes, category, lead_owner, lead_manager, created_by, created_at, source, in_master, stage, position,
         crm_known, crm_contacted, crm_replied, crm_status, crm_poc, crm_campaigns,
         crm_last_contact_at, crm_last_reply_at, crm_checked_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'added',0,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(handle_norm) DO NOTHING`)
      .bind(r.handle, r.raw, canonicalUrl(r.handle), r.emailRaw, r.email, r.firstName, r.notes, r.category, ownerName(user), managerOf(ownerName(user)), user.username, created, initStage, initPos,
            snap.crm_known, snap.crm_contacted, snap.crm_replied, snap.crm_status, snap.crm_poc,
            snap.crm_campaigns, snap.crm_last_contact_at, snap.crm_last_reply_at, snap.crm_checked_at);
  });

  for (let i = 0; i < stmts.length; i += 50) {
    const res = await env.DB.batch(stmts.slice(i, i + 50));
    res.forEach((rr, j) => {
      const { r, sig } = inserts[i + j];
      if (rr.meta && rr.meta.changes) {
        added++;
        report.push({ handle: r.handle, email: r.emailRaw, status: 'added',
                      verdict: verdictFor({ dup: false, in_master: false }, sig) });
      } else {
        duplicate++;
        report.push({ handle: r.handle, email: r.emailRaw, status: 'duplicate', dup: { raced: true } });
      }
    });
  }

  if (added) await bumpVersion(env);
  return { ok: true, added, duplicate, invalid, total: rows.length, crm_error: crmErr, report };
}

// Seed the default categories if the table is empty (defensive — the schema and
// migration already seed them).
async function ensureCategories(env) {
  const c = await env.DB.prepare('SELECT COUNT(*) n FROM categories').first();
  if (c && c.n > 0) return;
  const defs = ['SMM', 'Agency', 'Creator Coach', 'Videos'];
  await env.DB.batch(defs.map((n, i) => env.DB.prepare(
    'INSERT OR IGNORE INTO categories (name, sort, created_at) VALUES (?,?,?)').bind(n, i + 1, nowIso())));
}

// Edit an existing lead. Open to any logged-in teammate (not owner-restricted).
// Only the fields present in the body are changed; changing the handle re-checks
// the dedup key + master flag, and changing handle/email re-runs the CRM snapshot.
async function editEntry(env, user, body) {
  const id = parseInt(body.id, 10);
  if (!id) throw new ApiError(400, 'id required');
  const row = await env.DB.prepare('SELECT * FROM entries WHERE id=?').bind(id).first();
  if (!row) throw new ApiError(404, 'Entry not found');

  const sets = [], args = [];
  let newHandle = row.handle_norm, newEmailNorm = row.email_norm;
  let identityChanged = false;

  if ('social_url' in body || 'handle' in body) {
    const raw = body.social_url != null ? body.social_url : body.handle;
    const h = normHandle(raw);
    if (!h) throw new ApiError(400, 'Enter a valid Instagram profile link or handle');
    if (h !== row.handle_norm) {
      const clash = await env.DB.prepare('SELECT lead_owner FROM entries WHERE handle_norm=? AND id!=?').bind(h, id).first();
      if (clash) throw new ApiError(409, `@${h} is already in the platform (added by ${clash.lead_owner || 'someone'})`);
      // in_master stays tied to the row's source; renaming the handle doesn't change it.
      sets.push('handle_norm=?', 'handle_raw=?', 'social_url=?');
      args.push(h, String(raw || '').trim(), canonicalUrl(h));
      newHandle = h; identityChanged = true;
    }
  }
  if ('email' in body) {
    const emailRaw = String(body.email || '').trim();
    const en = normEmail(emailRaw);
    if (en !== row.email_norm) identityChanged = true;
    sets.push('email=?', 'email_norm=?'); args.push(emailRaw, en);
    newEmailNorm = en;
  }
  if ('first_name' in body) { sets.push('first_name=?'); args.push(String(body.first_name || '').trim()); }
  if ('notes' in body) { sets.push('notes=?'); args.push(String(body.notes || '').trim()); }
  if ('category' in body) { sets.push('category=?'); args.push(String(body.category || '').trim()); }
  if ('lead_owner' in body) {
    const newOwner = String(body.lead_owner || '').trim();
    sets.push('lead_owner=?'); args.push(newOwner);
    // Only when nobody is accountable yet, and only if the new owner is a CRM
    // user. An explicit lead_manager in the same request still wins below.
    if (!('lead_manager' in body)) {
      const m = (await managerResolver(env))(newOwner);
      if (m) { sets.push("lead_manager = CASE WHEN lead_manager='' THEN ? ELSE lead_manager END"); args.push(m); }
    }
  }
  // Manager is the CRM-side teammate accountable for the lead; it defaults to
  // the owner but is deliberately independent, since many owners are not users.
  if ('lead_manager' in body) { sets.push('lead_manager=?'); args.push(String(body.lead_manager || '').trim()); }
  // Pipeline position (node key). Setting a non-empty position also snaps the
  // Stage bucket to that node's stage, unless Stage is being set explicitly too.
  // Any human stage/position edit marks the lead 'manual' so CRM re-syncs skip it.
  if ('position' in body) {
    const pos = String(body.position || '').trim();
    sets.push('position=?'); args.push(pos);
    if (pos && !('stage' in body)) {
      const node = await env.DB.prepare('SELECT stage FROM pipeline_nodes WHERE key=?').bind(pos).first();
      if (node) { sets.push('stage=?'); args.push(node.stage); }
    }
  }
  if ('stage' in body) { sets.push('stage=?'); args.push(String(body.stage || '').trim()); }
  if ('position' in body || 'stage' in body) { sets.push('position_source=?'); args.push('manual'); }
  // Manual stage rate/deliverable fields are stored merged into stage_data JSON.
  const STAGE_FIELDS = ['initial_rate', 'closing_rate', 'counter_offer', 'final_rate', 'our_final_offer',
    'deliverables', 'deliverables_status', 'label', 'status',
    'closing_date', 'contract_signed', 'on_retainer', 'retainer_start_date', 'retainer_months', 'partnership_status',
    'fail_reason', 'fail_details', 'interested', 'not_interested_reason', 'outcome', 'signups', 'saas'];
  let sd = null;
  for (const f of STAGE_FIELDS) if (f in body) { if (!sd) { try { sd = JSON.parse(row.stage_data || '{}'); } catch { sd = {}; } } sd[f] = String(body[f] || '').trim(); }
  if (sd) { sets.push('stage_data=?'); args.push(JSON.stringify(sd)); }
  if ('date' in body) {
    const d = String(body.date || '').trim();
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      sets.push('created_at=?');
      args.push(new Date(Date.parse(d + 'T12:00:00.000+05:30')).toISOString()); // noon IST → exact IST day
    }
  }

  if (identityChanged) {
    // crm_deal intentionally left untouched — deal/rate data is owned by the sync
    // (from conversations); the local signal has none and would blank it.
    const snap = crmSnapshot((await localCrm(env, newEmailNorm, newHandle)).signal);
    sets.push('crm_known=?', 'crm_contacted=?', 'crm_replied=?', 'crm_status=?', 'crm_poc=?',
      'crm_campaigns=?', 'crm_last_contact_at=?', 'crm_last_reply_at=?', 'crm_checked_at=?', 'crm_label=?');
    args.push(snap.crm_known, snap.crm_contacted, snap.crm_replied, snap.crm_status, snap.crm_poc,
      snap.crm_campaigns, snap.crm_last_contact_at, snap.crm_last_reply_at, snap.crm_checked_at, snap.crm_label);
  }

  if (!sets.length) return { ok: true, entry: entryDict(row, env.CRM_URL || ''), unchanged: true };
  args.push(id);
  await env.DB.prepare(`UPDATE entries SET ${sets.join(', ')} WHERE id=?`).bind(...args).run();
  // Two-way sync: reflect this pipeline edit onto the lead's latest conversation
  // so the Unibox shows it, then re-project. Best-effort — the edit already stuck.
  try {
    const convKey = await pushEntryToConversation(env, id, body);
    if (convKey) await relinkConv(env, convKey);
  } catch (e) { /* best effort */ }
  await bumpVersion(env);
  const updated = await env.DB.prepare('SELECT * FROM entries WHERE id=?').bind(id).first();
  return { ok: true, entry: entryDict(updated, env.CRM_URL || '') };
}

async function checkLead(env, body) {
  const handle = normHandle(body.social_url || body.handle || '');
  const email = normEmail(body.email);
  if (!handle && !email) return { handle: '', email, dup: null, in_master: false, crm: null };

  let dup = null, inMaster = false;
  if (handle) {
    const existing = await env.DB.prepare(
      'SELECT id, lead_owner, created_by, created_at, email, source FROM entries WHERE handle_norm=?').bind(handle).first();
    if (existing) {
      dup = { handle, owner: existing.lead_owner, created_by: existing.created_by,
              created_at: existing.created_at, email: existing.email, id: existing.id,
              source: existing.source || 'added' };
      inMaster = existing.source === 'master';
    }
  }
  // Same email already in our DB (under any handle) — an independent "already a
  // lead" signal. Without this, a known email under a new/blank handle looked new.
  let emailDup = null;
  if (email) {
    const byEmail = await env.DB.prepare(
      'SELECT id, handle_norm, lead_owner, created_by, created_at, email, source FROM entries WHERE email_norm=? ORDER BY id LIMIT 1').bind(email).first();
    if (byEmail && (!dup || byEmail.id !== dup.id)) {
      emailDup = { id: byEmail.id, handle: byEmail.handle_norm || '', owner: byEmail.lead_owner,
                   created_by: byEmail.created_by, created_at: byEmail.created_at,
                   email: byEmail.email, source: byEmail.source || 'added' };
      if (byEmail.source === 'master') inMaster = true;
    }
  }
  const crm = await localCrm(env, email, handle);
  const sig = crm ? crm.signal : null;
  return {
    handle, email,
    dup, email_dup: emailDup, in_master: inMaster,
    crm,
    verdict: verdictFor({ dup: !!(dup || emailDup), in_master: inMaster }, sig),
  };
}

/* ── entrypoint ────────────────────────────────────────────── */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        const status = e instanceof ApiError ? e.status : 500;
        return json({ detail: e.message }, status);
      }
    }
    // Non-API paths are served by the static assets binding (the SPA).
    return new Response('Not found', { status: 404 });
  },

  // Instantly sync — one workspace per minute (no-op until an API key is set).
  async scheduled(event, env, ctx) {
    try { await runFullSync(env); }
    catch (e) { console.log('cron sync failed:', e && e.message); }
  },
};
