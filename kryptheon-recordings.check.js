// Checks the three parts of not drowning a new user in their own practice runs.
// Run with:  node kryptheon-recordings.check.js
//
// Every record writes another file and check runs all of them, so somebody
// learning the tool on their first afternoon ends up with five recordings, four
// of which never worked, and a check that says "2 working, 4 broken". Nothing
// is broken. Four recordings simply never had a baseline, and reading that as
// four faults in a healthy app is the reason the tool gets closed.
//
// The summary case goes through the real reporter, and the record and remove
// cases go through the real command in a real project folder, because a module
// that works and a command that never calls it look identical from inside a
// unit check.
//
// This file sits outside testDir and does not match Playwright's testMatch
// pattern, so `npx playwright test` ignores it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const recordings = require('./kryptheon-recordings.js');
const CLI = path.join(__dirname, 'bin', 'kryptheon.js');
const cli = require('./bin/kryptheon.js');

/** A throwaway project folder with the given recordings already in it. */
function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-rec-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  for (const name of Object.keys(files || {})) {
    fs.writeFileSync(path.join(dir, 'tests', name), files[name], 'utf8');
  }
  return dir;
}

function spec(title) {
  return [
    "const { test, expect } = require('@playwright/test');",
    '',
    "test('" + title + "', async ({ page }) => {",
    "  await page.goto('http://localhost:1/');",
    "  await page.getByRole('button', { name: 'Go' }).click();",
    '});',
  ].join('\n');
}

/**
 * Runs something that asks a question, with a stand-in for a terminal.
 *
 * There is no real terminal here, and the question only happens on one, so
 * stdin is replaced by something that answers keys. Everything else - the
 * wording, the default, the decision - is the real code.
 */
async function withKeys(keys, body) {
  const listeners = [];
  const fake = {
    isTTY: true,
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
    on: (event, fn) => {
      if (event === "data") listeners.push(fn);
      // The keys arrive once something is listening for them.
      setImmediate(() => {
        for (const key of keys) fn(Buffer.from(key));
      });
    },
    removeListener: (event, fn) => {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    },
  };
  const real = Object.getOwnPropertyDescriptor(process, "stdin");
  const said = [];
  const realLog = console.log;
  const realWrite = process.stdout.write;
  try {
    Object.defineProperty(process, "stdin", { value: fake, configurable: true });
    console.log = (...args) => said.push(args.join(" "));
    process.stdout.write = (chunk) => {
      said.push(String(chunk));
      return true;
    };
    const result = await body();
    return { result: result, out: said.join(String.fromCharCode(10)) };
  } finally {
    console.log = realLog;
    process.stdout.write = realWrite;
    Object.defineProperty(process, "stdin", real);
  }
}

/**
 * The same, without blocking.
 *
 * spawnSync holds the event loop, so a server running in this process could
 * never answer the browser the command starts - it would look like the app was
 * down. Anything run alongside a live server has to go through this one.
 */
function runLive(dir, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI].concat(args), {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
  });
}

/** Runs the real command in a real folder, with no terminal attached. */
function run(dir, args, input) {
  return spawnSync(process.execPath, [CLI].concat(args), {
    cwd: dir,
    encoding: 'utf8',
    input: input === undefined ? '' : input,
    timeout: 120000,
  });
}

/**
 * Drives the reporter the way Playwright does, and returns what it printed.
 *
 * The point of the summary is what reaches the terminal, so it is read from
 * the terminal rather than from the counting function underneath it.
 */
function reportOn(dir, records) {
  const cwd = process.cwd();
  const said = [];
  const realWrite = process.stdout.write;
  try {
    process.chdir(dir);
    // The reporter reads the working directory when it is required, so it is
    // loaded fresh here rather than reused from another case.
    delete require.cache[require.resolve('./kryptheon-reporter.js')];
    const Reporter = require('./kryptheon-reporter.js');
    const reporter = new Reporter();
    reporter.startedAt = new Date();
    reporter.records = records;
    process.stdout.write = (chunk) => {
      said.push(String(chunk));
      return true;
    };
    reporter.onEnd({ status: 'failed' });
  } finally {
    process.stdout.write = realWrite;
    process.chdir(cwd);
    delete require.cache[require.resolve('./kryptheon-reporter.js')];
  }
  return said.join('');
}

const cases = [
  {
    name: '1. three recordings, one never passed: two parts, and nothing counted broken',
    run: () => {
      const dir = project({});
      try {
        const printed = reportOn(dir, [
          { title: 'Login', status: 'passed' },
          { title: 'Dashboard', status: 'passed' },
          { title: 'Practice', status: 'failed', neverPassed: true },
        ]);
        const problems = [];
        if (!/Summary: 2 working, 0 broken\./.test(printed)) {
          problems.push('the first line is wrong: ' + printed.split('\n').filter(Boolean)[0]);
        }
        if (!/1 recording has no baseline yet/.test(printed)) {
          problems.push('the second part is missing:\n' + printed);
        }
        if (!/never passed/.test(printed)) problems.push('it does not say they have never passed');
        if (/0 working, 1 broken|1 broken/.test(printed)) {
          problems.push('a recording that never passed was counted as broken: ' + printed);
        }
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '2. the case from the real run: 2 working, 4 never proven, 0 broken',
    run: () => {
      const dir = project({});
      try {
        const records = [
          { title: 'A', status: 'passed' },
          { title: 'B', status: 'passed' },
        ];
        for (const t of ['C', 'D', 'E', 'F']) records.push({ title: t, status: 'failed', neverPassed: true });
        const printed = reportOn(dir, records);
        const problems = [];
        if (!/Summary: 2 working, 0 broken\./.test(printed)) {
          problems.push('it still reports them as broken: ' + printed.split('\n').filter(Boolean)[0]);
        }
        if (!/4 recordings have no baseline yet/.test(printed)) {
          problems.push('the four are not accounted for:\n' + printed);
        }
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '3. a recording that used to pass and now fails IS broken',
    run: () => {
      const dir = project({});
      try {
        const printed = reportOn(dir, [
          { title: 'Login', status: 'passed' },
          { title: 'Checkout', status: 'failed', neverPassed: false },
        ]);
        const problems = [];
        if (!/Summary: 1 working, 1 broken\./.test(printed)) {
          problems.push('a real regression was not counted: ' + printed.split('\n').filter(Boolean)[0]);
        }
        // Nothing is unproven here, so the second part must not appear at all.
        if (/no baseline yet/.test(printed)) problems.push('it added the second part when nothing was unproven');
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '4. with recordings already there, record asks before adding another',
    run: async () => {
      const problems = [];

      // Pressing Enter takes the default, and the default keeps them.
      const kept = await withKeys([String.fromCharCode(13)], () =>
        cli.askAboutExisting(['one.spec.js', 'two.spec.js', 'three.spec.js']),
      );
      if (!/This project already has 3 recordings/.test(kept.out)) {
        problems.push('it did not say what is already there:' + String.fromCharCode(10) + kept.out);
      }
      if (!/keep them, and add this new one/.test(kept.out)) problems.push('the keep option is not offered');
      if (!/replace them - delete all 3/.test(kept.out)) problems.push('the replace option is not offered');
      if (!/Keep or replace\? \[K\/r\]/.test(kept.out)) problems.push('it never actually asks: ' + kept.out);
      if (kept.result !== false) problems.push('Enter did not take the safe default');

      // One keypress, no Enter, is enough to choose the other one.
      const replaced = await withKeys(['r'], () =>
        cli.askAboutExisting(['one.spec.js', 'two.spec.js', 'three.spec.js']),
      );
      if (replaced.result !== true) problems.push('r did not choose replace');
      if (!/deleted once this new recording is saved/.test(replaced.out)) {
        problems.push('it does not say when the old ones go: ' + replaced.out);
      }

      // A key that means nothing must not be read as either answer.
      const ignored = await withKeys(['q', 'k'], () => cli.askAboutExisting(['one.spec.js']));
      if (ignored.result !== false) problems.push('an unknown key was treated as an answer');
      if (!/already has 1 recording\b/.test(ignored.out)) {
        problems.push('the count reads wrong for one recording: ' + ignored.out);
      }

      // Nothing to replace means nothing to ask.
      const none = await withKeys([], () => cli.askAboutExisting([]));
      if (none.out.trim() !== '') problems.push('it asked with no recordings: ' + none.out);
      return problems;
    },
  },
  {
    name: '4b. with no terminal to answer with, it asks nothing and deletes nothing',
    run: () => {
      const dir = project({ 'one.spec.js': spec('One'), 'two.spec.js': spec('Two') });
      try {
        // An address nothing answers on, so this stops before a browser opens.
        const r = run(dir, ['record', 'http://localhost:9/']);
        const out = String(r.stdout || '') + String(r.stderr || '');
        const problems = [];
        if (/Keep or replace/.test(out)) problems.push('it asked a question nobody could answer');
        const left = fs.readdirSync(path.join(dir, 'tests')).sort();
        if (left.join(',') !== 'one.spec.js,two.spec.js') {
          problems.push('files were touched without an answer: ' + left.join(', '));
        }
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '5. with no recordings yet, record asks nothing',
    run: () => {
      const dir = project({});
      try {
        const r = run(dir, ['record', 'http://localhost:9/']);
        const out = String(r.stdout || '') + String(r.stderr || '');
        const problems = [];
        if (/already has/.test(out)) problems.push('it asked about recordings that do not exist:\n' + out);
        if (/Keep or replace/.test(out)) problems.push('it offered a choice with nothing to choose between');
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '6. remove with no name lists what is there',
    run: () => {
      const dir = project({ 'alpha.spec.js': spec('Alpha'), 'beta.spec.js': spec('Beta') });
      try {
        const r = run(dir, ['remove']);
        const out = String(r.stdout || '') + String(r.stderr || '');
        const problems = [];
        if (!/2 recordings in this project/.test(out)) problems.push('it did not count them: ' + out);
        if (!/1  tests[\\/]alpha\.spec\.js/.test(out)) problems.push('alpha is not listed by number:\n' + out);
        if (!/2  tests[\\/]beta\.spec\.js/.test(out)) problems.push('beta is not listed by number:\n' + out);
        // Listing must never be the same thing as deleting.
        const left = fs.readdirSync(path.join(dir, 'tests')).sort();
        if (left.length !== 2) problems.push('listing removed something: ' + left.join(', '));
        if (r.status !== 0) problems.push('listing exited ' + r.status);
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '7. remove takes out the one named, and only that one',
    run: () => {
      const dir = project({ 'alpha.spec.js': spec('Alpha'), 'beta.spec.js': spec('Beta'), 'gamma.spec.js': spec('Gamma') });
      try {
        const r = run(dir, ['remove', 'beta.spec.js']);
        const out = String(r.stdout || '') + String(r.stderr || '');
        const left = fs.readdirSync(path.join(dir, 'tests')).sort();
        const problems = [];
        if (r.status !== 0) problems.push('it exited ' + r.status + ':\n' + out);
        if (left.join(',') !== 'alpha.spec.js,gamma.spec.js') {
          problems.push('the wrong files are left: ' + left.join(', '));
        }
        if (!/Removed 1 recording/.test(out)) problems.push('it did not say what it did:\n' + out);
        if (!/beta\.spec\.js/.test(out)) problems.push('it did not name the file it removed');
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '8. remove takes the saved result with it',
    run: () => {
      const dir = project({ 'alpha.spec.js': spec('Alpha'), 'beta.spec.js': spec('Beta') });
      try {
        fs.writeFileSync(
          path.join(dir, 'kryptheon-baselines.json'),
          JSON.stringify(
            {
              'tests/alpha.spec.js :: Alpha': { url: '/a', title: 'A' },
              'tests/beta.spec.js :: Beta': { url: '/b', title: 'B' },
            },
            null,
            2,
          ),
          'utf8',
        );
        run(dir, ['remove', 'beta.spec.js']);
        const after = JSON.parse(fs.readFileSync(path.join(dir, 'kryptheon-baselines.json'), 'utf8'));
        const keys = Object.keys(after);
        const problems = [];
        if (keys.indexOf('tests/beta.spec.js :: Beta') !== -1) {
          problems.push('the saved result of the removed recording is still there');
        }
        if (keys.indexOf('tests/alpha.spec.js :: Alpha') === -1) {
          problems.push('it took the wrong saved result: ' + keys.join(', '));
        }
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '9. remove refuses a name it does not recognise rather than guessing',
    run: () => {
      const dir = project({ 'alpha.spec.js': spec('Alpha') });
      try {
        const r = run(dir, ['remove', 'alfa']);
        const out = String(r.stdout || '') + String(r.stderr || '');
        const problems = [];
        if (r.status === 0) problems.push('it reported success for a name that does not exist');
        if (fs.readdirSync(path.join(dir, 'tests')).length !== 1) problems.push('it deleted something anyway');
        if (!/no recording called that/.test(out)) problems.push('it does not say why:\n' + out);
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '10. remove with nothing recorded says so and does not fail',
    run: () => {
      const dir = project({});
      try {
        const r = run(dir, ['remove']);
        const out = String(r.stdout || '') + String(r.stderr || '');
        const problems = [];
        if (r.status !== 0) problems.push('it exited ' + r.status);
        if (!/no recordings to remove/.test(out)) problems.push('it does not say there is nothing:\n' + out);
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '11. an answer to the list is read, and a near miss is never a choice',
    run: () => {
      const names = ['alpha.spec.js', 'beta.spec.js', 'gamma.spec.js'];
      const problems = [];
      const pick = (answer) => recordings.chooseFromList(names, answer);

      if (pick('2').names[0] !== 'beta.spec.js') problems.push('a number does not pick that one');
      if (pick('beta').names[0] !== 'beta.spec.js') problems.push('a bare name does not pick that one');
      if (pick('a').names.length !== 3) problems.push('"a" does not mean all of them');
      if (pick('').action !== 'cancel') problems.push('an empty answer is not a cancel');
      // These delete files, so anything not understood must stay a question.
      for (const answer of ['4', '0', 'bet', 'alpha beta', 'y']) {
        if (pick(answer).action !== 'unclear') {
          problems.push(JSON.stringify(answer) + ' was treated as a choice: ' + JSON.stringify(pick(answer)));
        }
      }
      return problems;
    },
  },
  {
    name: '12. replacing never deletes the recording just made',
    run: () => {
      const dir = project({ 'old-one.spec.js': spec('Old'), 'old-two.spec.js': spec('Older') });
      const cwd = process.cwd();
      try {
        process.chdir(dir);
        delete require.cache[require.resolve('./bin/kryptheon.js')];
        const fresh = require('./bin/kryptheon.js');
        // The new recording is in the list too, the way it would be if the
        // list were read again after saving.
        fs.writeFileSync(path.join(dir, 'tests', 'new.spec.js'), spec('New'), 'utf8');
        const gone = fresh.dropOldRecordings(['old-one.spec.js', 'old-two.spec.js', 'new.spec.js'], 'tests/new.spec.js');
        const left = fs.readdirSync(path.join(dir, 'tests')).sort();
        const problems = [];
        if (left.join(',') !== 'new.spec.js') problems.push('the wrong files survived: ' + left.join(', '));
        if (gone.length !== 2) problems.push('it removed ' + gone.length + ', expected 2');
        return problems;
      } finally {
        process.chdir(cwd);
        delete require.cache[require.resolve('./bin/kryptheon.js')];
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '13. the command still knows how to remove things',
    run: () => {
      const problems = [];
      if (typeof cli.remove !== 'function') problems.push('bin/kryptheon.js does not expose remove');
      const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', timeout: 60000 });
      const out = String(r.stdout || '');
      if (!/kryptheon remove/.test(out)) problems.push('remove is not in the help:\n' + out);
      return problems;
    },
  },
  {
    name: '15. a real run: two that pass, one that never has, and no browser is blamed',
    run: async () => {
      // Cases 1 to 3 hand the reporter its records already marked, so they
      // cannot show that a real run marks them. This one runs the command.
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          '<!doctype html><html><head><meta charset="utf-8"><title>FinTrack</title></head>' +
            '<body><h1>Overview</h1><button>Refresh</button></body></html>',
        );
      });
      await new Promise((r) => server.listen(0, r));
      const url = 'http://localhost:' + server.address().port + '/';

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kryptheon-live-"));
      try {
        fs.mkdirSync(path.join(dir, "tests"));
        const fixture = JSON.stringify(path.join(__dirname, "kryptheon-fixture.js"));
        const write = (file, title, body) =>
          fs.writeFileSync(
            path.join(dir, "tests", file),
            [
              "const { test, expect } = require(" + fixture + ");",
              "",
              "test('" + title + "', async ({ page }) => {",
              "  await page.goto('" + url + "');",
              body,
              "});",
            ].join(String.fromCharCode(10)),
            "utf8",
          );

        write("login.spec.js", "Login", "  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();");
        write("dashboard.spec.js", "Dashboard", "  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();");
        // A practice recording, of the kind made while learning: it looks for
        // something that is not there, and it has never passed.
        write("practice.spec.js", "Practice", "  await expect(page.getByRole('button', { name: 'Delete account' })).toBeVisible({ timeout: 2000 });");

        const r = await runLive(dir, ["check"]);
        const out = String(r.stdout || "") + String(r.stderr || "");
        const problems = [];
        if (!/Summary: 2 working, 0 broken\./.test(out)) {
          problems.push("the summary is wrong:" + String.fromCharCode(10) + out.slice(-1200));
        }
        if (!/1 recording has no baseline yet - it has never passed\./.test(out)) {
          problems.push("the second part is missing:" + String.fromCharCode(10) + out.slice(-1200));
        }
        if (!/Each one has to pass once/.test(out)) problems.push("it does not say what to do about it");
        // The practice recording still has to be reported, just not as broken.
        if (!/X  Practice/.test(out)) problems.push("the recording that failed was not shown at all");
        return problems;
      } finally {
        server.close();
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
console.log('All ' + cases.length + ' recordings checks passed.');
})();
