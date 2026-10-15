/* Platforms: how a lead is identified on each one, and the canonical link to it.

   Instagram is the original and is left exactly as it was. Its handle_norm is
   the bare lowercase handle, so every existing row, the Chrome extension and
   HikerAPI enrichment keep working untouched.

   Every other platform stores "<platform>:<id>" in the same handle_norm column.
   Instagram handles cannot contain ":", so the two can never collide, and the
   existing UNIQUE(handle_norm) constraint becomes "unique per platform" without
   rebuilding the 25,000-row entries table in production.                     */

export const IG = 'instagram';

export const BUILTIN = [
  { key: 'instagram', name: 'Instagram', idLabel: 'Username',  idHint: '@username or instagram.com/…' },
  { key: 'youtube',   name: 'YouTube',   idLabel: 'Channel',   idHint: '@channel or youtube.com/…' },
  { key: 'x',         name: 'X',         idLabel: 'Handle',    idHint: '@handle or x.com/…' },
  { key: 'skool',     name: 'Skool',     idLabel: 'Community', idHint: 'skool.com/community-name' },
];
export const BUILTIN_KEYS = new Set(BUILTIN.map(p => p.key));

// Paths on x.com that are pages, not accounts.
const X_RESERVED = new Set(['home', 'i', 'search', 'explore', 'notifications', 'messages',
  'settings', 'login', 'signup', 'intent', 'share', 'hashtag', 'compose', 'tos', 'privacy']);

const stripUrl = s => String(s || '').trim()
  .replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/^m\./i, '')
  .split(/[?#]/)[0].replace(/\/+$/, '');

/* Turn whatever someone typed into a stable identifier for that platform.
   Returns { id, url } or null when nothing usable is there. `id` is what goes
   after the "<platform>:" prefix; `url` is the canonical profile link. */
export function platformIdentity(platform, raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  if (platform === 'youtube') {
    let m = s.match(/youtube\.com\/(@[\w.\-]+)/i);
    if (m) return { id: m[1].toLowerCase(), url: 'https://www.youtube.com/' + m[1] };
    m = s.match(/youtube\.com\/channel\/(UC[\w\-]{10,})/i);
    // Channel IDs are case-sensitive, so the link keeps the original case.
    if (m) return { id: 'channel/' + m[1].toLowerCase(), url: 'https://www.youtube.com/channel/' + m[1] };
    m = s.match(/youtube\.com\/(c|user)\/([\w.\-]+)/i);
    if (m) return { id: m[1].toLowerCase() + '/' + m[2].toLowerCase(), url: `https://www.youtube.com/${m[1]}/${m[2]}` };
    if (/youtu\.?be/i.test(s)) return null;                 // a video link, not a channel
    const h = s.replace(/^@+/, '').split(/[\s/]/)[0];
    return /^[\w.\-]{2,}$/.test(h) ? { id: '@' + h.toLowerCase(), url: 'https://www.youtube.com/@' + h } : null;
  }

  if (platform === 'x') {
    let h = '';
    const m = s.match(/(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i);
    if (m) h = m[1];
    else if (!/[./]/.test(s.replace(/^@+/, ''))) h = s.replace(/^@+/, '');
    h = h.toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(h) || X_RESERVED.has(h)) return null;
    return { id: h, url: 'https://x.com/' + h };
  }

  if (platform === 'skool') {
    const m = s.match(/skool\.com\/([\w\-]+)/i);
    const slug = (m ? m[1] : s.replace(/^@+/, '').split(/[\s/]/)[0]).toLowerCase();
    if (!/^[\w\-]{2,}$/.test(slug) || slug === 'signup' || slug === 'login') return null;
    return { id: slug, url: 'https://www.skool.com/' + slug };
  }

  // A platform added from the UI: identified by its profile URL.
  const u = stripUrl(s).toLowerCase();
  if (!u || /\s/.test(u)) return null;
  return { id: u, url: 'https://' + stripUrl(s) };
}

/* The value stored in entries.handle_norm. Instagram stays bare; everything
   else is prefixed. `normInstagram` is passed in so this module does not need
   its own copy of the Instagram rules. */
export function handleKey(platform, raw, normInstagram) {
  if (!platform || platform === IG) {
    const h = normInstagram(raw);
    return h ? { key: h, url: h ? 'https://instagram.com/' + h : '', id: h } : null;
  }
  const ident = platformIdentity(platform, raw);
  return ident ? { key: platform + ':' + ident.id, url: ident.url, id: ident.id } : null;
}

/* A lead with no profile identifier yet (created from an email reply on a
   non-Instagram campaign) is keyed by its email, which is unique per platform
   in practice and gets replaced if someone fills in the real profile later. */
export function emailKey(platform, email) {
  const e = String(email || '').trim().toLowerCase();
  return e ? platform + ':email:' + e : '';
}

// What follows the prefix — the part a person recognises.
export function displayId(platform, handleNorm) {
  const s = String(handleNorm || '');
  if (!platform || platform === IG) return s;
  const rest = s.startsWith(platform + ':') ? s.slice(platform.length + 1) : s;
  return rest.startsWith('email:') ? '' : rest;
}

/* Which platform a campaign is for, read from its name. Your names already say
   it — "YT- UGC Coaches", "SKOOL - UGC Communities", "Global IG_SID_Jan".
   Word boundaries matter: "x" alone is a platform, the x in "Max" is not.
   Returns [platform, confident]. */
export function detectCampaignPlatform(name, extra = []) {
  const n = ' ' + String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  if (/ skool(ers)? /.test(n)) return ['skool', true];
  if (/ (yt|youtube) /.test(n)) return ['youtube', true];
  if (/ (x|twitter) /.test(n)) return ['x', true];
  if (/ (ig|insta|instagram|reel|reels) /.test(n)) return ['instagram', true];
  // Platforms added from the UI match on their own name.
  for (const p of extra) {
    const w = String(p.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (w && n.includes(' ' + w + ' ')) return [p.key, true];
  }
  // Every lead held before platforms existed is Instagram, so that is the
  // default — and it is marked unconfirmed so someone can check it.
  return ['instagram', false];
}

// A safe key for a platform added from the UI.
export function slugPlatform(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
}
