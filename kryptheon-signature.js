// A "DOM signature": a small, plain description of what a page ended up
// showing. Not a screenshot and not a pixel comparison - just the words a
// person would use to say what is on screen.
//
// Why it exists. Automatic baselines currently remember the final address and
// the page title. In a single-page app with a catch-all route those both stay
// the same when a flow breaks: a login that no longer logs anyone in still
// lands on the same URL with the same title, so the baseline sees no
// difference and the run is reported as fine. The signature is the thing that
// would have noticed - the headings, buttons, links and fields on the page
// change even when the address does not.
//
// STEP ONE ONLY. This module captures and prints. Nothing here is written to a
// baseline, compared against anything, or allowed to affect whether a test
// passes. Collection does not even run unless KRYPTHEON_DEBUG_SIGNATURE=1.

const fs = require('fs');

const MAX_TEXT = 80;
const MAX_ACTIONS = 40;

// ---------------------------------------------------------------------------
// Pure helpers. No browser, no filesystem - so the unit checks can exercise
// them directly.
// ---------------------------------------------------------------------------

/**
 * One whole numeric value, however it happens to be written.
 *
 *   0   007   -42   +3.14   100.0   1,234   1,234.56   1 234   1.2.3
 *
 * It has to be the whole value, not each run of digits, or two ways of writing
 * the same quantity stop matching: "0" became "#" while "100.0" became "#.#",
 * and the signature reported a page as changed because a rate went from 0% to
 * 100.0%. The parts of a number are therefore all claimed by one match - the
 * thousands groups, whether separated by a comma or a space, and every decimal
 * or dotted section after them, which also takes "1.2.3" in one piece rather
 * than leaving "#.#.#" behind.
 *
 * The sign belongs to the number only when nothing word-like precedes it, so
 * "-42" is a single value while "COVID-19" keeps its hyphen and becomes
 * "COVID-#".
 */
const NUMBER = /(?:(?<![A-Za-z0-9])[-+])?\d+(?: \d{3}|,\d{3})*(?:[.,]\d+)*/g;

/**
 * One line, every number reduced to the same mark, capped.
 *
 * The digits are the important part. "Savings rate 0%" and "Savings rate 12%"
 * are the same page as far as this is concerned, and a signature that treated
 * them as different would report a regression every time a number moved.
 *
 * Only digits are touched. Everything else survives exactly as it was, because
 * a normaliser aggressive enough to blur the words would hide the changes this
 * is here to catch.
 */
function normaliseText(value) {
  const line = String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(NUMBER, '#');
  return line.length > MAX_TEXT ? line.slice(0, MAX_TEXT) : line;
}

function uniqueSorted(list) {
  const seen = Object.create(null);
  const out = [];
  for (const item of list || []) {
    const text = normaliseText(item);
    if (!text || seen[text]) continue;
    seen[text] = true;
    out.push(text);
  }
  return out.sort();
}

function uniqueInOrder(list) {
  const seen = Object.create(null);
  const out = [];
  for (const item of list || []) {
    const text = normaliseText(item);
    if (!text || seen[text]) continue;
    seen[text] = true;
    out.push(text);
  }
  return out;
}

/**
 * Path only: no host, no query string, no fragment.
 *
 * Deliberately not the reporter's requestPath, which keeps the query string so
 * a person reading a failure can see it. A signature is stored and compared,
 * and query strings routinely carry tokens, ids and search terms.
 */
function signaturePath(requestUrl) {
  let s = String(requestUrl == null ? '' : requestUrl);
  try {
    s = new URL(s).pathname || '/';
  } catch (e) {
    // Not absolute: strip any scheme://host by hand, then the query and hash.
    s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/, '');
    const hash = s.indexOf('#');
    if (hash !== -1) s = s.slice(0, hash);
    const query = s.indexOf('?');
    if (query !== -1) s = s.slice(0, query);
  }
  return s || '/';
}

/** Method, path and status. Never a query string, never a body. */
function toSignatureRequests(list) {
  const seen = Object.create(null);
  const out = [];
  for (const req of list || []) {
    const status = Number(req && req.status);
    if (!(status >= 400 && status <= 599)) continue;
    const entry = {
      method: (req && req.method) || 'GET',
      path: signaturePath((req && req.url) != null ? req.url : req && req.path),
      status: status,
    };
    const key = entry.method + ' ' + entry.path + ' ' + entry.status;
    if (seen[key]) continue;
    seen[key] = true;
    out.push(entry);
  }
  return out;
}

/** Assembles the signature from raw, page-shaped input. */
function buildSignature(raw) {
  const input = raw || {};
  return {
    headings: uniqueInOrder(input.headings),
    actions: uniqueSorted(input.actions).slice(0, MAX_ACTIONS),
    fields: uniqueSorted(input.fields),
    failedRequests: toSignatureRequests(input.failedRequests),
  };
}

/**
 * One plain line saying what was on screen, for a failure report.
 *
 * Deliberately not the JSON. Somebody reading a failure wants "it was still on
 * the sign-in page", not a structure to parse; the whole object stays behind
 * the debug flag for when the detail is actually wanted.
 */
function describeSignature(signature) {
  if (!signature || typeof signature !== 'object') return null;
  const headings = (signature.headings || []).slice(0, 2);
  const actions = (signature.actions || []).slice(0, 3);
  const fields = (signature.fields || []).slice(0, 3);

  let what;
  if (headings.length) what = quoteList(headings);
  else if (fields.length) what = 'a form';
  else if (actions.length) what = 'no headings';
  else return null; // nothing readable was on the page

  const parts = [];
  if (actions.length) parts.push(actions.join(', '));
  if (!headings.length && fields.length) parts.push(fields.join(', '));
  return parts.length ? what + ' with ' + parts.join('; ') : what;
}

// ---------------------------------------------------------------------------
// Comparing two signatures.
// ---------------------------------------------------------------------------

/**
 * What left and what arrived, as sets.
 *
 * Sets, not sequences: a page that moves its buttons around is the same page.
 * Only something appearing or disappearing is worth stopping a run over.
 */
function setDifference(before, after) {
  const had = new Set(before || []);
  const has = new Set(after || []);
  return {
    gone: [...had].filter((item) => !has.has(item)),
    added: [...has].filter((item) => !had.has(item)),
  };
}

function requestLabel(req) {
  return (req.method || 'GET') + ' ' + req.path + ' ' + req.status;
}

function quoteList(items) {
  return items.map((item) => '"' + item + '"').join(', ');
}

/**
 * Compares a stored signature with what this run saw. Returns a message
 * describing the change, or null when nothing worth failing over moved.
 *
 * Returns null when either side is missing. A baseline recorded before this
 * feature existed has no signature and must keep working on address and title
 * alone, and a run whose capture failed knows nothing - neither is evidence of
 * a regression, and treating them as one would fail every old project on
 * upgrade.
 */
function compareSignatures(previous, current) {
  if (!previous || typeof previous !== 'object') return null;
  if (!current || typeof current !== 'object') return null;

  const headings = setDifference(previous.headings, current.headings);
  const actions = setDifference(previous.actions, current.actions);
  const fields = setDifference(previous.fields, current.fields);

  // Only new failures matter. A 500 that has been fixed since the baseline was
  // taken is an improvement, and failing the run for it would be perverse.
  const knownRequests = new Set((previous.failedRequests || []).map(requestLabel));
  const newRequests = (current.failedRequests || [])
    .map(requestLabel)
    .filter((label) => !knownRequests.has(label));

  const moved =
    headings.gone.length ||
    headings.added.length ||
    actions.gone.length ||
    actions.added.length ||
    fields.gone.length ||
    fields.added.length ||
    newRequests.length;
  if (!moved) return null;

  const lines = ['Baseline changed: the page ended up somewhere different than before.'];
  if (headings.gone.length) lines.push('Headings that are gone: ' + quoteList(headings.gone));
  if (headings.added.length) lines.push('Headings that are new: ' + quoteList(headings.added));
  if (actions.gone.length) lines.push('Buttons and links that are gone: ' + quoteList(actions.gone));
  if (actions.added.length) lines.push('Buttons and links that are new: ' + quoteList(actions.added));
  if (fields.gone.length) lines.push('Form fields that are gone: ' + quoteList(fields.gone));
  if (fields.added.length) lines.push('Form fields that are new: ' + quoteList(fields.added));
  if (newRequests.length) lines.push('Requests that failed this time: ' + newRequests.join(', '));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The browser side.
// ---------------------------------------------------------------------------

// Runs inside the page. Written as a single self-contained function because
// page.evaluate serialises it across the wire - it cannot close over anything
// in this file.
function readPage() {
  const isVisible = (el) => {
    if (!el) return false;
    // checkVisibility covers display:none, visibility:hidden, content-visibility
    // and the hidden attribute in one call where it exists.
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
    } else {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  };

  const text = (el) => (el && el.innerText ? el.innerText : (el && el.textContent) || '');

  const headings = [];
  for (const el of document.querySelectorAll('h1, h2, h3')) {
    if (isVisible(el)) headings.push(text(el));
  }

  const actions = [];
  const actionSelector =
    'button, a[href], [role="button"], [role="link"], input[type="submit"], input[type="button"]';
  for (const el of document.querySelectorAll(actionSelector)) {
    if (!isVisible(el)) continue;
    const label =
      el.getAttribute('aria-label') ||
      (el.tagName === 'INPUT' ? el.value : '') ||
      text(el) ||
      el.getAttribute('title') ||
      '';
    if (label) actions.push(label);
  }

  const fields = [];
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'hidden' || type === 'submit' || type === 'button') continue;
    if (!isVisible(el)) continue;
    // What a person would call this field, in the order they would find it.
    let label = '';
    if (el.id) {
      const tag = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (tag) label = text(tag);
    }
    if (!label && el.closest('label')) label = text(el.closest('label'));
    if (!label) label = el.getAttribute('aria-label') || '';
    if (!label) label = el.getAttribute('placeholder') || '';
    if (!label) label = el.getAttribute('name') || '';
    if (!label) label = el.id || '';
    if (label) fields.push(label);
  }

  // A page that never declares its encoding is decoded by guesswork, and the
  // text really does come out as mojibake - on screen and therefore in here.
  // That is the app's bug, not this tool's, but it is worth saying once.
  const declared = !!document.querySelector('meta[charset], meta[http-equiv="Content-Type" i]');
  const guessedEncoding = !declared && String(document.characterSet || '').toUpperCase() !== 'UTF-8';

  return { headings: headings, actions: actions, fields: fields, guessedEncoding: guessedEncoding };
}

/** True only for an explicit opt-in. */
function signatureEnabled(env) {
  const source = env || process.env;
  return String(source.KRYPTHEON_DEBUG_SIGNATURE || '') === '1';
}

// How often the page is read while waiting for it to hold still.
const SETTLE_GAP = 200;
// How long it has to hold still before the reading is believed. Measured, not
// guessed: against a page that renders 1.5s after its request answers, 700ms
// still read the screen from before the click and 1200ms read the right one.
const SETTLE_QUIET = 1200;
// Never spend longer than this on one signature, however restless the page.
const SETTLE_BUDGET = 4000;
// A pending request is worth waiting out first, but not for the whole budget.
const NETWORK_BUDGET = 1500;

/** Two readings of the same page, exactly. */
function sameSignature(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

async function pause(page, ms) {
  try {
    await page.waitForTimeout(ms);
  } catch (e) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

async function readSignature(page, failedRequests) {
  const raw = await page.evaluate(readPage);
  const signature = buildSignature({
    headings: raw.headings,
    actions: raw.actions,
    fields: raw.fields,
    failedRequests: failedRequests,
  });
  // Not part of the signature itself - it describes the page's markup, not
  // what the page showed, and it must never count as a difference.
  Object.defineProperty(signature, 'guessedEncoding', {
    value: !!raw.guessedEncoding,
    enumerable: false,
  });
  return signature;
}

/**
 * Reads the page once it has stopped changing, and returns a signature - or
 * null if it could not be read at all. Never throws: this is a diagnostic and
 * must not become a second failure.
 *
 * Why it is not just networkidle. In a single-page app a click causes no
 * navigation: the request answers and the framework swaps the DOM a moment
 * later. Playwright's networkidle means "no requests for 500ms", which is a
 * fact about the network, not about the page - so a render that lands even
 * 300ms after the response is missed entirely and the reading describes the
 * screen the user was on *before* the click. That is exactly how a working
 * login came back as the login form.
 *
 * Why it is not a fixed sleep either: whatever number is picked is too short
 * for a slow machine and wasted on a fast one.
 *
 * So: wait out any pending request, then read the page repeatedly until it has
 * held still for a while. The quiet window matters more than the gap between
 * reads - two identical readings 200ms apart prove nothing on a page that is
 * simply waiting, which is why stability is measured from the last change seen
 * rather than from the first pair that happened to agree. A page that never
 * settles is capped, and whatever it looked like at the cap is used; running
 * out of patience is not a reason to fail somebody's test.
 */
function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The quiet window and the cap, either of which a slow app may need more of.
 *
 * No amount of waiting can predict a render that has not happened yet, so
 * these are a judgement about how long a page is given to prove it has
 * finished. An app that renders later than the window still reads early, and
 * raising this is the way out of that.
 */
function settleSettings(env) {
  const source = env || process.env;
  return {
    quiet: positiveNumber(source.KRYPTHEON_SIGNATURE_QUIET_MS, SETTLE_QUIET),
    budget: positiveNumber(source.KRYPTHEON_SIGNATURE_BUDGET_MS, SETTLE_BUDGET),
  };
}

async function collectSignature(page, failedRequests, options) {
  const opts = options || {};
  const fromEnv = settleSettings(opts.env);
  const gap = opts.settleGap == null ? SETTLE_GAP : opts.settleGap;
  const quiet = opts.settleQuiet == null ? fromEnv.quiet : opts.settleQuiet;
  const budget = opts.settleBudget == null ? fromEnv.budget : opts.settleBudget;

  try {
    const started = Date.now();

    // An answer still in flight will change the page the moment it lands, so
    // it is worth waiting out before deciding the page has stopped moving.
    try {
      await page.waitForLoadState('networkidle', {
        timeout: Math.min(NETWORK_BUDGET, Math.max(0, budget - (Date.now() - started))),
      });
    } catch (e) {
      /* still talking, or the state is unavailable - the loop below copes */
    }

    let current = await readSignature(page, failedRequests);
    let lastChange = Date.now();

    for (;;) {
      const now = Date.now();
      if (now - lastChange >= quiet) return current;
      if (now - started >= budget) return current;
      await pause(page, gap);
      const next = await readSignature(page, failedRequests);
      if (!sameSignature(current, next)) lastChange = Date.now();
      current = next;
    }
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Getting the signature out of the worker and onto the terminal.
//
// Nothing written from inside a Playwright worker reaches the terminal here.
// Playwright pipes the worker's real file descriptors and hands whatever comes
// out to reporter.onStdOut / onStdErr; kryptheon's reporter implements neither
// hook and the config runs no other reporter, so it is collected and dropped.
// Measured, not assumed: console.log, process.stdout.write, process.stderr.write
// and fs.writeSync to both fd 1 and fd 2 all vanish.
//
// So the worker hands the signature over through a file, and the CLI - whose
// stderr really is the terminal - prints it once the run is over. The reporter
// and its output format are untouched.
// ---------------------------------------------------------------------------

const SINK_ENV = 'KRYPTHEON_SIGNATURE_FILE';

/** Where the worker should leave signatures, or null if nobody asked for them. */
function sinkPath(env) {
  const source = env || process.env;
  const file = source[SINK_ENV];
  return file ? String(file) : null;
}

/** One JSON line per test. Append-only, so parallel workers cannot interleave. */
function recordSignature(label, signature, env) {
  const file = sinkPath(env);
  if (!file) return false;
  try {
    fs.appendFileSync(file, JSON.stringify({ test: label, signature: signature }) + '\n', 'utf8');
    return true;
  } catch (e) {
    return false; // a diagnostic must never become a second failure
  }
}

/** Reads what the workers left, newest run last. Missing file means nothing ran. */
function readRecorded(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      /* a torn line is not worth failing over */
    }
  }
  return out;
}

/**
 * Prints the signature. Step one does nothing else with it.
 *
 * Goes to stderr so the reporter's own output, which is stdout, stays exactly
 * as it was - a person or a script reading the report sees no difference.
 */
function printSignature(signature, label, out) {
  const write = out || ((line) => process.stderr.write(line + '\n'));
  if (!signature) {
    write('[kryptheon signature] ' + label + ': could not read the page');
    return;
  }
  write('[kryptheon signature] ' + label);
  write(JSON.stringify(signature, null, 2));
}

/** Prints everything the workers recorded, then clears the file. */
function drainSignatures(file, out) {
  const records = readRecorded(file);
  for (const record of records) {
    printSignature(record.signature, record.test, out);
  }
  try {
    fs.rmSync(file, { force: true });
  } catch (e) {
    /* leftover temp file is not worth failing over */
  }
  return records.length;
}

module.exports = {
  SINK_ENV: SINK_ENV,
  sinkPath: sinkPath,
  recordSignature: recordSignature,
  readRecorded: readRecorded,
  drainSignatures: drainSignatures,
  normaliseText: normaliseText,
  uniqueSorted: uniqueSorted,
  uniqueInOrder: uniqueInOrder,
  signaturePath: signaturePath,
  toSignatureRequests: toSignatureRequests,
  buildSignature: buildSignature,
  compareSignatures: compareSignatures,
  describeSignature: describeSignature,
  setDifference: setDifference,
  signatureEnabled: signatureEnabled,
  collectSignature: collectSignature,
  printSignature: printSignature,
  readPage: readPage,
  sameSignature: sameSignature,
  settleSettings: settleSettings,
  MAX_TEXT: MAX_TEXT,
  SETTLE_GAP: SETTLE_GAP,
  SETTLE_QUIET: SETTLE_QUIET,
  SETTLE_BUDGET: SETTLE_BUDGET,
  MAX_ACTIONS: MAX_ACTIONS,
};
