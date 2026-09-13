/* Apply a generated .sql backfill to production D1 over the REST API, in chunks.
   Reports progress and stops on the first bad statement, so a half-applied run
   is visible rather than silent. Transient edge errors are retried.

     node apply_sql.js fix_dates.sql            # 250 statements per request
     node apply_sql.js rollback_dates.sql       # the undo

   Reads the account token from cf_token.txt (gitignored). */
const fs = require('fs');
const path = require('path');
const CF = fs.readFileSync(path.join(__dirname, 'cf_token.txt'), 'utf8').trim();
const URL = 'https://api.cloudflare.com/client/v4/accounts/b9adbd733b7629f367f66d1dacfd1820/d1/database/7700f30a-bca0-4d06-b460-45cb6ef1fd03/query';

const d1 = async sql => {
  for (let attempt = 1; ; attempt++) {
    let r, j;
    try {
      r = await fetch(URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + CF, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql }),
      });
      j = await r.json();
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise(s => setTimeout(s, 1500 * attempt));
      continue;
    }
    if (j.success) return j.result;
    const msg = JSON.stringify(j.errors).slice(0, 300);
    // A transient edge/D1 hiccup is worth a retry; a bad statement is not.
    if (attempt < 4 && /timeout|internal|503|429|overload/i.test(msg)) {
      await new Promise(s => setTimeout(s, 1500 * attempt));
      continue;
    }
    throw new Error(msg);
  }
};

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('usage: node apply_sql.js <file.sql> [chunk]'); process.exit(1); }
  const CHUNK = +(process.argv[3] || 250);
  const lines = fs.readFileSync(file, 'utf8').split('\n')
    .map(l => l.trim()).filter(l => l && !l.startsWith('--'));
  console.log(`${path.basename(file)}: ${lines.length} statements, ${CHUNK} per request`);
  const t0 = Date.now();
  for (let i = 0; i < lines.length; i += CHUNK) {
    await d1(lines.slice(i, i + CHUNK).join('\n'));
    const done = Math.min(i + CHUNK, lines.length);
    if (done % 2500 === 0 || done === lines.length) {
      console.log(`  ${done}/${lines.length}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  }
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
