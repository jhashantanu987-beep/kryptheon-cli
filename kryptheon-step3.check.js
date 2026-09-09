// Four bugs found while using kryptheon on a real project, and the checks that
// keep them fixed.
// Run with:  node kryptheon-step3.check.js
//
//   1. A recording whose password came from KRYPTHEON_PASSWORD signed in with
//      an empty string when the variable was not set. The login failed for a
//      reason nothing in the report mentioned. Two hours went into that.
//   2. After recording, nothing said the .env file had to be created.
//   3. Baselines were suspected of being written in the wrong encoding.
//   4. A failing test never said what was on screen when it gave up.
//
// Everything goes through the real thing: bin/kryptheon.js, the real
// playwright.config.js, the real kryptheon reporter.
//
// This file sits outside testDir and does not match Playwright's testMatch
// pattern, so `npx playwright test` ignores it.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const secretsModule = require('./kryptheon-secrets.js');

const PACKAGE_DIR = __dirname;
const CLI = path.join(PACKAGE_DIR, 'bin', 'kryptheon.js');
const FIXTURE = path.join(PACKAGE_DIR, 'kryptheon-fixture.js').split(path.sep).join('/');

// Non-ASCII on purpose, and the page says which encoding it is in - the way a
// correct app does.
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>FinTrack — Sign in</title></head>
<body><div id="app"></div>
<script>
document.getElementById('app').innerHTML =
  '<h1>FinTrack</h1><h2>2 × 3 accounts</h2>' +
  '<label for="u">Username</label><input id="u" name="username">' +
  '<label for="p">Password</label><input id="p" name="password" type="password">' +
  '<button id="login-btn">Sign In</button><a href="/signup">Sign Up</a>';
document.getElementById('login-btn').onclick = async () => {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('p').value }),
  });
  const data = await res.json();
  setTimeout(() => {
    document.getElementById('app').innerHTML = data.ok
      ? '<h1>Dashboard</h1><button id="out">Log Out</button>'
      : '<h1>FinTrack</h1><p>Wrong password.</p><button id="login-btn">Sign In</button>';
  }, 250);
};
</script>
</body></html>`;

// The shape the scrubber writes: an empty string when the variable is missing.
const SECRET_SPEC = `const { test, expect } = require(${JSON.stringify(FIXTURE)});

test('Login flow', async ({ page }) => {
  await page.goto(process.env.STEP3_URL);
  await page.locator('#u').fill('someone');
  await page.locator('#p').fill(process.env.KRYPTHEON_PASSWORD || '');
  await page.locator('#login-btn').click();
  await expect(page.locator('h1')).toBeVisible();
});
`;

const UNICODE_SPEC = `const { test, expect } = require(${JSON.stringify(FIXTURE)});

// Stays on the sign-in screen, which is where the non-ASCII text lives.
test('Unicode flow', async ({ page }) => {
  await page.goto(process.env.STEP3_URL);
  await expect(page.locator('h2')).toBeVisible();
});
`;

// No secret, and it fails on purpose, so the report has to say where it got to.
const FAILING_SPEC = `const { test, expect } = require(${JSON.stringify(FIXTURE)});

test('Broken flow', async ({ page }) => {
  await page.goto(process.env.STEP3_URL);
  await expect(page.locator('#not-here')).toBeVisible({ timeout: 2000 });
});
`;

function run(dir, url, extraEnv) {
  return new Promise((resolve) => {
    // Asynchronous on purpose: spawnSync would block this process's event loop
    // and the page under test is served from here.
    const child = spawn(process.execPath, [CLI, 'check'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { STEP3_URL: url }, extraEnv || {}),
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

/**
 * The headings the login recording ended on, out of the stored baseline.
 *
 * The recording's own assertion cannot answer "did the password work": the h1
 * is visible on the sign-in screen too. The signature can - "Dashboard" only
 * appears when the login actually went through.
 */
function signedInHeadings(dir) {
  try {
    const all = JSON.parse(fs.readFileSync(path.join(dir, 'kryptheon-baselines.json'), 'utf8'));
    const entry = all['tests/login.spec.js :: Login flow'];
    return (entry && entry.signature && entry.signature.headings) || [];
  } catch (e) {
    return [];
  }
}

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-step3-'));
  // check refuses a folder that is not a project, so a throwaway one has to
  // look like the real thing.
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"demo","version":"1.0.0"}', 'utf8');
  fs.mkdirSync(path.join(dir, 'tests'));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  return dir;
}

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/login')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let password = '';
        try {
          password = JSON.parse(body).password || '';
        } catch (e) {
          /* treat as blank */
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        // A blank password is refused, exactly as a real login would.
        res.end(JSON.stringify({ ok: password === 'hunter2' }));
      });
      return;
    }
    // ?noCharset serves the very same bytes without saying what they are, so
    // the browser has to guess - which is where the mojibake comes from.
    if (/noCharset/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(Buffer.from(PAGE.replace('<meta charset="utf-8">', ''), 'utf8'));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(Buffer.from(PAGE, 'utf8'));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const url = 'http://localhost:' + server.address().port + '/';

  const dirs = [];
  const results = [];
  const record = (name, problems) => results.push({ name, problems });
  const dump = (label, r) => {
    if (process.env.KRYPTHEON_CHECK_DUMP !== '1') return;
    console.log('----- ' + label + ' (exit ' + r.status + ') -----\n' + r.stdout);
  };

  try {
    /* --- 1. a missing password is never sent blank ----------------------- */
    const noEnv = project({ 'tests/login.spec.js': SECRET_SPEC });
    dirs.push(noEnv);
    const missing = await run(noEnv, url, { KRYPTHEON_PASSWORD: '' });
    dump('1. no password anywhere', missing);
    record('1. a recording with no password set is skipped, and says how to fix it', (() => {
      const problems = [];
      if (!/needs a password/.test(missing.stdout)) problems.push('the report does not say a password is needed');
      if (!/\.env/.test(missing.stdout)) {
        problems.push('the report does not say to create a .env file');
      }
      if (!/KRYPTHEON_PASSWORD=/.test(missing.stdout)) problems.push('the report does not name the variable');
      if (/^OK\s+Login flow/m.test(missing.stdout)) problems.push('it ran the recording anyway');
      if (missing.status === 0) problems.push('a skipped recording was reported as a pass (exit 0)');
      return problems;
    })());

    /* --- and with the password present, it runs -------------------------- */
    const withEnv = project({ 'tests/login.spec.js': SECRET_SPEC });
    dirs.push(withEnv);
    const supplied = await run(withEnv, url, { KRYPTHEON_PASSWORD: 'hunter2' });
    dump('1b. password supplied', supplied);
    record('1b. the same recording runs once the password is set', (() => {
      const problems = [];
      if (!/^OK\s+Login flow/m.test(supplied.stdout)) problems.push('it did not run: ' + supplied.stdout.slice(0, 200));
      if (supplied.status !== 0) problems.push('exit was ' + supplied.status);
      if (/needs a password/.test(supplied.stdout)) problems.push('it still complained about the password');
      return problems;
    })());

    /* --- and a .env file counts, not just a real variable ---------------- */
    const dotEnv = project({
      'tests/login.spec.js': SECRET_SPEC,
      '.env': 'KRYPTHEON_PASSWORD=hunter2\n',
    });
    dirs.push(dotEnv);
    const viaFile = await run(dotEnv, url, { KRYPTHEON_PASSWORD: '' });
    dump('1c. password from .env', viaFile);
    record('1c. a password in .env is found, not just one in the environment', (() => {
      const problems = [];
      if (/needs a password/.test(viaFile.stdout)) problems.push('the .env file was not read');
      if (!/^OK\s+Login flow/m.test(viaFile.stdout)) problems.push('it did not run');
      return problems;
    })());

    /* --- 4. a failing test says where it got to -------------------------- */
    const failing = project({ 'tests/broken.spec.js': FAILING_SPEC });
    dirs.push(failing);
    const broke = await run(failing, url);
    dump('4. failing test', broke);
    record('4. a failing test reports the page it was on, in words', (() => {
      const problems = [];
      const line = (broke.stdout.match(/^\s*- Page showed: .*$/m) || [])[0];
      if (!line) return ['no "Page showed" line in the report'];
      if (!/FinTrack/.test(line)) problems.push('it does not name the heading: ' + line.trim());
      if (!/Sign In/.test(line)) problems.push('it does not name the buttons: ' + line.trim());
      if (/[{}[\]]/.test(line)) problems.push('it dumped JSON instead of plain language: ' + line.trim());
      return problems;
    })());

    /* --- 3. encoding survives the round trip ----------------------------- */
    const unicode = project({ 'tests/uni.spec.js': UNICODE_SPEC });
    dirs.push(unicode);
    const uni = await run(unicode, url);
    dump('3. unicode', uni);
    record('3. non-ASCII is stored as UTF-8, byte for byte', (() => {
      const problems = [];
      if (uni.status !== 0) problems.push('the run did not pass: exit ' + uni.status);
      let bytes;
      try {
        bytes = fs.readFileSync(path.join(unicode, 'kryptheon-baselines.json'));
      } catch (e) {
        return ['no baseline file was written: ' + e.message];
      }
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) problems.push('the file has a byte order mark');
      const text = bytes.toString('utf8');
      if (text.indexOf('—') === -1) problems.push('the em dash is missing from the stored title');
      if (text.indexOf('×') === -1) problems.push('the multiplication sign is missing from the stored heading');
      if (/Ã—|â€”/.test(text)) problems.push('the file contains mojibake');
      // And they are the UTF-8 bytes, not something re-encoded on the way out.
      if (bytes.indexOf(Buffer.from('—', 'utf8')) === -1) problems.push('the em dash is not stored as UTF-8 bytes');
      if (bytes.indexOf(Buffer.from('×', 'utf8')) === -1) problems.push('the multiplication sign is not stored as UTF-8 bytes');
      return problems;
    })());

    /* --- 3b. a baseline saved with a BOM is not silently thrown away ----- */
    const bom = project({ 'tests/login.spec.js': SECRET_SPEC });
    dirs.push(bom);
    const first = await run(bom, url, { KRYPTHEON_PASSWORD: 'hunter2' });
    const baselineFile = path.join(bom, 'kryptheon-baselines.json');
    const before = fs.readFileSync(baselineFile, 'utf8');
    fs.writeFileSync(baselineFile, '﻿' + before, 'utf8');
    const afterBom = await run(bom, url, { KRYPTHEON_PASSWORD: 'hunter2' });
    dump('3b. baseline with a BOM', afterBom);
    record('3b. a baseline saved with a byte order mark is still read', (() => {
      const problems = [];
      if (first.status !== 0) problems.push('the first run did not pass');
      const after = JSON.parse(fs.readFileSync(baselineFile, 'utf8').replace(/^﻿/, ''));
      const entry = after['tests/login.spec.js :: Login flow'];
      if (!entry) return ['the baseline entry is gone'];
      // If the BOM had broken the read, the entry would have been recreated
      // with a fresh timestamp instead of matching.
      const original = JSON.parse(before)['tests/login.spec.js :: Login flow'];
      if (entry.recordedAt !== original.recordedAt) {
        problems.push('the baseline was silently recreated, so a real change would have been missed');
      }
      if (afterBom.status !== 0) problems.push('the run failed: exit ' + afterBom.status);
      return problems;
    })());
    /* --- 5. a .env written the way Windows writes it still works --------- */
    const bomEnv = project({ 'tests/login.spec.js': SECRET_SPEC });
    dirs.push(bomEnv);
    // Exactly what PowerShell's Out-File and Notepad produce.
    const BOM = String.fromCharCode(0xfeff);
    fs.writeFileSync(path.join(bomEnv, '.env'), BOM + 'KRYPTHEON_PASSWORD=hunter2' + String.fromCharCode(13, 10), 'utf8');
    const withBom = await run(bomEnv, url, { KRYPTHEON_PASSWORD: '' });
    dump('5. .env with a byte order mark', withBom);
    record('5. a .env saved with a byte order mark is read, not silently ignored', (() => {
      const problems = [];
      const bytes = fs.readFileSync(path.join(bomEnv, '.env'));
      if (!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
        return ['the test file has no byte order mark, so this proves nothing'];
      }
      if (/needs a password/.test(withBom.stdout)) problems.push('the password was not seen at all');
      if (!/^OK\s+Login flow/m.test(withBom.stdout)) problems.push('the recording did not run');
      if (withBom.status !== 0) problems.push('exit was ' + withBom.status);
      // The proof. The recording's own assertion passes either way - the h1 is
      // visible on the sign-in screen too. A blank password is refused by the
      // server, so only a real one ever reaches the dashboard.
      const headings = signedInHeadings(bomEnv);
      if (!headings.includes('Dashboard')) {
        problems.push('the password never arrived: the page ended on ' + JSON.stringify(headings));
      }
      return problems;
    })());

    /* --- 6. the tool writes the example file and tidies .gitignore -------- */
    record('6. .env.example is written as plain UTF-8, with no byte order mark', (() => {
      const dir = project({});
      dirs.push(dir);
      const written = secretsModule.writeEnvExample(dir, ['KRYPTHEON_PASSWORD']);
      if (!written) return ['nothing was written'];
      const bytes = fs.readFileSync(written);
      const problems = [];
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        problems.push('the example file itself has a byte order mark');
      }
      if (bytes.toString('utf8').indexOf('KRYPTHEON_PASSWORD=') === -1) problems.push('the variable is missing');
      // An existing file is never clobbered - it may hold earlier names.
      fs.writeFileSync(written, 'KEEP_ME=1' + String.fromCharCode(10), 'utf8');
      if (secretsModule.writeEnvExample(dir, ['OTHER']) !== null) problems.push('it overwrote an existing file');
      if (fs.readFileSync(written, 'utf8').indexOf('KEEP_ME') === -1) problems.push('it lost what was there');
      return problems;
    })());

    record('6b. an existing .gitignore gains the entries, once', (() => {
      const dir = project({ '.gitignore': 'node_modules' + String.fromCharCode(10) });
      dirs.push(dir);
      const added = secretsModule.updateGitignore(dir);
      const problems = [];
      for (const entry of secretsModule.GITIGNORE_ENTRIES) {
        if (!added.includes(entry)) problems.push('did not add ' + entry);
      }
      const body = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      if (body.indexOf('node_modules') === -1) problems.push('it lost what was already there');
      // Running again finds nothing missing, so the file stops growing.
      if (secretsModule.updateGitignore(dir).length) problems.push('it added the entries a second time');
      // And a project without a .gitignore is left alone.
      const bare = project({});
      dirs.push(bare);
      if (secretsModule.updateGitignore(bare).length) problems.push('it created a .gitignore that was not there');
      if (fs.existsSync(path.join(bare, '.gitignore'))) problems.push('a .gitignore appeared out of nowhere');
      return problems;
    })());

    /* --- bonus: a page that never says what encoding it is in ------------ */
    const noCharset = project({ 'tests/uni.spec.js': UNICODE_SPEC });
    dirs.push(noCharset);
    const guessed = await run(noCharset, url + '?noCharset=1');
    dump('bonus. no meta charset', guessed);
    record('bonus. a page with no declared encoding is called out, once', (() => {
      const problems = [];
      const notes = (guessed.stdout.match(/does not declare a character encoding/g) || []).length;
      if (notes === 0) problems.push('nothing was said about the missing encoding');
      if (notes > 1) problems.push('it was said ' + notes + ' times, not once');
      if (!/<meta charset="utf-8">/.test(guessed.stdout)) problems.push('it does not say what to add');
      if (guessed.status !== 0) problems.push('the note turned into a failure: exit ' + guessed.status);
      return problems;
    })());

    /* --- and a page that does declare one is not nagged ------------------ */
    record('bonus b. a page that declares its encoding is left alone', (() => {
      return /does not declare a character encoding/.test(uni.stdout)
        ? ['a correct page was warned about anyway']
        : [];
    })());

    /* --- 2. after recording, the .env requirement is spelled out --------- */
    // Unit-level, not through the real CLI: reaching this message needs a live
    // `kryptheon record`, which opens a browser window a person has to drive.
    record('2. the record message says the check will skip until .env exists', (() => {
      const cli = require(CLI);
      const lines = [];
      const realLog = console.log;
      console.log = (line) => lines.push(String(line == null ? '' : line));
      try {
        cli.reportSecrets([{ envName: 'KRYPTHEON_PASSWORD', field: 'password' }]);
      } finally {
        console.log = realLog;
      }
      const text = lines.join(String.fromCharCode(10));
      const problems = [];
      if (!/\.env/.test(text)) problems.push('it does not mention .env');
      if (!/KRYPTHEON_PASSWORD=/.test(text)) problems.push('it does not name the variable');
      if (!/will skip this recording/.test(text)) {
        problems.push('it does not say what happens if the file is never created: ' + JSON.stringify(text));
      }
      if (!/blank password/.test(text)) problems.push('it does not mention the blank password');
      return problems;
    })());

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
      console.log('PASS  ' + r.name);
    }
  }

  console.log('');
  if (failures) {
    console.log(failures + ' check(s) failed.');
    process.exit(1);
  }
  console.log('All ' + results.length + ' step-three checks passed.');
})();
