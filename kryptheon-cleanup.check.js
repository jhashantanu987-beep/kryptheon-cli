// Checks the tidying that happens before a recording is saved.
// Run with:  node kryptheon-cleanup.check.js
//
// This is the one piece of the tool that changes what you recorded, so most of
// what is checked here is restraint. Removing a step nobody needed saves a
// moment. Removing a real one silently changes what the test does, and nobody
// finds out until the thing it was covering breaks unnoticed - so every case
// below that asserts something is kept matters more than the ones that assert
// something goes.
//
// The last case runs the real command on a real file, because a module that
// cleans and a recording flow that never calls it look identical from inside a
// unit check.
//
// This file sits outside testDir and does not match Playwright's testMatch
// pattern, so `npx playwright test` ignores it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const cleanup = require('./kryptheon-cleanup.js');
const CLI = path.join(__dirname, 'bin', 'kryptheon.js');
const cli = require('./bin/kryptheon.js');

/** Wraps steps in the file codegen would have written around them. */
function recording(steps) {
  return [
    "import { test, expect } from '../kryptheon-fixture';",
    '',
    "test('Personal Finance Tracker', async ({ page }) => {",
    "  await page.goto('http://localhost:4173/');",
  ]
    .concat(steps.map((s) => '  ' + s))
    .concat(['});'])
    .join('\n');
}

/** The steps left behind, without the wrapping. */
function stepsLeft(source) {
  return source
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /\bpage\s*\./.test(l) && !/page\.goto/.test(l));
}

function clean(steps) {
  return cleanup.cleanRecording(recording(steps));
}

// Three pieces of fumbling among eight steps that were meant.
const REALISTIC = [
  "await page.getByRole('textbox', { name: 'Username' }).fill('shantanu892');",
  "await page.getByRole('textbox', { name: 'Username' }).fill('shantanu89');",
  "await page.getByRole('textbox', { name: 'Password' }).fill(process.env.PFT_PASSWORD);",
  "await page.getByRole('img').filter({ hasText: /^$/ }).click();",
  "await page.getByRole('button', { name: 'Sign In' }).click();",
  "await page.getByRole('link', { name: 'Accounts' }).click();",
  "await page.getByRole('button', { name: 'Add transaction' }).click();",
  "await page.getByLabel('Amount').fill('42.50');",
  "await page.getByRole('button', { name: 'Save' }).click();",
  "await page.getByRole('button', { name: 'Save' }).click();",
  "await page.getByRole('link', { name: 'Reports' }).click();",
];

const cases = [
  {
    name: '1. the same field filled twice in a row: only the last survives',
    run: () => {
      const out = clean([
        "await page.getByRole('textbox', { name: 'Username' }).fill('shantanu892');",
        "await page.getByRole('textbox', { name: 'Username' }).fill('shantanu89');",
      ]);
      const left = stepsLeft(out.source);
      const problems = [];
      if (left.length !== 1) return ['expected one step, got ' + left.length + ': ' + left.join(' | ')];
      if (!/shantanu89'\)/.test(left[0])) problems.push('the wrong one survived: ' + left[0]);
      if (out.removed.length !== 1) problems.push('it reported ' + out.removed.length + ' removals');
      if (out.removed[0].kind !== 'typed-twice') problems.push('the reason is ' + out.removed[0].kind);
      return problems;
    },
  },
  {
    name: '2. fill, something else, then the same field again: both survive',
    run: () => {
      const out = clean([
        "await page.getByRole('textbox', { name: 'Username' }).fill('first');",
        "await page.getByRole('button', { name: 'Check' }).click();",
        "await page.getByRole('textbox', { name: 'Username' }).fill('second');",
      ]);
      const left = stepsLeft(out.source);
      const problems = [];
      // Going back to a field after doing something else is deliberate.
      if (left.length !== 3) problems.push('it removed something: ' + left.join(' | '));
      if (out.removed.length) problems.push('it reported a removal: ' + JSON.stringify(out.removed));
      return problems;
    },
  },
  {
    name: "3. a click on getByRole('img') with no name and no text goes",
    run: () => {
      const out = clean([
        "await page.getByRole('img').filter({ hasText: /^$/ }).click();",
        "await page.getByRole('link', { name: 'Reports' }).click();",
      ]);
      const left = stepsLeft(out.source);
      const problems = [];
      if (left.length !== 1) return ['expected one step, got ' + left.length + ': ' + left.join(' | ')];
      if (!/Reports/.test(left[0])) problems.push('it removed the wrong one: ' + left[0]);
      if (out.removed[0].kind !== 'points-at-nothing') problems.push('the reason is ' + out.removed[0].kind);
      // A bare unnamed image is the same thing without the filter.
      const bare = clean(["await page.getByRole('img').click();"]);
      if (bare.removed.length !== 1) problems.push('a bare unnamed image was kept');
      return problems;
    },
  },
  {
    name: "4. getByRole('button', { name: 'Save' }) is never removed",
    run: () => {
      const problems = [];
      const kept = [
        "await page.getByRole('button', { name: 'Save' }).click();",
        "await page.getByRole('img', { name: 'Company logo' }).click();",
        "await page.getByRole('button').click();",
        "await page.getByRole('link').click();",
        "await page.getByTestId('logo').click();",
        "await page.locator('#logo').click();",
        "await page.locator('div').nth(3).click();",
        "await page.getByRole('figure').filter({ hasText: 'Chart' }).click();",
      ];
      for (const step of kept) {
        const out = clean([step]);
        if (out.removed.length) problems.push('removed: ' + step + '  (' + out.removed[0].why + ')');
      }
      return problems;
    },
  },
  {
    name: '5. the same button clicked twice in a row: once is enough',
    run: () => {
      const out = clean([
        "await page.getByRole('button', { name: 'Save' }).click();",
        "await page.getByRole('button', { name: 'Save' }).click();",
      ]);
      const left = stepsLeft(out.source);
      const problems = [];
      if (left.length !== 1) problems.push('expected one step, got ' + left.length);
      if (out.removed.length !== 1) problems.push('it reported ' + out.removed.length + ' removals');
      else if (out.removed[0].kind !== 'clicked-twice') problems.push('the reason is ' + out.removed[0].kind);

      // Three in a row must not collapse past one, and a click either side of
      // something else is two separate intentions.
      const apart = clean([
        "await page.getByRole('button', { name: 'Save' }).click();",
        "await page.getByRole('link', { name: 'Next' }).click();",
        "await page.getByRole('button', { name: 'Save' }).click();",
      ]);
      if (apart.removed.length) problems.push('it collapsed two clicks with a step between them');
      return problems;
    },
  },
  {
    name: '6. a whole recording: three taken out, eight left, and all three reported',
    run: () => {
      const out = cleanup.cleanRecording(recording(REALISTIC));
      const left = stepsLeft(out.source);
      const problems = [];
      if (out.removed.length !== 3) {
        problems.push('it removed ' + out.removed.length + ': ' + out.removed.map((r) => r.why).join(' | '));
      }
      if (left.length !== 8) problems.push('it left ' + left.length + ' steps, expected 8');

      const kinds = out.removed.map((r) => r.kind).sort();
      if (kinds.join(',') !== 'clicked-twice,points-at-nothing,typed-twice') {
        problems.push('the wrong three went: ' + kinds.join(', '));
      }
      // The eight that were meant all have to still be there.
      for (const wanted of ['Password', 'Sign In', 'Accounts', 'Add transaction', 'Amount', 'Save', 'Reports']) {
        if (!left.some((l) => l.indexOf(wanted) !== -1)) problems.push(wanted + ' was removed');
      }
      if (left.some((l) => /shantanu892/.test(l))) problems.push('the typo attempt is still in the file');
      if (left.some((l) => /getByRole\('img'\)/.test(l))) problems.push('the click on nothing is still in the file');

      const printed = cleanup.describeCleanup(out.removed).join('\n');
      if (!/3 steps were taken out/.test(printed)) problems.push('the count is not stated: ' + printed);
      if (!/Username was typed twice/.test(printed)) problems.push('the double fill is not explained');
      if (!/nothing to identify it/.test(printed)) problems.push('the empty click is not explained');
      if (!/Save was clicked twice/.test(printed)) problems.push('the double click is not explained');
      return problems;
    },
  },
  {
    name: '7. a value that was typed never reaches the report',
    run: () => {
      const out = cleanup.cleanRecording(recording(REALISTIC));
      const printed = cleanup.describeCleanup(out.removed).join('\n');
      const problems = [];
      // Tidying runs after secrets are moved out, but a username is private
      // enough and a password would be far worse.
      for (const value of ['shantanu892', 'shantanu89', '42.50', 'PFT_PASSWORD']) {
        if (printed.indexOf(value) !== -1) problems.push('the report quotes a typed value: ' + value);
      }
      return problems;
    },
  },
  {
    name: '8. a clean recording is left exactly as it was, and nothing is said',
    run: () => {
      const source = recording([
        "await page.getByLabel('Email').fill('a@b.test');",
        "await page.getByRole('button', { name: 'Sign In' }).click();",
        "await page.getByRole('link', { name: 'Reports' }).click();",
      ]);
      const out = cleanup.cleanRecording(source);
      const problems = [];
      if (out.source !== source) problems.push('the file was changed');
      if (out.removed.length) problems.push('it reported ' + out.removed.length + ' removals');
      if (cleanup.describeCleanup(out.removed).length) problems.push('it printed something with nothing to say');
      return problems;
    },
  },
  {
    name: '9. only whole lines go - nothing else in the file is touched',
    run: () => {
      const source = recording(REALISTIC);
      const out = cleanup.cleanRecording(source);
      const before = source.split('\n');
      const after = out.source.split('\n');
      const problems = [];
      if (before.length - after.length !== 3) {
        problems.push('the file lost ' + (before.length - after.length) + ' lines, expected 3');
      }
      // Every surviving line has to be a line that was there before, unchanged.
      const known = new Set(before);
      for (const line of after) {
        if (!known.has(line)) problems.push('a line was rewritten: ' + JSON.stringify(line));
      }
      if (after[0] !== before[0]) problems.push('the import line changed');
      if (!/await page\.goto/.test(out.source)) problems.push('the opening address was removed');
      return problems;
    },
  },
  {
    name: '10. an assertion is never treated as a step to tidy',
    run: () => {
      const out = clean([
        "await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();",
        "await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();",
        "await page.getByRole('img').filter({ hasText: /^$/ }).click();",
      ]);
      const problems = [];
      if (out.removed.length !== 1) {
        problems.push('it touched an assertion: ' + out.removed.map((r) => r.why).join(' | '));
      } else if (out.removed[0].kind !== 'points-at-nothing') {
        problems.push('the wrong thing went: ' + out.removed[0].kind);
      }

      // Said at the mechanism, not just at the outcome. Nothing above can tell
      // an assertion that is read as a step but happens to survive from one
      // that was never read as a step at all, and the difference matters the
      // moment another verb is added to the list.
      const steps = cleanup.readSteps(
        recording([
          "await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();",
          "await expect(page.getByRole('img')).toHaveCount(0);",
          "await page.getByRole('button', { name: 'Save' }).click();",
        ]),
      );
      const asserted = steps.filter((s) => /expect\s*\(/.test(s.text));
      if (asserted.length) {
        problems.push('an assertion was read as a step: ' + asserted.map((s) => s.text).join(' | '));
      }
      // The goto and the click are the two real steps in that recording.
      if (steps.length !== 2) problems.push('it read ' + steps.length + ' steps, expected 2');
      return problems;
    },
  },
  {
    name: '11. the recording flow actually tidies the file it saved',
    run: () => {
      // The module working proves nothing about the command calling it, and
      // bin/kryptheon.js reads the working directory once, when required. So
      // this runs a child process in a real project folder.
      if (typeof cli.tidyRecording !== 'function') return ['bin/kryptheon.js does not expose tidyRecording'];
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-tidy-'));
      try {
        fs.mkdirSync(path.join(dir, 'tests'));
        const spec = 'tests/recorded.spec.js';
        fs.writeFileSync(path.join(dir, spec), recording(REALISTIC), 'utf8');

        const runner = path.join(dir, 'run.js');
        fs.writeFileSync(
          runner,
          [
            'const cli = require(' + JSON.stringify(CLI) + ');',
            'const removed = cli.tidyRecording(' + JSON.stringify(spec) + ');',
            'cli.reportTidying(removed);',
            "console.log('---COUNT--- ' + removed.length);",
          ].join('\n'),
          'utf8',
        );

        const r = spawnSync(process.execPath, [runner], { cwd: dir, encoding: 'utf8', timeout: 60000 });
        if (r.status !== 0) return ['the child process failed: ' + String(r.stderr || '').slice(0, 300)];

        const out = String(r.stdout || '');
        const onDisk = fs.readFileSync(path.join(dir, spec), 'utf8');
        const problems = [];
        if (!/---COUNT--- 3/.test(out)) problems.push('the command removed a different number: ' + out.slice(0, 200));
        if (!/3 steps were taken out of the recording/.test(out)) problems.push('it printed no report:\n' + out);
        // The file on disk is the thing that will run from now on.
        if (/shantanu892/.test(onDisk)) problems.push('the typo attempt is still in the saved file');
        if (/getByRole\('img'\)/.test(onDisk)) problems.push('the click on nothing is still in the saved file');
        if (stepsLeft(onDisk).length !== 8) problems.push('the saved file has ' + stepsLeft(onDisk).length + ' steps');
        if (!/Sign In/.test(onDisk)) problems.push('a real step was lost from the saved file');
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '12. finishing a real recording tidies it, without being asked to',
    run: () => {
      // Case 11 calls the tidying directly, so it would still pass if the
      // recording flow stopped calling it - which is exactly how a feature
      // ends up dead while every check is green. This runs the flow.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-flow-'));
      try {
        fs.mkdirSync(path.join(dir, 'tests'));
        const spec = 'tests/recorded-20260908-120000.spec.js';
        // Named already, so finishing it does not go to the network.
        fs.writeFileSync(
          path.join(dir, spec),
          recording(REALISTIC).replace("Personal Finance Tracker", "Finance"),
          'utf8',
        );

        const runner = path.join(dir, 'finish.js');
        fs.writeFileSync(
          runner,
          [
            'const cli = require(' + JSON.stringify(CLI) + ');',
            'cli.finaliseRecording(' + JSON.stringify(spec) + ', {})',
            "  .then((r) => console.log('---DONE--- ' + r.code + ' ' + r.savedAs))",
            "  .catch((e) => { console.log('---THREW--- ' + e.message); process.exit(1); });",
          ].join(String.fromCharCode(10)),
          'utf8',
        );

        const r = spawnSync(process.execPath, [runner], {
          cwd: dir,
          encoding: 'utf8',
          timeout: 120000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const out = String(r.stdout || '') + String(r.stderr || '');
        const problems = [];
        if (!/---DONE--- 0/.test(out)) problems.push('finishing the recording did not succeed: ' + out.slice(0, 400));
        if (!/3 steps were taken out of the recording/.test(out)) {
          problems.push('finishing a recording said nothing about tidying it:' + String.fromCharCode(10) + out.slice(0, 700));
        }
        if (!/Username was typed twice/.test(out)) problems.push('the double fill was not reported');

        // Whatever it ended up being called, the saved file is the one that
        // will run from now on.
        const saved = fs.readdirSync(path.join(dir, 'tests'));
        if (saved.length !== 1) return problems.concat(['expected one saved file, got ' + saved.join(', ')]);
        const onDisk = fs.readFileSync(path.join(dir, 'tests', saved[0]), 'utf8');
        if (/shantanu892/.test(onDisk)) problems.push('the typo attempt is still in the saved recording');
        if (/getByRole\('img'\)/.test(onDisk)) problems.push('the click on nothing is still in the saved recording');
        if (stepsLeft(onDisk).length !== 8) problems.push('the saved recording has ' + stepsLeft(onDisk).length + ' steps, expected 8');
        if (!/Sign In/.test(onDisk)) problems.push('a real step was lost from the saved recording');
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
console.log('All ' + cases.length + ' cleanup checks passed.');
