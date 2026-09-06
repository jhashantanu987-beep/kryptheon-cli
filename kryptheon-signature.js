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
 * One line, no digits, capped.
 *
 * The digits are the important part. "Savings rate 0%" and "Savings rate 12%"
 * are the same page as far as this is concerned, and a signature that treated
 * them as different would report a regression every time a number moved.
 */
function normaliseText(value) {
  const line = String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\d+/g, '#');
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

  return { headings: headings, actions: actions, fields: fields };
}

/** True only for an explicit opt-in. */
function signatureEnabled(env) {
  const source = env || process.env;
  return String(source.KRYPTHEON_DEBUG_SIGNATURE || '') === '1';
}

/**
 * Lets the page finish whatever it was doing before it is read.
 *
 * A flow that just submitted a form is often still mid-request when the last
 * assertion returns, and reading then describes the page on its way somewhere
 * rather than where it landed. Network idle is the right signal; the short
 * wait is the fallback for a page that keeps a socket open forever.
 */
async function settle(page, timeout) {
  const budget = timeout == null ? 2000 : timeout;
  try {
    await page.waitForLoadState('networkidle', { timeout: budget });
    return;
  } catch (e) {
    /* still busy, or no such state - fall through to the short wait */
  }
  try {
    await page.waitForTimeout(300);
  } catch (e) {
    /* page already closed */
  }
}

/**
 * Reads the page and returns a signature, or null if it could not be read.
 * Never throws: this is a diagnostic and must not become a second failure.
 */
async function collectSignature(page, failedRequests, options) {
  const opts = options || {};
  try {
    await settle(page, opts.settleTimeout);
    const raw = await page.evaluate(readPage);
    return buildSignature({
      headings: raw.headings,
      actions: raw.actions,
      fields: raw.fields,
      failedRequests: failedRequests,
    });
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
  signatureEnabled: signatureEnabled,
  collectSignature: collectSignature,
  printSignature: printSignature,
  readPage: readPage,
  MAX_TEXT: MAX_TEXT,
  MAX_ACTIONS: MAX_ACTIONS,
};
