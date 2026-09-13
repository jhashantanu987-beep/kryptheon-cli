// Checks `kryptheon record` end to end, through bin/kryptheon.js.
// Run with:  node kryptheon-record.check.js
//
// The watchdog's decisions are checked directly in kryptheon-watchdog.check.js,
// where a probe can be made to hang. What is checked here is the part only the
// real command can show: that a browser genuinely opens in the time the
// watchdog allows, and that when codegen complains, its own words reach the
// person instead of a list of guesses.
//
// Recording needs a person to click things, so these runs are ended on purpose
// once the point has been made.
//
// This file sits outside testDir and does not match Playwright's testMatch
// pattern, so `npx playwright test` ignores it.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PACKAGE_DIR = __dirname;
const CLI = path.join(PACKAGE_DIR, 'bin', 'kryptheon.js');
const cli = require('./bin/kryptheon.js');

function runRecord(dir, url, options) {
  const opts = options || {};
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, 'record', url], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, opts.env || {}),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));

    // Stop watching once the browser is up: there is nobody here to click.
    let windowAt = null;
    const watching = opts.untilWindow
      ? setInterval(() => {
          const seen = cli.inspectBrowserWindows();
          if (seen.known && seen.windows > 0) {
            windowAt = Date.now() - started;
            clearInterval(watching);
            child.kill();
          }
        }, 400)
      : null;

    const giveUp = setTimeout(() => {
      if (watching) clearInterval(watching);
      child.kill();
    }, opts.timeoutMs || 60000);

    child.on('close', (status) => {
      if (watching) clearInterval(watching);
      clearTimeout(giveUp);
      resolve({ status, stdout, stderr, windowAt, tookMs: Date.now() - started });
    });
  });
}

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-record-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"t","private":true}\n', 'utf8');
  return dir;
}

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>Rec</title><h1>Record me</h1>');
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const url = 'http://localhost:' + server.address().port + '/';

  const dirs = [];
  const results = [];
  const record = (name, problems, detail) => results.push({ name, problems, detail });
  const dump = (label, r) => {
    if (process.env.KRYPTHEON_CHECK_DUMP !== '1') return;
    console.log('----- ' + label + ' (exit ' + r.status + ') -----\n' + r.stdout + '\n--- stderr ---\n' + r.stderr);
  };

  try {
    /* --- a browser really does open, well inside the budget -------------- */
    const fresh = project();
    dirs.push(fresh);
    const opened = await runRecord(fresh, url, { untilWindow: true, timeoutMs: 60000 });
    dump('a window opens', opened);
    record(
      'a browser window opens well inside the budget the watchdog allows',
      (() => {
        const problems = [];
        if (opened.windowAt === null) {
          problems.push('no window was ever seen in ' + opened.tookMs + 'ms');
        } else if (opened.windowAt > cli.WINDOW_TIMEOUT_MS) {
          problems.push('took ' + opened.windowAt + 'ms, past the ' + cli.WINDOW_TIMEOUT_MS + 'ms budget');
        }
        const said = opened.stdout + opened.stderr;
        if (/No browser window appeared/.test(said)) problems.push('it claimed no window appeared');
        if (/Could not tell whether/.test(said)) problems.push('it claimed it could not tell');
        return problems;
      })(),
      opened.windowAt === null ? 'never' : opened.windowAt + 'ms',
    );

    /* --- an address that refuses: the browser's own words come first ----- */
    const refused = project();
    dirs.push(refused);
    // Nothing is listening on this port, so codegen fails to reach it and says so.
    const dead = await runRecord(refused, 'http://localhost:9', { timeoutMs: 60000 });
    dump('a refused address', dead);
    record(
      'when the browser complains, its own words are reported',
      (() => {
        const problems = [];
        const said = dead.stdout + dead.stderr;
        if (dead.status === 0) problems.push('a failed recording exited 0');
        // Any route is fine - what must not happen is silence about the real
        // reason while a list of guesses is printed instead. In practice the
        // reachability check catches this one before codegen even starts, which
        // is why the stderr path itself is covered by unit checks rather than
        // here: a failure that gets past the pre-flight and then breaks inside
        // codegen cannot be produced on demand.
        const named =
          /The browser reported:/.test(said) ||
          /Nothing answered at/.test(said) ||
          /could not be reached|refused the connection|does not look like it is running/.test(said);
        if (/No browser window appeared/.test(said)) {
          problems.push('it blamed the window instead of the address');
        }
        if (!named) {
          problems.push('nothing in the output names the real problem: ' + JSON.stringify(said.slice(0, 400)));
        }
        return problems;
      })(),
      'exit ' + dead.status,
    );

    /* --- the check can be turned off ------------------------------------- */
    const forced = project();
    dirs.push(forced);
    const off = await runRecord(forced, url, { untilWindow: true, timeoutMs: 45000, env: { KRYPTHEON_FORCE_RECORD: '1' } });
    dump('watchdog off', off);
    record(
      'KRYPTHEON_FORCE_RECORD skips the check without breaking the recording',
      (() => {
        const problems = [];
        const said = off.stdout + off.stderr;
        if (/No browser window appeared/.test(said)) problems.push('the check still fired');
        if (/Could not tell whether/.test(said)) problems.push('the check still fired');
        if (off.windowAt === null) problems.push('no window opened with the check off');
        return problems;
      })(),
      off.windowAt === null ? 'never' : off.windowAt + 'ms',
    );
  } finally {
    server.close();
    for (const dir of dirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        /* temp dir cleanup is best effort */
      }
    }
  }

  let failures = 0;
  for (const r of results) {
    if (r.problems.length) {
      failures++;
      console.log('FAIL  ' + r.name);
      r.problems.forEach((p) => console.log('      - ' + p));
    } else {
      console.log('PASS  ' + r.name + (r.detail ? '   [' + r.detail + ']' : ''));
    }
  }

  console.log('');
  if (failures) {
    console.log(failures + ' check(s) failed.');
    process.exit(1);
  }
  console.log('All ' + results.length + ' record checks passed.');
})();
