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
        if (!/does not make this a project/.test(forcedLines)) {
          problems.push('it does not explain the package.json that is sitting there:\n' + forcedLines);
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
