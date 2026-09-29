// Checks `npx kryptheon verify` through the real command, in a throwaway
// project with a scratch store. Run with:  node kryptheon-verify.check.js
//
// No recordings, so no browser: what is checked here is what verify says
// about change - what changed, what broke, what was fixed, what was merely
// deleted - and the exit code an AI tool will read.

process.env.KRYPTHEON_HOME = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'kryptheon-home-'));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('./kryptheon-store.js');

const CLI = path.join(__dirname, 'bin', 'kryptheon.js');
const results = [];
const check = (name, problems) => results.push({ name, problems });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-verify-'));
const write = (rel, body) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body, 'utf8');
  // A real save moves the modified time; make sure it does here too.
  const later = new Date(Date.now() + Math.floor(Math.random() * 1000) + 2000);
  fs.utimesSync(path.join(dir, rel), later, later);
};
const run = () => {
  const r = spawnSync(process.execPath, [CLI, 'verify'], { cwd: dir, encoding: 'utf8', env: process.env, timeout: 120000 });
  return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
};

write('package.json', '{"name":"verify-demo","private":true}\n');
write('src/app.js', 'export const n = 1;\n');
write('.env', 'SECRET_TOKEN=never-keep-this\n');
const before = fs.readdirSync(dir).sort().join(',');
const kept = store.pathsFor(dir);

const first = run();
check('1. the first look says it is the starting point, and keeps a snapshot in the store', (() => {
  const p = [];
  if (first.code !== 0) p.push('exit ' + first.code);
  if (!/First look at this project/.test(first.out)) p.push('it did not say it was the first look');
  if (/WHAT BROKE/.test(first.out)) p.push('a first look reported breakage');
  if (!fs.existsSync(kept.snapshot)) p.push('no snapshot was kept');
  if (fs.existsSync(kept.snapshot) && /never-keep-this|SECRET_TOKEN/.test(fs.readFileSync(kept.snapshot, 'utf8'))) p.push('the .env content reached the snapshot');
  if (fs.existsSync(kept.snapshot) && /"\.env"/.test(fs.readFileSync(kept.snapshot, 'utf8'))) p.push('.env was listed in the snapshot');
  if (!/regression\s+no recordings yet/.test(first.out)) p.push('it did not say there are no recordings to replay');
  if (p.length) p.push(first.out);
  return p;
})());

// An AI-style change: a new file that puts a server value into the page, a docs edit.
write('src/offer.js', 'async function o(){ const r = await fetch("/o"); const d = await r.json(); el.innerHTML = `<b>${d.name}</b>`; }\n');
write('README.md', '# demo\n');
const second = run();
check('2. a change is listed by part, the checks it calls for run, and what is new is named', (() => {
  const p = [];
  if (!/WHAT CHANGED\s+2 files/.test(second.out)) p.push('WHAT CHANGED does not count 2 files');
  if (!/frontend\s+[\s\S]*added\s+src\/offer\.js/.test(second.out)) p.push('src/offer.js is not listed as an added frontend file');
  if (!/docs\s+[\s\S]*added\s+README\.md/.test(second.out)) p.push('README.md is not listed under docs');
  if (!/frontend\s+ran/.test(second.out)) p.push('the frontend read did not run');
  if (!/WHAT BROKE\s+1 new/.test(second.out)) p.push('the new finding was not reported as new');
  if (!/src\/offer\.js:1/.test(second.out)) p.push('the new finding is not located');
  // Only a finding that needs verification: nothing confirmed is broken.
  if (second.code !== 0) p.push('exit ' + second.code + ' although nothing confirmed is broken');
  if (p.length) p.push(second.out);
  return p;
})());

const third = run();
check('3. nothing changed means nothing changed, and nothing is called new', (() => {
  const p = [];
  if (!/Nothing changed since the last look/.test(third.out)) p.push('it did not say nothing changed');
  if (/WHAT BROKE\s+\d+ new/.test(third.out)) p.push('an old finding was reported as new');
  if (p.length) p.push(third.out);
  return p;
})());

write('src/offer.js', 'async function o(){ const r = await fetch("/o"); const d = await r.json(); el.textContent = d.name; }\n');
const fourth = run();
check('4. a finding made safe is reported as fixed', (() => {
  const p = [];
  if (!/WHAT GOT FIXED\s+1/.test(fourth.out)) p.push('the fix was not reported');
  if (/GONE WITH ITS FILE/.test(fourth.out)) p.push('a fixed file was called deleted');
  if (p.length) p.push(fourth.out);
  return p;
})());

write('src/offer.js', 'async function o(){ const r = await fetch("/o"); const d = await r.json(); el.innerHTML = `<b>${d.name}</b>`; }\n');
run();
fs.unlinkSync(path.join(dir, 'src', 'offer.js'));
const fifth = run();
check('5. a finding whose file was deleted is gone with it - not called fixed', (() => {
  const p = [];
  if (!/GONE WITH ITS FILE\s+1/.test(fifth.out)) p.push('the deletion was not said as such');
  if (/WHAT GOT FIXED/.test(fifth.out)) p.push('deleting the file was called a fix');
  if (!/deleted\s+src\/offer\.js/.test(fifth.out)) p.push('the deletion is not listed as a change');
  if (p.length) p.push(fifth.out);
  return p;
})());

// A confirmed problem already open: a recorded flow that broke on the last run.
fs.appendFileSync(kept.history, JSON.stringify({
  runAt: new Date().toISOString(), status: 'failed', passed: 0, failed: 1,
  tests: [{ title: 'Checkout', status: 'failed', specFile: 'tests/checkout.spec.js', failure: { line: 3, plainLanguage: 'Could not find Pay.' } }],
}) + '\n', 'utf8');
const sixth = run();
check('6. while anything confirmed is broken, the exit code says so - even with no new change', (() => {
  const p = [];
  if (sixth.code !== 1) p.push('exit ' + sixth.code + ' with a confirmed broken flow open');
  if (!/Still broken: 1 confirmed problem/.test(sixth.out)) p.push('it did not say what is still broken');
  if (p.length) p.push(sixth.out);
  return p;
})());

// Switched off in the dashboard: it must not run, and must say so.
fs.writeFileSync(kept.config, JSON.stringify({ enabled: { frontend: false, regression: true, data: true } }), 'utf8');
write('src/more.js', 'export const m = 2;\n');
const seventh = run();
check('7. a check switched off is not run, and the report says it was off', (() => {
  const p = [];
  if (!/frontend\s+switched off in the dashboard/.test(seventh.out)) p.push('the switched-off check was not reported as off');
  if (/frontend\s+ran/.test(seventh.out)) p.push('a switched-off check ran');
  if (p.length) p.push(seventh.out);
  return p;
})());

check('8. the project holds nothing of Kryptheon\'s after all of it', (() => {
  const now = fs.readdirSync(dir).sort().join(',');
  // README.md is the test's own "AI change" from step 2; nothing else may appear.
  const want = before.split(',').concat('README.md').sort().join(',');
  return now === want ? [] : ['the project now holds: ' + now + ' (was ' + want + ')'];
})());

check('9. every look is kept in the store\'s change history', (() => {
  const lines = fs.existsSync(kept.changes) ? fs.readFileSync(kept.changes, 'utf8').split('\n').filter(Boolean) : [];
  const p = [];
  if (lines.length !== 8) p.push(lines.length + ' looks kept, expected 8');
  const second = lines[1] ? JSON.parse(lines[1]) : null;
  if (!second || second.newFindings !== 1 || !second.files.some((f) => f.path === 'src/offer.js' && f.part === 'frontend')) p.push('the second look was not recorded as it happened: ' + (lines[1] || '').slice(0, 200));
  return p;
})());

fs.rmSync(dir, { recursive: true, force: true });

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
console.log('All ' + results.length + ' verify checks passed.');
