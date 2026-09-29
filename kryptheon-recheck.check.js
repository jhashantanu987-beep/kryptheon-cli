// Checks the fix loop: `npx kryptheon recheck` proves a fix or says it cannot.
// Run with:  node kryptheon-recheck.check.js
//
// The code-read findings go through the real command. Recorded flows are
// driven through kryptheon-look.js with a stand-in replay, so the verdicts can
// be checked without a browser - including the one that matters most: an app
// that did not answer is never read as a fix.

process.env.KRYPTHEON_HOME = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'kryptheon-home-'));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('./kryptheon-store.js');
const looker = require('./kryptheon-look.js');
const dash = require('./kryptheon-dashboard.js');

const CLI = path.join(__dirname, 'bin', 'kryptheon.js');
const results = [];
const check = (name, problems) => results.push({ name, problems });

function project(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"loop","private":true}\n', 'utf8');
  return dir;
}
function write(dir, rel, body) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body, 'utf8');
  const later = new Date(Date.now() + Math.floor(Math.random() * 1000) + 2000);
  fs.utimesSync(path.join(dir, rel), later, later);
}
const cli = (dir, args) => {
  const r = spawnSync(process.execPath, [CLI].concat(args), { cwd: dir, encoding: 'utf8', env: process.env, timeout: 120000 });
  return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
};
const UNSAFE = 'async function o(){ const r = await fetch("/o"); const d = await r.json(); el.innerHTML = `<b>${d.name}</b>`; }\n';
const SAFE = 'async function o(){ const r = await fetch("/o"); const d = await r.json(); el.textContent = d.name; }\n';

/* ---------------------------- the code read ---------------------------- */
const a = project('kryptheon-recheck-');
write(a, 'src/offer.js', UNSAFE);
cli(a, ['verify']);
const listed = cli(a, ['recheck']);
const first = dash.buildState(a).findings.find((f) => f.where.startsWith('src/offer.js'));
const id = first && first.id;

check('1. every open finding is listed with an id, and its prompt ends with how to prove the fix', (() => {
  const p = [];
  if (!first) return ['no finding for src/offer.js'];
  if (!/^[0-9a-f]{8}$/.test(id)) p.push('id ' + id);
  if (listed.out.indexOf(id) === -1) p.push('recheck with no id does not list it');
  if (!/npx kryptheon recheck [0-9a-f]{8}/.test(first.fixPrompt) || first.fixPrompt.indexOf(id) === -1) p.push('the prompt does not end with the re-check to run');
  return p;
})());

const notYet = cli(a, ['recheck', id]);
check('2. re-checked before any fix: STILL OPEN, exit 1', (() => {
  const p = [];
  if (!/VERDICT\s+STILL OPEN/.test(notYet.out)) p.push(notYet.out);
  if (notYet.code !== 1) p.push('exit ' + notYet.code);
  return p;
})());

// The fix - and, in the same change, a new problem somewhere else.
write(a, 'src/offer.js', SAFE);
write(a, 'src/banner.js', UNSAFE.replace('/o', '/b'));
const fixedButNew = cli(a, ['recheck', id]);
check('3. fixed, but the change broke something else: FIXED, the new problem named, exit 1', (() => {
  const p = [];
  if (!/VERDICT\s+FIXED/.test(fixedButNew.out)) p.push('not FIXED');
  if (!/NEW PROBLEMS\s+1/.test(fixedButNew.out) || !/src\/banner\.js/.test(fixedButNew.out)) p.push('the new problem was not named');
  if (fixedButNew.code !== 1) p.push('exit ' + fixedButNew.code + ' although something new broke');
  if (p.length) p.push(fixedButNew.out);
  return p;
})());

const banner = dash.buildState(a).findings.find((f) => f.where.startsWith('src/banner.js'));
fs.unlinkSync(path.join(a, 'src', 'banner.js'));
const deleted = banner ? cli(a, ['recheck', banner.id]) : { out: '', code: null };
check('4. a finding whose file was deleted is GONE WITH ITS FILE - never FIXED', (() => {
  const p = [];
  if (!banner) return ['no banner finding to re-check'];
  if (!/GONE WITH ITS FILE/.test(deleted.out)) p.push(deleted.out);
  if (/VERDICT\s+FIXED/.test(deleted.out)) p.push('deleting the file was called FIXED');
  if (deleted.code !== 1) p.push('exit ' + deleted.code);
  return p;
})());

const unknown = cli(a, ['recheck', 'deadbeef']);
check('5. an id that is not open is refused, not guessed at', (() => {
  const p = [];
  if (unknown.code !== 1) p.push('exit ' + unknown.code);
  if (!/no open finding with the id deadbeef/.test(unknown.out)) p.push(unknown.out);
  return p;
})());

check('6. every attempt is kept, and a proven fix is listed once its finding is gone', (() => {
  const kept = store.pathsFor(a);
  const lines = fs.existsSync(kept.fixes) ? fs.readFileSync(kept.fixes, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  const p = [];
  if (lines.length !== 3) p.push(lines.length + ' attempts kept, expected 3');
  const verdicts = lines.map((l) => l.verdict).join(',');
  if (verdicts !== 'still open,fixed,gone with its file') p.push('verdicts: ' + verdicts);
  const proven = dash.buildState(a).proven;
  if (!proven.some((x) => x.id === id)) p.push('the proven fix is not listed: ' + JSON.stringify(proven));
  if (proven.some((x) => banner && x.id === banner.id)) p.push('a deleted file is listed as a proven fix');
  return p;
})());

/* -------------------------- the database check ------------------------- */
const b = project('kryptheon-recheck-db-');
const kb = store.open(b);
fs.writeFileSync(kb.nightLast, JSON.stringify({ findings: [{ severity: 'HIGH', status: 'confirmed', table: 'orders', kind: 'exposed', headline: 'Your orders table can be read by anyone.', body: 'I read 2 rows.', fixPrompt: 'Fix it.' }] }), 'utf8');
cli(b, ['verify']);
const dbFinding = dash.buildState(b).findings.find((f) => f.check === 'data');
const dbRun = dbFinding ? cli(b, ['recheck', dbFinding.id]) : { out: '', code: null };
check('7. a check that cannot run here is COULD NOT CONFIRM, exit 2 - never fixed', (() => {
  const p = [];
  if (!dbFinding) return ['no database finding'];
  if (!/COULD NOT CONFIRM - needs your database/.test(dbRun.out)) p.push(dbRun.out);
  if (dbRun.code !== 2) p.push('exit ' + dbRun.code);
  return p;
})());

/* ------------------------ recorded flows, replayed ------------------------ */
// A stand-in replay: it writes a run to the history the way the reporter does,
// and returns the exit code the real replay would.
function flowProject() {
  const dir = project('kryptheon-recheck-flow-');
  write(dir, 'tests/pay.spec.js', '// a recording\n');
  const kept = store.open(dir);
  const run = (status, plain) => fs.appendFileSync(kept.history, JSON.stringify({
    runAt: new Date().toISOString(), status: status === 'passed' ? 'passed' : 'failed',
    passed: status === 'passed' ? 1 : 0, failed: status === 'passed' ? 0 : 1,
    tests: [{ title: 'Pay', status: status, specFile: 'tests/pay.spec.js', failure: status === 'passed' ? undefined : { file: 'tests/pay.spec.js', plainLanguage: plain } }],
  }) + '\n', 'utf8');
  run('failed', 'The page ended up somewhere different than before.');
  looker.look(dir, { frontend: () => ({ ran: true }), regression: () => null }, { replay: false });
  const flowId = dash.buildState(dir).findings.find((f) => f.check === 'regression').id;
  return { dir: dir, run: run, id: flowId };
}
const verdictWith = (outcome) => {
  const f = flowProject();
  const r = looker.recheck(f.dir, {
    frontend: () => ({ ran: true }),
    regression: () => {
      if (outcome === 'down') f.run('failed', 'The page could not be opened - net::ERR_CONNECTION_REFUSED.');
      else if (outcome === 'broken') f.run('failed', 'Could not find the Pay button on the page.');
      else f.run('passed');
      return outcome === 'fixed' ? 0 : 1;
    },
  }, f.id);
  return r;
};

check('8. an app that did not answer is COULD NOT CONFIRM - not still open, and never fixed', (() => {
  const r = verdictWith('down');
  return r.verdict === 'could not confirm' && /did not answer/.test(r.why) ? [] : ['verdict ' + r.verdict + ' (' + r.why + ')'];
})());

check('9. a flow still broken - even in a new way - is STILL OPEN, not fixed-plus-new', (() => {
  const r = verdictWith('broken');
  const p = [];
  if (r.verdict !== 'still open') p.push('verdict ' + r.verdict);
  if (r.newProblems.length) p.push('the same flow was counted as a new problem: ' + JSON.stringify(r.newProblems));
  return p;
})());

check('10. a flow that passes again is FIXED', (() => {
  const r = verdictWith('fixed');
  return r.verdict === 'fixed' && !r.newProblems.length ? [] : ['verdict ' + r.verdict + ', new ' + r.newProblems.length];
})());

let failures = 0;
for (const r of results) {
  if (r.problems.length) {
    failures++;
    console.log('FAIL  ' + r.name);
    r.problems.forEach((x) => console.log('      - ' + String(x).split('\n').join('\n        ')));
  } else {
    console.log('PASS  ' + r.name);
  }
}
console.log('');
if (failures) {
  console.log(failures + ' check(s) failed.');
  process.exit(1);
}
console.log('All ' + results.length + ' fix-loop checks passed.');
