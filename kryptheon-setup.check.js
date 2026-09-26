// Checks that `record` sets a folder up before the browser, not after.
// Run with:  node kryptheon-setup.check.js
//
// The person this is for built an app in Lovable. They have a web address and
// nothing else: no source folder, no package.json, nothing to change into.
// Measured before this existed: in an empty folder `record` went straight to
// the browser - a 200MB download on a new machine - and `check`, afterwards,
// in the same folder, said "There is no project here". Five minutes of
// somebody's time, thrown away at the very end.
//
// Everything here runs in real folders, and the installs are real `npm
// install`s against the registry, because an install that is only ever
// imagined is the one that fails on somebody's laptop. The home folder is
// always a temporary one: the real one is never touched.
//
// This file sits outside testDir and does not match Playwright's testMatch
// pattern, so `npx playwright test` ignores it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const project = require('./kryptheon-project.js');
const CLI = path.join(__dirname, 'bin', 'kryptheon.js');
const NL = String.fromCharCode(10);

// A page that answers, so `record` gets past its reachability check and on to
// the folder. Served from this process, which is why every command below is
// run with spawn rather than spawnSync: a synchronous child would freeze the
// loop this server answers on.
let server = null;
let address = null;
function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Demo</title><button>Save</button>');
    });
    server.listen(0, '127.0.0.1', () => {
      address = 'http://127.0.0.1:' + server.address().port + '/';
      resolve();
    });
  });
}

// Nothing listens on port 1. A child `record` pointed here stops at its own
// reachability check - before any browser - which is how the home-folder case
// is followed into its second process without a window ever opening.
const NOWHERE = 'http://127.0.0.1:1/';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(dir, rel, contents) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents, 'utf8');
}

// A home folder of our own. os.homedir() reads USERPROFILE on Windows and HOME
// elsewhere, every time it is called, so both are pointed here.
function fakeHomeEnv(home) {
  return { USERPROFILE: home, HOME: home };
}

// stdin is a pipe, never a terminal: every question takes its default. That is
// the path somebody in a terminal Node cannot recognise goes down, and the one
// a check can walk without somebody at the keyboard.
function run(args, options) {
  const opts = options || {};
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: opts.cwd,
      env: Object.assign({}, process.env, opts.env || {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group on Linux and macOS, so a browser it started can
      // be stopped with it. Not on Windows, where detached means a new window.
      detached: process.platform !== 'win32',
    });
    let out = '';
    let stopped = false;
    // No case here should ever reach the browser. If one does, the guard it is
    // checking has broken - and a check that fails by leaving a browser window
    // open on somebody's screen has made a second problem. Stop the whole
    // tree the moment it says it is opening one.
    const watch = () => {
      if (stopped || !/Opening .* in a browser/.test(out)) return;
      stopped = true;
      out += NL + '---STOPPED: it went on to the browser---';
      if (process.platform === 'win32') {
        require('child_process').spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (err) { /* gone */ }
      }
    };
    child.stdout.on('data', (c) => { out += c; watch(); });
    child.stderr.on('data', (c) => { out += c; watch(); });
    child.stdin.end();
    const timer = setTimeout(() => {
      out += NL + '---TIMED OUT---';
      try { child.kill(); } catch (err) { /* gone */ }
    }, opts.timeout || 300000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code, out: out });
    });
  });
}

// The real prepareFolder, in a real process standing in `dir`. Every path in
// the command is worked out from the folder it starts in, so this is the only
// honest way to run it somewhere else.
function prepareIn(dir, url, env) {
  const runner = path.join(os.tmpdir(), 'kryptheon-prepare-' + process.pid + '-' + Date.now() + '.js');
  fs.writeFileSync(
    runner,
    [
      'const cli = require(' + JSON.stringify(CLI) + ');',
      'cli.prepareFolder(' + JSON.stringify(url) + ')',
      "  .then((r) => console.log('---RESULT--- ' + r))",
      "  .catch((e) => { console.log('---THREW--- ' + e.stack); process.exit(1); });",
    ].join(NL),
    'utf8',
  );
  return run([runner], { cwd: dir, env: env }).then((r) => {
    try { fs.unlinkSync(runner); } catch (err) { /* fine */ }
    const m = /---RESULT--- (\S+)/.exec(r.out);
    return { result: m ? m[1] : null, out: r.out };
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

function looksLikeAStackTrace(out) {
  return /\n\s+at .+\(.+:\d+:\d+\)/.test(out) || /---THREW---/.test(out);
}

// Records, by name, what was in each folder before. Anything new afterwards
// was written by the command.
function contents(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch (err) {
    return [];
  }
}

const cases = [
  {
    name: '1. every kind of folder gets the plan it should, and the plan only looks',
    run: async () => {
      const problems = [];
      const root = tmp('kryptheon-plan-');
      const home = path.join(root, 'home');
      fs.mkdirSync(home);
      const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
      Object.assign(process.env, fakeHomeEnv(home));
      try {
        if (path.resolve(os.homedir()) !== path.resolve(home)) {
          return ['could not point the home folder somewhere safe: ' + os.homedir()];
        }
        const expect = (label, dir, want, env) => {
          const plan = project.setupPlan(dir, env || {});
          const got = plan.action + (plan.reason ? '/' + plan.reason : '');
          if (got !== want) problems.push(label + ': expected ' + want + ', got ' + got);
          return plan;
        };

        const empty = path.join(root, 'work', 'empty');
        fs.mkdirSync(empty, { recursive: true });
        expect('an empty folder', empty, 'create');

        write(root, 'work/app/package.json', '{"name":"app"}');
        expect('a project without kryptheon', path.join(root, 'work', 'app'), 'install');

        fs.mkdirSync(path.join(root, 'work', 'app', 'sub'));
        const above = expect('a folder inside that project', path.join(root, 'work', 'app', 'sub'), 'above');
        if (above.project && path.resolve(above.project) !== path.resolve(path.join(root, 'work', 'app'))) {
          problems.push('the project above was named as ' + above.project);
        }

        write(root, 'work/ready/package.json', '{}');
        write(root, 'work/ready/node_modules/kryptheon/kryptheon-fixture.js', '');
        expect('a project with kryptheon installed', path.join(root, 'work', 'ready'), 'ready');

        expect('an empty folder with the escape hatch set', empty, 'ready', { KRYPTHEON_ALLOW_NO_PACKAGE_JSON: '1' });

        // This repository loads itself by name. Without the self-reference rule
        // record offered to install kryptheon into kryptheon.
        expect('the kryptheon package itself', __dirname, 'ready');

        // Somebody else's app with the same name is not this package.
        write(root, 'work/named/package.json', '{"name":"kryptheon"}');
        expect('an app that happens to be called kryptheon', path.join(root, 'work', 'named'), 'install');

        const inHome = expect('the home folder', home, 'home');
        if (inHome.into !== path.join(home, project.HOME_RECORDINGS)) problems.push('home records into ' + inHome.into);

        write(home, 'kryptheon-tests/notes.txt', 'somebody else');
        expect('the home folder, with kryptheon-tests holding something else', home, 'refuse/taken');
        fs.rmSync(path.join(home, 'kryptheon-tests'), { recursive: true, force: true });

        write(home, 'kryptheon-tests/package.json', '{"devDependencies":{"kryptheon":"^0.1.12"}}');
        expect('the home folder, with a kryptheon-tests made on an earlier run', home, 'home');

        if (process.env.SystemRoot) expect('a system folder', process.env.SystemRoot, 'refuse/system');
        else expect('a system folder', '/usr', 'refuse/system');

        // The measured state of one real machine: a stray package.json in the
        // home folder. A folder on the Desktop must not be told that is its
        // project.
        write(home, 'package.json', '{"name":"stray"}');
        fs.mkdirSync(path.join(home, 'Desktop', 'mytests'), { recursive: true });
        expect('a folder under a home that holds a stray package.json', path.join(home, 'Desktop', 'mytests'), 'create');

        // Only looks: not one file was added anywhere by all of the above.
        if (contents(empty).length) problems.push('planning wrote into the empty folder: ' + contents(empty).join(', '));
        if (contents(path.join(root, 'work', 'app', 'sub')).length) problems.push('planning wrote into the subfolder');
      } finally {
        Object.assign(process.env, saved);
        if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
        if (saved.HOME === undefined) delete process.env.HOME;
        fs.rmSync(root, { recursive: true, force: true });
      }
      return problems;
    },
  },
  {
    name: '2. Enter takes the offered answer; only y or n is read as more than that',
    run: async () => {
      const problems = [];
      const table = [
        ['', true, true], ['', false, false],
        ['y', false, true], ['Y', false, true], ['yes', false, true],
        ['n', true, false], ['N', true, false], ['no', true, false],
        ['   ', true, true], ['  y ', false, true],
        // Anything else is not a yes. Setting a folder up is not done on a typo.
        ['x', true, false], ['ok', true, false],
      ];
      for (const [typed, byDefault, want] of table) {
        const got = project.answeredYes(typed, byDefault);
        if (got !== want) {
          problems.push(JSON.stringify(typed) + ' with ' + (byDefault ? 'yes' : 'no') + ' by default read as ' + got);
        }
      }
      if (project.setupQuestion({ action: 'above' }).yesByDefault) {
        problems.push('a second project inside somebody\'s first is set up on Enter');
      }
      for (const action of ['create', 'install', 'home']) {
        if (!project.setupQuestion({ action: action }).yesByDefault) problems.push(action + ' is no by default');
      }
      return problems;
    },
  },
  {
    name: '3. record in a home folder whose kryptheon-tests is somebody else\'s: stops before the browser, writes nothing',
    run: async () => {
      const home = tmp('kryptheon-home-');
      try {
        write(home, 'kryptheon-tests/notes.txt', 'somebody else');
        const before = contents(home);
        const r = await run([CLI, 'record', address], { cwd: home, env: fakeHomeEnv(home), timeout: 60000 });
        const problems = [];
        if (r.code === 0) problems.push('it reported success');
        if (!/not one I made/.test(r.out)) problems.push('it does not say why:' + NL + r.out);
        if (/Opening .* in a browser/.test(r.out)) problems.push('it went on to the browser anyway');
        if (JSON.stringify(contents(home)) !== JSON.stringify(before)) {
          problems.push('the home folder changed: ' + contents(home).join(', '));
        }
        if (JSON.stringify(contents(path.join(home, 'kryptheon-tests'))) !== JSON.stringify(['notes.txt'])) {
          problems.push('somebody else\'s folder was written into: ' + contents(path.join(home, 'kryptheon-tests')).join(', '));
        }
        if (looksLikeAStackTrace(r.out)) problems.push('a stack trace reached the screen');
        return problems;
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  },
  {
    name: '4. record in a folder inside another project, no keyboard: says where the project is, changes nothing',
    run: async () => {
      const root = tmp('kryptheon-above-');
      try {
        write(root, 'package.json', '{"name":"app"}');
        const sub = path.join(root, 'e2e');
        fs.mkdirSync(sub);
        const r = await run([CLI, 'record', address], { cwd: sub, timeout: 60000 });
        const problems = [];
        if (r.code === 0) problems.push('it reported success');
        if (!/inside a project/.test(r.out)) problems.push('it does not say this folder is inside a project:' + NL + r.out);
        if (r.out.indexOf(root) === -1) problems.push('it does not name the project');
        if (!/Nothing was changed/.test(r.out)) problems.push('it does not say nothing changed');
        if (/Opening .* in a browser/.test(r.out)) problems.push('it went on to the browser anyway');
        if (contents(sub).length) problems.push('it wrote into the subfolder: ' + contents(sub).join(', '));
        const pkg = readJson(path.join(root, 'package.json'));
        if (!pkg || pkg.devDependencies) problems.push('the project above was changed');
        return problems;
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: '5. an empty folder is set up for real, and check then agrees it is a project',
    run: async () => {
      const dir = tmp('kryptheon-empty-');
      try {
        const r = await prepareIn(dir, address);
        const problems = [];
        if (r.result !== 'null') problems.push('it did not carry on to record (returned ' + r.result + '):' + NL + r.out);
        const pkg = readJson(path.join(dir, 'package.json'));
        if (!pkg) problems.push('no package.json was written');
        else if (!pkg.devDependencies || !pkg.devDependencies.kryptheon) problems.push('package.json does not list kryptheon: ' + JSON.stringify(pkg));
        if (!project.kryptheonInstalledIn(dir)) problems.push('kryptheon is not installed in the folder');
        if (!/Installed\./.test(r.out)) problems.push('it did not say the install finished');
        if (looksLikeAStackTrace(r.out)) problems.push('a stack trace reached the screen');

        // The whole point: the command that used to refuse now accepts it.
        const c = await run([CLI, 'check'], { cwd: dir, timeout: 60000 });
        if (/no project here/i.test(c.out)) problems.push('check still says there is no project here');
        if (!/No recordings were found/.test(c.out)) problems.push('check did not treat it as a project:' + NL + c.out);
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '6. a project without kryptheon: installed, and nothing else in its package.json moves',
    run: async () => {
      const dir = tmp('kryptheon-install-');
      try {
        const original = { name: 'shop', version: '2.3.4', scripts: { start: 'node server.js' }, dependencies: { left: '1.0.0' } };
        write(dir, 'package.json', JSON.stringify(original, null, 2));
        const r = await prepareIn(dir, address);
        const problems = [];
        if (r.result !== 'null') problems.push('it did not carry on to record (returned ' + r.result + '):' + NL + r.out);
        if (!/npm install --save-dev kryptheon/.test(r.out)) problems.push('it did not say what it would run');
        const pkg = readJson(path.join(dir, 'package.json')) || {};
        for (const key of ['name', 'version', 'scripts', 'dependencies']) {
          if (JSON.stringify(pkg[key]) !== JSON.stringify(original[key])) {
            problems.push(key + ' changed: ' + JSON.stringify(pkg[key]));
          }
        }
        if (!pkg.devDependencies || !pkg.devDependencies.kryptheon) problems.push('kryptheon was not added to devDependencies');
        if (!project.kryptheonInstalledIn(dir)) problems.push('kryptheon is not installed');
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '7. from the home folder: a kryptheon-tests folder is made, set up, and record runs again inside it',
    run: async () => {
      const home = tmp('kryptheon-home-');
      try {
        // The address answers nothing, so the second record - the one inside
        // the new folder - stops at its own reachability check. What it says
        // is the proof that it ran, and ran there.
        const r = await prepareIn(home, NOWHERE, fakeHomeEnv(home));
        const into = path.join(home, project.HOME_RECORDINGS);
        const problems = [];
        if (r.result !== '1') problems.push('expected the second record to stop at the address, got ' + r.result + ':' + NL + r.out);
        if (!fs.existsSync(path.join(into, 'package.json'))) problems.push('no package.json in ' + into);
        if (!project.kryptheonInstalledIn(into)) problems.push('kryptheon is not installed in ' + into);
        if (!/127\.0\.0\.1:1/.test(r.out)) problems.push('the second record never ran - nothing was said about the address:' + NL + r.out);
        // Nothing loose in the home folder itself.
        const loose = contents(home).filter((n) => n !== project.HOME_RECORDINGS);
        if (loose.length) problems.push('things were left loose in the home folder: ' + loose.join(', '));
        // The second record failed, so the "your recordings are in" lines must
        // not be printed: they would describe a recording that does not exist.
        if (/Your recordings are in/.test(r.out)) problems.push('it pointed at recordings that were never made');
        if (looksLikeAStackTrace(r.out)) problems.push('a stack trace reached the screen');
        return problems;
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  },
  {
    name: '8. the install fails: said plainly, nothing to undo, and running again carries on from there',
    run: async () => {
      const dir = tmp('kryptheon-offline-');
      try {
        // A registry that answers nothing, and no retries, so this fails fast.
        const offline = { npm_config_registry: 'http://127.0.0.1:1/', npm_config_fetch_retries: '0' };
        const r = await prepareIn(dir, address, offline);
        const problems = [];
        if (r.result !== '1') problems.push('it did not stop (returned ' + r.result + '):' + NL + r.out);
        if (!/could not be installed/.test(r.out)) problems.push('it does not say the install failed:' + NL + r.out);
        if (!/nothing needs undoing/.test(r.out)) problems.push('it does not say a rerun is safe');
        if (/Installed\./.test(r.out)) problems.push('it claimed the install finished');
        if (/npm (ERR|error)/.test(r.out) || looksLikeAStackTrace(r.out)) problems.push('npm\'s own error reached the screen:' + NL + r.out);
        if (project.kryptheonInstalledIn(dir)) problems.push('kryptheon is somehow installed');

        // Running again, online, goes straight to the install: the package.json
        // left behind is not a problem, it is progress.
        const again = await prepareIn(dir, address);
        if (again.result !== 'null') problems.push('the second run did not recover (returned ' + again.result + '):' + NL + again.out);
        if (!project.kryptheonInstalledIn(dir)) problems.push('the second run did not install kryptheon');
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '8b. npm says it worked but nothing is on disk: not believed',
    run: async () => {
      const dir = tmp('kryptheon-liar-');
      const bin = tmp('kryptheon-fakenpm-');
      try {
        // An npm that exits 0 and does nothing, first on the PATH. The install
        // is judged by what is on disk, not by what npm says.
        if (process.platform === 'win32') {
          write(bin, 'npm.cmd', '@echo off' + NL + 'exit /b 0' + NL);
        } else {
          write(bin, 'npm', '#!/bin/sh' + NL + 'exit 0' + NL);
          fs.chmodSync(path.join(bin, 'npm'), 0o755);
        }
        const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
        const env = {};
        env[key] = bin + path.delimiter + process.env[key];
        const r = await prepareIn(dir, address, env);
        const problems = [];
        if (r.result !== '1') problems.push('it carried on to record with nothing installed (returned ' + r.result + '):' + NL + r.out);
        if (/Installed\./.test(r.out)) problems.push('it said Installed with nothing on disk');
        if (!/could not be installed/.test(r.out)) problems.push('it did not say the install failed');
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(bin, { recursive: true, force: true });
      }
    },
  },
  {
    name: '9. check in a home folder where record left recordings: names that folder, not "go and find a project"',
    run: async () => {
      const home = tmp('kryptheon-home-');
      try {
        write(home, 'kryptheon-tests/package.json', '{"private":true,"devDependencies":{"kryptheon":"^0.1.12"}}');
        const r = await run([CLI, 'check'], { cwd: home, env: fakeHomeEnv(home), timeout: 60000 });
        const into = path.join(home, project.HOME_RECORDINGS);
        const problems = [];
        if (r.code === 0) problems.push('it reported success from the home folder');
        if (r.out.indexOf(into) === -1) problems.push('it does not name the folder the recordings are in:' + NL + r.out);
        if (!/npx kryptheon check/.test(r.out)) problems.push('it does not say what to run');
        if (/cd path\\to\\your\\project/.test(r.out)) problems.push('it still sends them looking for a project they never had');
        return problems;
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  },
  {
    name: '10. an empty folder, check first: it says a web address is enough',
    run: async () => {
      const dir = tmp('kryptheon-nothing-');
      try {
        const r = await run([CLI, 'check'], { cwd: dir, timeout: 60000 });
        const problems = [];
        if (r.code === 0) problems.push('it reported success');
        if (!/only a web address/.test(r.out)) problems.push('it does not tell somebody with only an address what to do:' + NL + r.out);
        if (!/npx kryptheon record/.test(r.out)) problems.push('it does not name the command');
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '11. a finished recording says npx kryptheon check - the bare name does not exist after npx',
    run: async () => {
      const dir = tmp('kryptheon-saved-');
      try {
        write(dir, 'package.json', '{}');
        const spec = 'tests/recorded-20260924-120000.spec.js';
        // Named already, so finishing it does not go to the network.
        write(dir, spec, [
          "import { test, expect } from '@playwright/test';",
          '',
          "test('Save a note', async ({ page }) => {",
          "  await page.goto('http://127.0.0.1:1/');",
          "  await page.getByRole('button', { name: 'Save' }).click();",
          '});',
          '',
        ].join(NL));
        const runner = path.join(dir, 'finish.js');
        write(dir, 'finish.js', [
          'const cli = require(' + JSON.stringify(CLI) + ');',
          'cli.finaliseRecording(' + JSON.stringify(spec) + ', {})',
          "  .then((r) => console.log('---DONE--- ' + r.code))",
          "  .catch((e) => { console.log('---THREW--- ' + e.message); process.exit(1); });",
        ].join(NL));
        const r = await run([runner], { cwd: dir, timeout: 120000 });
        const problems = [];
        if (!/---DONE--- 0/.test(r.out)) problems.push('finishing the recording did not succeed:' + NL + r.out.slice(0, 600));
        if (!/Run it any time with:\s+npx kryptheon check/.test(r.out)) {
          problems.push('it does not say npx kryptheon check:' + NL + r.out.slice(0, 600));
        }
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '12. nothing tells anybody to type a bare "kryptheon" - after npx that command does not exist',
    run: async () => {
      // Measured on a machine without a global install, in a folder record had
      // just set up: `kryptheon check` -> "The term 'kryptheon' is not
      // recognized". The machine this is built on has a global link, so the
      // bare name works here and nowhere else. Twenty messages said it.
      const problems = [];
      const bare = /(?<!npx )(?<![\w/.-])kryptheon (record|check|accept|remove|rm|setup-ai)\b/;
      const shipped = require('./package.json').files;
      const files = [];
      for (const entry of shipped) {
        const full = path.join(__dirname, entry);
        if (entry.endsWith('/')) {
          for (const name of fs.readdirSync(full)) if (name.endsWith('.js')) files.push(path.join(entry, name));
        } else if (entry.endsWith('.js')) {
          files.push(entry);
        }
      }
      for (const rel of files) {
        const lines = fs.readFileSync(path.join(__dirname, rel), 'utf8').split(/\r?\n/);
        lines.forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments are for us, not for them
          if (bare.test(line)) problems.push(rel + ':' + (i + 1) + ' says ' + line.trim());
        });
      }

      // And through the real command, on the two paths a person meets first.
      const help = await run([CLI], { timeout: 60000 });
      // Command lines only - the title line above them names the tool, it is
      // not something to type.
      const helpLines = help.out.split(/\r?\n/).filter((l) => /^\s+(npx )?kryptheon (record|check|accept|remove|setup-ai|--version)/.test(l));
      if (helpLines.length < 5) problems.push('the help did not list the commands:' + NL + help.out);
      for (const l of helpLines) if (!/^\s+npx kryptheon /.test(l)) problems.push('the help says: ' + l.trim());

      // The one found live: a recording cut off by a closed window is skipped,
      // and the way out it offers has to be one that works.
      const dir = tmp('kryptheon-cutoff-');
      try {
        write(dir, 'package.json', '{}');
        write(dir, 'node_modules/kryptheon/kryptheon-fixture.js', '');
        write(dir, 'tests/recorded-20260924-142532.spec.js', [
          "import { test, expect } from '@playwright/test';",
          '',
          "test('test', async ({ page }) => {",
          "  await page.goto('http://127.0.0.1:1/');",
          '});',
          '',
        ].join(NL));
        const r = await run([CLI, 'check'], { cwd: dir, timeout: 60000 });
        if (!/not a real recording/.test(r.out)) problems.push('the cut-off recording was not reported:' + NL + r.out);
        if (!/Record it again:\s+npx kryptheon record/.test(r.out)) problems.push('the way out is not npx:' + NL + r.out);
        for (const l of r.out.split(/\r?\n/)) if (bare.test(l)) problems.push('check says: ' + l.trim());
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return problems;
    },
  },
  {
    name: '13. check run by another copy - npx kryptheon@latest - hands over to the folder\'s own, so Playwright loads once',
    run: async () => {
      // Found through the MCP server, then measured by hand: in a folder record
      // had set up, `npx kryptheon@latest check` ran npx's copy while the
      // recordings loaded the folder's, and Playwright stopped with "Requiring
      // @playwright/test second time" before anything ran. This repository is
      // the other copy here; the folder gets its own from the registry, set up
      // exactly the way record does it.
      const dir = tmp('kryptheon-twocopies-');
      try {
        const setup = await prepareIn(dir, address);
        if (setup.result !== 'null') return ['could not set the folder up for the check:' + NL + setup.out];
        write(dir, 'tests/recorded-20260925-120000.spec.js', [
          "import { test, expect } from '@playwright/test';",
          '',
          "test('Press save', async ({ page }) => {",
          '  await page.goto(' + JSON.stringify(address) + ');',
          "  await page.getByRole('button', { name: 'Save' }).click();",
          '});',
          '',
        ].join(NL));
        const r = await run([CLI, 'check'], { cwd: dir, timeout: 180000 });
        const problems = [];
        if (/second time/.test(r.out)) problems.push('two Playwrights were loaded:' + NL + r.out.slice(0, 700));
        if (!/1 working, 0 broken/.test(r.out)) problems.push('the recording did not run and pass:' + NL + r.out.slice(0, 900));
        const theirs = readJson(path.join(dir, 'node_modules', 'kryptheon', 'package.json')).version;
        const mine = require('./package.json').version;
        if (theirs !== mine && r.out.indexOf('installed in this folder (' + theirs + ')') === -1) {
          problems.push('the folder runs ' + theirs + ' and this is ' + mine + ', and nothing said which one ran:' + NL + r.out.slice(0, 500));
        }
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '14. a folder with an older kryptheon is updated first, so @latest and every AI tool get the fix they asked for',
    run: async () => {
      // Found the day 0.1.18 shipped: the fix was on the registry, and in a
      // folder record had set up with 0.1.17, `npx kryptheon@latest check`
      // handed over to that 0.1.17 and the fix never ran.
      const v = await registryPair();
      if (!v) return ['could not ask the registry which versions exist'];
      const dir = await folderWith(v.older, address);
      const me = copyClaiming(v.latest);
      try {
        const r = await run([path.join(me, 'bin', 'kryptheon.js'), 'check'], { cwd: dir, timeout: 240000 });
        const problems = [];
        const now = (readJson(path.join(dir, 'node_modules', 'kryptheon', 'package.json')) || {}).version;
        if (now !== v.latest) problems.push('the folder still has ' + now + ', not ' + v.latest + ':' + NL + r.out.slice(0, 900));
        if (!/Updated\./.test(r.out)) problems.push('it did not say it updated:' + NL + r.out.slice(0, 900));
        if (/installed in this folder \(/.test(r.out)) problems.push('it still says it ran an older copy');
        if (!/1 working, 0 broken/.test(r.out)) problems.push('the recording did not run and pass after the update:' + NL + r.out.slice(0, 900));
        const dep = ((readJson(path.join(dir, 'package.json')) || {}).devDependencies || {}).kryptheon || '';
        if (dep.indexOf(v.latest) === -1) problems.push('package.json still asks for ' + dep);
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(me, { recursive: true, force: true });
      }
    },
  },
  {
    name: '15. the update cannot happen (no internet): the folder\'s own copy runs, and it says so',
    run: async () => {
      const v = await registryPair();
      if (!v) return ['could not ask the registry which versions exist'];
      const dir = await folderWith(v.older, address);
      const me = copyClaiming(v.latest);
      const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
      try {
        const offline = { npm_config_registry: 'http://127.0.0.1:1/', npm_config_fetch_retries: '0' };
        const r = await run([path.join(me, 'bin', 'kryptheon.js'), 'check'], { cwd: dir, env: offline, timeout: 240000 });
        const problems = [];
        if (!/Could not update it just now/.test(r.out)) problems.push('it did not say the update failed:' + NL + r.out.slice(0, 900));
        if (r.out.indexOf('installed in this folder (' + v.older + ')') === -1) problems.push('it did not say which copy ran');
        if (!/1 working, 0 broken/.test(r.out)) problems.push('the recording did not still run:' + NL + r.out.slice(0, 900));
        const now = (readJson(path.join(dir, 'node_modules', 'kryptheon', 'package.json')) || {}).version;
        if (now !== v.older) problems.push('the folder now has ' + now);
        if (fs.readFileSync(path.join(dir, 'package.json'), 'utf8') !== before) problems.push('package.json changed although nothing was updated');
        if (looksLikeAStackTrace(r.out)) problems.push('a stack trace reached the person');
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(me, { recursive: true, force: true });
      }
    },
  },
  {
    name: '16. never downwards: an old cached copy leaves a newer folder exactly as it is',
    run: async () => {
      const v = await registryPair();
      if (!v) return ['could not ask the registry which versions exist'];
      const dir = await folderWith(v.older, address);
      const me = copyClaiming('0.0.1');
      const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
      try {
        const r = await run([path.join(me, 'bin', 'kryptheon.js'), 'check'], { cwd: dir, timeout: 240000 });
        const problems = [];
        if (/Updating/.test(r.out)) problems.push('it tried to change the folder\'s copy:' + NL + r.out.slice(0, 600));
        const now = (readJson(path.join(dir, 'node_modules', 'kryptheon', 'package.json')) || {}).version;
        if (now !== v.older) problems.push('the folder now has ' + now);
        if (fs.readFileSync(path.join(dir, 'package.json'), 'utf8') !== before) problems.push('package.json changed');
        if (!/1 working, 0 broken/.test(r.out)) problems.push('the recording did not run:' + NL + r.out.slice(0, 600));
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(me, { recursive: true, force: true });
      }
    },
  },
];

// The two newest versions on the registry, asked once. The update checks
// install real published versions: a check that only imagines an install is
// the one that fails on somebody's laptop.
let pair;
function registryPair() {
  if (pair !== undefined) return Promise.resolve(pair);
  const args = ['view', 'kryptheon', 'versions', '--json'];
  const r = process.platform === 'win32'
    ? require('child_process').spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm'].concat(args), { encoding: 'utf8' })
    : require('child_process').spawnSync('npm', args, { encoding: 'utf8' });
  try {
    const all = JSON.parse(r.stdout).filter((x) => /^\d+\.\d+\.\d+$/.test(x));
    pair = all.length >= 2 ? { older: all[all.length - 2], latest: all[all.length - 1] } : null;
  } catch (err) {
    pair = null;
  }
  return Promise.resolve(pair);
}

// A folder set up by an older kryptheon, with one recording, installed once
// and copied for each check that needs it.
const olderFolders = {};
async function folderWith(version, url) {
  if (!olderFolders[version]) {
    const dir = tmp('kryptheon-older-' + version.split('.').join('-') + '-');
    write(dir, 'package.json', '{"name":"older","version":"1.0.0","private":true}');
    const args = ['install', '--save-dev', 'kryptheon@' + version, '--no-audit', '--no-fund', '--loglevel=error'];
    if (process.platform === 'win32') {
      require('child_process').spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm'].concat(args), { cwd: dir });
    } else {
      require('child_process').spawnSync('npm', args, { cwd: dir });
    }
    write(dir, 'tests/recorded-20260926-120000.spec.js', [
      "import { test, expect } from 'kryptheon/kryptheon-fixture';",
      '',
      "test('Press save', async ({ page }) => {",
      '  await page.goto(' + JSON.stringify(url) + ');',
      "  await page.getByRole('button', { name: 'Save' }).click();",
      '});',
      '',
    ].join(NL));
    olderFolders[version] = dir;
  }
  const copy = tmp('kryptheon-older-copy-');
  fs.cpSync(olderFolders[version], copy, { recursive: true });
  return copy;
}

// This repository, as if it were published as `version` - what npx would
// have in its cache.
function copyClaiming(version) {
  const dir = tmp('kryptheon-claims-');
  fs.cpSync(__dirname, dir, { recursive: true, filter: (p) => !/[\\/](\.git|test-results)([\\/]|$)/.test(p) });
  const pkg = readJson(path.join(dir, 'package.json'));
  pkg.version = version;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
  return dir;
}

(async () => {
  await startServer();
  let failures = 0;
  try {
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
  } finally {
    server.close();
    for (const d of Object.values(olderFolders)) fs.rmSync(d, { recursive: true, force: true });
  }

  console.log('');
  if (failures) {
    console.log(failures + ' check(s) failed.');
    process.exit(1);
  }
  console.log('All ' + cases.length + ' folder-setup checks passed.');
})();
