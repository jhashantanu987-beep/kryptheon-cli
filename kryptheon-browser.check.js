// Checks that the browser a recording is replayed in does not eat the time the
// recording itself needs.
// Run with:  node kryptheon-browser.check.js
//
// Measured on a Windows 11 machine with Playwright 1.63: its separate headless
// shell took 23 seconds to open each new page - every run, not just the first.
// That time is inside the 30 second test timeout, so a correct flow that took
// longer than about 7 seconds was reported broken, and the report blamed the
// app. A 15 second flow failed with "Test timeout of 30000ms exceeded". Proxy
// settings made no difference; the full Chromium, run headless, opened the
// same page in 1.5 seconds.
//
// On a machine where the shell is fast, case 2 passes either way and case 1
// is what holds the line. On one where it is slow, case 2 is the real proof.
//
// This file sits outside testDir and does not match Playwright's testMatch
// pattern, so `npx playwright test` ignores it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const CLI = path.join(__dirname, 'bin', 'kryptheon.js');
const NL = String.fromCharCode(10);

const cases = [
  {
    name: '1. recordings replay in the full Chromium, headless - not the separate headless shell',
    run: async () => {
      const problems = [];
      const config = require('./playwright.config.js');
      const use = config.use || {};
      if (use.headless !== true) problems.push('headless is ' + use.headless);
      if (use.channel !== 'chromium') problems.push('channel is ' + JSON.stringify(use.channel) + ', which means the headless shell');
      return problems;
    },
  },
  {
    name: '2. a correct 12 second flow passes through the real check command',
    run: async () => {
      // A page that answers, served from this process - so the command is
      // spawned, never run synchronously, or this server could not answer it.
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(req.url.split('?')[0] === '/done'
          ? '<!doctype html><meta charset="utf-8"><title>Done</title><h1>Done</h1>'
          : '<!doctype html><meta charset="utf-8"><title>Start</title><a href="/done">Go on</a>');
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = 'http://127.0.0.1:' + server.address().port + '/';
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-browser-'));
      try {
        fs.writeFileSync(path.join(dir, 'package.json'), '{}', 'utf8');
        fs.mkdirSync(path.join(dir, 'tests'));
        // Twelve seconds of somebody's flow: slow pages, a form, a wait for an
        // email. Well inside 30 seconds - unless the browser takes 23 of them.
        fs.writeFileSync(path.join(dir, 'tests', 'slow-flow.spec.js'), [
          'const { test, expect } = require(' + JSON.stringify(path.join(__dirname, 'kryptheon-fixture.js')) + ');',
          '',
          "test('Slow but correct', async ({ page }) => {",
          '  await page.goto(' + JSON.stringify(address) + ');',
          '  await page.waitForTimeout(12000);',
          "  await page.getByRole('link', { name: 'Go on' }).click();",
          "  await expect(page.getByRole('heading', { name: 'Done' })).toBeVisible();",
          '});',
          '',
        ].join(NL), 'utf8');

        const r = await new Promise((resolve) => {
          const child = spawn(process.execPath, [CLI, 'check'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          child.stdout.on('data', (c) => { out += c; });
          child.stderr.on('data', (c) => { out += c; });
          const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } }, 180000);
          child.on('close', (code) => { clearTimeout(timer); resolve({ code: code, out: out }); });
        });
        const problems = [];
        if (r.code !== 0 || !/1 working, 0 broken/.test(r.out)) {
          problems.push('a correct flow was not reported working:' + NL + r.out.slice(0, 900));
        }
        if (/Test timeout/.test(r.out)) problems.push('it ran out of time - the browser is eating the budget');
        return problems;
      } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
];

(async () => {
  let failures = 0;
  for (const c of cases) {
    let problems;
    try {
      problems = await c.run();
    } catch (err) {
      problems = ['threw: ' + (err && err.stack ? err.stack : err)];
    }
    if (problems.length) {
      failures++;
      console.log('FAIL  ' + c.name);
      problems.forEach((p) => console.log('      - ' + p));
    } else {
      console.log('PASS  ' + c.name);
    }
  }
  console.log('');
  if (failures) {
    console.log(failures + ' check(s) failed.');
    process.exit(1);
  }
  console.log('All ' + cases.length + ' browser checks passed.');
})();
