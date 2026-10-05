// Checks what `kryptheon accept` says when there is nothing it can take.
// Run with:  node kryptheon-accept.check.js
//
// Found on a blind test (HelixOps): a step was broken on purpose, check said
// so, and accept answered "it last matched its saved result" - the opposite
// of what had happened. accept only takes a run that went all the way through
// and finished on a different page; a step that no longer matches is a changed
// flow (record again) or a broken app (check says what to fix).
//
// Through the real command, in a project folder of its own, with the saved
// result and the run history written where the command reads them.

process.env.KRYPTHEON_HOME = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'kryptheon-home-'));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('./kryptheon-store.js');
const baselines = require('./kryptheon-baselines.js');

const CLI = path.join(__dirname, 'bin', 'kryptheon.js');
const KEY = 'tests/board.spec.js :: Board';

const results = [];
const check = (name, problems) => results.push({ name, problems });

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-accept-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }), 'utf8');
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'board.spec.js'), '// recorded\n', 'utf8');
  const paths = store.pathsFor(dir);
  fs.mkdirSync(path.dirname(paths.baselines), { recursive: true });
  fs.writeFileSync(paths.baselines, JSON.stringify({ [KEY]: { url: 'http://127.0.0.1:5179/', title: 'Board' } }), 'utf8');
  return { dir: dir, paths: paths };
}

/** One line of run history, as the reporter appends it. */
function run(status, failure) {
  return JSON.stringify({
    runAt: new Date().toISOString(),
    status: status,
    tests: [Object.assign({ title: 'Board', status: status, specFile: 'tests\\board.spec.js' }, failure ? { failure: failure } : {})],
  });
}

function accept(dir) {
  const r = spawnSync(process.execPath, [CLI, 'accept', 'Board'], { cwd: dir, encoding: 'utf8', env: process.env, timeout: 60000 });
  return { code: r.status, out: (String(r.stdout || '') + String(r.stderr || '')).replace(/\s+/g, ' ') };
}

const broke = { line: 5, file: 'tests\\board.spec.js', plainLanguage: 'Could not find the text "Refresh" on the page.' };

// A run that passed, then one that broke on a step: the last one counts.
const one = project();
fs.writeFileSync(one.paths.history, run('passed') + '\n' + run('failed', broke) + '\n', 'utf8');
const said = accept(one.dir);
check('after a run that broke on a step, it says so - never that it matched', (() => {
  const p = [];
  if (said.code !== 1) p.push('exit ' + said.code);
  if (/last matched its saved result|matched its saved result/.test(said.out)) p.push('it says the run matched: ' + said.out);
  if (said.out.indexOf('its last run broke at line 5 of tests/board.spec.js, before the end (Could not find the text "Refresh" on the page).') < 0) {
    p.push('it does not say where the run broke: ' + said.out);
  }
  if (!/accept only covers a run that went all the way through and finished on a different page/.test(said.out)) p.push('it does not say what accept is for');
  if (!/record it again \(npx kryptheon record\)/.test(said.out)) p.push('it does not say a changed flow is recorded again');
  return p;
})());

// The same history, the other way round: the last run passed.
const two = project();
fs.writeFileSync(two.paths.history, run('failed', broke) + '\n' + run('passed') + '\n', 'utf8');
const matched = accept(two.dir);
check('after a run that passed, it says the run matched its saved result', (() => {
  const p = [];
  if (!/Nothing to accept - its last run matched its saved result\./.test(matched.out)) p.push(matched.out);
  if (/broke/.test(matched.out)) p.push('it talks about a break that is not the last run');
  return p;
})());

// No history at all: it claims neither.
const three = project();
const never = accept(three.dir);
check('with no run on record, it claims neither a match nor a break', (() => {
  const p = [];
  if (!/no run has finished on a different page/.test(never.out)) p.push(never.out);
  if (/matched|broke/.test(never.out)) p.push('it claims something it never saw: ' + never.out);
  return p;
})());

check('a run of another test, or of the same name in another file, is not this one', (() => {
  const p = [];
  const file = path.join(os.tmpdir(), 'kryptheon-accept-history-' + Date.now() + '.jsonl');
  const other = JSON.stringify({ runAt: 'x', tests: [{ title: 'Board', status: 'failed', specFile: 'tests/other.spec.js' }] });
  fs.writeFileSync(file, run('passed') + '\n' + other + '\n', 'utf8');
  const last = baselines.lastRunOf(file, KEY);
  if (!last || last.status !== 'passed') p.push('took ' + JSON.stringify(last));
  fs.rmSync(file, { force: true });
  return p;
})());

for (const p of [one, two, three]) fs.rmSync(p.dir, { recursive: true, force: true });

let failures = 0;
for (const r of results) {
  if (r.problems.length) {
    failures++;
    console.log('FAIL  ' + r.name);
    r.problems.forEach((x) => console.log('      - ' + x));
  } else {
    console.log('PASS  ' + r.name);
  }
}
console.log('');
if (failures) {
  console.log(failures + ' check(s) failed.');
  process.exit(1);
}
console.log('All ' + results.length + ' accept checks passed.');
