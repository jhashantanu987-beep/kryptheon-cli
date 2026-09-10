// Checks that the command refuses to test a project it is not standing in.
// Run with:  node kryptheon-project.check.js
//
// `check` reads recordings out of ./tests and results out of the folder it was
// run in. Run it somewhere that is not a project and it does not fail - it
// succeeds, about whatever tests folder happened to be lying there. Somebody
// installed into their home folder and got exactly that.
//
// A green that belongs to another project is not a result, it is a lie with a
// tick beside it, so this is the one case worth exiting non-zero over even
// though nothing was tested.
//
// Everything here goes through the real command in a real folder. A guard that
// exists in a module and is never reached is the same as no guard.
//
// This file sits outside testDir and does not match Playwright's testMatch
// pattern, so `npx playwright test` ignores it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const project = require('./kryptheon-project.js');
const CLI = path.join(__dirname, 'bin', 'kryptheon.js');

function folder(options) {
  const opts = options || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-proj-'));
  if (opts.packageJson) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }), 'utf8');
  }
  if (opts.recording) {
    fs.mkdirSync(path.join(dir, 'tests'));
    fs.writeFileSync(
      path.join(dir, 'tests', 'flow.spec.js'),
      [
        'const { test, expect } = require(' + JSON.stringify(path.join(__dirname, 'kryptheon-fixture.js')) + ');',
        '',
        "test('Flow', async ({ page }) => {",
        "  await page.goto('http://localhost:1/');",
        "  await page.getByRole('button', { name: 'Go' }).click();",
        '});',
      ].join('\n'),
      'utf8',
    );
  }
  return dir;
}

function run(dir, env) {
  return spawnSync(process.execPath, [CLI, 'check'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120000,
    env: Object.assign({}, process.env, env || {}),
  });
}

const cases = [
  {
    name: '1. a folder with no package.json: it stops, and the exit code says so',
    run: () => {
      const dir = folder({});
      try {
        // A tests folder is sitting there - the whole danger is that it would
        // be picked up and reported on as though it belonged here.
        fs.mkdirSync(path.join(dir, 'tests'));
        fs.writeFileSync(path.join(dir, 'tests', 'someone-elses.spec.js'), '// not this project\n', 'utf8');

        const r = run(dir);
        const out = String(r.stdout || '') + String(r.stderr || '');
        const problems = [];
        if (r.status === 0) problems.push('it reported success in a folder that is not a project');
        if (!/no project here/i.test(out)) problems.push('it does not say what is wrong:\n' + out);
        if (out.indexOf(dir) === -1) problems.push('it does not say where you are:\n' + out);
        if (!/package\.json/.test(out)) problems.push('it does not name what is missing');
        if (!/cd /.test(out)) problems.push('it does not say what to do instead');
        // Nothing may have been run.
        if (/Summary:|working, /.test(out)) problems.push('it ran something anyway:\n' + out);
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '2. a real project with nothing recorded: a plain message, and no failure',
    run: () => {
      const dir = folder({ packageJson: true });
      try {
        const r = run(dir);
        const out = String(r.stdout || '') + String(r.stderr || '');
        const problems = [];
        // Not a failure: an assistant running this after every change would
        // read a non-zero exit as "something broke" and start repairing code
        // that is perfectly fine.
        if (r.status !== 0) problems.push('it failed when there was simply nothing to check: exit ' + r.status);
        if (!/No recordings were found in this project/.test(out)) {
          problems.push('it does not say what it found:\n' + out);
        }
        if (!/kryptheon record http:\/\/localhost:3000/.test(out)) {
          problems.push('it does not show the command to run first:\n' + out);
        }
        if (/no project here/i.test(out)) problems.push('it confused an empty project with no project at all');
        if (/Error|error:|stack/i.test(out)) problems.push('it crashed rather than explained:\n' + out);
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '3. a home or system folder: it says so specifically',
    run: () => {
      const problems = [];
      // Said through the real message builder, with the real detector - running
      // the command in the actual home folder would leave artefacts there.
      if (!project.isHomeOrSystem(os.homedir())) problems.push('the home folder is not recognised as one');
      if (!project.isHomeOrSystem(path.parse(process.cwd()).root)) {
        problems.push('a drive root is not recognised as a system folder');
      }
      if (project.isHomeOrSystem(path.join(os.homedir(), 'code', 'my-app'))) {
        problems.push('an ordinary project inside the home folder was treated as the home folder');
      }

      const inspection = project.inspectProject(os.homedir(), {});
      if (inspection.ok) problems.push('the home folder was accepted as a project');
      if (!inspection.personal) problems.push('it did not notice the home folder is personal');
      const lines = project.noProjectLines(inspection).join('\n');
      if (!/home or a system folder/.test(lines)) {
        problems.push('the home folder gets no special warning:\n' + lines);
      }
      if (!/almost certainly not the one you meant/.test(lines)) {
        problems.push('it does not say why this is nearly always a mistake');
      }

      // The case that actually happened, and the reason a package.json is not
      // enough on its own: installing into a home folder leaves a package.json,
      // a node_modules and a tests folder there. Every sign says "project" and
      // none of them is true. Checked against a folder built to look exactly
      // like that, so this holds on a machine where home is still clean.
      const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-decoy-'));
      try {
        fs.writeFileSync(path.join(decoy, 'package.json'), '{"name":"x"}', 'utf8');
        const asHome = project.inspectProject(decoy, {});
        // Standing in for the real home folder, since the detector compares
        // against the actual one.
        const forced = Object.assign({}, asHome, { personal: true, ok: false, reason: 'personal' });
        const forcedLines = project.noProjectLines(forced).join('\n');
        if (!/not what makes a project/.test(forcedLines)) {
          problems.push('it does not explain the package.json that is sitting there:\n' + forcedLines);
        }
        if (!/npm install was run in this folder by mistake/.test(forcedLines)) {
          problems.push('it does not name how the package.json got there:\n' + forcedLines);
        }
      } finally {
        fs.rmSync(decoy, { recursive: true, force: true });
      }
      if (project.hasPackageJson(os.homedir()) && project.inspectProject(os.homedir(), {}).ok) {
        problems.push('a package.json in the home folder was enough to get past the guard');
      }

      // An ordinary project must not carry that warning.
      const ordinary = project.inspectProject(path.join(os.homedir(), 'code', 'my-app'), {});
      const ordinaryLines = project.noProjectLines(ordinary).join('\n');
      if (/home or a system folder/.test(ordinaryLines)) {
        problems.push('an ordinary folder was warned about as if it were the home folder');
      }
      return problems;
    },
  },
  {
    name: '4. a normal project with recordings: no warning of any kind',
    run: () => {
      const dir = folder({ packageJson: true, recording: true });
      try {
        // Nothing here can reach a browser, so what matters is what it says on
        // the way past the guard, not the result of the run.
        const r = run(dir);
        const out = String(r.stdout || '') + String(r.stderr || '');
        const problems = [];
        if (/no project here/i.test(out)) problems.push('it refused a real project:\n' + out);
        if (/home or a system folder/.test(out)) problems.push('it warned about an ordinary project folder');
        if (/No recordings were found/.test(out)) problems.push('it did not see the recording that is there');
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '5. the escape hatch lets a folder with no package.json run',
    run: () => {
      const dir = folder({ recording: true });
      try {
        const blocked = run(dir);
        const problems = [];
        if (blocked.status === 0) problems.push('it ran without the escape hatch being set');

        const allowed = run(dir, { KRYPTHEON_ALLOW_NO_PACKAGE_JSON: '1' });
        const out = String(allowed.stdout || '') + String(allowed.stderr || '');
        if (/no project here/i.test(out)) {
          problems.push('the escape hatch did not let it past:\n' + out.slice(0, 500));
        }
        if (project.ESCAPE_HATCH !== 'KRYPTHEON_ALLOW_NO_PACKAGE_JSON') {
          problems.push('the variable is named ' + project.ESCAPE_HATCH);
        }
        // An empty value is not setting it. Asserted here rather than through
        // a child process: Windows drops an empty variable on the way across,
        // so the child would never see the case being tested.
        const emptied = project.inspectProject(dir, { KRYPTHEON_ALLOW_NO_PACKAGE_JSON: '' });
        if (emptied.ok) problems.push('an empty value counted as permission');
        if (emptied.allowed) problems.push('an empty value was read as the hatch being set');
        const set = project.inspectProject(dir, { KRYPTHEON_ALLOW_NO_PACKAGE_JSON: '1' });
        if (!set.ok) problems.push('a real value did not let it past');
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '6. the home folder WITH a package.json: it stops - the case from the real machine',
    run: () => {
      // The one that got past the first version of this guard. An npm install
      // that ran here by mistake left a package.json, a node_modules and a
      // tests folder, so every sign said "project"; none of them was true.
      const problems = [];
      const home = os.homedir();
      if (!project.hasPackageJson(home)) {
        // Not true on every machine, so it is built rather than assumed.
        problems.push('(note) this machine\'s home folder has no package.json - the built case below still applies');
      }
      const inspection = project.inspectProject(home, {});
      if (inspection.ok) problems.push('the home folder was accepted as a project');
      if (inspection.reason !== 'personal') {
        problems.push('it was refused for the wrong reason: ' + inspection.reason);
      }

      const lines = project.noProjectLines(inspection).join(String.fromCharCode(10));
      if (!/home or a system folder/.test(lines)) problems.push('no home-folder warning:' + lines);
      if (inspection.packaged && !/npm install was run in this folder by mistake/.test(lines)) {
        problems.push('it does not explain the package.json that is sitting there:' + lines);
      }
      return problems.filter((x) => x.indexOf('(note)') !== 0);
    },
  },
  {
    name: '7. the home folder WITHOUT a package.json: it stops too',
    run: () => {
      // Built rather than found, so this holds on a machine whose home folder
      // is still clean - and on one where it is not.
      const problems = [];
      const clean = { dir: os.homedir(), packaged: false, personal: true, allowed: false, ok: false, reason: 'personal' };
      const lines = project.noProjectLines(clean).join(String.fromCharCode(10));
      if (!/home or a system folder/.test(lines)) problems.push('no home-folder warning:' + lines);
      if (/npm install was run in this folder/.test(lines)) {
        problems.push('it blamed an npm install that never happened');
      }
      // And the detector itself does not lean on the package.json either way.
      if (!project.isHomeOrSystem(os.homedir())) problems.push('the home folder is not recognised');
      return problems;
    },
  },
  {
    name: '8. the folder every account lives in - C:\\Users, /home - stops as a system folder',
    run: () => {
      const problems = [];
      const accounts = path.dirname(os.homedir());
      if (!project.isHomeOrSystem(accounts)) {
        problems.push(accounts + ' is not recognised as a system folder');
      }
      // It has no package.json today, so it would be refused anyway. The
      // point is that one stray npm install there must not turn it into a
      // project - which is exactly what happened one folder down.
      const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-accounts-'));
      try {
        fs.writeFileSync(path.join(decoy, 'package.json'), '{"name":"x"}', 'utf8');
        const asAccounts = Object.assign({}, project.inspectProject(decoy, {}), { personal: true });
        if (project.inspectProject(accounts, {}).ok) {
          problems.push(accounts + ' was accepted as a project');
        }
        if (!asAccounts.packaged) problems.push('the decoy was built wrong');
      } finally {
        fs.rmSync(decoy, { recursive: true, force: true });
      }

      for (const dir of [path.parse(process.cwd()).root, os.homedir()]) {
        if (!project.isHomeOrSystem(dir)) problems.push(dir + ' is not recognised');
      }

      // The list is asked directly as well as through the detector. On Windows
      // the literal "/Users" resolves to C:\Users and USERPROFILE is the home
      // folder, so both derived rules are shadowed here and their absence would
      // not show up in behaviour - on a machine whose home is somewhere
      // unusual, they are the only things covering it.
      const folders = project.systemFolders().map((f) => project.tidy(f));
      if (folders.indexOf(project.tidy(accounts)) === -1) {
        problems.push('the folder accounts live in is not among the system folders');
      }
      // Asked for by position, because by value it is indistinguishable here:
      // on Windows the literal "/Users" resolves to C:\Users, so dropping the
      // derived entry changes nothing that can be measured on this machine. It
      // is the only thing covering a home folder that is not under C:\Users or
      // /home, so its presence is pinned rather than inferred.
      if (project.tidy(project.systemFolders()[0]) !== project.tidy(accounts)) {
        problems.push('the system folders no longer start from where this machine keeps accounts');
      }

      // And the home folder is recognised on its own account, not because
      // Windows happens to also name it USERPROFILE.
      const had = Object.prototype.hasOwnProperty.call(process.env, 'USERPROFILE');
      const saved = process.env.USERPROFILE;
      try {
        delete process.env.USERPROFILE;
        if (!project.isHomeOrSystem(os.homedir())) {
          problems.push('the home folder is only recognised through USERPROFILE');
        }
      } finally {
        if (had) process.env.USERPROFILE = saved;
      }
      return problems;
    },
  },
  {
    name: '9. the escape hatch gets past the home folder too, not just a missing package.json',
    run: () => {
      const problems = [];
      const forced = project.inspectProject(os.homedir(), { KRYPTHEON_ALLOW_NO_PACKAGE_JSON: '1' });
      if (!forced.ok) problems.push('the escape hatch does not cover the home folder');
      const blocked = project.inspectProject(os.homedir(), {});
      if (blocked.ok) problems.push('the home folder is open without it');
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

console.log('');
if (failures) {
  console.log(failures + ' check(s) failed.');
  process.exit(1);
}
console.log('All ' + cases.length + ' project-folder checks passed.');
