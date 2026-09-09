// Checks that a saved result stays tied to the recording it came from.
// Run with:  node kryptheon-orphan.check.js
//
// What happened, in a real project: `del tests\*.spec.js`, which is what
// anybody does before the tool has taught them `kryptheon remove`. The spec
// files went; kryptheon-baselines.json did not. The flow was recorded again and
// handed the same name, so it inherited the old recording's saved page - a page
// it had never visited - and failed on its first run, permanently. The report
// said both of these at once:
//
//   This has not passed before.
//   Headings that are gone: "Transactions"
//
// Twenty minutes went into trying to reconcile two things that cannot both be
// true. So the last case here is about the report never saying them together,
// and the rest are about it never getting into that state.
//
// This file sits outside testDir and does not match Playwright's testMatch
// pattern, so `npx playwright test` ignores it.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const baselines = require('./kryptheon-baselines.js');
const replay = require('./kryptheon-replay.js');
const CLI = path.join(__dirname, 'bin', 'kryptheon.js');

/** A project folder with a package.json, so the project guard lets it run. */
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-orphan-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }), 'utf8');
  fs.mkdirSync(path.join(dir, 'tests'));
  return dir;
}

function spec(title, step) {
  return [
    'const { test, expect } = require(' + JSON.stringify(path.join(__dirname, 'kryptheon-fixture.js')) + ');',
    '',
    "test('" + title + "', async ({ page }) => {",
    "  await page.goto('%URL%');",
    '  ' + step,
    '});',
  ].join('\n');
}

function write(dir, name, contents) {
  fs.writeFileSync(path.join(dir, 'tests', name), contents, 'utf8');
}

function readBaselines(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'kryptheon-baselines.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

/** The command, run without blocking - a server has to keep answering. */
function runCheck(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'check'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => resolve({ code: code, out: out }));
  });
}

/** A page whose headings this run should see. */
function serve(headings) {
  const state = { headings: headings };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><head><meta charset="utf-8"><title>FinTrack</title></head><body>' +
        state.headings.map((h) => '<h1>' + h + '</h1>').join('') +
        '<button>Refresh</button></body></html>',
    );
  });
  return { server: server, state: state };
}

const cases = [
  {
    name: '1. the recording is deleted: its saved result goes, and it is said out loud',
    run: async () => {
      const { server, state } = serve(['Overview', 'Transactions']);
      await new Promise((r) => server.listen(0, r));
      const url = 'http://localhost:' + server.address().port + '/';
      const dir = project();
      try {
        write(dir, 'flow.spec.js', spec('Flow', "await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();").split('%URL%').join(url));
        const first = await runCheck(dir);
        const problems = [];
        if (first.code !== 0) problems.push('the first run did not pass:\n' + first.out.slice(-600));
        if (!readBaselines(dir)) return problems.concat(['no baseline was written at all']);

        // The way anybody clears recordings before they know about the command.
        fs.unlinkSync(path.join(dir, 'tests', 'flow.spec.js'));
        write(dir, 'other.spec.js', spec('Other', "await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();").split('%URL%').join(url));

        const second = await runCheck(dir);
        if (!/1 old baseline removed/.test(second.out)) {
          problems.push('it did not say the old baseline went:\n' + second.out.slice(0, 900));
        }
        if (!/no longer here/.test(second.out)) problems.push('it does not say why the baseline went');
        const after = readBaselines(dir) || {};
        if (Object.keys(after).some((k) => /flow\.spec\.js/.test(k))) {
          problems.push('the deleted recording still has a saved result: ' + Object.keys(after).join(', '));
        }
        if (second.code !== 0) problems.push('the run after the deletion failed:\n' + second.out.slice(-600));
        return problems;
      } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '2. the same name, different steps: the old result is not used, and the first run passes',
    run: async () => {
      // This is the one that cost twenty minutes. The file is there, so nothing
      // looks wrong; it is simply not the recording the baseline was taken from.
      const { server, state } = serve(['Overview', 'Transactions']);
      await new Promise((r) => server.listen(0, r));
      const url = 'http://localhost:' + server.address().port + '/';
      const dir = project();
      try {
        write(dir, 'pft.spec.js', spec('Personal Finance Tracker', "await expect(page.getByRole('heading', { name: 'Transactions' })).toBeVisible();").split('%URL%').join(url));
        const first = await runCheck(dir);
        const problems = [];
        if (first.code !== 0) return ['the first run did not pass:\n' + first.out.slice(-600)];

        // Recorded again: same title, same file name, different steps - and the
        // app has moved on, so the old saved page no longer matches.
        state.headings = ['Overview', 'Accounts'];
        write(dir, 'pft.spec.js', spec('Personal Finance Tracker', "await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();").split('%URL%').join(url));

        const second = await runCheck(dir);
        if (second.code !== 0) {
          problems.push('the re-recorded flow failed on its first run:\n' + second.out.slice(-900));
        }
        if (/Headings that are gone/.test(second.out)) {
          problems.push('it compared against the old recording\'s page:\n' + second.out.slice(-900));
        }
        if (!/1 old baseline removed/.test(second.out)) {
          problems.push('it did not say the stale baseline went:\n' + second.out.slice(0, 900));
        }
        if (!/recorded again since/.test(second.out)) problems.push('it does not say why');
        return problems;
      } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '3. recording and result both intact: nothing is removed, and a change is still caught',
    run: async () => {
      const { server, state } = serve(['Overview', 'Transactions']);
      await new Promise((r) => server.listen(0, r));
      const url = 'http://localhost:' + server.address().port + '/';
      const dir = project();
      try {
        write(dir, 'pft.spec.js', spec('Personal Finance Tracker', "await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();").split('%URL%').join(url));
        const first = await runCheck(dir);
        const problems = [];
        if (first.code !== 0) return ['the first run did not pass:\n' + first.out.slice(-600)];

        const second = await runCheck(dir);
        if (second.code !== 0) problems.push('an unchanged project failed on its second run:\n' + second.out.slice(-600));
        if (/old baseline removed/.test(second.out)) problems.push('it threw away a live baseline:\n' + second.out);

        // And the whole point of a baseline still works: the app changes, the
        // recording does not, and that is a real difference.
        state.headings = ['Overview'];
        const third = await runCheck(dir);
        if (third.code === 0) problems.push('the page lost a heading and it passed anyway');
        if (!/Headings that are gone/.test(third.out)) {
          problems.push('a real change was not reported as one:\n' + third.out.slice(-900));
        }
        if (/old baseline removed/.test(third.out)) problems.push('it discarded the baseline instead of comparing');
        return problems;
      } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '4. the same name in two folders: neither takes the other\'s saved result',
    run: () => {
      const dir = project();
      try {
        fs.mkdirSync(path.join(dir, 'tests', 'a'));
        fs.mkdirSync(path.join(dir, 'tests', 'b'));
        const one = spec('Personal Finance Tracker', "await page.getByRole('link', { name: 'One' }).click();");
        const two = spec('Personal Finance Tracker', "await page.getByRole('link', { name: 'Two' }).click();");
        fs.writeFileSync(path.join(dir, 'tests', 'a', 'pft.spec.js'), one, 'utf8');
        fs.writeFileSync(path.join(dir, 'tests', 'b', 'pft.spec.js'), two, 'utf8');

        const api = require('./kryptheon-fixture.js');
        const keyA = 'tests/a/pft.spec.js :: Personal Finance Tracker';
        const keyB = 'tests/b/pft.spec.js :: Personal Finance Tracker';
        const problems = [];
        if (keyA === keyB) problems.push('two different files share one key');

        // Neither is an orphan, neither is stale: they are separate recordings
        // that happen to be called the same thing.
        const all = {};
        all[keyA] = { url: '/', title: 'T', recordingId: replay.recordingId(one) };
        all[keyB] = { url: '/', title: 'T', recordingId: replay.recordingId(two) };
        const pruned = baselines.pruneBaselines(all, dir);
        if (pruned.dropped.length) {
          problems.push('it removed ' + pruned.dropped.map((d) => d.key).join(', '));
        }
        // And the fingerprints really are different, or the check above is empty.
        if (replay.recordingId(one) === replay.recordingId(two)) {
          problems.push('two different recordings share a fingerprint');
        }
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '5. "has not passed before" and a list of differences never appear together',
    run: () => {
      // Driven through the real reporter: it is the thing that prints both.
      const dir = project();
      const cwd = process.cwd();
      const said = [];
      const realWrite = process.stdout.write;
      try {
        process.chdir(dir);
        delete require.cache[require.resolve('./kryptheon-reporter.js')];
        const Reporter = require('./kryptheon-reporter.js');
        const reporter = new Reporter();
        reporter.startedAt = new Date();
        reporter.previousRuns = []; // nothing has ever passed
        reporter.records = [];
        process.stdout.write = (chunk) => {
          said.push(String(chunk));
          return true;
        };
        reporter.onTestEnd(
          { title: 'Personal Finance Tracker' },
          {
            status: 'failed',
            duration: 1200,
            startTime: new Date(),
            errors: [
              {
                message:
                  'Error: Baseline changed: the page ended up somewhere different than before.\n' +
                  'Headings that are gone: "Transactions"\n' +
                  'Headings that are new: "Accounts"',
              },
            ],
            attachments: [],
          },
        );
        process.stdout.write = realWrite;

        const printed = said.join('');
        const problems = [];
        if (!/This has not passed before/.test(printed)) {
          problems.push('the case being checked did not happen:\n' + printed);
        }
        if (/Headings that are gone/.test(printed)) {
          problems.push('it listed differences against a baseline it says does not exist:\n' + printed);
        }
        if (/Headings that are new/.test(printed)) problems.push('it listed new headings too');
        return problems;
      } finally {
        process.stdout.write = realWrite;
        process.chdir(cwd);
        delete require.cache[require.resolve('./kryptheon-reporter.js')];
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '6. a saved result from before fingerprints is kept, not thrown away',
    run: () => {
      // "Cannot tell" must never become "accept whatever this run saw". An
      // entry with no fingerprint is left exactly as it is, and tied to the
      // recording it is being compared against from now on.
      const dir = project();
      try {
        const source = spec('Flow', "await page.getByRole('link', { name: 'One' }).click();");
        fs.writeFileSync(path.join(dir, 'tests', 'flow.spec.js'), source, 'utf8');
        const key = 'tests/flow.spec.js :: Flow';
        const all = {};
        all[key] = { url: '/dashboard', title: 'FinTrack', signature: { headings: ['Overview'] } };

        const pruned = baselines.pruneBaselines(all, dir);
        const problems = [];
        if (pruned.dropped.length) problems.push('it discarded an entry it could not judge');
        if (!pruned.baselines[key]) return problems.concat(['the entry is gone entirely']);
        if (pruned.baselines[key].url !== '/dashboard') problems.push('the entry was altered');
        if (!pruned.baselines[key].recordingId) problems.push('it was not tied to the recording for next time');
        if (pruned.stamped !== 1) problems.push('it reported ' + pruned.stamped + ' stamped, expected 1');
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '7. the fixture refuses a mismatched baseline even when nothing pruned it',
    run: () => {
      // The command prunes stale results before it runs anything, so the
      // fixture never normally meets one. It still has to refuse: a person
      // running playwright directly, or a recording redone while a check is
      // in flight, both get there without passing the prune.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-fx-'));
      try {
        const file = path.join(dir, 'baselines.json');
        const api = require('./kryptheon-fixture.js');
        const key = 'tests/pft.spec.js :: Personal Finance Tracker';

        const problems = [];
        // What the old recording left behind.
        api.writeBaseline(file, key, {
          url: '/dashboard',
          title: 'FinTrack',
          signature: { headings: ['Overview', 'Transactions'], actions: [], fields: [], failedRequests: [] },
          recordingId: 'aaaaaaaaaaaa',
        });

        // A different recording, landing on the same name.
        const outcome = api.applyBaseline(file, key, {
          url: '/dashboard',
          title: 'FinTrack',
          signature: { headings: ['Overview', 'Accounts'], actions: [], fields: [], failedRequests: [] },
          recordingId: 'bbbbbbbbbbbb',
        });
        if (outcome.status !== 'created') {
          problems.push('it compared against a result from another recording: ' + outcome.status + ' ' + (outcome.message || ''));
        }
        if (outcome.message) {
          problems.push('it reported a difference against a baseline this recording never made');
        }

        // And the same recording is still compared, not waved through.
        const again = api.applyBaseline(file, key, {
          url: '/dashboard',
          title: 'FinTrack',
          signature: { headings: ['Overview'], actions: [], fields: [], failedRequests: [] },
          recordingId: 'bbbbbbbbbbbb',
        });
        if (again.status !== 'changed') {
          problems.push('the same recording losing a heading was not reported: ' + again.status);
        }
        return problems;
      } finally {
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
  console.log('All ' + cases.length + ' orphan-baseline checks passed.');
})();
