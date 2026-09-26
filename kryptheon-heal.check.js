// Checks that a renamed button no longer hides the rest of a flow.
// Run with:  node kryptheon-heal.check.js
//
// Found on a real Lovable app: "Reserve a table" became "Reserve here", the
// replay stopped at that click, and nothing after it - the form, its checks,
// the confirmation - was looked at. The report called the flow broken and it
// was not; whatever really was broken behind it went unseen.
//
// Everything below goes through the real command, config and reporter
// against a page served from here, so what is checked is what a person sees.
// The rule being checked is narrow on purpose, and most of these runs are
// the ways it must NOT follow a rename: a button that is gone with nothing
// in its place, a rename next to another new button, a new name two buttons
// share.
//
// This file sits outside testDir and does not match Playwright's testMatch
// pattern, so `npx playwright test` ignores it.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const heal = require('./kryptheon-heal.js');

const PACKAGE_DIR = __dirname;
const CLI = path.join(PACKAGE_DIR, 'bin', 'kryptheon.js');
const FIXTURE = path.join(PACKAGE_DIR, 'kryptheon-fixture.js').split(path.sep).join('/');

// What the server shows, changed between runs. Read per request.
const app = {
  reserve: 'Reserve a table', // null: the button is gone
  twin: false, //                a second button with the reserve button's name
  extra: false, //               an unrelated new button on the same page
  sendWorks: true, //            the form's button takes you to /thanks
  menu: 'Open menu',
};

function home() {
  const b = (id, label) => (label ? '<button type="button" id="' + id + '">' + label + '</button>' : '');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Cinder</title></head>
<body><main>
<h1>Cinder</h1><p>Twelve seats.</p>
${b('r', app.reserve)}${app.twin ? b('t', app.reserve) : ''}${app.extra ? b('g', 'Gift cards') : ''}
${b('m', app.menu)}
<div id="panel" hidden><h2>Menu</h2></div>
<form id="f" hidden><label for="n">Name</label><input id="n"><button type="button" id="s">Send</button></form>
</main>
<script>
const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
on('r', () => { document.getElementById('f').hidden = false; });
on('t', () => { document.getElementById('f').hidden = false; });
on('m', () => { const p = document.getElementById('panel'); p.hidden = !p.hidden; });
on('s', () => { ${app.sendWorks ? "location.href = '/thanks';" : '/* broken: does nothing */'} });
</script></body></html>`;
}

const THANKS = `<!doctype html><html><head><meta charset="utf-8"><title>Cinder</title></head>
<body><main><h1>Thanks</h1><a href="/">Back</a></main></body></html>`;

// The flow ends on a different page from the one the renamed button is on,
// so only what the steps themselves remembered can prove the rename.
const RESERVE_SPEC = `const { test, expect } = require(${JSON.stringify(FIXTURE)});

test('Reserve', async ({ page }) => {
  test.setTimeout(15000);
  await page.goto(process.env.HEAL_CHECK_URL);
  await page.getByRole('button', { name: 'Reserve a table' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Ada');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('heading', { name: 'Thanks' })).toBeVisible();
});
`;

// Ends on the page the button is on: what an older baseline, with no step
// memory, can still prove from the buttons it saw last time.
const MENU_SPEC = `const { test, expect } = require(${JSON.stringify(FIXTURE)});

test('Menu', async ({ page }) => {
  test.setTimeout(15000);
  await page.goto(process.env.HEAL_CHECK_URL);
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('heading', { name: 'Menu' })).toBeVisible();
});
`;

// What the recorder's "assert text" button writes, with the wrong words.
const WORDS_SPEC = `const { test, expect } = require(${JSON.stringify(FIXTURE)});

test('Words', async ({ page }) => {
  test.setTimeout(15000);
  await page.goto(process.env.HEAL_CHECK_URL);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Ember');
});
`;

function project(prefix, file, spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"demo","version":"1.0.0"}', 'utf8');
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', file), spec, 'utf8');
  return dir;
}

function runCheck(dir, url, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'check'].concat(args || []), {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { HEAL_CHECK_URL: url }),
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

function baseline(dir, key) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'kryptheon-baselines.json'), 'utf8'))[key] || null;
  } catch (e) {
    return null;
  }
}

const RENAMED = /Renamed: The button "Reserve a table" is now called "Reserve here"/;
const ANY_RENAME = /Renamed/;

(async () => {
  const results = [];
  const record = (name, problems, detail) => results.push({ name, problems, detail });
  const dump = (label, run) => {
    if (process.env.KRYPTHEON_CHECK_DUMP !== '1') return;
    console.log('----- ' + label + ' (exit ' + run.status + ') -----\n' + run.stdout);
    if (run.stderr.trim()) console.log('--- stderr ---\n' + run.stderr);
  };

  // ---- the decision on its own, names in and names out ----
  const d = heal.decideRename;
  record('1. one name gone, the recorded one, and one new name of the same role: followed', (() => {
    const p = [];
    const got = d('Reserve a table', ['Reserve a table', 'Menu'], ['Reserve here', 'Menu'], ['Reserve here', 'Menu']);
    if (got !== 'Reserve here') p.push('got ' + JSON.stringify(got));
    // Case and spacing are how CSS draws a label, not what it is.
    const upper = d('Reserve a table', ['RESERVE A TABLE', 'MENU'], ['Reserve  here', 'Menu'], ['Reserve  here']);
    if (upper !== 'Reserve  here') p.push('upper-case baseline: got ' + JSON.stringify(upper));
    return p;
  })(), 'decideRename');

  record('2. anything looser is not followed', (() => {
    const p = [];
    const cases = [
      ['two new names', ['Reserve a table', 'Menu'], ['Reserve here', 'Gift cards', 'Menu'], ['Reserve here', 'Gift cards', 'Menu']],
      ['two names gone', ['Reserve a table', 'Menu'], ['Reserve here'], ['Reserve here']],
      ['nothing new', ['Reserve a table', 'Menu'], ['Menu'], ['Menu']],
      ['another button renamed, the recorded one not remembered', ['Menu', 'Help'], ['Menu', 'Support'], ['Menu', 'Support']],
      ['the new name is not of the step\'s role', ['Reserve a table', 'Menu'], ['Reserve here', 'Menu'], ['Menu']],
      ['nothing remembered', [], ['Reserve here'], ['Reserve here']],
    ];
    for (const c of cases) {
      const got = d('Reserve a table', c[1], c[2], c[3]);
      if (got !== null) p.push(c[0] + ': followed to ' + JSON.stringify(got));
    }
    return p;
  })(), 'decideRename');

  record('3. names are read the way getByRole reads them, quotes and all', (() => {
    const p = [];
    const m = heal.namesByRole([
      '- main:',
      '  - button "Reserve here"',
      '  - link "Story":',
      '    - /url: "#stories"',
      '  - button "Say \\"hi\\"" [disabled]',
      '  - textbox "Email"',
      '  - button',
    ].join('\n'));
    if (JSON.stringify(m.get('button')) !== JSON.stringify(['Reserve here', 'Say "hi"'])) p.push('buttons: ' + JSON.stringify(m.get('button')));
    if (JSON.stringify(m.get('link')) !== JSON.stringify(['Story'])) p.push('links: ' + JSON.stringify(m.get('link')));
    if (JSON.stringify(m.get('textbox')) !== JSON.stringify(['Email'])) p.push('textboxes: ' + JSON.stringify(m.get('textbox')));
    return p;
  })(), 'namesByRole');

  // ---- through the real command ----
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url.startsWith('/thanks') ? THANKS : home());
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const url = 'http://localhost:' + server.address().port + '/';
  const reset = () => Object.assign(app, { reserve: 'Reserve a table', twin: false, extra: false, sendWorks: true, menu: 'Open menu' });

  const dir = project('kryptheon-heal-', 'reserve.spec.js', RESERVE_SPEC);
  const KEY = 'tests/reserve.spec.js :: Reserve';

  try {
    reset();
    const first = await runCheck(dir, url);
    dump('4. first run', first);
    const saved = baseline(dir, KEY);
    record('4. a passing run remembers what each step saw', (() => {
      const p = [];
      if (first.status !== 0) p.push('exit ' + first.status);
      if (!saved || !saved.steps) p.push('no step memory in the baseline');
      else {
        const keys = Object.keys(saved.steps);
        if (keys.length !== 3) p.push('expected 3 remembered steps, got ' + JSON.stringify(keys));
        const reserve = saved.steps['0 button Reserve a table'];
        if (!reserve || !reserve.includes('Reserve a table')) p.push('the reserve step did not note its own page: ' + JSON.stringify(reserve));
      }
      return p;
    })(), 'exit ' + first.status);

    app.reserve = 'Reserve here';
    const renamed = await runCheck(dir, url);
    dump('5. renamed', renamed);
    record('5. the button renamed: it carries on, passes, and says what it followed', (() => {
      const p = [];
      if (renamed.status !== 0) p.push('exit ' + renamed.status);
      if (!/^OK\s+Reserve/m.test(renamed.stdout)) p.push('not reported OK');
      if (!RENAMED.test(renamed.stdout)) p.push('the rename was not said');
      if (!/Nothing is broken/.test(renamed.stdout)) p.push('it did not say nothing is broken');
      return p;
    })(), 'exit ' + renamed.status);

    const again = await runCheck(dir, url);
    dump('6. renamed, next run', again);
    record('6. and the run after that still follows it - the old note is kept', (() => {
      const p = [];
      if (again.status !== 0) p.push('exit ' + again.status);
      if (!RENAMED.test(again.stdout)) p.push('the rename was not followed again');
      const kept = (baseline(dir, KEY) || {}).steps || {};
      if (!(kept['0 button Reserve a table'] || []).includes('Reserve a table')) p.push('the note for the renamed step was overwritten');
      return p;
    })(), 'exit ' + again.status);

    app.sendWorks = false;
    const brokenBehind = await runCheck(dir, url);
    dump('7. renamed and broken behind it', brokenBehind);
    record('7. a real break AFTER the rename is now reached and reported', (() => {
      const p = [];
      if (brokenBehind.status === 0) p.push('passed a flow whose form does nothing');
      if (!/^X\s+Reserve/m.test(brokenBehind.stdout)) p.push('not marked broken');
      if (!/Thanks/.test(brokenBehind.stdout)) p.push('the failure is not the missing confirmation');
      if (!/Renamed on the way: The button "Reserve a table" is now called "Reserve here"/.test(brokenBehind.stdout)) p.push('the rename on the way was not said');
      return p;
    })(), 'exit ' + brokenBehind.status);

    reset();
    app.reserve = null;
    const gone = await runCheck(dir, url);
    dump('8. gone', gone);
    record('8. the button gone with nothing in its place: broken, as before', (() => {
      const p = [];
      if (gone.status === 0) p.push('passed without the button');
      if (!/Could not find the button "Reserve a table"/.test(gone.stdout)) p.push('not the usual message');
      if (ANY_RENAME.test(gone.stdout)) p.push('claimed a rename');
      return p;
    })(), 'exit ' + gone.status);

    reset();
    app.reserve = 'Reserve here';
    app.extra = true;
    const two = await runCheck(dir, url);
    dump('9. renamed plus another new button', two);
    record('9. renamed while another button also appeared: not a rename it can prove', (() => {
      const p = [];
      if (two.status === 0) p.push('passed');
      if (ANY_RENAME.test(two.stdout)) p.push('guessed a rename');
      if (!/Could not find the button "Reserve a table"/.test(two.stdout)) p.push('not the usual message');
      return p;
    })(), 'exit ' + two.status);

    reset();
    app.reserve = 'Reserve here';
    app.twin = true;
    const twins = await runCheck(dir, url);
    dump('10. new name on two buttons', twins);
    record('10. the new name is on two buttons: it does not pick one', (() => {
      const p = [];
      if (twins.status === 0) p.push('passed');
      if (ANY_RENAME.test(twins.stdout)) p.push('picked one');
      return p;
    })(), 'exit ' + twins.status);

    // ---- a project recorded before step memory existed ----
    reset();
    const old = project('kryptheon-heal-old-', 'menu.spec.js', MENU_SPEC);
    const OLD_KEY = 'tests/menu.spec.js :: Menu';
    const oldFirst = await runCheck(old, url);
    const file = path.join(old, 'kryptheon-baselines.json');
    const all = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete all[OLD_KEY].steps; // as every baseline written by 0.1.17 and before
    fs.writeFileSync(file, JSON.stringify(all, null, 2), 'utf8');
    app.menu = 'Show menu';
    const oldRenamed = await runCheck(old, url);
    dump('11. old baseline, renamed', oldRenamed);
    record('11. an older baseline with no step memory: proved from the last page, and not reported twice', (() => {
      const p = [];
      if (oldFirst.status !== 0) p.push('first run exit ' + oldFirst.status);
      if (oldRenamed.status !== 0) p.push('exit ' + oldRenamed.status);
      if (!/Renamed: The button "Open menu" is now called "Show menu"/.test(oldRenamed.stdout)) p.push('the rename was not followed');
      if (/somewhere different/.test(oldRenamed.stdout)) p.push('the same rename was also reported as the page changing');
      return p;
    })(), 'exit ' + oldRenamed.status);

    const quiet = await runCheck(old, url, ['--quiet']);
    dump('12. quiet', quiet);
    record('12. --quiet still says what it followed', (() => {
      const p = [];
      if (quiet.status !== 0) p.push('exit ' + quiet.status);
      if (!/Renamed: The button "Open menu"/.test(quiet.stdout)) p.push('quiet swallowed the rename');
      return p;
    })(), 'exit ' + quiet.status);

    // The step that had to follow a rename teaches nothing; one that finds
    // its button by name does, and an old baseline has to start learning.
    app.menu = 'Open menu';
    const oldBack = await runCheck(old, url);
    dump('12b. old baseline, name back', oldBack);
    record('12b. an older baseline starts remembering its steps on the next plain pass', (() => {
      const p = [];
      if (oldBack.status !== 0) p.push('exit ' + oldBack.status);
      const steps = (baseline(old, OLD_KEY) || {}).steps || {};
      if (!(steps['0 button Open menu'] || []).includes('Open menu')) p.push('no step memory learned: ' + JSON.stringify(steps));
      return p;
    })(), 'exit ' + oldBack.status);

    // ---- what a failed "assert text" check says ----
    reset();
    const words = project('kryptheon-heal-words-', 'words.spec.js', WORDS_SPEC);
    const wordsRun = await runCheck(words, url);
    dump('13. wrong words', wordsRun);
    record('13. a text check that fails says what it looked for and what was there', (() => {
      const p = [];
      if (wordsRun.status === 0) p.push('passed');
      if (!/The test expected the heading to say "Ember", but it says "Cinder"\./.test(wordsRun.stdout)) {
        p.push('got: ' + JSON.stringify((wordsRun.stdout.match(/^X .*\n.*$/m) || [''])[0]));
      }
      if (/A check on/.test(wordsRun.stdout)) p.push('still the old vague line');
      return p;
    })(), 'exit ' + wordsRun.status);
  } finally {
    server.close();
  }

  let failed = 0;
  for (const r of results) {
    if (r.problems.length) {
      failed++;
      console.log('FAIL  ' + r.name);
      for (const p of r.problems) console.log('        - ' + p);
    } else {
      console.log('PASS  ' + r.name);
    }
  }
  console.log(failed ? failed + ' of ' + results.length + ' rename checks FAILED.' : 'All ' + results.length + ' rename checks passed.');
  process.exit(failed ? 1 : 0);
})();
