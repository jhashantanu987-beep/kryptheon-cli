// Checks the fragile-selector report.
// Run with:  node kryptheon-selectors.check.js
//
// The point of this report is that it does not cry wolf. A tool that flags
// getByTestId or getByRole teaches people to ignore it, and then the one real
// warning goes past unread. So half of what is checked here is silence.
//
// The last case runs the real CLI function, not just the module, because a
// module that works and a command that never calls it look identical from
// inside a unit check.
//
// This file sits outside testDir and does not match Playwright's testMatch
// pattern, so `npx playwright test` ignores it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const selectors = require('./kryptheon-selectors.js');
const CLI = path.join(__dirname, 'bin', 'kryptheon.js');
const cli = require('./bin/kryptheon.js');

/** The findings for one line of a recording. */
function scan(line) {
  return selectors.findFragileSelectors('  ' + line);
}

function flagged(line) {
  return scan(line).length > 0;
}

function reasonKinds(line) {
  const found = scan(line);
  return found.length ? found[0].reasons.map((r) => r.kind) : [];
}

// A recording with five selectors that must stay quiet and two that must not.
const REALISTIC = [
  "import { test, expect } from '../kryptheon-fixture';",
  '',
  "test('savings dashboard', async ({ page }) => {",
  "  await page.goto('http://localhost:4173/dashboard');",
  "  await page.getByLabel('Email').fill(process.env.FINTRACK_EMAIL);",
  "  await page.getByPlaceholder('Enter your password').fill(process.env.FINTRACK_PASSWORD);",
  "  await page.getByRole('button', { name: 'Sign In' }).click();",
  "  await page.getByTestId('account-summary').click();",
  "  await page.locator('div').filter({ hasText: 'Savings Rate 0%' }).nth(3).click();",
  "  await page.getByRole('link', { name: 'Reports' }).click();",
  "  await page.getByText('Total balance $1,234.56').click();",
  "  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();",
  '});',
].join('\n');

const cases = [
  {
    name: "1. the real one: 'Savings Rate 0%' with .nth(3) is flagged, for both reasons",
    run: () => {
      const line = "await page.locator('div').filter({ hasText: 'Savings Rate 0%' }).nth(3).click();";
      const found = scan(line);
      if (found.length !== 1) return ['expected one finding, got ' + found.length];
      const kinds = found[0].reasons.map((r) => r.kind);
      const problems = [];
      if (!kinds.includes('data')) problems.push('the live data in the text is not reported: ' + kinds.join(', '));
      if (!kinds.includes('positional')) problems.push('.nth(3) is not reported: ' + kinds.join(', '));
      if (found[0].soft) problems.push('it is reported as a maybe, but a calculated percentage is not a maybe');
      // The selector has to be the text the reader will search their file for.
      const shown = found[0].selector;
      if (shown !== "locator('div').filter({ hasText: 'Savings Rate 0%' }).nth(3)") {
        problems.push('the selector is not shown as written: ' + shown);
      }
      const printed = selectors.describeFragileSelectors(found).join('\n');
      if (!/Savings Rate 0%/.test(printed)) problems.push('the printed report does not quote the text');
      if (!/\.nth\(3\)/.test(printed)) problems.push('the printed report does not name .nth(3)');
      return problems;
    },
  },
  {
    name: "2. getByRole('button', { name: 'Save' }) is left alone",
    run: () => {
      const line = "await page.getByRole('button', { name: 'Save' }).click();";
      return flagged(line) ? ['flagged a role and a stable label: ' + JSON.stringify(reasonKinds(line))] : [];
    },
  },
  {
    name: "3. getByTestId('savings-rate') is left alone",
    run: () => {
      const problems = [];
      if (flagged("await page.getByTestId('savings-rate').click();")) {
        problems.push('flagged a plain test id');
      }
      // A test id is an anchor on purpose, so it stays quiet even next to the
      // things that would otherwise be reported.
      if (flagged("await page.getByTestId('savings-rate').filter({ hasText: '0%' }).nth(2).click();")) {
        problems.push('flagged a test id that also carried a number and a position');
      }
      return problems;
    },
  },
  {
    name: "4. getByLabel('Email') is left alone",
    run: () => {
      const problems = [];
      if (flagged("await page.getByLabel('Email').fill('a@b.test');")) problems.push('flagged getByLabel');
      if (flagged("await page.getByPlaceholder('Search').fill('x');")) problems.push('flagged getByPlaceholder');
      // A form field keeps its label when the data behind it changes, so even a
      // label with a number in it is not the failure this is looking for.
      if (flagged("await page.getByLabel('Line 1 address').fill('x');")) {
        problems.push('flagged a form label that happens to contain a number');
      }
      return problems;
    },
  },
  {
    name: "5. hasText: '$1,234.56' is flagged as money",
    run: () => {
      const line = "await page.getByRole('row').filter({ hasText: '$1,234.56' }).click();";
      const found = scan(line);
      if (!found.length) return ['a currency amount was not flagged'];
      const problems = [];
      if (found[0].soft) problems.push('money was reported as a maybe');
      const printed = selectors.describeFragileSelectors(found).join('\n');
      if (!/money/.test(printed)) problems.push('the reason does not say it is money: ' + printed);
      // The same amount without its currency mark is still an amount.
      if (!flagged("await page.getByText('1,234.56').click();")) {
        problems.push('a grouped decimal amount with no currency mark was not flagged');
      }
      if (selectors.volatileKind('$1,234.56') !== 'currency') {
        problems.push('it is classed as ' + selectors.volatileKind('$1,234.56') + ', not currency');
      }
      return problems;
    },
  },
  {
    name: '6. .nth(0) is flagged, and so are .first() and .last()',
    run: () => {
      const problems = [];
      // Zero is the index most likely to be read as "no position at all".
      const zero = "await page.getByRole('listitem').nth(0).click();";
      if (!flagged(zero)) problems.push('.nth(0) was not flagged');
      else if (!reasonKinds(zero).includes('positional')) {
        problems.push('.nth(0) was flagged for the wrong reason: ' + reasonKinds(zero).join(', '));
      }
      if (!flagged("await page.getByRole('listitem').first().click();")) problems.push('.first() was not flagged');
      if (!flagged("await page.getByRole('listitem').last().click();")) problems.push('.last() was not flagged');
      if (selectors.positionalIn(zero) !== '.nth(0)') {
        problems.push('the step is named as ' + selectors.positionalIn(zero));
      }
      return problems;
    },
  },
  {
    name: '7. a whole recording: five safe selectors stay quiet, two are reported',
    run: () => {
      const found = selectors.findFragileSelectors(REALISTIC);
      const problems = [];
      if (found.length !== 2) {
        return ['expected 2 findings, got ' + found.length + ': ' + found.map((f) => f.selector).join(' | ')];
      }
      const lines = found.map((f) => f.line).sort((a, b) => a - b);
      if (lines[0] !== 9 || lines[1] !== 11) {
        problems.push('the wrong lines were reported: ' + lines.join(', '));
      }
      const printed = selectors.describeFragileSelectors(found).join('\n');
      // Only the findings are searched. The advice underneath names
      // getByTestId on purpose - that is the thing being recommended.
      const listed = printed.split('    Better:')[0];
      for (const quiet of ['getByLabel', 'getByPlaceholder', 'getByTestId', "name: 'Sign In'", "name: 'Overview'"]) {
        if (listed.indexOf(quiet) !== -1) problems.push('the report mentions ' + quiet);
      }
      if (printed.indexOf('getByTestId') === -1) problems.push('the advice no longer suggests a test id');
      if (!/2 selectors rest/.test(printed)) problems.push('the count is not stated: ' + printed.split('\n')[1]);
      return problems;
    },
  },
  {
    name: '8. a clean recording prints nothing at all',
    run: () => {
      const clean = [
        "test('login', async ({ page }) => {",
        "  await page.goto('http://localhost:4173/');",
        "  await page.getByLabel('Email').fill('a@b.test');",
        "  await page.getByRole('button', { name: 'Sign In' }).click();",
        "  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();",
        '});',
      ].join('\n');
      const found = selectors.findFragileSelectors(clean);
      if (found.length) return ['flagged ' + found.length + ': ' + found.map((f) => f.selector).join(' | ')];
      const printed = selectors.describeFragileSelectors(found);
      return printed.length ? ['it printed ' + printed.length + ' lines when it had nothing to say'] : [];
    },
  },
  {
    name: '9. a number that is part of a label is flagged, but said to be probably fine',
    run: () => {
      const line = "await page.getByRole('heading', { name: 'Step 2 of 3' }).click();";
      const found = scan(line);
      if (!found.length) return ['a heading with digits was not mentioned at all'];
      const problems = [];
      if (!found[0].soft) problems.push('it was reported as certain, but this one is an edge case');
      const printed = selectors.describeFragileSelectors(found).join('\n');
      if (!/may well be fine/.test(printed)) {
        problems.push('the report does not say it may be fine: ' + printed);
      }
      return problems;
    },
  },
  {
    name: '10. the report never rewrites the recording',
    run: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-sel-'));
      try {
        const file = path.join(dir, 'recorded.spec.js');
        fs.writeFileSync(file, REALISTIC, 'utf8');
        const before = fs.readFileSync(file);
        selectors.describeFragileSelectors(selectors.findFragileSelectors(fs.readFileSync(file, 'utf8')));
        const after = fs.readFileSync(file);
        return after.equals(before) ? [] : ['the recording on disk was changed'];
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: '11. the command itself prints the report, and stays quiet when there is nothing',
    run: () => {
      // The module working proves nothing about the command calling it, and
      // bin/kryptheon.js reads the working directory once, when it is required.
      // So this starts a real child process in a real project folder - the way
      // the command runs for a person - and calls the CLI's own function there.
      if (typeof cli.reportFragileSelectors !== 'function') {
        return ['bin/kryptheon.js does not expose reportFragileSelectors'];
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-sel-cli-'));
      try {
        fs.mkdirSync(path.join(dir, 'tests'));
        fs.writeFileSync(path.join(dir, 'tests', 'risky.spec.js'), REALISTIC, 'utf8');
        fs.writeFileSync(
          path.join(dir, 'tests', 'clean.spec.js'),
          "test('t', async ({ page }) => { await page.getByRole('button', { name: 'Save' }).click(); });",
          'utf8',
        );
        const runner = path.join(dir, 'run.js');
        fs.writeFileSync(
          runner,
          [
            'const cli = require(' + JSON.stringify(CLI) + ');',
            "const risky = cli.reportFragileSelectors('tests/risky.spec.js');",
            "console.log('---SPLIT---');",
            "const clean = cli.reportFragileSelectors('tests/clean.spec.js');",
            "console.log('---COUNTS--- ' + risky.length + ' ' + clean.length);",
          ].join(String.fromCharCode(10)),
          'utf8',
        );

        const r = spawnSync(process.execPath, [runner], { cwd: dir, encoding: 'utf8', timeout: 60000 });
        if (r.status !== 0) {
          return ['the child process failed: ' + String(r.stderr || '').slice(0, 300)];
        }

        const out = String(r.stdout || '');
        const problems = [];
        const counts = out.match(/---COUNTS--- (\d+) (\d+)/);
        if (!counts) return ['the child printed no result: ' + out.slice(0, 300)];
        if (counts[1] !== '2') problems.push('the command found ' + counts[1] + ' risky selectors, not 2');
        if (counts[2] !== '0') problems.push('the command flagged ' + counts[2] + ' in a clean recording');

        const riskyOutput = out.split('---SPLIT---')[0];
        const cleanOutput = out.split('---SPLIT---')[1].split('---COUNTS---')[0];
        if (!/Savings Rate 0%/.test(riskyOutput)) problems.push('the command printed no report');
        if (!/1,234\.56/.test(riskyOutput)) problems.push('the command left the money selector out');
        if (cleanOutput.trim() !== '') {
          problems.push('the command printed something for a clean recording: ' + cleanOutput);
        }
        return problems;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "12. locator('div') with no anchor is flagged, and locator('#id') is not",
    run: () => {
      const problems = [];
      // A bare tag is whatever happened to be in that position that day.
      const generic = "await page.locator('div').filter({ hasText: 'Reports' }).click();";
      if (!flagged(generic)) problems.push("locator('div') with a filter was not flagged");
      else if (!reasonKinds(generic).includes('generic')) {
        problems.push("locator('div') was flagged, but not for having no anchor: " + reasonKinds(generic).join(', '));
      }
      for (const tag of ['span', 'li', 'td', 'section']) {
        const line = "await page.locator('" + tag + "').filter({ hasText: 'Reports' }).click();";
        if (!reasonKinds(line).includes('generic')) problems.push('locator(' + tag + ') was not flagged');
      }
      // An id, a class or an attribute is somebody saying which one they mean.
      for (const anchored of [
        "await page.locator('#main-nav').getByRole('link', { name: 'Features' }).click();",
        "await page.locator('[data-role=summary]').click();",
        "await page.locator('.savings-rate').click();",
      ]) {
        if (flagged(anchored)) problems.push('flagged an anchored locator: ' + anchored);
      }
      if (selectors.genericTagIn(generic) !== 'div') {
        problems.push('the tag is named as ' + selectors.genericTagIn(generic));
      }
      return problems;
    },
  },
  {
    name: '13. a real recording being finished prints the report',
    run: () => {
      // Case 11 calls the report directly, so it cannot see the recording flow
      // dropping the call - which is exactly how a feature ends up dead while
      // every unit check passes. This runs finaliseRecording itself, in a child
      // process, on a real file in a real project folder.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-sel-flow-'));
      try {
        fs.mkdirSync(path.join(dir, 'tests'));
        const spec = path.join('tests', 'recorded-20260907-101500.spec.js');
        // Named already, so finishing it does not go to the network for a title.
        fs.writeFileSync(
          path.join(dir, spec),
          [
            "import { test, expect } from '@playwright/test';",
            "",
            "test('savings dashboard', async ({ page }) => {",
            "  await page.goto('http://localhost:4173/dashboard');",
            "  await page.getByRole('button', { name: 'Sign In' }).click();",
            "  await page.locator('div').filter({ hasText: 'Savings Rate 0%' }).nth(3).click();",
            "});",
          ].join(String.fromCharCode(10)),
          'utf8',
        );

        const runner = path.join(dir, 'finish.js');
        fs.writeFileSync(
          runner,
          [
            'const cli = require(' + JSON.stringify(CLI) + ');',
            'cli.finaliseRecording(' + JSON.stringify(spec.split(path.sep).join('/')) + ', {})',
            "  .then((r) => console.log('---DONE--- ' + r.code))",
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
        if (!/Saved to/.test(out)) problems.push('the recording was not saved');
        // The report itself, reached the only way a person reaches it.
        if (!/rests on data that can change|rest on data that can change/.test(out)) {
          problems.push('finishing a recording printed no fragile-selector report:' + String.fromCharCode(10) + out.slice(0, 600));
        }
        if (!/Savings Rate 0%/.test(out)) problems.push('the report did not quote the selector text');
        if (!/\.nth\(3\)/.test(out)) problems.push('the report did not name the position');
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
console.log('All ' + cases.length + ' selector checks passed.');
