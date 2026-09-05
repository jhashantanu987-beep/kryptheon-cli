// Unit checks for the plain-language reporter.
// Run with:  node kryptheon-reporter.check.js
//
// The messages below are copied from real Playwright output, ANSI colour codes
// included, because those codes are what the reporter actually receives.
//
// This file sits outside testDir and does not match Playwright's testMatch
// pattern, so `npx playwright test` ignores it.

const Reporter = require('./kryptheon-reporter.js');

const E = '\u001b';
const dim = (s) => E + '[2m' + s + E + '[22m';
const red = (s) => E + '[31m' + s + E + '[39m';
const colouredExpect = (target, notPart, matcher) =>
  dim('expect(') + red(target) + dim(')' + notPart + '.') + matcher + dim('(') + dim(')') + ' failed';

// --- the regression this file exists for --------------------------------
// A test-level timeout spent waiting for an element that was never there.
// Playwright reports this as TWO errors: a bare timeout with no call log,
// and a second error carrying "waiting for <locator>". Reading only the
// first made the reporter blame a slow site.
const TIMEOUT_WITH_CALL_LOG = [
  { message: red('Test timeout of 4000ms exceeded.') },
  {
    message:
      'Error: locator.click: Test timeout of 4000ms exceeded.\nCall log:\n' +
      dim("  - waiting for getByRole('button', { name: 'Request my demo' })") +
      '\n',
    location: { file: 'C:/x/tests/homepage.spec.js', line: 26 },
  },
];

// The same shape, but nothing was being waited for: genuine slowness.
const TIMEOUT_WITHOUT_CALL_LOG = [{ message: red('Test timeout of 3000ms exceeded.') }];

const cases = [
  {
    name: 'timeout with call log -> element not found, NOT slowness',
    errors: TIMEOUT_WITH_CALL_LOG,
    expectContains: ['Could not find', 'the button "Request my demo"'],
    expectMissing: ['slower than usual', 'ran out of time'],
    expectAdvice: 'renamed, hidden, or removed',
  },
  {
    name: 'timeout without call log -> genuine slowness',
    errors: TIMEOUT_WITHOUT_CALL_LOG,
    expectContains: ['ran out of time'],
    expectMissing: ['Could not find'],
    expectAdvice: 'slower than usual',
  },
  {
    name: 'action timeout with call log -> element not found',
    errors: [
      {
        message:
          'TimeoutError: locator.click: Timeout 2500ms exceeded.\nCall log:\n' +
          dim("  - waiting for getByRole('button', { name: 'Request my demo' })") +
          '\n',
      },
    ],
    expectContains: ['Could not find', 'the button "Request my demo"'],
    expectMissing: ['slower than usual'],
  },
  {
    name: 'toBeVisible element absent -> element not found',
    errors: [
      {
        message:
          'Error: ' + colouredExpect('locator', '', 'toBeVisible') + '\n\n' +
          "Locator: getByText('Thanks for submitting.')\nExpected: visible\nError: element(s) not found\n",
      },
    ],
    expectContains: ['Could not find', 'the text "Thanks for submitting."'],
    expectMissing: ['slower than usual'],
  },
  {
    name: 'not.toBeVisible -> still present, not "could not find"',
    errors: [
      {
        message:
          'Error: ' + colouredExpect('locator', '.not', 'toBeVisible') + '\n\n' +
          "Locator:  getByRole('button', { name: 'Request my demo' })\n" +
          'Expected: not visible\nReceived: visible\n\nCall log:\n' +
          dim("  - waiting for getByRole('button', { name: 'Request my demo' })") + '\n',
      },
    ],
    expectContains: ['was still on the page'],
    expectMissing: ['Could not find'],
  },
  {
    name: 'navigation failure -> page could not be opened',
    errors: [{ message: 'Error: page.goto: net::ERR_NAME_NOT_RESOLVED at https://nope.invalid/\n' }],
    expectContains: ['could not be opened'],
    expectMissing: ['Could not find'],
  },

  // --- URL mismatch: must say where the browser actually went, and must not
  // --- fall back to the misleading "content on the page may have changed".
  {
    name: 'toHaveURL regex mismatch -> reports expected vs actual',
    errors: [
      {
        message:
          'Error: ' + colouredExpect('page', '', 'toHaveURL') + '\n\n' +
          'Expected pattern: ' + E + '[32m/\\/dashboard\\.html/' + E + '[39m\n' +
          'Received string:  ' + E + '[31m"https://www.catchai.live/auth.html"' + E + '[39m\n' +
          'Timeout: 2000ms\n',
      },
    ],
    expectContains: ['did not go where it was supposed to'],
    expectMissing: ['content on the page may have changed'],
    expectPrinted: ['Expected: /dashboard.html', 'Actually on: /auth.html'],
  },
  {
    name: 'toHaveURL string mismatch -> reports expected vs actual',
    errors: [
      {
        message:
          'Error: ' + colouredExpect('page', '', 'toHaveURL') + '\n\n' +
          'Expected: "https://www.catchai.live/' + E + '[7mdashboard' + E + '[27m.html"\n' +
          'Received: "https://www.catchai.live/' + E + '[7mauth' + E + '[27m.html"\n' +
          'Timeout:  2000ms\n',
      },
    ],
    expectContains: ['did not go where it was supposed to'],
    expectMissing: ['content on the page may have changed'],
    expectPrinted: ['Expected: /dashboard.html', 'Actually on: /auth.html'],
  },

  // --- "Where to look": only what the browser actually did.
  {
    name: 'observations -> Where to look lists url, bad response, console error',
    errors: [{ message: 'Error: something unfamiliar\n' }],
    observations: {
      url: 'https://www.catchai.live/auth.html',
      failedRequests: [{ method: 'POST', url: 'https://www.catchai.live/api/auth/login', status: 401 }],
      consoleErrors: ['Uncaught TypeError: x is not a function'],
    },
    expectPrinted: [
      'Where to look:',
      'Browser was on: https://www.catchai.live/auth.html',
      'POST /api/auth/login returned 401',
      'Console error: Uncaught TypeError: x is not a function',
    ],
  },
  {
    name: 'no observations -> Where to look omitted entirely',
    errors: [{ message: 'Error: something unfamiliar\n' }],
    expectPrintedMissing: ['Where to look:'],
  },
  {
    name: 'empty observations -> Where to look omitted entirely',
    errors: [{ message: 'Error: something unfamiliar\n' }],
    observations: { url: null, failedRequests: [], consoleErrors: [] },
    expectPrintedMissing: ['Where to look:'],
  },

  // --- HTTP status codes explained in plain language, raw code still shown.
  {
    name: 'status 401 -> plain language added',
    errors: [{ message: 'Error: something unfamiliar\n' }],
    observations: {
      url: 'https://site.test/auth.html',
      failedRequests: [{ method: 'POST', url: 'https://site.test/auth/v1/token', status: 401 }],
      consoleErrors: [],
    },
    expectPrinted: ['POST /auth/v1/token returned 401', 'wrong credentials, a missing login session'],
  },
  {
    name: 'status 404 -> plain language added',
    errors: [{ message: 'Error: something unfamiliar\n' }],
    observations: {
      url: 'https://site.test/a',
      failedRequests: [{ method: 'GET', url: 'https://site.test/gone', status: 404 }],
      consoleErrors: [],
    },
    expectPrinted: ['GET /gone returned 404', 'does not exist on the server'],
  },
  {
    name: 'status 429 -> plain language added',
    errors: [{ message: 'Error: something unfamiliar\n' }],
    observations: {
      url: 'https://site.test/a',
      failedRequests: [{ method: 'GET', url: 'https://site.test/api', status: 429 }],
      consoleErrors: [],
    },
    expectPrinted: ['returned 429', 'too many requests too quickly'],
  },
  {
    name: 'status 503 -> plain language added',
    errors: [{ message: 'Error: something unfamiliar\n' }],
    observations: {
      url: 'https://site.test/a',
      failedRequests: [{ method: 'GET', url: 'https://site.test/api', status: 503 }],
      consoleErrors: [],
    },
    expectPrinted: ['returned 503', 'error is in backend code, not the page'],
  },

  // --- The paste-ready prompt, built only from observed facts.
  {
    name: 'prompt section composed from URL mismatch and observations',
    errors: [
      {
        message:
          'Error: ' + colouredExpect('page', '', 'toHaveURL') + '\n\n' +
          'Expected pattern: /\\/dashboard\\.html/\n' +
          'Received string:  "https://www.catchai.live/auth.html"\n',
      },
    ],
    observations: {
      url: 'https://www.catchai.live/auth.html',
      failedRequests: [{ method: 'POST', url: 'https://sb.example.co/auth/v1/token?grant_type=password', status: 400 }],
      consoleErrors: [],
    },
    lastPassedMinutesAgo: 12,
    expectPrinted: [
      'Paste this into your AI tool:',
      'My "prompt section composed from URL mismatch and observations" flow broke.',
      'stayed on /auth.html instead of reaching /dashboard.html',
      'The request POST /auth/v1/token?grant_type=password returned 400.',
      'This was working 12 minutes ago.',
      'Fix only this.',
    ],
  },
  {
    name: 'prompt states no cause and no file paths',
    errors: [
      {
        message:
          'TimeoutError: locator.click: Timeout 2500ms exceeded.\nCall log:\n' +
          dim("  - waiting for getByRole('button', { name: 'Request my demo' })") + '\n',
        location: { file: 'C:/x/tests/homepage.spec.js', line: 26 },
      },
    ],
    observations: { url: 'https://site.test/page', failedRequests: [], consoleErrors: [] },
    expectPrinted: ['Could not find the button "Request my demo" on the page.', 'The browser was on https://site.test/page.'],
    // The advice text and any source path must never leak into the prompt.
    expectPromptMissing: ['may have renamed', 'homepage.spec.js', 'tests/', 'line 26'],
  },
  // --- Hostnames must never appear: shared output would leak project ids.
  {
    name: 'third-party host is stripped from both sections',
    errors: [{ message: 'Error: something unfamiliar\n' }],
    observations: {
      url: 'https://www.catchai.live/auth.html',
      failedRequests: [
        { method: 'POST', url: 'https://wbibehdgvmcrpgzaxkvu.supabase.co/auth/v1/token?grant_type=password', status: 400 },
      ],
      consoleErrors: [],
    },
    expectPrinted: ['POST /auth/v1/token?grant_type=password returned 400'],
    expectPrintedMissing: ['wbibehdgvmcrpgzaxkvu', 'supabase.co'],
  },
  // --- A baseline failure must read as plain language, not hit the fallback.
  {
    name: 'baseline mismatch is rendered, not treated as unknown',
    errors: [
      {
        message:
          'Error: Baseline changed: the page address changed since the last passing run.\n' +
          'Address was: /dashboard.html\nAddress now: /auth.html',
      },
    ],
    expectContains: ['The page address changed since the last passing run.'],
    expectPrinted: ['Address was: /dashboard.html', 'Address now: /auth.html'],
    expectPrintedMissing: ['it was not recognised'],
  },
  // --- The technical line must go when it only repeats the headline, and
  // --- must stay when it carries something the headline does not.
  {
    name: 'restated closing line is dropped',
    errors: [
      {
        message:
          'Error: Baseline changed: the page address changed since the last passing run.\n' +
          'Address was: /a\nAddress now: /b',
      },
    ],
    expectPrinted: ['Address was: /a'],
    expectPrintedMissing: ['Technical detail:'],
  },
  {
    name: 'closing line kept when it carries more',
    errors: [
      {
        message:
          'Error: ' + colouredExpect('locator', '', 'toBeVisible') + '\n\n' +
          "Locator: getByText('Thanks for submitting.')\nExpected: visible\nError: element(s) not found\n",
      },
    ],
    expectPrinted: ['Technical detail:', 'expect(locator).toBeVisible() failed'],
  },
  // --- A first-run failure is framed as a recording problem, not a regression.
  {
    name: 'the opening run points at the step that cannot repeat',
    errors: [
      {
        message:
          'TimeoutError: locator.click: Timeout 4000ms exceeded.\nCall log:\n' +
          dim("  - waiting for getByRole('button', { name: 'Sign Up' })") + '\n',
      },
    ],
    specSource:
      "test('t', async ({ page }) => {\n" +
      "  await page.goto('https://app.test/');\n" +
      "  await page.getByRole('button', { name: 'Sign Up' }).click();\n});\n",
    expectPrinted: [
      'This is the first run of this recording',
      'Most likely the step that cannot repeat',
      '"Sign Up"',
    ],
    // The usual advice would contradict "nothing has broken yet".
    expectPrintedMissing: ['your last change may have renamed'],
  },
  {
    name: 'a test that used to pass is not blamed on the recording',
    errors: [
      {
        message:
          'TimeoutError: locator.click: Timeout 4000ms exceeded.\nCall log:\n' +
          dim("  - waiting for getByRole('button', { name: 'Sign Up' })") + '\n',
      },
    ],
    specSource:
      "test('t', async ({ page }) => {\n" +
      "  await page.goto('https://app.test/');\n" +
      "  await page.getByRole('button', { name: 'Sign Up' }).click();\n});\n",
    lastPassedMinutesAgo: 30,
    expectPrintedMissing: ['This is the first run of this recording'],
  },
  // --- A pass belongs to the recording that produced it, not to the name.
  {
    name: 'a replacement recording does not inherit the old one history',
    errors: [
      {
        message:
          'TimeoutError: locator.click: Timeout 4000ms exceeded.\nCall log:\n' +
          dim("  - waiting for getByRole('button', { name: 'Sign Up' })") + '\n',
      },
    ],
    specSource:
      "test('t', async ({ page }) => {\n" +
      "  await page.goto('https://app.test/');\n" +
      "  await page.getByRole('button', { name: 'Sign Up' }).click();\n});\n",
    // A pass logged under the same name, but by a different recording.
    lastPassedMinutesAgo: 45,
    priorRecordingId: 'aaaaaaaaaaaa',
    expectPrinted: ['This has not passed before.', 'This is the first run of this recording'],
    expectPrintedMissing: ['This was working', 'your last change may have renamed'],
  },
  {
    name: 'the same recording keeps its own history',
    errors: [
      {
        message:
          'TimeoutError: locator.click: Timeout 4000ms exceeded.\nCall log:\n' +
          dim("  - waiting for getByRole('button', { name: 'Sign Up' })") + '\n',
      },
    ],
    specSource:
      "test('t', async ({ page }) => {\n" +
      "  await page.goto('https://app.test/');\n" +
      "  await page.getByRole('button', { name: 'Sign Up' }).click();\n});\n",
    lastPassedMinutesAgo: 45,
    expectPrinted: ['This was working'],
    expectPrintedMissing: ['This is the first run of this recording'],
  },
  {
    name: 'prompt omits timing when there is no previous pass',
    errors: [{ message: 'Error: something unfamiliar\n' }],
    expectPrintedMissing: ['This was working'],
    expectPrinted: ['Fix only this.'],
  },
];

// Runs one case and returns both the stored record and the block the user
// actually sees, so the checks cover the real printed output.
function runCase(c) {
  const reporter = new Reporter();
  reporter.previousRuns = [];
  reporter.records = [];

  // Required locally: the shared helpers are declared further down the file.
  const localFs = require('fs');
  const localPath = require('path');
  const localOs = require('os');
  const localReplay = require('./kryptheon-replay.js');

  // A prior passing run now has to belong to THIS recording, so any case that
  // claims one needs a real spec on disk to be fingerprinted.
  const source =
    c.specSource ||
    (c.lastPassedMinutesAgo != null
      ? "test('t', async ({ page }) => {\n  await page.goto('https://app.test/');\n" +
        "  await page.getByRole('link', { name: 'Next' }).click();\n});\n"
      : null);

  let specFile = null;
  let specRecordingId = null;
  if (source) {
    const dir = localFs.mkdtempSync(localPath.join(localOs.tmpdir(), 'kryptheon-spec-'));
    specFile = localPath.join(dir, 'recording.spec.js');
    localFs.writeFileSync(specFile, source, 'utf8');
    specRecordingId = localReplay.recordingId(source);
  }

  // A synthetic earlier passing run, so "This was working N minutes ago" is
  // deterministic rather than depending on the real history file.
  if (c.lastPassedMinutesAgo != null) {
    const ts = new Date(Date.now() - c.lastPassedMinutesAgo * 60000).toISOString();
    reporter.previousRuns = [
      {
        runAt: ts,
        tests: [
          {
            title: c.name,
            status: 'passed',
            timestamp: ts,
            // The pass belongs to this same recording.
            recordingId: c.priorRecordingId || specRecordingId,
          },
        ],
      },
    ];
  }

  let printed = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    printed += chunk;
    return true;
  };
  // Observations travel to the reporter as a JSON attachment body, the same
  // way the fixture sends them.
  const attachments = c.observations
    ? [{
        name: 'kryptheon-observations',
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(c.observations), 'utf8'),
      }]
    : [];

  // Cases that exercise the first-run advice need a spec on disk to read.
  const testCase = specFile
    ? { title: c.name, location: { file: specFile, line: 1, column: 1 } }
    : { title: c.name };

  try {
    reporter.onTestEnd(
      testCase,
      { status: 'timedOut', duration: 100, startTime: new Date(), errors: c.errors, attachments: attachments }
    );
  } finally {
    process.stdout.write = write;
  }
  return { failure: reporter.records[0].failure, printed: printed };
}

let failures = 0;
for (const c of cases) {
  const result = runCase(c);
  const failure = result.failure;
  const printed = result.printed;
  const text = failure.plainLanguage;
  const problems = [];

  for (const needle of c.expectContains || []) {
    if (!text.includes(needle)) problems.push('missing ' + JSON.stringify(needle));
  }
  for (const needle of c.expectMissing || []) {
    if (text.includes(needle)) problems.push('should not contain ' + JSON.stringify(needle));
  }
  // The prompt is word-wrapped, so match on content with whitespace collapsed
  // rather than depending on where lines happen to break.
  const flatten = (s) => String(s).replace(/\s+/g, ' ').trim();
  const flatPrinted = flatten(printed);

  for (const needle of c.expectPrinted || []) {
    if (!flatPrinted.includes(flatten(needle))) problems.push('printed block missing ' + JSON.stringify(needle));
  }
  for (const needle of c.expectPrintedMissing || []) {
    if (flatPrinted.includes(flatten(needle))) problems.push('printed block should not contain ' + JSON.stringify(needle));
  }
  // Checked against the pasteable prompt alone: the advice text and the Source
  // line legitimately appear elsewhere in the block.
  if (c.expectPromptMissing) {
    const lines = printed.split('\n');
    const start = lines.findIndex((l) => l.includes('Paste this into your AI tool:'));
    const prompt = start < 0 ? '' : flatten(lines.slice(start).join('\n'));
    if (!prompt) problems.push('no prompt section was printed');
    for (const needle of c.expectPromptMissing) {
      if (prompt.includes(flatten(needle))) problems.push('prompt should not contain ' + JSON.stringify(needle));
    }
  }
  if (c.expectAdvice) {
    const adviceLine = printed.split('\n').find((l) => l.includes('What to check:')) || '';
    if (!adviceLine.includes(c.expectAdvice)) {
      problems.push('advice missing ' + JSON.stringify(c.expectAdvice) + ' (got: ' + adviceLine.trim() + ')');
    }
  }
  if (/\u001b/.test(text)) problems.push('contains ANSI escapes');

  if (problems.length) {
    failures++;
    console.log('FAIL  ' + c.name);
    console.log('      got: ' + text);
    problems.forEach((p) => console.log('      - ' + p));
  } else {
    console.log('PASS  ' + c.name);
    console.log('      ' + text);
  }
}

// ---------------------------------------------------------------------------
// Baseline checks. These call the fixture's helpers directly, against scratch
// files, so the project's real kryptheon-baselines.json is never touched.
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const nodePath = require('path');
const fixture = require('./kryptheon-fixture.js');

const scratchDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'kryptheon-baseline-'));
let scratchCount = 0;

// Returns a path in a temp directory. Pass contents to pre-seed the file;
// omit it to leave the file absent.
function scratchFile(contents) {
  const file = nodePath.join(scratchDir, 'baselines-' + ++scratchCount + '.json');
  if (contents !== undefined) fs.writeFileSync(file, contents, 'utf8');
  return file;
}

// Loads a fresh reporter with quiet mode on, drives a whole run through it,
// and returns everything it printed. The flag is read at module load, so the
// module cache has to be cleared for it to take effect.
function runReporterQuiet(tests) {
  const reporterPath = nodePath.join(__dirname, 'kryptheon-reporter.js');
  const hadQuiet = process.env.KRYPTHEON_QUIET;
  process.env.KRYPTHEON_QUIET = '1';
  delete require.cache[require.resolve(reporterPath)];

  let printed = '';
  const realWrite = process.stdout.write.bind(process.stdout);
  try {
    const QuietReporter = require(reporterPath);
    const reporter = new QuietReporter();
    reporter.previousRuns = [];
    reporter.records = [];

    process.stdout.write = (chunk) => {
      printed += chunk;
      return true;
    };
    reporter.onBegin();
    for (const t of tests) {
      reporter.onTestEnd(
        { title: t.title },
        {
          status: t.status,
          duration: t.duration,
          startTime: new Date(),
          errors: t.errors || [],
          attachments: [],
        }
      );
    }
    reporter.onEnd({ status: tests.some((t) => t.status !== 'passed') ? 'failed' : 'passed' });
  } finally {
    process.stdout.write = realWrite;
    delete require.cache[require.resolve(reporterPath)];
    if (hadQuiet === undefined) delete process.env.KRYPTHEON_QUIET;
    else process.env.KRYPTHEON_QUIET = hadQuiet;
  }
  return printed;
}

const KEY = 'tests/login.spec.js :: Login';
const DASHBOARD = { url: '/dashboard.html', title: 'Catchai | Clinic Dashboard' };

function seeded(entry) {
  const obj = {};
  obj[KEY] = entry;
  return scratchFile(JSON.stringify(obj, null, 2));
}

const baselineCases = [
  {
    name: 'first run with no file -> baseline created, test allowed to pass',
    run: () => {
      const file = scratchFile(); // absent
      const out = fixture.applyBaseline(file, KEY, DASHBOARD);
      const problems = [];
      if (out.status !== 'created') problems.push('expected status "created", got ' + out.status);
      if (out.message) problems.push('a first run must not produce a failure message');
      const written = fixture.readBaselines(file)[KEY];
      if (!written) problems.push('no baseline was written to the file');
      else {
        if (written.url !== DASHBOARD.url) problems.push('stored url is ' + written.url);
        if (written.title !== DASHBOARD.title) problems.push('stored title is ' + written.title);
      }
      return problems;
    },
  },
  {
    name: 'matching baseline -> no failure',
    run: () => {
      const file = seeded(DASHBOARD);
      const out = fixture.applyBaseline(file, KEY, DASHBOARD);
      return out.status === 'match' && !out.message ? [] : ['expected a match, got ' + out.status];
    },
  },
  {
    name: 'query string and trailing slash are ignored when comparing',
    run: () => {
      const file = seeded({ url: '/app/', title: 'Same' });
      const out = fixture.applyBaseline(file, KEY, { url: '/app?tab=2', title: 'Same' });
      return out.status === 'match' ? [] : ['expected a match, got ' + out.status + ': ' + out.message];
    },
  },
  {
    name: 'different address -> failure naming before and after',
    run: () => {
      const file = seeded(DASHBOARD);
      const out = fixture.applyBaseline(file, KEY, { url: '/auth.html', title: DASHBOARD.title });
      const problems = [];
      if (out.status !== 'changed') problems.push('expected status "changed", got ' + out.status);
      const m = out.message || '';
      if (!m.includes('the page address changed')) problems.push('message does not name the address');
      if (!m.includes('Address was: /dashboard.html')) problems.push('message lacks the previous address');
      if (!m.includes('Address now: /auth.html')) problems.push('message lacks the current address');
      if (m.includes('Title was:')) problems.push('title should not be reported as changed');
      return problems;
    },
  },
  {
    name: 'different heading text -> failure naming before and after',
    run: () => {
      const file = seeded(DASHBOARD);
      const out = fixture.applyBaseline(file, KEY, { url: DASHBOARD.url, title: 'Catchai | Sign In' });
      const problems = [];
      if (out.status !== 'changed') problems.push('expected status "changed", got ' + out.status);
      const m = out.message || '';
      if (!m.includes('the page title changed')) problems.push('message does not name the title');
      if (!m.includes('Title was: "Catchai | Clinic Dashboard"')) problems.push('message lacks the previous title');
      if (!m.includes('Title now: "Catchai | Sign In"')) problems.push('message lacks the current title');
      if (m.includes('Address was:')) problems.push('address should not be reported as changed');
      return problems;
    },
  },
  {
    name: 'unreadable file contents -> treated as no baseline yet',
    run: () => {
      const file = scratchFile('{ this is not valid json at all ');
      const problems = [];
      if (Object.keys(fixture.readBaselines(file)).length !== 0) {
        problems.push('a damaged file should read as empty');
      }
      const out = fixture.applyBaseline(file, KEY, DASHBOARD);
      if (out.status !== 'created') problems.push('expected status "created", got ' + out.status);
      if (out.message) problems.push('a damaged file must not fail the test');
      if (!fixture.readBaselines(file)[KEY]) problems.push('the file was not repaired with a fresh baseline');
      return problems;
    },
  },
  {
    name: 'JSON that is not an object -> treated as no baseline yet',
    run: () => {
      const file = scratchFile('["not", "an", "object"]');
      const out = fixture.applyBaseline(file, KEY, DASHBOARD);
      return out.status === 'created' ? [] : ['expected status "created", got ' + out.status];
    },
  },

  // --- Noise the last passing run already produced is not evidence.
  {
    name: 'noise seen on the last pass is filtered out',
    run: () => {
      const previous = {
        consoleErrors: ['CSP blocked iconify script'],
        failedRequests: [{ method: 'GET', path: '/favicon.ico', status: 404 }],
      };
      const current = {
        consoleErrors: ['CSP blocked iconify script'],
        failedRequests: [{ method: 'GET', url: 'https://site.test/favicon.ico', status: 404 }],
      };
      const out = fixture.newObservations(current, previous);
      const problems = [];
      if (out.consoleErrors.length !== 0) {
        problems.push('kept a console error that was already there: ' + JSON.stringify(out.consoleErrors));
      }
      if (out.failedRequests.length !== 0) {
        problems.push('kept a request that was already failing: ' + JSON.stringify(out.failedRequests));
      }
      return problems;
    },
  },
  {
    name: 'noise that appeared this run is kept',
    run: () => {
      const previous = {
        consoleErrors: ['CSP blocked iconify script'],
        failedRequests: [{ method: 'GET', path: '/favicon.ico', status: 404 }],
      };
      const current = {
        consoleErrors: ['CSP blocked iconify script', 'Uncaught TypeError: save is not a function'],
        failedRequests: [
          { method: 'GET', url: 'https://site.test/favicon.ico', status: 404 },
          { method: 'POST', url: 'https://site.test/api/save', status: 500 },
        ],
      };
      const out = fixture.newObservations(current, previous);
      const problems = [];
      if (out.consoleErrors.length !== 1 || !out.consoleErrors[0].includes('save is not a function')) {
        problems.push('expected only the new console error, got ' + JSON.stringify(out.consoleErrors));
      }
      if (out.failedRequests.length !== 1 || out.failedRequests[0].status !== 500) {
        problems.push('expected only the new failed request, got ' + JSON.stringify(out.failedRequests));
      }
      return problems;
    },
  },

  // --- Accepting one test must leave every other test alone.
  {
    name: 'agreeing to one result leaves the others untouched',
    run: () => {
      const other = 'tests/homepage.spec.js :: Demo form';
      const file = scratchFile(
        JSON.stringify({
          [KEY]: { url: '/dashboard.html', title: 'Old Login', pending: { url: '/home.html', title: 'New Login' } },
          [other]: { url: '/', title: 'Old Home', pending: { url: '/x', title: 'New Home' } },
        })
      );
      const result = fixture.acceptBaseline(file, KEY);
      const all = fixture.readBaselines(file);
      const problems = [];
      if (!result.ok) problems.push('accept failed: ' + result.reason);
      if (all[KEY].url !== '/home.html') problems.push('named test not updated, url is ' + all[KEY].url);
      if (all[KEY].title !== 'New Login') problems.push('named test title is ' + all[KEY].title);
      if (all[KEY].pending) problems.push('pending was not cleared on the named test');
      if (all[other].url !== '/') problems.push('OTHER test was changed, url is ' + all[other].url);
      if (all[other].title !== 'Old Home') problems.push('OTHER test title changed to ' + all[other].title);
      if (!all[other].pending) problems.push('OTHER test lost its waiting result');
      return problems;
    },
  },
  // --- Naming a fresh recording.
  {
    name: 'a recording gets a name taken from the page',
    run: () => {
      const cli = require('./bin/kryptheon.js');
      const problems = [];
      if (cli.nameFromTitle('Catchai | About Us') !== 'About Us') {
        problems.push('title gave ' + JSON.stringify(cli.nameFromTitle('Catchai | About Us')));
      }
      // A long marketing tail is prose, not a name, so it is rejected.
      if (cli.nameFromTitle('Catchai | AI Patient Recovery Engine for Healthcare Clinics') !== null) {
        problems.push('a long tail should be rejected');
      }
      if (cli.deriveTestName("page.goto('https://x.test/about-us.html')") !== 'About Us') {
        problems.push('path gave ' + cli.deriveTestName("page.goto('https://x.test/about-us.html')"));
      }
      if (cli.slugify('About Us') !== 'about-us') problems.push('slug gave ' + cli.slugify('About Us'));
      return problems;
    },
  },
  // --- Deciding whether a recording is worth keeping.
  {
    name: 'an abandoned recording counts as empty',
    run: () => {
      const cli = require('./bin/kryptheon.js');
      // Exactly what codegen leaves behind when the page never loaded.
      const empty =
        "import { test, expect } from 'kryptheon/kryptheon-fixture';\n\n" +
        "test('test', async ({ page }) => {\n});\n";
      const gotoOnly = empty.replace('=> {\n}', "=> {\n  await page.goto('https://x.test/');\n}");
      const busy =
        gotoOnly.replace(
          "await page.goto('https://x.test/');",
          "await page.goto('https://x.test/');\n" +
            "  await page.getByRole('link', { name: 'Next' }).click();\n" +
            "  await page.getByRole('textbox', { name: 'Email' }).fill('a@b.c');"
        );
      const problems = [];
      if (cli.countRecordedActions(empty) !== 0) {
        problems.push('an empty body should count 0, got ' + cli.countRecordedActions(empty));
      }
      if (cli.countRecordedActions(gotoOnly) !== 1) {
        problems.push('a single navigation should count 1, got ' + cli.countRecordedActions(gotoOnly));
      }
      if (cli.countRecordedActions(busy) !== 3) {
        problems.push('three steps should count 3, got ' + cli.countRecordedActions(busy));
      }
      if (cli.countRecordedActions(null) !== 0) problems.push('null should count 0');
      return problems;
    },
  },

  // --- Telling apart the ways an address can fail to answer.
  {
    name: 'connection failures are sorted into kinds',
    run: () => {
      const cli = require('./bin/kryptheon.js');
      const asFetchError = (code) => {
        const e = new TypeError('fetch failed');
        e.cause = { code: code };
        return e;
      };
      const aborted = new Error('This operation was aborted');
      aborted.name = 'AbortError';

      const expected = [
        [asFetchError('ECONNREFUSED'), 'refused'],
        [asFetchError('ENOTFOUND'), 'unknown-address'],
        [asFetchError('EAI_AGAIN'), 'unknown-address'],
        [aborted, 'timeout'],
        [asFetchError('ETIMEDOUT'), 'timeout'],
        [asFetchError('DEPTH_ZERO_SELF_SIGNED_CERT'), 'reachable'],
        [asFetchError('SOMETHING_ELSE'), 'other'],
      ];
      const problems = [];
      for (const [err, want] of expected) {
        const got = cli.classifyFetchError(err);
        if (got !== want) {
          problems.push((err.cause ? err.cause.code : err.name) + ' gave "' + got + '", wanted "' + want + '"');
        }
      }
      return problems;
    },
  },
  {
    name: 'a typed address is tidied before use',
    run: () => {
      const cli = require('./bin/kryptheon.js');
      const problems = [];
      if (cli.normaliseRecordUrl('localhost:3000') !== 'http://localhost:3000') {
        problems.push('bare host gave ' + cli.normaliseRecordUrl('localhost:3000'));
      }
      if (cli.normaliseRecordUrl('https://a.test/x') !== 'https://a.test/x') {
        problems.push('an address with a scheme should be left alone');
      }
      if (!cli.isLocalAddress('http://localhost:3000')) problems.push('localhost not recognised');
      if (!cli.isLocalAddress('http://127.0.0.1:8080')) problems.push('127.0.0.1 not recognised');
      if (cli.isLocalAddress('https://www.example.com')) problems.push('a public site was called local');
      return problems;
    },
  },
  // --- The three failures that together produced a false green.
  {
    name: 'a bare navigation does not count as recorded work',
    run: () => {
      const cli = require('./bin/kryptheon.js');
      // Byte-for-byte what a killed run left behind in the bug report.
      const killedRun =
        "import { test, expect } from '@playwright/test';\n\n" +
        "test('test', async ({ page }) => {\n" +
        "  await page.goto('https://www.catchai.live/about.html');\n});\n";
      const withClick = killedRun.replace(
        '});',
        "  await page.getByRole('link', { name: 'Next' }).click();\n});"
      );
      const problems = [];
      if (cli.isRealRecording(killedRun)) {
        problems.push('a lone navigation was treated as a usable recording');
      }
      if (cli.isRealRecording("test('t', async ({ page }) => {\n});")) {
        problems.push('an empty body was treated as a usable recording');
      }
      if (!cli.isRealRecording(withClick)) {
        problems.push('a navigation plus a click should be usable');
      }
      return problems;
    },
  },
  {
    name: 'a spec wired straight to the engine is spotted',
    run: () => {
      const cli = require('./bin/kryptheon.js');
      const problems = [];
      if (!cli.importsPlaywrightDirectly("import { test } from '@playwright/test';")) {
        problems.push('an import of the engine was missed');
      }
      if (!cli.importsPlaywrightDirectly('const { test } = require("@playwright/test");')) {
        problems.push('a require of the engine was missed');
      }
      if (cli.importsPlaywrightDirectly("import { test } from 'kryptheon/kryptheon-fixture';")) {
        problems.push('an already-wired spec was flagged');
      }
      if (cli.importsPlaywrightDirectly("const { test } = require('../kryptheon-fixture');")) {
        problems.push('a relative fixture import was flagged');
      }
      return problems;
    },
  },
  {
    name: 'recording is never refused before the browser is tried',
    run: () => {
      // A real user in Command Prompt was refused because stdout.isTTY came
      // back falsy, and told to go and run the command they had just run.
      // Nothing may gate the launch on a guess about the terminal.
      const source = fs.readFileSync(nodePath.join(__dirname, 'bin', 'kryptheon.js'), 'utf8');
      const problems = [];

      const beforeRecord = source.split('async function record(url)')[1] || '';
      const upToLaunch = beforeRecord.split('startCodegen')[0] || '';
      if (/isTTY/.test(upToLaunch)) {
        problems.push('something still inspects isTTY before launching the browser');
      }
      if (/looksLikeNoDesktop/.test(source)) {
        problems.push('the terminal-guessing refusal is still present');
      }
      return problems;
    },
  },
  {
    name: 'the no-window message does not repeat back what was just run',
    run: () => {
      const cli = require('./bin/kryptheon.js');
      const text = cli.noWindowLines(30).join('\n');
      const problems = [];

      // Telling someone in Command Prompt to open Command Prompt and run the
      // same command is the dead end this replaced.
      if (/Open Command Prompt/i.test(text)) problems.push('it still tells them to open a terminal');
      if (/^\s*npx kryptheon record/m.test(text)) {
        problems.push('it still hands back the command they just ran');
      }
      if (text.indexOf('No browser window appeared') === -1) {
        problems.push('it does not say plainly what happened');
      }
      // It has to be clear this was tried, not assumed.
      if (!/browser was started/i.test(text)) {
        problems.push('it does not make clear the browser was actually launched');
      }
      if (text.indexOf('KRYPTHEON_FORCE_RECORD') === -1) {
        problems.push('there is no way out for someone whose window is real');
      }
      return problems;
    },
  },
  // --- Teardown. Cutting the process off while the terminal still has output
  // --- queued is what produced the libuv assertion on Windows, and fetch's
  // --- pooled sockets were still open at that moment too.
  {
    name: 'the command never cuts its own process off',
    run: () => {
      const source = fs.readFileSync(nodePath.join(__dirname, 'bin', 'kryptheon.js'), 'utf8');
      const offenders = source
        .split('\n')
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter((entry) => entry.line.indexOf('process.exit(') !== -1)
        .filter((entry) => entry.line.indexOf('//') !== 0);
      return offenders.length
        ? offenders.map((o) => 'line ' + o.n + ' still forces an exit: ' + o.line)
        : [];
    },
  },
  {
    name: 'the command does not use pooled connections',
    run: () => {
      const source = fs.readFileSync(nodePath.join(__dirname, 'bin', 'kryptheon.js'), 'utf8');
      const problems = [];
      const calls = source
        .split('\n')
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter((entry) => /(^|[^.\w])fetch\s*\(/.test(entry.line))
        .filter((entry) => entry.line.indexOf('//') !== 0);
      for (const call of calls) {
        problems.push('line ' + call.n + ' still uses fetch: ' + call.line);
      }
      if (source.indexOf('agent: false') === -1) {
        problems.push('requests are not made with agent: false');
      }
      return problems;
    },
  },
  // --- Recordings that cannot be run a second time.
  {
    name: 'steps that only work once are named',
    run: () => {
      const replay = require('./kryptheon-replay.js');
      const source =
        "import { test, expect } from 'kryptheon/kryptheon-fixture';\n\n" +
        "test('t', async ({ page }) => {\n" +
        "  await page.goto('https://app.test/');\n" +
        "  await page.getByRole('textbox', { name: 'Email' }).fill('me@example.com');\n" +
        "  await page.getByRole('button', { name: 'Create Account' }).click();\n" +
        "  await page.getByRole('button', { name: 'Add budget' }).click();\n" +
        "  await page.getByRole('button', { name: 'Sign Out' }).click();\n});\n";
      const risks = replay.findReplayRisks(source);
      const byKind = {};
      for (const r of risks) byKind[r.kind] = r;
      const problems = [];
      if (!byKind.signup || byKind.signup.step !== 'Create Account') {
        problems.push('the account-creating step was not named: ' + JSON.stringify(byKind.signup));
      }
      if (!byKind['logout-last'] || byKind['logout-last'].step !== 'Sign Out') {
        problems.push('the closing sign-out was not named');
      }
      if (!byKind['creates-data'] || byKind['creates-data'].step !== 'Add budget') {
        problems.push('the row-adding step was not named');
      }
      return problems;
    },
  },
  {
    name: 'an ordinary recording raises nothing',
    run: () => {
      const replay = require('./kryptheon-replay.js');
      const source =
        "test('t', async ({ page }) => {\n" +
        "  await page.goto('https://app.test/');\n" +
        "  await page.getByRole('link', { name: 'Pricing' }).click();\n" +
        "  await page.getByRole('textbox', { name: 'Search' }).fill('shoes');\n});\n";
      const risks = replay.findReplayRisks(source);
      return risks.length ? risks.map((r) => 'unexpected warning: ' + r.kind + ' on "' + r.step + '"') : [];
    },
  },
  {
    name: 'a typed password never reaches the file',
    run: () => {
      const replay = require('./kryptheon-replay.js');
      const source =
        "  await page.getByRole('textbox', { name: 'Email' }).fill('me@example.com');\n" +
        "  await page.getByRole('textbox', { name: 'Password' }).fill('hunter2');\n" +
        "  await page.getByRole('textbox', { name: 'Password' }).fill('hunter2');\n" +
        "  await page.getByRole('textbox', { name: 'Confirm Password' }).fill('hunter2');\n";
      const out = replay.scrubSecrets(source);
      const problems = [];
      if (out.source.indexOf('hunter2') !== -1) problems.push('the secret is still in the file');
      if (out.source.indexOf("'me@example.com'") === -1) problems.push('a normal field was altered');
      // The same secret in the same field twice is one variable to set.
      const names = out.replacements.map((r) => r.envName);
      if (names.length !== 2) {
        problems.push('expected two variables (password, confirm password), got ' + JSON.stringify(names));
      }
      if (out.source.indexOf('process.env.' + names[0]) === -1) {
        problems.push('the variable is not referenced in the file');
      }
      return problems;
    },
  },
  {
    name: 'only a closing sign-out is taken off the end',
    run: () => {
      const replay = require('./kryptheon-replay.js');
      const ending =
        "  await page.goto('https://app.test/');\n" +
        "  await page.getByRole('button', { name: 'Save' }).click();\n" +
        "  await page.getByRole('button', { name: 'Log out' }).click();\n";
      const middle =
        "  await page.goto('https://app.test/');\n" +
        "  await page.getByRole('button', { name: 'Log out' }).click();\n" +
        "  await page.getByRole('button', { name: 'Save' }).click();\n";
      const problems = [];
      const dropped = replay.dropTrailingLogout(ending);
      if (dropped.removed !== 'Log out') problems.push('a closing sign-out was not removed');
      if (dropped.source.indexOf('Log out') !== -1) problems.push('the line is still there');
      if (dropped.source.indexOf('Save') === -1) problems.push('it removed the wrong line');

      const untouched = replay.dropTrailingLogout(middle);
      if (untouched.removed !== null) problems.push('a sign-out in the middle should be left alone');
      return problems;
    },
  },
  {
    name: 'a recording is not named after the way it ended',
    run: () => {
      const cli = require('./bin/kryptheon.js');
      const problems = [];
      // Ends with a sign-out: taking the last name would be wrong.
      const endsWithLogout =
        "  await page.goto('https://app.test/');\n" +
        "  await page.getByRole('link', { name: 'Login' }).click();\n" +
        "  await page.getByRole('button', { name: 'Sign Out' }).click();\n";
      if (cli.deriveTestName(endsWithLogout) === 'Sign Out') {
        problems.push('named after the closing sign-out');
      }
      // Starts with a sign-out: taking the first name would also be wrong,
      // so the sign-out has to be skipped rather than just re-ordered.
      const startsWithLogout =
        "  await page.goto('https://app.test/');\n" +
        "  await page.getByRole('button', { name: 'Log out' }).click();\n" +
        "  await page.getByRole('link', { name: 'Pricing' }).click();\n";
      const leading = cli.deriveTestName(startsWithLogout);
      if (leading === 'Log out') problems.push('named after an opening sign-out');
      return problems;
    },
  },
  // --- Folder names with brackets and spaces.
  {
    name: 'a folder name with brackets survives being shortened',
    run: () => {
      const localFs = require('fs');
      const localOs = require('os');
      const localPath = require('path');
      const Reporter = require('./kryptheon-reporter.js');

      const root = localFs.mkdtempSync(localPath.join(localOs.tmpdir(), 'kryptheon-brackets-'));
      const awkward = localPath.join(root, 'New folder (2) & more');
      localFs.mkdirSync(localPath.join(awkward, 'tests'), { recursive: true });
      const spec = localPath.join(awkward, 'tests', 'personal-finance-tracker.spec.js');
      localFs.writeFileSync(
        spec,
        "test('t', async ({ page }) => {\n  await page.goto('https://app.test/');\n" +
          "  await page.getByRole('button', { name: 'Add budget' }).click();\n});\n",
        'utf8'
      );

      const reporter = new Reporter();
      reporter.previousRuns = [];
      reporter.records = [];

      let printed = '';
      const realWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk) => {
        printed += chunk;
        return true;
      };
      try {
        reporter.onTestEnd(
          { title: 'Personal finance tracker', location: { file: spec, line: 3, column: 1 } },
          {
            status: 'failed',
            duration: 10,
            startTime: new Date(),
            // Exactly how Playwright mangles it: truncated at the first "(".
            errors: [
              {
                message: 'Error: locator.click: Timeout 4000ms exceeded.\nCall log:\n  - waiting for getByRole(\'button\', { name: \'Add budget\' })\n',
                location: { file: '2) & more\\tests\\personal-finance-tracker.spec.js', line: 3, column: 1 },
              },
            ],
            attachments: [],
          }
        );
      } finally {
        process.stdout.write = realWrite;
      }

      const problems = [];
      const sourceLine = printed.split('\n').find((l) => l.indexOf('Source:') !== -1) || '';
      if (!sourceLine) problems.push('no Source line was printed');
      // Truncation shows up as the path starting mid-way through the folder
      // name; the whole name surviving is what proves it did not happen.
      if (sourceLine.indexOf('New folder (2) & more') === -1) {
        problems.push('the folder name was cut short: ' + sourceLine.trim());
      }
      if (sourceLine.indexOf('personal-finance-tracker.spec.js') === -1) {
        problems.push('the spec file is not named: ' + sourceLine.trim());
      }
      try {
        localFs.rmSync(root, { recursive: true, force: true });
      } catch (err) {
        /* best effort */
      }
      return problems;
    },
  },
  // --- Quiet mode. The flag is read when the module loads, so these load a
  // --- fresh copy of the reporter with the flag set.
  {
    name: 'a whole passing run says one line and nothing else',
    run: () => {
      const printed = runReporterQuiet([
        { title: 'Sign in', status: 'passed', duration: 1200 },
        { title: 'Checkout', status: 'passed', duration: 900 },
      ]);
      const lines = printed.split('\n').filter((l) => l.trim().length);
      const problems = [];
      if (lines.length !== 1) {
        problems.push('expected exactly one line, got ' + lines.length + ': ' + JSON.stringify(lines));
      }
      if (printed.indexOf('Kryptheon test run') !== -1) problems.push('the header was printed');
      if (printed.indexOf('Sign in') !== -1) problems.push('a per-test line was printed');
      if (lines[0] && lines[0].indexOf('2 recordings') === -1) {
        problems.push('the one line does not say how many: ' + lines[0]);
      }
      return problems;
    },
  },
  {
    name: 'a failing run in quiet mode still explains itself fully',
    run: () => {
      const printed = runReporterQuiet([
        { title: 'Sign in', status: 'passed', duration: 1200 },
        {
          title: 'Checkout',
          status: 'failed',
          duration: 4000,
          errors: [
            {
              message:
                'TimeoutError: locator.click: Timeout 4000ms exceeded.\nCall log:\n' +
                '  - waiting for getByRole(\'button\', { name: \'Place order\' })\n',
            },
          ],
        },
      ]);
      const problems = [];
      if (printed.indexOf('Could not find the button "Place order"') === -1) {
        problems.push('the plain-language reason is missing');
      }
      if (printed.indexOf('Paste this into your AI tool:') === -1) {
        problems.push('the pasteable prompt is missing');
      }
      if (printed.indexOf('Sign in') !== -1) problems.push('the passing test was still announced');
      // Quiet only replaces the closing line when nothing failed; a failing
      // run still has to say how many broke.
      if (printed.indexOf('1 working, 1 broken') === -1) {
        problems.push('the closing count is missing on a failing run');
      }
      return problems;
    },
  },

  // --- The rules file that tells an assistant to check its own work.
  {
    name: 'the rule is written into a file that did not exist',
    run: () => {
      const cli = require('./bin/kryptheon.js');
      const out = cli.applyRules(null, 'html');
      const problems = [];
      if (out.action !== 'created') problems.push('expected "created", got ' + out.action);
      if (out.contents.indexOf('npx kryptheon check') === -1) problems.push('the command is not in the rule');
      if (out.contents.indexOf('kryptheon:start') === -1) problems.push('no opening marker');
      if (out.contents.indexOf('kryptheon:end') === -1) problems.push('no closing marker');
      return problems;
    },
  },
  {
    name: 'an existing file keeps everything it already had',
    run: () => {
      const cli = require('./bin/kryptheon.js');
      const mine = '# My project\n\nAlways use tabs.\nNever touch src/legacy.\n';
      const out = cli.applyRules(mine, 'html');
      const problems = [];
      if (out.action !== 'appended') problems.push('expected "appended", got ' + out.action);
      if (out.contents.indexOf('Always use tabs.') === -1) problems.push('existing content was lost');
      if (out.contents.indexOf('Never touch src/legacy.') === -1) problems.push('existing content was lost');
      if (out.contents.indexOf('# My project') !== 0) problems.push('the file no longer starts as it did');
      if (out.contents.indexOf('npx kryptheon check') === -1) problems.push('the rule was not added');
      return problems;
    },
  },
  {
    name: 'running it twice does not stack a second copy',
    run: () => {
      const cli = require('./bin/kryptheon.js');
      const once = cli.applyRules('# Mine\n\nkeep me\n', 'html').contents;
      const twice = cli.applyRules(once, 'html');
      const problems = [];
      const count = twice.contents.split('kryptheon:start').length - 1;
      if (count !== 1) problems.push('the marked section appears ' + count + ' times');
      if (twice.contents.indexOf('keep me') === -1) problems.push('existing content was lost on the second run');
      if (twice.action === 'appended') problems.push('a second run appended instead of replacing');
      return problems;
    },
  },
  {
    name: 'the rule covers the case where nothing is recorded yet',
    run: () => {
      const cli = require('./bin/kryptheon.js');
      const block = cli.rulesBlock('html');
      const flat = block.replace(/\s+/g, ' ');
      const problems = [];
      if (flat.indexOf('npx kryptheon record') === -1) {
        problems.push('the rule never mentions how to record');
      }
      if (flat.indexOf('their own terminal') === -1) {
        problems.push('the rule does not say the user must do it themselves');
      }
      if (flat.indexOf('do not try to fix it') === -1) {
        problems.push('the rule does not say this is not something to fix');
      }
      return problems;
    },
  },
  {
    name: 'the plain-text format is commented, not left as markdown',
    run: () => {
      const cli = require('./bin/kryptheon.js');
      const block = cli.rulesBlock('hash');
      const problems = [];
      const lines = block.split('\n').filter((l) => l.length);
      const uncommented = lines.filter((l) => l.charAt(0) !== '#');
      if (uncommented.length) problems.push('lines without a comment marker: ' + JSON.stringify(uncommented.slice(0, 2)));
      if (block.indexOf('npx kryptheon check') === -1) problems.push('the command is missing');
      return problems;
    },
  },
  {
    name: 'agreeing with nothing waiting is refused',
    run: () => {
      const file = seeded(DASHBOARD);
      const result = fixture.acceptBaseline(file, KEY);
      if (result.ok) return ['expected a refusal when there is nothing waiting'];
      return result.reason === 'nothing-pending' ? [] : ['unexpected reason: ' + result.reason];
    },
  },
];

for (const c of baselineCases) {
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

try {
  fs.rmSync(scratchDir, { recursive: true, force: true });
} catch (e) {
  /* temp dir cleanup is best effort */
}

const total = cases.length + baselineCases.length;

console.log('');
if (failures) {
  console.log(failures + ' check(s) failed.');
  process.exit(1);
}
console.log('All ' + total + ' checks passed.');
