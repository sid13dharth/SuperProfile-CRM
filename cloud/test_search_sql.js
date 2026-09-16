/* Execute the SQL the worker ACTUALLY builds, not a reconstruction of it.

   The previous stress test rebuilt the WHERE clause in the test file with the
   correct escaping, so it passed while the worker's own string was broken —
   "ESCAPE '\'" collapses to "ESCAPE ''" in JavaScript and SQLite rejects an
   empty escape character. Extracting the literal from the source is the only
   way that class of bug shows up. */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'src/worker.js'), 'utf8');
const CF = fs.readFileSync(path.join(__dirname, 'cf_token.txt'), 'utf8').trim();

// Pull each `sql += <expr>;` for the two searches and evaluate the expression
// exactly as the worker would.
function fragment(marker) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('marker not found: ' + marker);
  const start = src.lastIndexOf('sql +=', i + marker.length);
  const end = src.indexOf(';', src.indexOf('"', start));
  let expr = src.slice(start + 'sql +='.length, src.indexOf(';', start));
  // The statement may span lines with + concatenation; take through the ');
  expr = src.slice(start + 'sql +='.length, end + 1).replace(/;\s*$/, '');
  return eval(expr);                    // the worker's own string, verbatim
}

const grab = n => {
  const i = src.indexOf('function ' + n + '(');
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
};
const likeTerm = new Function('const PATTERN_MAX=44;' + grab('likeTerm') + ';return likeTerm;')();

const d1 = async (sql, params) => {
  const r = await fetch('https://api.cloudflare.com/client/v4/accounts/b9adbd733b7629f367f66d1dacfd1820/d1/database/7700f30a-bca0-4d06-b460-45cb6ef1fd03/query',
    { method: 'POST', headers: { Authorization: 'Bearer ' + CF, 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, params }) });
  const j = await r.json();
  if (!j.success) return 'ERROR ' + j.errors[0].message.slice(0, 50);
  return j.result[0].results[0].n;
};

(async () => {
  const crm = fragment('handle_norm LIKE ?');
  const ubx = fragment('lower(c.email) LIKE ?');
  console.log('CRM fragment from source :' + crm);
  console.log('Unibox fragment          :' + ubx);
  console.log('');

  let fails = 0;
  const TERMS = ['estheer.ugc', 'meg', 'MEG', 'morefunwithoutit', '50%', 'a_b', 'o\'brien',
    'x'.repeat(60), 'https://instagram.com/estheer.ugc/'];
  console.log('CRM search, running the worker\'s own SQL:');
  for (const t of TERMS) {
    const p = likeTerm(t);
    const n = await d1('SELECT COUNT(*) n FROM entries WHERE 1=1' + crm, [p, p, p]);
    const bad = String(n).startsWith('ERROR');
    if (bad) fails++;
    console.log('  ' + (bad ? 'FAIL ' : ' ok  ') + JSON.stringify(t).slice(0, 40).padEnd(42) + n);
  }
  console.log('\nUnibox search, same:');
  for (const t of ['estheer.ugc', 'meg', '50%']) {
    const p = likeTerm(t);
    const n = await d1('SELECT COUNT(*) n FROM conversations c WHERE 1=1' + ubx, [p, p, p]);
    const bad = String(n).startsWith('ERROR');
    if (bad) fails++;
    console.log('  ' + (bad ? 'FAIL ' : ' ok  ') + JSON.stringify(t).padEnd(42) + n);
  }
  console.log('\nfailures: ' + fails);
  process.exit(fails ? 1 : 0);
})();
