/**
 * MERGE Phase 2 — Instantly sync engine, ported from the CRM worker.
 *
 * Faithful port of the CRM's per-minute sync (campaigns → emails → recompute →
 * backfill → enrichment → auto-status → rate extraction), with two additions for
 * the merged model:
 *   - it writes to `conversations` (the CRM `leads` grain: one row per campaign+
 *     email, created only once a lead replies), NOT a separate DB;
 *   - after each sync it LINKS every conversation to a person in `entries`
 *     (by Instagram handle, else email), AUTO-CREATING an entry for any replied
 *     lead not yet sourced, and mirrors the outreach signal onto that entry so
 *     the pipeline/funnel stay live (no snapshot, no drift, no coverage gap).
 *
 * The sync only runs when an Instantly API key exists (env.INSTANTLY_API_KEY or a
 * workspaces row); with no key it is a safe no-op.
 */

const AUTO_POC_NAMES = ['Siddharth', 'Rijul', 'Ahan'];
const SYNC_OVERLAP_MINUTES = 10;
const INSTANTLY_BASE = 'https://api.instantly.ai/api/v2';

const INSTANTLY_LABEL_MAP = {
  '-499': 'Not Relevant',
  '-491': 'DND (REMOVE LEAD)',
  '-490': 'Out of budget',
};

/* ── tiny helpers (self-contained so the module has no import cycle) ── */
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');

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

// Instagram handle normalisation (mirrors worker.js normHandle).
const IG_RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'tv', 'accounts', 'directory']);
function normHandle(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return '';
  const m = s.match(/instagram\.com\/@?([^/?#\s]+)/i);
  if (m) s = m[1];
  else s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  s = s.replace(/^@+/, '').split(/[/?#\s]/)[0].replace(/\/+$/, '').trim().toLowerCase();
  if (IG_RESERVED.has(s)) return '';
  return s;
}
function normEmail(x) { return String(x == null ? '' : x).trim().toLowerCase(); }
function canonicalUrl(h) { return h ? `https://instagram.com/${h}` : ''; }

function getFirstName(subject, email) {
  const m = (subject || '').match(/Paid Partnership\s*[-–]\s*(.+?)\s+[xX]\s+SuperProfile/i);
  if (m) { const n = m[1].trim().split(/\s+/)[0]; return n.charAt(0).toUpperCase() + n.slice(1); }
  const local = (email || '').split('@')[0].split('.')[0].split('+')[0];
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/* ── Instantly API ── */
async function instantlyGet(env, path, params, apiKey) {
  const key = apiKey || env.INSTANTLY_API_KEY;
  const url = new URL(INSTANTLY_BASE + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (r.status === 429) { await new Promise(res => setTimeout(res, 2000)); continue; }
    if (!r.ok) throw new Error(`Instantly GET ${path} -> ${r.status}`);
    return r.json();
  }
  throw new Error(`Instantly GET ${path} rate-limited`);
}
async function instantlyPost(env, path, body, apiKey) {
  const key = apiKey || env.INSTANTLY_API_KEY;
  const r = await fetch(INSTANTLY_BASE + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Instantly POST ${path} -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/* ── workspaces ── */
async function ensureDefaultWorkspace(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) c FROM workspaces').first();
  if (row && row.c > 0) return;
  if (!env.INSTANTLY_API_KEY) return;
  await env.DB.prepare('INSERT INTO workspaces (id, name, api_key, created_at) VALUES (1, ?, ?, ?)')
    .bind('SuperProfile', env.INSTANTLY_API_KEY, nowIso()).run();
}
async function listWorkspaces(env) {
  const { results } = await env.DB.prepare('SELECT id, name, api_key FROM workspaces ORDER BY id').all();
  return results || [];
}
async function wsKey(env, ws) {
  const row = await env.DB.prepare('SELECT api_key FROM workspaces WHERE id=?').bind(ws).first();
  return (row && row.api_key) || env.INSTANTLY_API_KEY;
}

/* ── emails + conversation recompute ── */
function emailUpsertStmt(env, e, ws = 1) {
  const body = e.body || {};
  return env.DB.prepare(
    `INSERT INTO emails (id, campaign_id, lead_email, thread_id, eaccount,
                         ue_type, from_email, to_email, subject, preview,
                         body_html, body_text, timestamp_email, timestamp_created, ws)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       preview=excluded.preview, body_html=excluded.body_html,
       body_text=excluded.body_text, ue_type=excluded.ue_type, ws=excluded.ws`)
    .bind(e.id || '', e.campaign_id || '', (e.lead || '').toLowerCase(), e.thread_id || '',
      e.eaccount || '', Number(e.ue_type || 0), e.from_address_email || '', e.to_address_email_list || '',
      e.subject || '', (e.content_preview || '').slice(0, 300), (body.html || '').slice(0, 500000),
      (body.text || '').slice(0, 200000), e.timestamp_email || '', e.timestamp_created || '', ws);
}

// Rebuild `conversations` rows for a list of "campaignId|leadEmail" pairs.
async function recomputeConversations(env, pairs) {
  const CHUNK = 45;
  const touchedKeys = [];
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const chunk = pairs.slice(i, i + CHUNK).filter(p => p.includes('|'));
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => '?').join(',');
    const { results: rows } = await env.DB.prepare(
      `SELECT campaign_id, lead_email, ue_type, timestamp_email, subject, eaccount, preview, ws
       FROM emails WHERE (campaign_id || '|' || lead_email) IN (${placeholders})
       ORDER BY timestamp_email ASC`).bind(...chunk).all();

    const byPair = new Map(chunk.map(p => [p, []]));
    for (const r of rows) { const l = byPair.get(`${r.campaign_id}|${r.lead_email}`); if (l) l.push(r); }

    const stmts = [];
    for (const [key, list] of byPair) {
      const leadMsgs = list.filter(r => r.ue_type === 2);
      if (!leadMsgs.length) { stmts.push(env.DB.prepare('DELETE FROM conversations WHERE key=?').bind(key)); continue; }
      const j = key.indexOf('|');
      const campaignId = key.slice(0, j);
      const leadEmail = key.slice(j + 1);
      const sent = list.filter(r => r.ue_type === 1 || r.ue_type === 3);
      const latest = list[list.length - 1];
      const latestLeadMsg = leadMsgs[leadMsgs.length - 1];
      const firstReplyAt = leadMsgs[0].timestamp_email;
      const ourAfter = sent.filter(r => r.timestamp_email > firstReplyAt);
      const lastOurMsgAt = ourAfter.length ? ourAfter[ourAfter.length - 1].timestamp_email : '';
      const subject = latest.subject || list[0].subject;
      const eaccount = latest.eaccount || (sent.length ? sent[sent.length - 1].eaccount : '');
      touchedKeys.push(key);
      stmts.push(env.DB.prepare(
        `INSERT INTO conversations (key, campaign_id, email, first_name, subject, preview,
                            eaccount, last_lead_msg_at, last_our_msg_at, last_msg_at,
                            last_msg_ue_type, first_reply_at, msg_count, lead_reply_count, ws, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET
           first_name=excluded.first_name, subject=excluded.subject,
           preview=excluded.preview, eaccount=excluded.eaccount,
           last_lead_msg_at=excluded.last_lead_msg_at, last_our_msg_at=excluded.last_our_msg_at,
           last_msg_at=excluded.last_msg_at, last_msg_ue_type=excluded.last_msg_ue_type,
           first_reply_at=excluded.first_reply_at, msg_count=excluded.msg_count,
           lead_reply_count=excluded.lead_reply_count, ws=excluded.ws, updated_at=excluded.updated_at`)
        .bind(key, campaignId, leadEmail, getFirstName(subject, leadEmail), subject,
              (latestLeadMsg.preview || '').slice(0, 300), eaccount, latestLeadMsg.timestamp_email,
              lastOurMsgAt, latest.timestamp_email, latest.ue_type, firstReplyAt,
              list.length, leadMsgs.length, (list[0].ws || 1), nowIso()));
    }
    if (stmts.length) await env.DB.batch(stmts);
  }
  return touchedKeys;
}

async function runSync(env, ws, apiKey, maxPages = 6) {
  try {
    let startingAfter = null;
    const stmts = [];
    for (let page = 0; page < 25; page++) {
      const data = await instantlyGet(env, '/campaigns', { limit: 100, starting_after: startingAfter }, apiKey);
      const items = data.items || [];
      for (const c of items) stmts.push(env.DB.prepare(
        'INSERT INTO campaigns (id, name, status, ws, created) VALUES (?,?,?,?,?) '
        + 'ON CONFLICT(id) DO UPDATE SET name=excluded.name, status=excluded.status, ws=excluded.ws, created=excluded.created')
        .bind(c.id || '', c.name || '', String(c.status ?? ''), ws, c.timestamp_created || ''));
      if (!data.next_starting_after) break;
      startingAfter = data.next_starting_after;
    }
    if (stmts.length) await env.DB.batch(stmts);
  } catch (e) { console.log('campaign fetch failed:', e.message); }

  const watermark = await metaGet(env, `watermark:${ws}`, '');
  let minTs = null;
  if (watermark) minTs = new Date(Date.parse(watermark) - SYNC_OVERLAP_MINUTES * 60000).toISOString().replace(/\.\d{3}Z$/, '.000Z');

  const touched = new Set();
  let maxCreated = watermark, count = 0, startingAfter = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await instantlyGet(env, '/emails', { limit: 100, sort_order: 'asc', min_timestamp_created: minTs, starting_after: startingAfter }, apiKey);
    const items = data.items || [];
    if (items.length) {
      await env.DB.batch(items.filter(e => e.id).map(e => emailUpsertStmt(env, e, ws)));
      for (const e of items) {
        if (!e.id) continue;
        count++;
        touched.add(`${e.campaign_id || ''}|${(e.lead || '').toLowerCase()}`);
        const tc = e.timestamp_created || '';
        if (tc > maxCreated) maxCreated = tc;
      }
    }
    if (!data.next_starting_after || items.length < 100) break;
    startingAfter = data.next_starting_after;
  }

  const keys = await recomputeConversations(env, [...touched].filter(p => p.split('|')[1]));
  const stmts = [metaSetStmt(env, `last_sync:${ws}`, nowIso()), metaSetStmt(env, 'last_sync', nowIso())];
  if (maxCreated) stmts.push(metaSetStmt(env, `watermark:${ws}`, maxCreated));
  await env.DB.batch(stmts);
  if (keys.length) await linkConversations(env, keys);
  if (touched.size) await bumpVersion(env);
  return count;
}

async function runBackfill(env, ws, apiKey, maxPages = 6) {
  if ((await metaGet(env, `backfill_done:${ws}`, '')) === '1') return 0;
  const target = await metaGet(env, `backfill_target:${ws}`, '');
  let cursor = await metaGet(env, `backfill_cursor:${ws}`, '');
  let startingAfter = null, maxSeen = cursor, count = 0, done = false;
  for (let page = 0; page < maxPages; page++) {
    const data = await instantlyGet(env, '/emails', { limit: 100, sort_order: 'asc', min_timestamp_created: cursor || null, starting_after: startingAfter }, apiKey);
    const items = data.items || [];
    if (items.length) {
      await env.DB.batch(items.filter(e => e.id).map(e => emailUpsertStmt(env, e, ws)));
      count += items.length;
      for (const e of items) { const tc = e.timestamp_created || ''; if (tc > maxSeen) maxSeen = tc; }
    }
    if (!data.next_starting_after || items.length < 100) { done = true; break; }
    if (target && maxSeen >= target) { done = true; break; }
    startingAfter = data.next_starting_after;
  }
  const stmts = [metaSetStmt(env, `backfill_cursor:${ws}`, maxSeen)];
  if (done) stmts.push(metaSetStmt(env, `backfill_done:${ws}`, '1'));
  await env.DB.batch(stmts);
  return count;
}

async function runBodyBackfill(env, ws, apiKey, max = 10) {
  const { results } = await env.DB.prepare(
    `SELECT id FROM emails WHERE ws=? AND body_html='' AND body_text='' AND body_checked=0
     ORDER BY CASE ue_type WHEN 2 THEN 0 WHEN 3 THEN 1 ELSE 2 END, timestamp_email DESC LIMIT ?`).bind(ws, max).all();
  if (!results.length) return 0;
  const stmts = []; let filled = 0;
  for (const row of results) {
    let e;
    try { e = await instantlyGet(env, `/emails/${row.id}`, null, apiKey); }
    catch (err) { if (/-> 4\d\d/.test(err.message || '')) stmts.push(env.DB.prepare('UPDATE emails SET body_checked=1 WHERE id=?').bind(row.id)); continue; }
    const b = (e && e.body) || {};
    if (b.html || b.text) {
      stmts.push(env.DB.prepare('UPDATE emails SET body_html=?, body_text=?, preview=?, body_checked=1 WHERE id=?')
        .bind(b.html || '', b.text || '', (e.content_preview || '').slice(0, 300), row.id));
      filled++;
    } else stmts.push(env.DB.prepare('UPDATE emails SET body_checked=1 WHERE id=?').bind(row.id));
  }
  if (stmts.length) { await env.DB.batch(stmts); await bumpVersion(env); }
  return filled;
}

/* ── enrichment + auto-POC ── */
function extractSocial(payload) {
  if (!payload || typeof payload !== 'object') return '';
  for (const k of ['Primary Social Profile', 'primary_social_profile', 'primarySocialProfile']) {
    const v = payload[k];
    if (typeof v === 'string' && v.startsWith('http')) return v.trim();
  }
  for (const [k, v] of Object.entries(payload)) {
    const lk = k.toLowerCase();
    if (typeof v === 'string' && v.startsWith('http') && (lk.includes('social') || lk.includes('instagram') || lk.includes('tiktok') || lk.includes('youtube'))) return v.trim();
  }
  return '';
}
function extractOwner(payload) {
  if (!payload || typeof payload !== 'object') return '';
  for (const k of ['Lead Owner', 'leadOwner', 'lead_owner', 'owner']) if (typeof payload[k] === 'string') return payload[k].trim();
  return '';
}
async function pocCounts(env) {
  const counts = Object.fromEntries(AUTO_POC_NAMES.map(n => [n, 0]));
  const q = AUTO_POC_NAMES.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT poc, COUNT(*) c FROM conversations WHERE poc IN (${q}) GROUP BY poc`).bind(...AUTO_POC_NAMES).all();
  for (const r of results) counts[r.poc] = r.c;
  return counts;
}
async function runEnrich(env, ws, apiKey, maxEmails = 40) {
  const { results } = await env.DB.prepare('SELECT DISTINCT email FROM conversations WHERE ws=? AND enriched=0 LIMIT ?').bind(ws, maxEmails).all();
  const emails = results.map(r => r.email);
  if (!emails.length) return 0;
  let items = [];
  try {
    const data = await instantlyPost(env, '/leads/list', { contacts: emails, limit: 100 }, apiKey);
    items = data.items || [];
    if (data.next_starting_after && items.length === 100) {
      const more = await instantlyPost(env, '/leads/list', { contacts: emails, limit: 100, starting_after: data.next_starting_after }, apiKey);
      items = items.concat(more.items || []);
    }
  } catch (e) { console.log('enrich failed:', e.message); return 0; }

  const byKey = {}, byEmailBest = {}, bestTs = {};
  for (const item of items) {
    const em = (item.email || '').toLowerCase();
    const camp = item.campaign || '';
    const social = extractSocial(item.payload);
    const owner = extractOwner(item.payload);
    const label = INSTANTLY_LABEL_MAP[String(item.lt_interest_status)] || '';
    const ts = item.timestamp_created || '';
    if (camp) { const prev = byKey[`${camp}|${em}`] || ['', '', '']; byKey[`${camp}|${em}`] = [prev[0] || social, prev[1] || owner, prev[2] || label]; }
    const fb = byEmailBest[em] || ['', '', '']; fb[1] = fb[1] || owner; fb[2] = fb[2] || label;
    if (social && ts >= (bestTs[em] || '')) { fb[0] = social; bestTs[em] = ts; }
    byEmailBest[em] = fb;
  }

  const counts = await pocCounts(env);
  const { results: leadRows } = await env.DB.prepare(
    `SELECT key, email, campaign_id, poc, label FROM conversations WHERE ws=? AND email IN (${emails.map(() => '?').join(',')})`).bind(ws, ...emails).all();
  const byEmail = new Map();
  for (const r of leadRows) { if (!byEmail.has(r.email)) byEmail.set(r.email, []); byEmail.get(r.email).push(r); }

  const now = nowIso();
  const stmts = [];
  for (const r of leadRows) {
    const em = (r.email || '').toLowerCase();
    const camp = byKey[`${r.campaign_id}|${em}`] || ['', '', ''];
    const fb = byEmailBest[em] || ['', '', ''];
    const social = camp[0] || fb[0], owner = camp[1] || fb[1], label = camp[2] || fb[2];
    stmts.push(env.DB.prepare('UPDATE conversations SET social_url=?, handle_norm=?, lead_owner=?, enriched=1, label_checked=1 WHERE key=?')
      .bind(social, normHandle(social), owner, r.key));
    if (label) stmts.push(env.DB.prepare("UPDATE conversations SET label=? WHERE key=? AND label=''").bind(label, r.key));
  }
  for (const em of emails) {
    const owner = (byEmailBest[em.toLowerCase()] || ['', '', ''])[1];
    const rows = byEmail.get(em) || [];
    const unassigned = rows.filter(r => !r.poc).map(r => r.key);
    if (!unassigned.length) continue;
    let poc = AUTO_POC_NAMES.find(n => n.toLowerCase() === (owner || '').trim().toLowerCase()) || '';
    if (!poc) poc = (rows.find(r => r.poc) || {}).poc || '';
    if (!poc) { const low = Math.min(...Object.values(counts)); const lowest = AUTO_POC_NAMES.filter(n => counts[n] === low); poc = lowest[Math.floor(Math.random() * lowest.length)]; }
    counts[poc] = (counts[poc] || 0) + unassigned.length;
    for (const key of unassigned) {
      stmts.push(env.DB.prepare('UPDATE conversations SET poc=?, updated_at=? WHERE key=?').bind(poc, now, key));
      stmts.push(env.DB.prepare('INSERT INTO activity (lead_key, author, kind, detail, created_at) VALUES (?,?,?,?,?)').bind(key, 'Auto', 'poc_change', `auto-assigned to ${poc}`, now));
    }
  }
  await env.DB.batch(stmts);
  await bumpVersion(env);
  // Newly-enriched rows now have social/handle → link them to people.
  await linkConversations(env, leadRows.map(r => r.key));
  return emails.length;
}

async function runLabelBackfill(env, ws, apiKey, maxEmails = 60) {
  const { results } = await env.DB.prepare('SELECT DISTINCT email FROM conversations WHERE ws=? AND label_checked=0 LIMIT ?').bind(ws, maxEmails).all();
  const emails = results.map(r => r.email);
  if (!emails.length) return 0;
  let items = [];
  try {
    const data = await instantlyPost(env, '/leads/list', { contacts: emails, limit: 100 }, apiKey);
    items = data.items || [];
    if (data.next_starting_after && items.length === 100) {
      const more = await instantlyPost(env, '/leads/list', { contacts: emails, limit: 100, starting_after: data.next_starting_after }, apiKey);
      items = items.concat(more.items || []);
    }
  } catch (e) { console.log('label backfill failed:', e.message); return 0; }
  const labelByEmail = {};
  for (const item of items) { const em = (item.email || '').toLowerCase(); const label = INSTANTLY_LABEL_MAP[String(item.lt_interest_status)] || ''; if (label && !labelByEmail[em]) labelByEmail[em] = label; }
  const stmts = [];
  for (const em of emails) {
    const label = labelByEmail[em.toLowerCase()];
    if (label) stmts.push(env.DB.prepare("UPDATE conversations SET label=?, label_checked=1 WHERE ws=? AND email=? AND label=''").bind(label, ws, em));
    stmts.push(env.DB.prepare('UPDATE conversations SET label_checked=1 WHERE ws=? AND email=?').bind(ws, em));
  }
  await env.DB.batch(stmts);
  await bumpVersion(env);
  return emails.length;
}

/* ── auto-status detection ── */
function currencyClause(col) {
  const parts = [];
  for (const sym of ['₹', '$', '€', '£']) { parts.push(`${col} GLOB '*${sym}[0-9]*'`); parts.push(`${col} GLOB '*${sym} [0-9]*'`); }
  return parts.join(' OR ');
}
const USD_PER = { '$': 1, '₹': 1 / 83, '€': 1.08, '£': 1.27, 'C$': 0.73, 'A$': 0.66 };
function stripQuotes(text) {
  const t = String(text || '').replace(/\r/g, '');
  const cuts = [
    /\n\s*On\b[^\n]*\bwrote:\s*(\n|$)/i, /\n-{2,}\s*Original Message\s*-{2,}/i, /\n_{5,}/,
    /\nFrom:\s?[^\n]+\n(?:Sent|Date|To):\s?[^\n]+/i, /\n\s*>{1,}\s?[^\n]*/, /\nSent from my [^\n]*/i, /\nGet Outlook for [^\n]*/i,
  ];
  let cut = t.length;
  for (const re of cuts) { const m = t.match(re); if (m && m.index < cut) cut = m.index; }
  return t.slice(0, cut);
}
const UNIT_MAP = {
  reel: 'reel', reels: 'reel', video: 'video', videos: 'video', vid: 'video', vids: 'video',
  carousel: 'carousel', carousels: 'carousel', post: 'post', posts: 'post', story: 'story', stories: 'story',
  content: 'content', collab: 'collab', collabs: 'collab', collaboration: 'collab', deliverable: 'deliverable',
  deliverables: 'deliverable', photo: 'photo', photos: 'photo', clip: 'clip', clips: 'clip', short: 'short', shorts: 'short',
};
const NUM_WORD = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, few: 3 };
const UNIT_RE = Object.keys(UNIT_MAP).sort((a, b) => b.length - a.length).join('|');
const NUM_TOK = '\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|couple|few';
const RX_FWD = new RegExp(`^\\s*(?:for\\s+)?(?:the\\s+)?(${NUM_TOK})\\s+(${UNIT_RE})\\b`, 'i');
const RX_FWD_PER = new RegExp(`^\\s*(?:for\\s+)?(?:a|an|each|per)\\s+(${UNIT_RE})\\b`, 'i');
const RX_FWD_SLASH = new RegExp(`^\\s*(?:\\/|per\\s+)(${UNIT_RE})\\b`, 'i');
const RX_FWD_BARE = new RegExp(`^\\s*for\\s+(?:the\\s+)?(${UNIT_RE})\\b`, 'i');
const RX_BACK = new RegExp(`(${NUM_TOK})\\s+(${UNIT_RE})\\s*(?:for|at|=|:|-|,)?\\s*$`, 'i');
const numOf = w => NUM_WORD[w.toLowerCase()] ?? parseInt(w, 10);
function parseQuotes(text) {
  if (!text) return [];
  const t = text.replace(/\s+/g, ' ');
  const re = /([₹$€£])\s?([0-9][0-9,]*(?:\.[0-9]+)?)\s?([kK])?/g;
  const out = []; let m;
  while ((m = re.exec(t)) !== null) {
    let amt = parseFloat(m[2].replace(/,/g, ''));
    if (m[3]) amt *= 1000;
    if (!isFinite(amt) || amt <= 0) continue;
    const cur = m[1];
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 45);
    const before = t.slice(Math.max(0, m.index - 35), m.index);
    let qty = null, unit = null, mm;
    if ((mm = after.match(RX_FWD))) { qty = numOf(mm[1]); unit = UNIT_MAP[mm[2].toLowerCase()]; }
    else if ((mm = after.match(RX_FWD_PER))) { qty = 1; unit = UNIT_MAP[mm[1].toLowerCase()]; }
    else if ((mm = after.match(RX_FWD_SLASH))) { qty = 1; unit = UNIT_MAP[mm[1].toLowerCase()]; }
    else if ((mm = after.match(RX_FWD_BARE))) { qty = 1; unit = UNIT_MAP[mm[1].toLowerCase()]; }
    else if ((mm = before.match(RX_BACK))) { qty = numOf(mm[1]); unit = UNIT_MAP[mm[2].toLowerCase()]; }
    if (!unit || !qty || !isFinite(qty) || qty < 1) { qty = 1; unit = 'flat'; }
    const fx = USD_PER[cur] || 1;
    out.push({ cur, total: amt, qty, unit, totalUsd: amt * fx, perUnitUsd: (amt / qty) * fx });
  }
  return out;
}
async function runRateExtraction(env) {
  const { results } = await env.DB.prepare(
    `SELECT campaign_id, lead_email, body_text, body_html FROM emails
     WHERE ue_type=2 AND (${currencyClause('body_text')} OR ${currencyClause('body_html')})`).all();
  const byLead = new Map();
  for (const r of results) {
    let src;
    if (r.body_text && r.body_text.trim()) src = r.body_text;
    else src = (r.body_html || '').replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, ' ');
    const quotes = parseQuotes(stripQuotes(src));
    if (!quotes.length) continue;
    const key = `${r.campaign_id}|${r.lead_email}`;
    if (!byLead.has(key)) byLead.set(key, []);
    byLead.get(key).push(...quotes);
  }
  await env.DB.prepare(
    `UPDATE conversations SET quoted_currency='', quoted_amount=NULL, quoted_usd=NULL, quoted_all='',
       quoted_qty=NULL, quoted_unit='', quoted_per_unit_usd=NULL
     WHERE quoted_usd IS NOT NULL AND quoted_source != 'manual'`).run();
  const stmts = [];
  for (const [key, quotes] of byLead) {
    const low = quotes.reduce((a, b) => (b.perUnitUsd < a.perUnitUsd ? b : a));
    const all = quotes.slice().sort((a, b) => a.perUnitUsd - b.perUnitUsd).map(q => ({ c: q.cur, t: q.total, q: q.qty, u: q.unit, pu: Math.round(q.perUnitUsd), tu: Math.round(q.totalUsd) }));
    stmts.push(env.DB.prepare(
      `UPDATE conversations SET quoted_currency=?, quoted_amount=?, quoted_usd=?, quoted_all=?,
         quoted_qty=?, quoted_unit=?, quoted_per_unit_usd=?, quoted_source='auto'
       WHERE key=? AND quoted_source != 'manual'`)
      .bind(low.cur, low.total, Math.round(low.totalUsd), JSON.stringify(all), low.qty, low.unit, Math.round(low.perUnitUsd), key));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await bumpVersion(env);
  return byLead.size;
}
async function runAutoStatus(env) {
  const now = nowIso();
  try { await runRateExtraction(env); } catch (e) { console.log('rate extract:', e.message); }
  await env.DB.prepare(`UPDATE conversations SET status='', status_source='', updated_at=? WHERE status='rates_quoted' AND status_source='auto' AND quoted_usd IS NULL`).bind(now).run();
  const rates = await env.DB.prepare(`UPDATE conversations SET status='rates_quoted', status_source='auto', updated_at=? WHERE status='' AND quoted_usd IS NOT NULL`).bind(now).run();
  const wa = await env.DB.prepare(
    `UPDATE conversations SET status='moved_to_wa', status_source='auto', updated_at=?
     WHERE status='' AND EXISTS (SELECT 1 FROM emails e WHERE e.campaign_id = conversations.campaign_id AND e.lead_email = conversations.email
       AND e.ue_type = 2 AND (lower(e.body_text) LIKE '%whatsapp%' OR e.body_text LIKE '%wa.me/%' OR lower(e.body_html) LIKE '%whatsapp%' OR e.body_html LIKE '%wa.me/%'))`).bind(now).run();
  const pitch = await env.DB.prepare(
    `UPDATE conversations SET status='call_pitched', status_source='auto', updated_at=?
     WHERE status='' AND EXISTS (SELECT 1 FROM emails e WHERE e.campaign_id = conversations.campaign_id AND e.lead_email = conversations.email
       AND e.ue_type IN (1, 3) AND (e.body_text LIKE '%superprofile.bio/bookings/%' OR e.body_html LIKE '%superprofile.bio/bookings/%'
         OR e.body_text LIKE '%calendly.com%' OR e.body_html LIKE '%calendly.com%' OR e.body_text LIKE '%cal.com%' OR e.body_html LIKE '%cal.com%'
         OR e.body_text LIKE '%meet.google.com%' OR e.body_html LIKE '%meet.google.com%' OR e.body_text LIKE '%zoom.us%' OR e.body_html LIKE '%zoom.us%'
         OR e.body_text LIKE '%calendso%' OR e.body_html LIKE '%calendso%'))`).bind(now).run();
  const changed = (rates.meta.changes || 0) + (wa.meta.changes || 0) + (pitch.meta.changes || 0);
  if (changed) await bumpVersion(env);
  return changed;
}

/* ── link conversations → people (entries), and mirror the pipeline ──
 * This is the merge glue. For each conversation it: persists handle_norm,
 * finds/creates the entries person (by handle, else email), and refreshes that
 * person's outreach signal + auto pipeline placement from ALL their conversations.
 */

// CRM status → suggested {stage, position} (mirror of worker.js crmSuggest).
function crmSuggest(status, label) {
  const s = (status || '').toLowerCase(), l = (label || '').toLowerCase();
  if (s === 'closed') return { stage: 'Closed', position: '' };
  if (s === 'failed' || s === 'partner_of_competitor') return { stage: 'Failed', position: 'Failed/other' };
  if (l === 'out of budget') return { stage: 'Failed', position: 'Failed/out_of_budget' };
  if (s === 'rates_quoted') return { stage: 'Responses', position: 'Responses/interested/relevant/rates_quoted' };
  if (s === 'call_booked') return { stage: 'Responses', position: 'Responses/interested/relevant/call_booked' };
  if (s === 'call_pitched') return { stage: 'Responses', position: 'Responses/interested/relevant/call_pitched' };
  if (s === 'moved_to_wa') return { stage: 'Responses', position: 'Responses/interested/relevant' };
  if (s === 'not_relevant' || l === 'not relevant' || l === 'dnd (remove lead)') return { stage: 'Responses', position: 'Responses/interested/notrelevant' };
  return null;
}
// Which single status is "furthest" when a person has several conversations.
const STATUS_RANK = ['closed', 'rates_quoted', 'call_booked', 'call_pitched', 'moved_to_wa', 'failed', 'partner_of_competitor', 'not_relevant', ''];
function furthest(a, b) { return STATUS_RANK.indexOf(a) <= STATUS_RANK.indexOf(b) ? a : b; }

async function linkConversations(env, keys) {
  keys = [...new Set((keys || []).filter(Boolean))];
  if (!keys.length) return;
  const affectedEntries = new Set();
  for (let i = 0; i < keys.length; i += 40) {
    const chunk = keys.slice(i, i + 40);
    const ph = chunk.map(() => '?').join(',');
    const { results: convs } = await env.DB.prepare(
      `SELECT key, email, social_url, handle_norm, entry_id, first_name, lead_owner FROM conversations WHERE key IN (${ph})`).bind(...chunk).all();
    for (const c of convs) {
      const handle = c.handle_norm || normHandle(c.social_url);
      const emailNorm = normEmail(c.email);
      // Find the person: handle first (unique), then email.
      let entry = null;
      if (handle) entry = await env.DB.prepare('SELECT id FROM entries WHERE handle_norm=?').bind(handle).first();
      if (!entry && emailNorm) entry = await env.DB.prepare("SELECT id FROM entries WHERE email_norm=? ORDER BY id LIMIT 1").bind(emailNorm).first();
      let entryId = entry ? entry.id : 0;
      if (!entryId && handle) {
        // Auto-create the person from the conversation (closes the coverage gap).
        const res = await env.DB.prepare(
          `INSERT INTO entries (handle_norm, handle_raw, social_url, email, email_norm, first_name, lead_owner, created_by, created_at, source, in_master, stage, position, position_source, crm_campaigns)
           VALUES (?,?,?,?,?,?,?,'', ?, 'crm', 0, 'Responses', '', 'auto', '[]') ON CONFLICT(handle_norm) DO NOTHING`)
          .bind(handle, c.social_url || canonicalUrl(handle), canonicalUrl(handle), c.email || '', emailNorm, c.first_name || '', c.lead_owner || '', nowIso()).run();
        const got = await env.DB.prepare('SELECT id FROM entries WHERE handle_norm=?').bind(handle).first();
        entryId = got ? got.id : 0;
      }
      if (entryId && entryId !== c.entry_id) await env.DB.prepare('UPDATE conversations SET entry_id=? WHERE key=?').bind(entryId, c.key).run();
      if (entryId && (c.handle_norm !== handle) && handle) await env.DB.prepare('UPDATE conversations SET handle_norm=? WHERE key=?').bind(handle, c.key).run();
      if (entryId) affectedEntries.add(entryId);
    }
  }
  await syncEntriesFromConversations(env, [...affectedEntries]);
}

// Refresh each person's outreach mirror + auto pipeline placement from their
// conversations. Never overrides a manual pipeline classification.
async function syncEntriesFromConversations(env, entryIds) {
  for (const id of entryIds) {
    const { results: convs } = await env.DB.prepare(
      `SELECT campaign_id, status, label, poc, quoted_usd, rate_their_initial, rate_their_final, rate_our_final, deal_deliverables, deal_budget,
              fail_reason, fail_notes, last_lead_msg_at, last_our_msg_at FROM conversations WHERE entry_id=?`).bind(id).all();
    if (!convs.length) continue;
    let status = '', label = '', poc = '', lastReply = '', lastContact = '';
    const camps = new Set();
    for (const c of convs) {
      status = furthest(status, (c.status || '').toLowerCase());
      if (!label && c.label) label = c.label;
      if (!poc && c.poc) poc = c.poc;
      if (c.campaign_id) camps.add(c.campaign_id);
      if (c.last_lead_msg_at > lastReply) lastReply = c.last_lead_msg_at;
      if (c.last_our_msg_at > lastContact) lastContact = c.last_our_msg_at;
    }
    // Campaign display names.
    let campNames = [];
    if (camps.size) {
      const ids = [...camps]; const ph = ids.map(() => '?').join(',');
      const { results: cn } = await env.DB.prepare(`SELECT name FROM campaigns WHERE id IN (${ph})`).bind(...ids).all();
      campNames = cn.map(r => r.name).filter(Boolean);
    }
    const deal = convs.find(c => c.rate_their_initial || c.rate_their_final || c.rate_our_final || c.deal_deliverables) || {};
    const crmDeal = JSON.stringify({
      their_initial: deal.rate_their_initial || '', their_final: deal.rate_their_final || '',
      our_final: deal.rate_our_final || '', deliverables: deal.deal_deliverables || '', budget: deal.deal_budget || '',
    });
    // Carry the Unibox close/fail form's failure reason onto the person so it
    // lands in the CRM's Failed "Reason" column (out_of_budget → "Out of budget").
    const failedConv = convs.find(c => c.fail_reason) || {};
    const failReason = failedConv.fail_reason === 'out_of_budget' ? 'Out of budget'
      : (failedConv.fail_reason ? 'Other reasons' : '');
    const failDetails = failReason ? (failedConv.fail_notes || '') : '';
    const sug = crmSuggest(status, label);
    const autoStage = sug ? sug.stage : 'Responses';
    let autoPos = sug ? sug.position : '';
    // Reason for failure = the Failed sub-node; derive it from the conversation's
    // fail_reason so a Unibox "out of budget" fail lands in that node (not Other).
    if (status === 'failed') autoPos = failedConv.fail_reason === 'out_of_budget' ? 'Failed/out_of_budget' : 'Failed/other';
    await env.DB.prepare(
      `UPDATE entries SET crm_known=1, crm_contacted=1, crm_replied=1, crm_status=?, crm_label=?, crm_poc=?,
         crm_campaigns=?, crm_deal=?, crm_last_reply_at=?, crm_last_contact_at=?, crm_checked_at=?,
         stage_data = CASE WHEN position_source!='manual' AND ? != ''
                        THEN json_set(CASE WHEN json_valid(stage_data) THEN stage_data ELSE '{}' END, '$.fail_reason', ?, '$.fail_details', ?)
                        ELSE stage_data END,
         stage = CASE WHEN position_source!='manual' THEN ? ELSE stage END,
         position = CASE WHEN position_source!='manual' THEN ? ELSE position END
       WHERE id=?`)
      .bind(status, label, poc, JSON.stringify(campNames), crmDeal, lastReply, lastContact, nowIso(),
        failReason, failReason, failDetails, autoStage, autoPos, id).run();
  }
}

/* ── top-level ticks ── */
async function runFullSync(env) {
  await ensureDefaultWorkspace(env);
  const workspaces = await listWorkspaces(env);
  if (!workspaces.length) return { ok: false, reason: 'no Instantly workspace/key configured' };
  // Round-robin one workspace per tick (mirrors the CRM cron).
  const idx = parseInt(await metaGet(env, 'cron_ws_idx', '0'), 10) || 0;
  const ws = workspaces[idx % workspaces.length];
  await metaSetStmt(env, 'cron_ws_idx', String((idx + 1) % workspaces.length)).run();
  const key = ws.api_key || env.INSTANTLY_API_KEY;
  const out = {};
  try { out.synced = await runSync(env, ws.id, key, 6); } catch (e) { out.syncError = e.message; }
  try { out.backfilled = await runBackfill(env, ws.id, key, 6); } catch (e) { out.backfillError = e.message; }
  try { out.bodies = await runBodyBackfill(env, ws.id, key, 10); } catch (e) { out.bodyError = e.message; }
  try { out.enriched = await runEnrich(env, ws.id, key, 40); } catch (e) { out.enrichError = e.message; }
  try { out.labels = await runLabelBackfill(env, ws.id, key, 60); } catch (e) { out.labelError = e.message; }
  try { out.autoStatus = await runAutoStatus(env); } catch (e) { out.autoStatusError = e.message; }
  // Re-sync entries for everything auto-status just changed (status → pipeline).
  try {
    const { results } = await env.DB.prepare("SELECT DISTINCT entry_id FROM conversations WHERE entry_id!=0").all();
    await syncEntriesFromConversations(env, results.map(r => r.entry_id));
  } catch (e) { out.entrySyncError = e.message; }
  out.ws = ws.id;
  return out;
}

// Manual single-workspace sync (for a /api/sync button later).
async function runManualSync(env, ws) {
  const key = await wsKey(env, ws);
  const synced = await runSync(env, ws, key, 12);
  await runBodyBackfill(env, ws, key, 20);
  await runLabelBackfill(env, ws, key, 60);
  await runAutoStatus(env);
  const { results } = await env.DB.prepare("SELECT DISTINCT entry_id FROM conversations WHERE entry_id!=0").all();
  await syncEntriesFromConversations(env, results.map(r => r.entry_id));
  return synced;
}

export {
  runFullSync, runManualSync, ensureDefaultWorkspace, listWorkspaces, wsKey,
  recomputeConversations, linkConversations, syncEntriesFromConversations,
  emailUpsertStmt, crmSuggest, INSTANTLY_LABEL_MAP, AUTO_POC_NAMES,
  instantlyPost, runRateExtraction, runBodyBackfill, USD_PER,
};
