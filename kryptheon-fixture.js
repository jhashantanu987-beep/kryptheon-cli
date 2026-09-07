// Shared test object that watches the browser during every test and, when a
// test fails, hands the reporter what was actually observed: the URL the
// browser ended on, any 4xx/5xx responses, and any console errors.
//
// It also keeps automatic baselines. After a test passes, the page's final
// address, title, and the browser noise it produced are remembered. On later
// runs the address and title are compared, so a recorded test catches
// regressions without anyone writing an assertion - and noise that was already
// there on the last passing run is filtered out of failure reports, because it
// is not evidence of the new problem.
//
// Specs import { test, expect } from here instead of from '@playwright/test'.
// Playwright has no global beforeEach, so this shared module is the way to
// apply the same behaviour to every spec without repeating it in each one.

const fs = require('fs');
const path = require('path');
const base = require('@playwright/test');

// Reuse the reporter's host-stripping so a baseline stores exactly the shape
// the reporter prints.
const { requestPath } = require('./kryptheon-reporter.js');
const signature = require('./kryptheon-signature.js');

const MAX_ITEMS = 5; // keep the failure block readable

// Baselines describe the user's app, so they live in the folder the command
// was run from - never inside the installed package.
const USER_DIR = process.cwd();
const BASELINE_FILE = path.join(USER_DIR, 'kryptheon-baselines.json');

function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Baselines. These helpers take the file path explicitly so they can be
// exercised against a scratch file in the unit checks.
// ---------------------------------------------------------------------------

// One entry per test, identified by where it lives plus what it is called.
function baselineKey(specFile, title) {
  let rel = String(specFile || '');
  try {
    rel = path.relative(USER_DIR, specFile);
  } catch (e) {
    /* keep what we were given */
  }
  return rel.split(path.sep).join('/') + ' :: ' + String(title || '');
}

// A missing or unreadable file, malformed JSON, or anything that is not a
// plain object all mean the same thing: no baselines yet.
function readBaselines(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, { encoding: 'utf8' });
  } catch (e) {
    return {};
  }
  // An editor that saved the file with a byte order mark would otherwise make
  // JSON.parse throw, and every baseline would silently vanish - which reads as
  // "all clear" on the next run rather than as the problem it is.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
}

function saveBaselines(file, all) {
  try {
    // Explicit, and without a byte order mark: this file is read back by the
    // same code and by people, and a mismatch would look like the app changed.
    fs.writeFileSync(file, JSON.stringify(all, null, 2) + '\n', { encoding: 'utf8' });
    return true;
  } catch (e) {
    return false; // diagnostics must never become a second failure
  }
}

// Identity of a failed request, independent of host and of run order.
function requestKey(req) {
  if (!req) return '';
  const where = req.path != null ? req.path : requestPath(req.url || '');
  return (req.method || 'GET') + ' ' + where + ' ' + req.status;
}

function toStoredRequests(list) {
  const seen = Object.create(null);
  const out = [];
  for (const req of list || []) {
    const key = requestKey(req);
    if (seen[key]) continue;
    seen[key] = true;
    out.push({
      method: req.method || 'GET',
      path: req.path != null ? req.path : requestPath(req.url || ''),
      status: req.status,
    });
  }
  return out;
}

function toStoredErrors(list) {
  const seen = Object.create(null);
  const out = [];
  for (const text of list || []) {
    const line = oneLine(text);
    if (!line || seen[line]) continue;
    seen[line] = true;
    out.push(line);
  }
  return out;
}

function normalisedEntry(current) {
  const stored = {
    url: current.url,
    title: current.title,
    consoleErrors: toStoredErrors(current.consoleErrors),
    failedRequests: toStoredRequests(current.failedRequests),
  };
  // Only when there is one. A run whose capture failed must not write an empty
  // signature over a good one, or the next run would report everything as gone.
  if (current.signature) stored.signature = current.signature;
  return stored;
}

function writeBaseline(file, key, entry) {
  const all = readBaselines(file);
  const stored = normalisedEntry(entry);
  stored.recordedAt = new Date().toISOString();
  all[key] = stored;
  return saveBaselines(file, all);
}

// Records what the failing run saw, WITHOUT changing the accepted baseline.
// `kryptheon accept` promotes this later, on the user's say-so.
function writePending(file, key, entry) {
  const all = readBaselines(file);
  const existing = all[key];
  if (!existing || typeof existing !== 'object') return false;
  existing.pending = normalisedEntry(entry);
  existing.pending.seenAt = new Date().toISOString();
  return saveBaselines(file, all);
}

// Promotes a pending observation into the accepted baseline for one test only.
function acceptBaseline(file, key) {
  const all = readBaselines(file);
  const entry = all[key];
  if (!entry || typeof entry !== 'object') {
    return { ok: false, reason: 'no-entry' };
  }
  if (!entry.pending || typeof entry.pending !== 'object') {
    return { ok: false, reason: 'nothing-pending' };
  }
  const promoted = normalisedEntry(entry.pending);
  promoted.recordedAt = new Date().toISOString();
  all[key] = promoted;
  return saveBaselines(file, all) ? { ok: true, entry: promoted } : { ok: false, reason: 'write-failed' };
}

// Query strings and trailing slashes are noise for this comparison.
function normaliseUrl(value) {
  let s = String(value == null ? '' : value);
  const hash = s.indexOf('#');
  if (hash !== -1) s = s.slice(0, hash);
  const query = s.indexOf('?');
  if (query !== -1) s = s.slice(0, query);
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}

function normaliseTitle(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// The address, the title, and what the page ended up showing decide pass or
// fail. Browser noise changing is not on its own a regression.
function compareBaselines(previous, current) {
  const urlChanged = normaliseUrl(previous.url) !== normaliseUrl(current.url);
  const titleChanged = normaliseTitle(previous.title) !== normaliseTitle(current.title);
  if (!urlChanged && !titleChanged) {
    // Nothing moved in the address bar. This is the case the address and title
    // alone cannot see: a single-page app with a catch-all route lands on the
    // same URL under the same title whether the flow worked or not.
    return signature.compareSignatures(previous.signature, current.signature);
  }

  const what =
    urlChanged && titleChanged ? 'the page address and title changed'
    : urlChanged ? 'the page address changed'
    : 'the page title changed';

  const lines = ['Baseline changed: ' + what + ' since the last passing run.'];
  if (urlChanged) {
    lines.push('Address was: ' + previous.url);
    lines.push('Address now: ' + current.url);
  }
  if (titleChanged) {
    lines.push('Title was: "' + normaliseTitle(previous.title) + '"');
    lines.push('Title now: "' + normaliseTitle(current.title) + '"');
  }
  return lines.join('\n');
}

// Drops anything the last passing run already produced. What is left is the
// only browser noise that could be evidence of this regression.
function newObservations(current, previous) {
  const knownErrors = Object.create(null);
  for (const text of (previous && previous.consoleErrors) || []) knownErrors[oneLine(text)] = true;

  const knownRequests = Object.create(null);
  for (const req of (previous && previous.failedRequests) || []) knownRequests[requestKey(req)] = true;

  return {
    consoleErrors: ((current && current.consoleErrors) || []).filter(function (text) {
      return !knownErrors[oneLine(text)];
    }),
    failedRequests: ((current && current.failedRequests) || []).filter(function (req) {
      return !knownRequests[requestKey(req)];
    }),
  };
}

// Adds a signature to an accepted baseline that predates the feature, without
// touching anything else about it - including when it was recorded, which is
// what the failure report means by "this last worked at".
function upgradeBaseline(file, key, sig) {
  const all = readBaselines(file);
  const entry = all[key];
  if (!entry || typeof entry !== 'object' || entry.signature || !sig) return false;
  entry.signature = sig;
  return saveBaselines(file, all);
}

// The whole decision in one call: create on first sight, otherwise compare.
function applyBaseline(file, key, current) {
  const previous = readBaselines(file)[key];
  if (!previous || typeof previous !== 'object') {
    writeBaseline(file, key, current);
    return { status: 'created', message: null };
  }
  const message = compareBaselines(previous, current);
  if (message) return { status: 'changed', message: message };

  // A baseline from before signatures existed passes on address and title, and
  // learns its signature here. Doing it on a pass rather than up front means an
  // upgraded project never fails on its first run under the new version.
  if (!previous.signature && current.signature) {
    upgradeBaseline(file, key, current.signature);
    return { status: 'learned', message: null };
  }
  return { status: 'match', message: null };
}

// ---------------------------------------------------------------------------

const test = base.test.extend({
  page: async ({ page }, use, testInfo) => {
    const consoleErrors = [];
    const failedRequests = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(oneLine(msg.text()));
    });
    // Uncaught exceptions never reach page.on('console') in every browser.
    page.on('pageerror', (err) => {
      consoleErrors.push(oneLine((err && err.message) || String(err)));
    });
    page.on('response', (res) => {
      const status = res.status();
      if (status >= 400) {
        failedRequests.push({ method: res.request().method(), url: res.url(), status: status });
      }
    });

    const key = baselineKey(testInfo.file, testInfo.title);

    // Reports only what this run added on top of the last passing run.
    const attachObservations = async () => {
      let url = null;
      try {
        url = page.url();
      } catch (e) {
        url = null; // page may already be closed
      }
      const previous = readBaselines(BASELINE_FILE)[key];
      const fresh = newObservations({ consoleErrors, failedRequests }, previous);
      try {
        await testInfo.attach('kryptheon-observations', {
          body: JSON.stringify({
            url: url,
            // What was actually on screen when it gave up. On a flow that
            // stopped half way this is the most useful line in the report.
            pageShowed: signature.describeSignature(captured),
            failedRequests: fresh.failedRequests.slice(0, MAX_ITEMS),
            consoleErrors: fresh.consoleErrors.slice(0, MAX_ITEMS),
          }),
          contentType: 'application/json',
        });
      } catch (e) {
        // Never let diagnostics turn into a second failure.
      }
    };

    await use(page);

    // Read the page before anything else looks at the outcome. A test that
    // failed is exactly the one where knowing what was on screen matters most,
    // so this runs whether it passed or not. It is null when the page could
    // not be read at all, and a null is never treated as a difference - not
    // knowing what the page showed is not evidence that it changed.
    //
    // Printed only when asked for, and handed to the CLI through a file:
    // Playwright pipes this worker's descriptors and gives whatever comes out
    // to reporter stdio hooks that this reporter does not implement, so
    // anything printed from here is dropped before it reaches a terminal.
    const captured = await signature.collectSignature(page, failedRequests);
    if (signature.signatureEnabled()) signature.recordSignature(testInfo.title, captured);

    // Said once per run by the reporter, not once per test: it is a fact about
    // the app, and repeating it for every recording would be noise.
    if (captured && captured.guessedEncoding) {
      try {
        await testInfo.attach('kryptheon-encoding', { body: 'guessed', contentType: 'text/plain' });
      } catch (e) {
        /* a note, never a second failure */
      }
    }

    // The test's own assertions decide first. A test that already failed keeps
    // its own error, and never contributes a baseline.
    if (testInfo.status !== testInfo.expectedStatus) {
      await attachObservations();
      return;
    }

    // Passed: keep what the page ended up as, noise included.
    let current = null;
    try {
      current = {
        url: requestPath(page.url()),
        title: normaliseTitle(await page.title()),
        consoleErrors: consoleErrors,
        failedRequests: failedRequests,
        signature: captured,
      };
    } catch (e) {
      current = null; // page closed by the test - leave any baseline untouched
    }
    if (!current) return;

    const outcome = applyBaseline(BASELINE_FILE, key, current);
    if (outcome.status === 'changed') {
      // Remember what this run saw so `kryptheon accept` can promote it, but
      // leave the accepted baseline exactly as it was.
      writePending(BASELINE_FILE, key, current);
      await attachObservations();
      throw new Error(outcome.message);
    }
  },
});

module.exports = {
  test: test,
  expect: base.expect,
  // Exported for the CLI and the unit checks.
  baselineKey: baselineKey,
  readBaselines: readBaselines,
  writeBaseline: writeBaseline,
  writePending: writePending,
  acceptBaseline: acceptBaseline,
  newObservations: newObservations,
  requestKey: requestKey,
  normaliseUrl: normaliseUrl,
  normaliseTitle: normaliseTitle,
  compareBaselines: compareBaselines,
  applyBaseline: applyBaseline,
  upgradeBaseline: upgradeBaseline,
  BASELINE_FILE: BASELINE_FILE,
};
