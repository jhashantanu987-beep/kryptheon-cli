// Checks that a signature describes the page the flow ended on, and that a
// failing test gets one too.
// Run with:  node kryptheon-signature.settle.check.js
//
// Both of these were real bugs, found on a real app rather than on a dev
// server, and neither was catchable from a unit check:
//
//   1. In a single-page app a click causes no navigation. The request answers,
//      networkidle is satisfied 500ms later, and the framework swaps the DOM
//      after that - so the signature described the login screen the user had
//      just left. A working login was recorded as "Sign In / Sign Up".
//
//   2. Capture ran after the pass/fail check and returned early on failure, so
//      of four tests in a run only the one that passed produced a signature -
//      and the three where knowing what was on screen would have helped most
//      produced nothing.
//
// Everything here goes through the real thing: bin/kryptheon.js check, the real
// playwright.config.js, the real kryptheon reporter.
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
const FIXTURE = path.join(PACKAGE_DIR, 'kryptheon-fixture.js').split(path.sep).join('/');

// The DOM is replaced this long after the login request answers, chosen from
// the query string so one server covers both cases.
//
// 500ms sits exactly on networkidle's own 500ms window, so it is a coin toss
// and proves nothing: the old single-read code passed it about as often as it
// failed. 900ms is past that window, and is what actually separates a settled
// reading from a lucky one.
const SWAP_ON_THE_LINE = 500;
const SWAP_PAST_THE_LINE = 900;

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>FinTrack</title></head>
<body><div id="app"></div>
<script>
document.getElementById('app').innerHTML =
  '<h1>FinTrack</h1>' +
  '<label for="u">Username</label><input id="u" name="username">' +
  '<label for="p">Password</label><input id="p" name="password" type="password">' +
  '<button id="login-btn">Sign In</button><a href="/signup">Sign Up</a>';
document.getElementById('login-btn').onclick = async () => {
  const res = await fetch('/api/login', { method: 'POST' });
  const data = await res.json();
  // No navigation, and the render lands after the network has gone quiet.
  setTimeout(() => {
    if (data.token) {
      document.getElementById('app').innerHTML =
        '<h1>Dashboard</h1><h2>Savings Rate 12%</h2>' +
        '<button id="out">Log Out</button><a href="/accounts">Accounts</a>';
    }
  }, Number(new URLSearchParams(location.search).get('swap') || 0));
};
</script>
</body></html>`;

const flowSpec = (title, swap) => `const { test, expect } = require(${JSON.stringify(FIXTURE)});

// The last step of the recording, exactly as codegen writes it - no wait after.
test('${title}', async ({ page }) => {
  await page.goto(process.env.SETTLE_CHECK_URL + '?swap=${swap}');
  await page.fill('#u', 'someone');
  await page.fill('#p', 'hunter2');
  await page.locator('#login-btn').click();
});
`;

const FAILING_SPEC = `const { test, expect } = require(${JSON.stringify(FIXTURE)});

test('Broken flow', async ({ page }) => {
  await page.goto(process.env.SETTLE_CHECK_URL);
  await expect(page.locator('#not-here')).toBeVisible({ timeout: 2000 });
});
`;

function runCheck(dir, url) {
  return new Promise((resolve) => {
    // Asynchronous on purpose: spawnSync would block this process's event loop
    // and the page under test is served from here, so nothing could be fetched.
    const child = spawn(process.execPath, [CLI, 'check'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, {
        SETTLE_CHECK_URL: url,
        KRYPTHEON_DEBUG_SIGNATURE: '1',
      }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => child.kill(), 180000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status: status, stdout: stdout, stderr: stderr });
    });
  });
}

/** The printed signatures, by test name. */
function parseSignatures(stderr) {
  const out = {};
  const parts = stderr.split('[kryptheon signature] ');
  for (const part of parts.slice(1)) {
    const newline = part.indexOf('\n');
    if (newline === -1) continue;
    const name = part.slice(0, newline).trim();
    const body = part.slice(newline);
    const start = body.indexOf('{');
    if (start === -1) {
      out[name] = null; // "could not read the page"
      continue;
    }
    // The JSON is pretty-printed, so it ends at the first line that is a lone
    // closing brace.
    const lines = body.slice(start).split('\n');
    const end = lines.findIndex((l) => l === '}');
    try {
      out[name] = JSON.parse(lines.slice(0, end + 1).join('\n'));
    } catch (e) {
      out[name] = null;
    }
  }
  return out;
}

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/login')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ token: 'abc' }));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const url = 'http://localhost:' + server.address().port + '/';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-settle-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'onthe.spec.js'), flowSpec('Login on the line', SWAP_ON_THE_LINE), 'utf8');
  fs.writeFileSync(path.join(dir, 'tests', 'past.spec.js'), flowSpec('Login past the line', SWAP_PAST_THE_LINE), 'utf8');
  fs.writeFileSync(path.join(dir, 'tests', 'broken.spec.js'), FAILING_SPEC, 'utf8');

  let run;
  let signatures;
  try {
    run = await runCheck(dir, url);
    signatures = parseSignatures(run.stderr);
    if (process.env.KRYPTHEON_CHECK_DUMP === '1') {
      console.log('----- stdout -----\n' + run.stdout);
      console.log('----- stderr -----\n' + run.stderr);
    }
  } finally {
    server.close();
  }

  const cases = [
    {
      name: 'the signature is the page the flow ended on, not the one before the click',
      run: () => {
        const problems = [];
        for (const name of ['Login on the line', 'Login past the line']) {
          const sig = signatures[name];
          if (!sig) {
            problems.push(name + ': no signature');
            continue;
          }
          if (!sig.headings.includes('Dashboard')) {
            problems.push(name + ': headings are ' + JSON.stringify(sig.headings) + ', wanted the dashboard');
          }
          if (sig.headings.includes('FinTrack')) {
            problems.push(name + ': it read the login screen from before the click');
          }
          if (sig.fields.length) {
            problems.push(name + ': the login form is still there: ' + JSON.stringify(sig.fields));
          }
        }
        return problems;
      },
    },
    {
      name: 'a failing test gets a signature too, so its page can be seen',
      run: () => {
        if (!Object.prototype.hasOwnProperty.call(signatures, 'Broken flow')) {
          return ['nothing was captured for the failing test; only ' + JSON.stringify(Object.keys(signatures))];
        }
        const sig = signatures['Broken flow'];
        if (!sig) return ['the failing test produced a signature that could not be read'];
        return sig.headings.includes('FinTrack')
          ? []
          : ['the failing test captured the wrong page: ' + JSON.stringify(sig.headings)];
      },
    },
    {
      name: 'every test in the run is accounted for',
      run: () => {
        const names = Object.keys(signatures).sort();
        return names.join(',') === 'Broken flow,Login on the line,Login past the line'
          ? []
          : ['signatures for ' + JSON.stringify(names) + ', wanted all three tests'];
      },
    },
    {
      name: 'waiting for the page never turns into a failure of its own',
      run: () => {
        const problems = [];
        // One test fails on purpose, so the run fails; the passing one must not.
        if (!/^OK\s+Login on the line/m.test(run.stdout)) problems.push('the boundary flow did not pass');
        if (!/^OK\s+Login past the line/m.test(run.stdout)) problems.push('the later flow did not pass');
        if (!/Summary: 2 working, 1 broken\./.test(run.stdout)) {
          problems.push('unexpected summary: ' + (run.stdout.match(/Summary:[^\n]*/) || ['none'])[0]);
        }
        return problems;
      },
    },
  ];

  let failures = 0;
  for (const c of cases) {
    let problems;
    try {
      problems = c.run();
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

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    /* temp dir cleanup is best effort */
  }

  console.log('');
  if (failures) {
    console.log(failures + ' check(s) failed.');
    process.exit(1);
  }
  console.log('All ' + cases.length + ' settle checks passed.');
})();
