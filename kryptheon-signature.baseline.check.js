// Checks that the DOM signature is actually part of the baseline, end to end.
// Run with:  node kryptheon-signature.baseline.check.js
//
// Everything here goes through the real thing: bin/kryptheon.js check, the real
// playwright.config.js, the real kryptheon reporter. No scratch config and no
// substitute reporter - the last time this feature was verified against the
// list reporter it passed sixteen unit checks while being completely dead in a
// real project.
//
// The app under test is the shape the bug was found in: a single-page app with
// a catch-all route, where a login that stops logging anyone in still lands on
// the same address under the same title. Breaking it renames the login
// response field from `token` to `accessToken`, which is the change that broke
// the real one.
//
// This file sits outside testDir and does not match Playwright's testMatch
// pattern, so `npx playwright test` ignores it.

// Records from every run below go to a scratch store, never the real
// ~/.kryptheon: this check makes throwaway projects by the dozen.
process.env.KRYPTHEON_HOME = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'kryptheon-home-'));
// Where the real command keeps a project's baselines: its store, not the project.
const store = require('./kryptheon-store.js');
const baselinesOf = (dir) => store.pathsFor(dir).baselines;

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PACKAGE_DIR = __dirname;
const CLI = path.join(PACKAGE_DIR, 'bin', 'kryptheon.js');
const FIXTURE = path.join(PACKAGE_DIR, 'kryptheon-fixture.js').split(path.sep).join('/');

// Flipped between runs. The server reads it per request, so one server serves
// both the working and the broken backend.
let broken = false;

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Acme</title></head>
<body><div id="app"></div>
<script>
function signedIn() {
  history.pushState({}, '', '/dashboard');
  document.title = 'Acme';
  document.getElementById('app').innerHTML =
    '<h1>Your workspace</h1><h2>Recent activity 14 items</h2>' +
    '<button id="out">Sign out</button><a href="/settings">Settings</a>';
}
function form(message) {
  history.pushState({}, '', '/dashboard');
  document.title = 'Acme';
  document.getElementById('app').innerHTML =
    '<h1>Sign in</h1>' + (message || '') +
    '<label for="email">Email</label><input id="email" name="email">' +
    '<label for="password">Password</label><input id="password" name="password" type="password">' +
    '<button id="go">Sign in</button><a href="/reset">Forgot password</a>';
  document.getElementById('go').onclick = async () => {
    const res = await fetch('/api/login?trace=abc123', { method: 'POST' });
    const data = await res.json();
    // The client still reads .token. After the rename this is undefined, so it
    // renders the signed-out view - same address, same title.
    if (data.token) signedIn(); else form('<p>We could not sign you in.</p>');
  };
}
form();
</script>
</body></html>`;

const SPEC = `const { test, expect } = require(${JSON.stringify(FIXTURE)});

// What a person would have asserted while recording: clicking Sign in lands
// you on the dashboard address. It passes either way, which is the point.
test('Login flow', async ({ page }) => {
  await page.goto(process.env.BASELINE_CHECK_URL);
  await page.fill('#email', 'a@b.test');
  await page.fill('#password', 'hunter2');
  await page.click('#go');
  await expect(page).toHaveURL(/\\/dashboard$/);
});
`;

function runCheck(dir, url) {
  return new Promise((resolve) => {
    // Asynchronous on purpose: spawnSync would block this process's event loop
    // and the page under test is served from here, so nothing could be fetched.
    const child = spawn(process.execPath, [CLI, 'check'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { BASELINE_CHECK_URL: url }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => child.kill(), 120000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status: status, stdout: stdout, stderr: stderr });
    });
  });
}

function baselineFile(dir) {
  return baselinesOf(dir);
}

function readBaseline(dir) {
  try {
    const all = JSON.parse(fs.readFileSync(baselineFile(dir), 'utf8'));
    return all['tests/login.spec.js :: Login flow'] || null;
  } catch (e) {
    return null;
  }
}

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/login')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(broken ? { accessToken: 'abc' } : { token: 'abc' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const url = 'http://localhost:' + server.address().port + '/';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-baseline-'));
  // check refuses a folder that is not a project, so a throwaway one has to
  // look like the real thing.
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"demo","version":"1.0.0"}', 'utf8');
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'login.spec.js'), SPEC, 'utf8');
  // A project with a .gitignore of its own and no password anywhere: nothing
  // of Kryptheon's belongs in it, not even a .env line.
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf8');

  const results = [];
  const record = (name, problems, detail) => results.push({ name, problems, detail });

  // Set KRYPTHEON_CHECK_DUMP=1 to see what the real command actually printed.
  // Working out why a subprocess check disagrees with you is otherwise guesswork.
  const dump = (label, run) => {
    if (process.env.KRYPTHEON_CHECK_DUMP !== '1') return;
    console.log('----- ' + label + ' (exit ' + run.status + ') -----');
    console.log(run.stdout);
    if (run.stderr.trim()) console.log('--- stderr ---\n' + run.stderr);
  };

  try {
    // (a) a new test, first run
    broken = false;
    const first = await runCheck(dir, url);
    dump('a. first run', first);
    const afterFirst = readBaseline(dir);
    record(
      'a. first run passes and the signature is saved to the baseline',
      (() => {
        const problems = [];
        if (first.status !== 0) problems.push('exit was ' + first.status);
        if (!/^OK\s+Login flow/m.test(first.stdout)) problems.push('the run did not report OK');
        if (!afterFirst) problems.push('no baseline entry was written');
        else {
          if (!afterFirst.signature) problems.push('the baseline has no signature');
          else {
            const sig = afterFirst.signature;
            if (!sig.headings.includes('Your workspace')) {
              problems.push('the signature did not capture the signed-in page: ' + JSON.stringify(sig.headings));
            }
            if (!Array.isArray(sig.actions) || !Array.isArray(sig.fields)) {
              problems.push('the signature is missing actions or fields');
            }
          }
        }
        return problems;
      })(),
      afterFirst && afterFirst.signature ? JSON.stringify(afterFirst.signature.headings) : '(none)',
    );

    // (b) same test again, nothing changed
    const second = await runCheck(dir, url);
    dump('b. unchanged run', second);
    record(
      'b. running it again with nothing changed does not fail',
      (() => {
        const problems = [];
        if (second.status !== 0) problems.push('exit was ' + second.status);
        if (!/^OK\s+Login flow/m.test(second.stdout)) problems.push('the run did not report OK');
        if (/somewhere different/.test(second.stdout)) problems.push('a false positive was reported');
        return problems;
      })(),
      'exit ' + second.status,
    );

    // (c) the login breaks: same address, same title, different page
    broken = true;
    const third = await runCheck(dir, url);
    dump('c. broken login', third);
    record(
      'c. a login that stops working fails, even though Playwright passed it',
      (() => {
        const problems = [];
        if (third.status === 0) problems.push('the run passed a broken login');
        if (!/^X\s+Login flow/m.test(third.stdout)) problems.push('the reporter did not mark it broken');
        if (!/ended up somewhere different than before/.test(third.stdout)) {
          problems.push('the reason was not the signature: ' + JSON.stringify(third.stdout.slice(0, 500)));
        }
        if (!/Your workspace/.test(third.stdout)) problems.push('the report does not say what went missing');
        return problems;
      })(),
      'exit ' + third.status,
    );

    // (d) a baseline written before signatures existed
    broken = false;
    const all = JSON.parse(fs.readFileSync(baselineFile(dir), 'utf8'));
    const entry = all['tests/login.spec.js :: Login flow'];
    delete entry.signature;
    delete entry.pending;
    const recordedAt = entry.recordedAt;
    fs.writeFileSync(baselineFile(dir), JSON.stringify(all, null, 2) + '\n', 'utf8');

    const fourth = await runCheck(dir, url);
    dump('d. old baseline', fourth);
    const afterFourth = readBaseline(dir);
    record(
      'd. a baseline with no signature keeps working, and learns one',
      (() => {
        const problems = [];
        if (fourth.status !== 0) problems.push('an old baseline was failed: exit ' + fourth.status);
        if (!/^OK\s+Login flow/m.test(fourth.stdout)) problems.push('the run did not report OK');
        if (!afterFourth || !afterFourth.signature) problems.push('the signature was not learned on the pass');
        if (afterFourth && afterFourth.recordedAt !== recordedAt) {
          problems.push('learning the signature moved recordedAt, losing when it last worked');
        }
        return problems;
      })(),
      afterFourth && afterFourth.signature ? 'learned' : 'not learned',
    );

    // (e) four real runs later, one of them a failure: nothing of Kryptheon's
    // is in the project. Everything it remembers is in the project's store.
    const left = fs.readdirSync(dir).sort();
    const kept = store.pathsFor(dir);
    const runs = fs.existsSync(kept.history) ? fs.readFileSync(kept.history, 'utf8').split('\n').filter(Boolean).length : 0;
    record(
      'e. the project holds only what the person made; the records are in its store',
      (() => {
        const problems = [];
        if (left.join(',') !== '.gitignore,package.json,tests') problems.push('the project now holds: ' + left.join(', '));
        if (fs.readFileSync(path.join(dir, '.gitignore'), 'utf8') !== 'node_modules/\n') problems.push('the project\'s .gitignore was changed');
        if (path.relative(dir, kept.dir).split(path.sep)[0] !== '..') problems.push('the store is inside the project');
        if (!fs.existsSync(kept.baselines)) problems.push('no baselines in the store');
        if (runs !== 4) problems.push('the store\'s history has ' + runs + ' runs, not 4');
        if (!/History saved outside your project/.test(fourth.stdout)) problems.push('the run did not say where the history went');
        return problems;
      })(),
      left.join(', ') + ' | ' + runs + ' runs in ' + path.basename(kept.dir),
    );

    // (f) a project from before the store: its baseline sits in the project,
    // and the login is broken today. The move must not cost the comparison -
    // a baseline lost on the way reads as "first run, all fine".
    const old = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-baseline-old-'));
    try {
      fs.writeFileSync(path.join(old, 'package.json'), '{"name":"old","version":"1.0.0"}', 'utf8');
      fs.mkdirSync(path.join(old, 'tests'));
      fs.writeFileSync(path.join(old, 'tests', 'login.spec.js'), SPEC, 'utf8');
      const legacyBaselines = fs.readFileSync(kept.baselines, 'utf8');
      const legacyRun = '{"runAt":"2026-09-01T10:00:00.000Z","status":"passed","passed":1,"failed":0,"tests":[]}\n';
      fs.writeFileSync(path.join(old, 'kryptheon-baselines.json'), legacyBaselines, 'utf8');
      fs.writeFileSync(path.join(old, 'kryptheon-history.jsonl'), legacyRun, 'utf8');
      fs.mkdirSync(path.join(old, 'test-results'));
      fs.writeFileSync(path.join(old, 'test-results', '.last-run.json'), '{"status":"passed"}', 'utf8');

      broken = true;
      const moved = await runCheck(old, url);
      dump('f. older project, broken login', moved);
      const oldKept = store.pathsFor(old);
      const history = fs.existsSync(oldKept.history) ? fs.readFileSync(oldKept.history, 'utf8').split('\n').filter(Boolean) : [];
      record(
        'f. an older project\'s records move out, and its baseline still catches the broken login',
        (() => {
          const problems = [];
          if (moved.status === 0) problems.push('the broken login passed: the moved baseline was not used');
          if (!/ended up somewhere different than before/.test(moved.stdout)) problems.push('the reason was not the baseline:\n' + moved.stdout.slice(0, 600));
          if (!/Moved out of this folder/.test(moved.stdout)) problems.push('the move was not said');
          const now = fs.readdirSync(old).sort().join(',');
          if (now !== 'package.json,tests') problems.push('the project still holds: ' + now);
          if (history[0] !== legacyRun.trim()) problems.push('the old history did not come along first');
          if (history.length !== 2) problems.push('history has ' + history.length + ' runs, not the old one plus this one');
          return problems;
        })(),
        'exit ' + moved.status,
      );

      // (g) the next run says nothing about moving: there is nothing left to move.
      broken = false;
      const next = await runCheck(old, url);
      record(
        'g. the move happens once',
        (() => {
          const problems = [];
          if (/Moved out of this folder/.test(next.stdout)) problems.push('it said it moved something again');
          if (next.status !== 0) problems.push('the fixed login did not pass: exit ' + next.status);
          return problems;
        })(),
        'exit ' + next.status,
      );
    } finally {
      fs.rmSync(old, { recursive: true, force: true });
    }
  } finally {
    server.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      /* temp dir cleanup is best effort */
    }
  }

  let failures = 0;
  for (const r of results) {
    if (r.problems.length) {
      failures++;
      console.log('FAIL  ' + r.name);
      r.problems.forEach((p) => console.log('      - ' + p));
    } else {
      console.log('PASS  ' + r.name + '   [' + r.detail + ']');
    }
  }

  console.log('');
  if (failures) {
    console.log(failures + ' check(s) failed.');
    process.exit(1);
  }
  console.log('All ' + results.length + ' baseline checks passed.');
})();
