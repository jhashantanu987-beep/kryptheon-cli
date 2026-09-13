// Checks that a recording which cannot be read says so.
// Run with:  node kryptheon-load.check.js
//
// A spec file with a syntax error, or one importing something that is not
// there, never becomes a test. Nothing calls onTestEnd, the run ends with no
// results, and a reporter that does not implement onError prints a summary of
// nothing and exits 1. That is what used to happen: zero tests, exit 1, not one
// word about which file was at fault. A silent failure, from the tool whose
// whole purpose is to say what went wrong.
//
// The last two cases are about the summary never being empty and never being
// cheerful. "0 working, 0 broken" reads as good news, and in quiet mode
// "OK 0 recordings still working" reads as a pass over a file that does not
// even compile.
//
// Everything here goes through the real command in a real project folder.
//
// This file sits outside testDir and does not match Playwright's testMatch
// pattern, so `npx playwright test` ignores it.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CLI = path.join(__dirname, 'bin', 'kryptheon.js');
const FIXTURE = JSON.stringify(path.join(__dirname, 'kryptheon-fixture.js'));
const reporter = require('./kryptheon-reporter.js');

// Enough steps that the triage treats these as real recordings and hands them
// to the test runner. A one-line file is turned away long before this point,
// which is a different message and a different code path.
const STEPS = [
  "  await page.getByRole('button', { name: 'Sign In' }).click();",
  "  await page.getByRole('link', { name: 'Reports' }).click();",
];

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-load-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fintrack","version":"1.0.0"}', 'utf8');
  fs.mkdirSync(path.join(dir, 'tests'));
  for (const name of Object.keys(files)) {
    fs.writeFileSync(path.join(dir, 'tests', name), files[name], 'utf8');
  }
  return dir;
}

function runCheck(dir, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'check'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, env || {}),
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => resolve({ code: code, out: out }));
  });
}

/** A recording that works, against a page this process serves. */
function workingSpec(url) {
  return [
    'const { test, expect } = require(' + FIXTURE + ');',
    '',
    "test('Dashboard', async ({ page }) => {",
    "  await page.goto('" + url + "');",
    "  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();",
    '});',
  ].join('\n');
}

const BROKEN_SYNTAX = [
  'const { test, expect } = require(' + FIXTURE + ');',
  '',
  "test('Personal Finance Tracker', async ({ page }) => {",
  "  await page.goto('http://localhost:9/');",
  "  await page.getByRole('button', { name: 'Sign In' .click();",
  STEPS[1],
  '});',
].join('\n');

const BROKEN_IMPORT = [
  'const { test, expect } = require(' + FIXTURE + ');',
  "const helpers = require('./helpers/not-here.js');",
  '',
  "test('Reports', async ({ page }) => {",
  "  await page.goto('http://localhost:9/');",
]
  .concat(STEPS)
  .concat(['});'])
  .join('\n');

function serve() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><head><meta charset="utf-8"><title>FinTrack</title></head>' +
        '<body><h1>Overview</h1><button>Refresh</button></body></html>',
    );
  });
  return server;
}

const cases = [
  {
    name: '1. a syntax error names the file and the line',
    run: async () => {
      const dir = project({ 'personal-finance-tracker.spec.js': BROKEN_SYNTAX });
      try {
        const r = await runCheck(dir);
        const out = r.out;
        const problems = [];
        if (!/could not be read/.test(out)) problems.push('it did not say a file could not be read:\n' + out);
        if (!/personal-finance-tracker\.spec\.js/.test(out)) problems.push('it did not name the file:\n' + out);
        if (!/line 5/.test(out)) problems.push('it did not give the line:\n' + out);
        if (!/SyntaxError/.test(out)) problems.push('it did not say what was wrong:\n' + out);
        if (!/Fix it and run this again/.test(out)) problems.push('it did not say what to do');
        // The old behaviour, which must never come back.
        if (/0 working, 0 broken/.test(out)) problems.push('it still printed a summary of nothing:\n' + out);
        if (r.code === 0) problems.push('a file that will not load exited 0');
        // The absolute path and the colour codes belong in an editor, not here.
        if (out.indexOf(dir) !== -1) problems.push('it printed the absolute path');
        if (/\u001b\[/.test(out)) problems.push('it printed terminal colour codes from the raw error');
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '2. an import that cannot be resolved says which module, and where',
    run: async () => {
      const dir = project({ 'reports.spec.js': BROKEN_IMPORT });
      try {
        const r = await runCheck(dir);
        const out = r.out;
        const problems = [];
        if (!/could not be read/.test(out)) problems.push('it did not say a file could not be read:\n' + out);
        if (!/reports\.spec\.js/.test(out)) problems.push('it did not name the file:\n' + out);
        if (!/not-here\.js/.test(out)) problems.push('it did not name the missing module:\n' + out);
        if (!/line 2/.test(out)) problems.push('it did not give the line:\n' + out);
        if (/0 working, 0 broken/.test(out)) problems.push('it still printed a summary of nothing');
        // The require stack is Playwright's plumbing, not the reader's problem.
        if (/Require stack/.test(out)) problems.push('it printed the require stack:\n' + out);
        if (r.code === 0) problems.push('a file that will not load exited 0');
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '3. a run where everything loads is unchanged',
    run: async () => {
      const server = serve();
      await new Promise((r) => server.listen(0, r));
      const url = 'http://localhost:' + server.address().port + '/';
      const dir = project({ 'dashboard.spec.js': workingSpec(url) });
      try {
        const r = await runCheck(dir);
        const out = r.out;
        const problems = [];
        if (r.code !== 0) problems.push('a good run did not pass:\n' + out.slice(-700));
        if (!/OK  Dashboard/.test(out)) problems.push('the passing line is missing:\n' + out);
        if (!/Summary: 1 working, 0 broken/.test(out)) problems.push('the summary is missing:\n' + out);
        // Nothing about loading may appear when nothing failed to load.
        if (/could not be read/.test(out)) problems.push('it invented a load error:\n' + out);
        if (/Nothing ran/.test(out)) problems.push('it said nothing ran when something did');
        return problems;
      } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '4. no tests ran and nothing failed: it says why, rather than nothing',
    run: async () => {
      // A file that loads cleanly but registers no test. Playwright reports
      // only "No tests found", which on its own is the whole explanation.
      const dir = project({
        'notes.spec.js': ['async function draft(page) {', "  await page.goto('http://localhost:9/');"]
          .concat(STEPS)
          .concat(['}', 'module.exports = draft;'])
          .join('\n'),
      });
      try {
        const r = await runCheck(dir);
        const out = r.out;
        const problems = [];
        if (!/Nothing ran/.test(out)) problems.push('it did not say that nothing ran:\n' + out);
        if (!/contain a test/.test(out)) problems.push('it did not say what to look at:\n' + out);
        if (/0 working, 0 broken/.test(out)) problems.push('it printed a summary of nothing:\n' + out);
        // There is no real error here, so it must not invent one.
        if (/could not be read/.test(out)) problems.push('it blamed a file that read perfectly well:\n' + out);
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '5. quiet mode never reports a pass over a file that will not load',
    run: async () => {
      const dir = project({ 'personal-finance-tracker.spec.js': BROKEN_SYNTAX });
      try {
        const r = await runCheck(dir, { KRYPTHEON_QUIET: '1' });
        const out = r.out;
        const problems = [];
        // The worst possible output: cheerful, and wrong.
        if (/OK  0 recording/.test(out)) problems.push('it reported a pass over a broken file:\n' + out);
        if (/still working/.test(out)) problems.push('it said recordings were still working:\n' + out);
        if (!/could not be read/.test(out)) problems.push('quiet mode swallowed the reason:\n' + out);
        if (r.code === 0) problems.push('quiet mode exited 0');
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '6. a broken file alongside working ones: both are reported',
    run: async () => {
      const server = serve();
      await new Promise((r) => server.listen(0, r));
      const url = 'http://localhost:' + server.address().port + '/';
      const dir = project({
        'dashboard.spec.js': workingSpec(url),
        'personal-finance-tracker.spec.js': BROKEN_SYNTAX,
      });
      try {
        const r = await runCheck(dir);
        const out = r.out;
        const problems = [];
        // Playwright stops the whole run when a file will not load, so the
        // recording that was fine does not get to run either. Whatever it did,
        // the unreadable file has to be named.
        if (!/could not be read/.test(out)) problems.push('the broken file was not mentioned:\n' + out);
        if (!/personal-finance-tracker\.spec\.js/.test(out)) problems.push('it did not name the broken file');
        if (r.code === 0) problems.push('a run containing an unreadable file exited 0');
        return problems;
      } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '7. the error is reduced to a file, a line and one sentence',
    run: () => {
      // Read straight from the helper, so the shape is pinned rather than
      // inferred from whatever the runner happened to print.
      const read = reporter.readLoadError(
        {
          message:
            'SyntaxError: C:\\p\\tests\\a.spec.js: Unexpected token, expected "," (5:44)\n\n' +
            '\u001b[0m 3 | code frame\u001b[0m',
          location: { file: 'C:\\p\\tests\\a.spec.js', line: 5, column: 44 },
        },
        'C:\\p',
      );
      const problems = [];
      if (read.file !== path.join('tests', 'a.spec.js')) problems.push('the path is not relative: ' + read.file);
      if (read.line !== 5) problems.push('the line is ' + read.line);
      if (read.message !== 'SyntaxError: Unexpected token, expected ","') {
        problems.push('the message is not one clean sentence: ' + JSON.stringify(read.message));
      }
      if (/\u001b\[/.test(read.message)) problems.push('colour codes survived');

      // "No tests found" arrives after a real error and is its consequence, so
      // it must not be listed as a second thing to fix.
      const printed = reporter
        .loadErrorLines(
          [
            { message: 'SyntaxError: boom', location: { file: 'C:\\p\\tests\\a.spec.js', line: 5 } },
            { message: 'Error: No tests found' },
          ],
          'C:\\p',
        )
        .join('\n');
      if (/No tests found/.test(printed)) problems.push('it repeated "No tests found" as a fault:\n' + printed);
      if (!/One of your recordings/.test(printed)) problems.push('it counted the consequence as a second file');
      return problems;
    },
  },
  {
    name: '8. an error arriving alongside results is still reported, not swallowed',
    run: () => {
      // A file that will not load stops the whole run, so Playwright never
      // produces results and a load error together. onError also carries
      // errors from outside any test, though, and one of those turning up
      // after results would otherwise be dropped in silence - which is the
      // bug this whole thing exists to fix. Driven directly, because the test
      // runner cannot be made to produce the combination.
      const dir = project({});
      const cwd = process.cwd();
      const said = [];
      const realWrite = process.stdout.write;
      try {
        process.chdir(dir);
        delete require.cache[require.resolve('./kryptheon-reporter.js')];
        const Reporter = require('./kryptheon-reporter.js');
        const r = new Reporter();
        r.startedAt = new Date();
        r.records = [{ title: 'Dashboard', status: 'passed' }];
        r.onError({
          message: 'SyntaxError: " + "C:\p\tests\a.spec.js: Unexpected token',
          location: { file: 'C:\p\tests\a.spec.js', line: 5 },
        });
        process.stdout.write = (chunk) => {
          said.push(String(chunk));
          return true;
        };
        r.onEnd({ status: 'failed' });
        process.stdout.write = realWrite;

        const printed = said.join('');
        const problems = [];
        if (!/could not be read/.test(printed)) {
          problems.push('an error alongside results was swallowed:' + String.fromCharCode(10) + printed);
        }
        if (!/a.spec.js/.test(printed)) problems.push('it did not name the file:' + String.fromCharCode(10) + printed);
        // And the run it did manage still gets its summary.
        if (!/Summary: 1 working, 0 broken/.test(printed)) {
          problems.push('the summary was lost:' + String.fromCharCode(10) + printed);
        }
        return problems;
      } finally {
        process.stdout.write = realWrite;
        process.chdir(cwd);
        delete require.cache[require.resolve('./kryptheon-reporter.js')];
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
];

let failures = 0;

(async () => {
  for (const c of cases) {
    let problems;
    try {
      problems = await c.run();
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

  console.log('');
  if (failures) {
    console.log(failures + ' check(s) failed.');
    process.exit(1);
  }
  console.log('All ' + cases.length + ' unreadable-recording checks passed.');
})();
