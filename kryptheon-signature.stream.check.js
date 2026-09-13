// Checks that the signature debug output actually reaches the terminal.
// Run with:  node kryptheon-signature.stream.check.js
//
// The unit checks cannot catch this. They call printSignature with a collector
// and see the right strings, which is exactly what happened while the feature
// was silently broken in a real project: Playwright captures a worker's stdout
// and hands it to reporter.onStdOut, kryptheon's reporter does not implement
// that hook, and the config runs no other reporter - so anything written to
// stdout from the fixture is collected and dropped without a trace.
//
// So this check drives the real thing: the real bin/kryptheon.js, the real
// config, the real reporter, against a local page, with stdout and stderr
// captured separately. It asserts the signature arrives on stderr, never on
// stdout, and that the reporter's own output is untouched.
//
// This file sits outside testDir and does not match Playwright's testMatch
// pattern, so `npx playwright test` ignores it.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PACKAGE_DIR = __dirname;
const CLI = path.join(PACKAGE_DIR, 'bin', 'kryptheon.js');

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Stream check</title></head>
<body>
  <h1>Your workspace</h1>
  <label for="email">Email</label><input id="email" name="email">
  <button id="go">Sign in</button>
</body></html>`;

const SPEC = `const { test, expect } = require(${JSON.stringify(
  path.join(PACKAGE_DIR, 'kryptheon-fixture.js').split(path.sep).join('/'),
)});

test('Stream check flow', async ({ page }) => {
  await page.goto(process.env.STREAM_CHECK_URL);
  await expect(page.locator('h1')).toBeVisible();
});
`;

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-stream-'));
  // check refuses a folder that is not a project, so a throwaway one has to
  // look like the real thing.
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"demo","version":"1.0.0"}', 'utf8');
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'stream.spec.js'), SPEC, 'utf8');
  return dir;
}

/**
 * Runs `kryptheon check` for real, keeping the two streams apart.
 *
 * Asynchronous on purpose. spawnSync blocks this process's event loop, and the
 * page under test is served from this same process - so a synchronous run
 * cannot answer a single request and every test fails to reach the address.
 */
function runCheck(dir, url, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'check'], {
      cwd: dir,
      // Piped, not inherited: the whole point is to see which stream each line
      // came out on. runPlaywright uses stdio 'inherit', so the test worker
      // ends up writing into these same two pipes.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { STREAM_CHECK_URL: url }, extraEnv || {}),
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

const MARKER = '[kryptheon signature]';

const cases = [
  {
    name: 'with the flag set, the signature reaches the terminal on stderr',
    run: (ctx) => {
      const problems = [];
      const out = ctx.on;
      if (!out.stderr.includes(MARKER)) {
        problems.push(
          'the signature never reached stderr. stderr was: ' + JSON.stringify(out.stderr.slice(0, 400)),
        );
      }
      if (!/"headings"/.test(out.stderr)) problems.push('stderr carried the prefix but not the JSON');
      if (!/Stream check flow/.test(out.stderr)) problems.push('the test name is missing from the prefix line');
      return problems;
    },
  },
  {
    name: 'the signature never goes to stdout, where the reporter would eat it',
    run: (ctx) => {
      return ctx.on.stdout.includes(MARKER)
        ? ['the signature appeared on stdout: ' + JSON.stringify(ctx.on.stdout.slice(0, 200))]
        : [];
    },
  },
  {
    name: "the reporter's own output is unchanged and still on stdout",
    run: (ctx) => {
      const problems = [];
      if (!/Kryptheon test run/.test(ctx.on.stdout)) problems.push('the reporter header is missing from stdout');
      if (!/^OK\s+Stream check flow/m.test(ctx.on.stdout)) problems.push('the reporter OK line is missing from stdout');
      if (!/Summary: 1 working, 0 broken\./.test(ctx.on.stdout)) problems.push('the reporter summary is missing');
      if (ctx.on.status !== 0) problems.push('the run did not pass: exit ' + ctx.on.status);
      return problems;
    },
  },
  {
    name: 'with the flag unset, nothing is printed and the run is unchanged',
    run: (ctx) => {
      const problems = [];
      if (ctx.off.stdout.includes(MARKER)) problems.push('the signature printed on stdout without the flag');
      if (ctx.off.stderr.includes(MARKER)) problems.push('the signature printed on stderr without the flag');
      if (!/^OK\s+Stream check flow/m.test(ctx.off.stdout)) problems.push('the reporter OK line is missing');
      if (ctx.off.status !== 0) problems.push('the run did not pass: exit ' + ctx.off.status);
      return problems;
    },
  },
  {
    name: 'the version is printed, so a bug report can name one',
    run: () => {
      const result = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8', timeout: 30000 });
      const printed = String(result.stdout || '').trim();
      const expected = require(path.join(PACKAGE_DIR, 'package.json')).version;
      const problems = [];
      if (result.status !== 0) problems.push('exit was ' + result.status);
      if (printed !== expected) problems.push('printed "' + printed + '", package says "' + expected + '"');
      const short = spawnSync(process.execPath, [CLI, '-v'], { encoding: 'utf8', timeout: 30000 });
      if (String(short.stdout || '').trim() !== expected) problems.push('-v did not match --version');
      return problems;
    },
  },
];

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const url = 'http://localhost:' + server.address().port + '/';

  const dir = makeProject();
  let failures = 0;
  try {
    const ctx = {
      on: await runCheck(dir, url, { KRYPTHEON_DEBUG_SIGNATURE: '1' }),
      off: await runCheck(dir, url, { KRYPTHEON_DEBUG_SIGNATURE: '' }),
    };

    for (const c of cases) {
      let problems;
      try {
        problems = c.run(ctx);
      } catch (err) {
        problems = ['threw: ' + err.message];
      }
      if (problems.length) {
        failures++;
        console.log('FAIL  ' + c.name);
        problems.forEach((p) => console.log('      - ' + p));
      } else {
        console.log('PASS  ' + c.name);
      }
    }
  } finally {
    server.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      /* temp dir cleanup is best effort */
    }
  }

  console.log('');
  if (failures) {
    console.log(failures + ' check(s) failed.');
    process.exit(1);
  }
  console.log('All ' + cases.length + ' stream checks passed.');
})();
