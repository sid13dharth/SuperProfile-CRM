/* Rebuild cloud/static/unibox/ from the CRM app's own static files.

   The Unibox users actually see is a COPY bundled into this worker and served
   at /unibox/ — the standalone superprofile-crm UI is not what the iframe
   loads. The copy is the original with exactly three deltas, applied here so
   the two cannot silently drift (which is how a fix can land in one and not
   the other):

     index.html  asset paths rewritten to /unibox/...
     style.css   #login-view starts hidden — this app shares the parent's
                 session, so flashing a sign-in screen while /api/me resolves
                 would be wrong
     app.js      copied verbatim

   Run after any change to D:/SuperProfile.claude/crm_platform/cloud/static:
     node sync_unibox.js                                                     */
const fs = require('fs');
const path = require('path');

const SRC = 'D:/SuperProfile.claude/crm_platform/cloud/static';
const DST = path.join(__dirname, 'static', 'unibox');
const must = (c, m) => { if (!c) { console.error('FAILED: ' + m); process.exit(1); } };

for (const f of ['index.html', 'app.js', 'style.css']) {
  must(fs.existsSync(path.join(SRC, f)), 'missing source ' + f);
}

/* ---- app.js: verbatim ---- */
fs.copyFileSync(path.join(SRC, 'app.js'), path.join(DST, 'app.js'));

/* ---- index.html: point the assets at /unibox/ ---- */
let h = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
must(h.includes('href="/style.css"'), 'index.html stylesheet href');
must(h.includes('src="/app.js"'), 'index.html script src');
h = h.replace('href="/style.css"', 'href="/unibox/style.css"')
     .replace('src="/app.js"', 'src="/unibox/app.js"');
fs.writeFileSync(path.join(DST, 'index.html'), h);

/* ---- style.css: keep the login card hidden until showLogin() asks ---- */
let s = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8');
const o = '  position: fixed; inset: 0; display: flex; align-items: center;';
must(s.includes(o), 'style.css #login-view rule');
s = s.replace(o, [
  '  /* Hidden by default so the sign-in screen never flashes while /api/me',
  '     resolves the shared session. showLogin() sets display:flex only when',
  '     the user is genuinely unauthenticated. */',
  '  position: fixed; inset: 0; display: none; align-items: center;',
].join('\n'));
fs.writeFileSync(path.join(DST, 'style.css'), s);

console.log('unibox bundle rebuilt from ' + SRC);
