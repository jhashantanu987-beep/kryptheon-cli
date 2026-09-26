// Plain-language Playwright reporter for non-technical readers.
// Prints a short line per passing test and a readable block per failure,
// and appends one JSON line per run to kryptheon-history.jsonl.

const fs = require('fs');
const path = require('path');
const recordings = require('./kryptheon-recordings.js');
const heal = require('./kryptheon-heal.js');

// An assistant runs this after every change, so it needs a mode that says
// nothing at all when the news is good.
const QUIET = !!process.env.KRYPTHEON_QUIET;

// The history belongs to whoever is running the tests, so it lives in their
// folder - not inside the installed package.
const USER_DIR = process.cwd();
const HISTORY_FILE = path.join(USER_DIR, 'kryptheon-history.jsonl');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

function formatWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  let hours = d.getHours();
  const suffix = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' at ' + hours + ':' + minutes + ' ' + suffix;
}

// Playwright colours its error messages with ANSI escapes; strip them before
// any pattern matching or they break every match and force the raw fallback.
// Built via RegExp so the source carries no literal escape character.
const ANSI_PATTERN = new RegExp('\\u001b\\[[0-9;?]*[ -/]*[@-~]', 'g');

function stripAnsi(value) {
  return String(value == null ? '' : value).replace(ANSI_PATTERN, '');
}

function formatDuration(ms) {
  if (typeof ms !== 'number' || isNaN(ms)) return 'unknown';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

// ---------------------------------------------------------------------------
// Turning a Playwright locator string into something a human can read.
// ---------------------------------------------------------------------------

const ROLE_NOUNS = {
  button: 'button',
  textbox: 'text box',
  link: 'link',
  heading: 'heading',
  checkbox: 'checkbox',
  radio: 'radio button',
  combobox: 'dropdown',
  option: 'option',
  img: 'image',
  dialog: 'dialog',
  // What the recorder's "assert text" button picks when the text is in the
  // body of the page: "a check on the main" meant nothing to anyone.
  main: 'main part of the page',
  navigation: 'menu',
  banner: 'top of the page',
  contentinfo: 'footer',
  status: 'status message',
};

// Returns a lower-case noun phrase such as: the button "Request my demo".
// Sentence-initial uses go through capitalise() below.
function describeLocator(locator) {
  if (!locator) return null;
  const raw = String(locator).trim();
  let m;

  m = raw.match(/getByRole\(\s*['"]([^'"]+)['"]\s*,\s*\{[^}]*name:\s*['"]([^'"]*)['"]/);
  if (m) return 'the ' + (ROLE_NOUNS[m[1]] || m[1]) + ' "' + m[2] + '"';

  // With no name, or with options that are not a name - { level: 1 } is
  // what a check on a page's main heading gets.
  m = raw.match(/getByRole\(\s*['"]([^'"]+)['"]\s*(?:,\s*\{[^}]*\}\s*)?\)/);
  if (m) return 'the ' + (ROLE_NOUNS[m[1]] || m[1]);

  m = raw.match(/getByText\(\s*['"]([^'"]*)['"]/);
  if (m) return 'the text "' + m[1] + '"';

  m = raw.match(/getByLabel\(\s*['"]([^'"]*)['"]/);
  if (m) return 'the field labelled "' + m[1] + '"';

  m = raw.match(/getByPlaceholder\(\s*['"]([^'"]*)['"]/);
  if (m) return 'the field with placeholder "' + m[1] + '"';

  m = raw.match(/getByTestId\(\s*['"]([^'"]*)['"]/);
  if (m) return 'the element with test id "' + m[1] + '"';

  m = raw.match(/getByTitle\(\s*['"]([^'"]*)['"]/);
  if (m) return 'the element titled "' + m[1] + '"';

  // Fall back to a name: value anywhere in the selector before the raw text.
  m = raw.match(/name:\s*['"]([^'"]*)['"]/);
  if (m) return 'the element "' + m[1] + '"';

  return 'the element `' + raw + '`';
}

function capitalise(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

// Turns what Playwright printed - a regex literal like /\/dashboard\.html/ or a
// quoted absolute URL - into the readable path a person recognises.
function tidyUrl(raw) {
  let s = String(raw == null ? '' : raw).trim();
  s = s.replace(/^["']+|["']+$/g, '');

  const asRegex = s.match(/^\/(.*)\/[gimsuy]*$/);
  if (asRegex) s = asRegex[1].replace(/\\(.)/g, '$1');

  try {
    const u = new URL(s);
    return (u.pathname || '/') + (u.search || '');
  } catch (e) {
    return s;
  }
}

// Path and query only - never the host. Output gets shared and pasted around,
// and hostnames leak project identifiers.
function requestPath(requestUrl) {
  try {
    const u = new URL(requestUrl);
    return (u.pathname || '/') + (u.search || '');
  } catch (e) {
    // Not a parseable absolute URL: strip any scheme://host prefix by hand.
    const stripped = String(requestUrl).replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/, '');
    return stripped || '/';
  }
}

// True when the Playwright call log shows we were waiting for an element that
// never turned up - the signal that distinguishes "missing" from "slow".
function waitingForLocator(message) {
  return /^\s*-\s*waiting for\s+.+$/m.test(String(message));
}

function isTimeoutMessage(message) {
  return /Timeout\s+\d+ms exceeded|[Tt]imeout of \d+ms exceeded|TimeoutError/.test(String(message));
}

// Pull the locator out of an error message, whichever form it took.
function extractLocator(message) {
  let m = message.match(/^\s*Locator:\s*(.+)$/m);
  if (m) return m[1].trim();
  m = message.match(/^\s*-\s*waiting for (.+)$/m);
  if (m) return m[1].trim();
  return null;
}

// True when the technical line would only repeat the headline in other words.
// Keeping it then just makes the block longer without adding anything.
function addsNothing(technical, reason) {
  const strip = function (s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/^baseline changed:\s*/, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  };
  const a = strip(technical);
  const b = strip(reason);
  if (!a) return true;
  return a === b || b.indexOf(a) !== -1 || a.indexOf(b) !== -1;
}

function firstMeaningfulLine(message) {
  const line = String(message).split('\n').find(function (l) {
    return l.trim().length > 0;
  });
  return line ? line.replace(/^(TimeoutError|Error):\s*/, '').trim() : 'The test failed.';
}

// ---------------------------------------------------------------------------
// Errors that belong to no test.
//
// A spec file with a syntax error, or one importing something that is not
// there, never becomes a test at all - so nothing calls onTestEnd and the run
// ends with no results. Playwright reports it through onError. A reporter that
// does not implement onError prints a summary of nothing and exits 1, and the
// person is left with a silent failure and no idea which file is at fault.
// ---------------------------------------------------------------------------

// Playwright says this once the load errors have already been reported. On its
// own it means an empty tests folder; after a real error it is a consequence,
// not a cause, and repeating it just buries the thing that has to be fixed.
function isNoTestsFound(error) {
  return /No tests found/i.test(String((error && error.message) || ''));
}

/**
 * A load error, reduced to the file, the line and one sentence.
 *
 * The message carries a code frame in ANSI colour and repeats the absolute
 * path inside its own first line. Neither helps here: the path is printed
 * separately and relative, and the frame belongs in an editor.
 */
function readLoadError(error, userDir) {
  const raw = stripAnsi((error && error.message) || (error && error.value) || String(error || ""));
  const location = (error && error.location) || {};

  let file = location.file || null;
  if (file) {
    try {
      file = path.relative(userDir || process.cwd(), file);
    } catch (e) {
      /* an absolute path is still better than nothing */
    }
  }

  // First line only, with the absolute path taken back out of it.
  let message = raw.split("\n").map(function (l) { return l.trim(); }).filter(Boolean)[0] || "The file could not be read.";
  if (location.file) message = message.split(location.file + ": ").join("");
  message = message.replace(/\s*\(\d+:\d+\)\s*$/, "");

  return {
    file: file,
    line: typeof location.line === "number" ? location.line : null,
    message: message,
  };
}

/**
 * What to print when nothing could be loaded.
 *
 * Said as "this file", not "the tests failed", because nothing was tested. The
 * app may be perfectly fine; a file in the tests folder is not.
 */
function loadErrorLines(errors, userDir) {
  const real = (errors || []).filter(function (e) { return !isNoTestsFound(e); });
  const lines = [];

  if (!real.length) {
    // Nothing ran and nothing explained why. Saying so is still better than a
    // summary of zero, which reads as "everything is fine".
    lines.push("Nothing ran.");
    lines.push("");
    lines.push("No recording produced a result, and the test runner gave no reason.");
    lines.push("Check that the files in tests/ contain a test.");
    lines.push("");
    return lines;
  }

  const many = real.length > 1;
  lines.push(many ? real.length + " of your recordings could not be read:" : "One of your recordings could not be read:");
  lines.push("");
  for (const error of real) {
    const read = readLoadError(error, userDir);
    const where = read.file ? read.file + (read.line ? "  line " + read.line : "") : "(the file was not named)";
    lines.push("  " + where);
    lines.push("  " + read.message);
    lines.push("");
  }
  lines.push(many
    ? "Nothing else ran, because those files could not be loaded at all."
    : "Nothing else ran, because that file could not be loaded at all.");
  lines.push("Fix it and run this again.");
  lines.push("");
  return lines;
}

// ---------------------------------------------------------------------------
// Translation: Playwright error -> { reason, advice }
// ---------------------------------------------------------------------------

function translate(message) {
  const msg = String(message || '');
  const locatorRaw = extractLocator(msg);
  const subject = describeLocator(locatorRaw);
  let m;

  // A baseline mismatch raised by the fixture. The message is already written
  // for a person; lift it out and keep the Was/Now lines as detail.
  if (/Baseline changed:/.test(msg)) {
    const lines = msg.split('\n').map(function (l) {
      return l.trim();
    });
    const headIndex = lines.findIndex(function (l) {
      return l.indexOf('Baseline changed:') !== -1;
    });
    const head = lines[headIndex].replace(/^.*Baseline changed:\s*/, '');
    // An allowlist, so a stack trace that happens to follow the message can
    // never leak into the report. Address and title come from the original
    // baseline; the rest name what the page stopped or started showing.
    const details = lines.slice(headIndex + 1).filter(function (l) {
      return /^(Address|Title) (was|now):/.test(l) || /^(Headings|Buttons and links|Form fields) that are (gone|new):/.test(l) || /^Requests that failed this time:/.test(l);
    });
    return {
      reason: capitalise(head),
      details: details,
      // The throw happens inside the fixture, so a source location would just
      // point at plumbing the reader did not write.
      hideSource: true,
      // %TEST% is filled in with the test's name when the block is printed,
      // so the command resets only this one test.
      advice: 'if this change is intended, run:  npx kryptheon accept "%TEST%"',
    };
  }

  // Navigation failures, e.g. "page.goto: net::ERR_NAME_NOT_RESOLVED at <url>"
  m = msg.match(/(?:page\.goto|page\.reload|page\.goBack)[^\n]*?(net::[A-Z_]+)(?:\s+at\s+(\S+))?/);
  if (m) {
    const url = m[2] ? ' (' + m[2] + ')' : '';
    const kind = m[1];
    let why = 'the address could not be reached';
    if (kind === 'net::ERR_NAME_NOT_RESOLVED') why = 'that web address could not be found';
    else if (kind === 'net::ERR_CONNECTION_REFUSED') why = 'the server refused the connection';
    else if (kind === 'net::ERR_INTERNET_DISCONNECTED') why = 'there was no internet connection';
    else if (kind === 'net::ERR_CONNECTION_TIMED_OUT') why = 'the server did not respond in time';
    return {
      reason: 'The page could not be opened' + url + ' - ' + why + '.',
      advice: 'check the site is online, that the address in the test is correct, and that you are connected to the internet.',
    };
  }
  if (/page\.goto[\s\S]*Timeout \d+ms exceeded/.test(msg)) {
    return {
      reason: 'The page took too long to load and the test gave up waiting.',
      advice: 'the site may be slow or down; try opening it in a browser yourself.',
    };
  }

  // expect(...).not.toBeVisible() - the element was still there. This must be
  // checked before the call-log rules below, because its call log also carries
  // a "waiting for" line even though the element was found.
  if (/expect\([^)]*\)\.not\.toBeVisible\(\)\s*failed/.test(msg)) {
    return {
      reason: capitalise(subject || 'the element') + ' was still on the page, but the test expected it to be gone by now.',
      advice: 'the page may not have moved on to the next step - for example a form that did not submit.',
    };
  }

  // expect(...).toBeVisible() - either absent entirely, or present but hidden.
  if (/expect\([^)]*\)\.toBeVisible\(\)\s*failed/.test(msg)) {
    if (/element\(s\) not found/.test(msg)) {
      return {
        reason: 'Could not find ' + (subject || 'the element') + ' on the page.',
        advice: 'your last change may have renamed, hidden, or removed it.',
      };
    }
    return {
      reason: capitalise(subject || 'the element') + ' is on the page but never became visible.',
      advice: 'it may be hidden behind a popup, still loading, or scrolled out of view.',
    };
  }

  // A URL mismatch is not "the content changed" - the browser simply ended up
  // somewhere else. Say where it was expected and where it actually was.
  // Playwright labels these two ways: "Expected pattern:"/"Received string:"
  // for a regex, and "Expected:"/"Received:" for a plain string.
  if (/expect\([^)]*\)(?:\.not)?\.toHaveURL\(/.test(msg)) {
    const expectedRaw = (msg.match(/^\s*Expected(?: pattern)?:\s*(.+)$/m) || [])[1];
    const actualRaw = (msg.match(/^\s*Received(?: string)?:\s*(.+)$/m) || [])[1];
    const details = [];
    if (expectedRaw) details.push('Expected: ' + tidyUrl(expectedRaw));
    if (actualRaw) details.push('Actually on: ' + tidyUrl(actualRaw));
    return {
      reason: 'The page did not go where it was supposed to.',
      details: details,
      urlExpected: expectedRaw ? tidyUrl(expectedRaw) : null,
      urlActual: actualRaw ? tidyUrl(actualRaw) : null,
      advice: 'the step before this may not have worked - for example a sign-in that was rejected, or a redirect elsewhere.',
    };
  }

  // What the recorder's snapshot button writes. Its diff is a page of YAML,
  // which says nothing to someone who has never seen one.
  if (/expect\([^)]*\)(?:\.not)?\.toMatchAriaSnapshot\(/.test(msg)) {
    return {
      reason: capitalise(subject || 'part of the page') + ' is laid out differently than when this check was recorded.',
      advice: 'something in it was added, removed or renamed - the screenshot shows how it looks now.',
    };
  }

  // Value comparisons: toHaveTitle / toHaveText / toHaveValue / toHaveCount.
  m = msg.match(/expect\([^)]*\)(\.not)?\.(toHave\w+|toContainText)\([^)]*\)\s*failed/);
  if (m) {
    // Playwright names the lines after what it compared: "Expected substring"
    // for toContainText, "Expected string" for toHaveText and toHaveValue,
    // "Expected pattern" for a regex. Reading only "Expected:" missed every
    // check the recorder's own buttons write.
    const expected = (msg.match(/^\s*Expected(?: substring| string| pattern)?:\s*(.+)$/m) || [])[1];
    const received = (msg.match(/^\s*Received(?: string)?:\s*(.+)$/m) || [])[1];
    const negated = Boolean(m[1]);
    const matcher = m[2];
    const what =
      matcher === 'toHaveTitle' ? 'the page title'
      : matcher === 'toHaveURL' ? 'the page address'
      : matcher === 'toHaveCount' ? 'the number of matching items'
      : subject ? subject.charAt(0).toLowerCase() + subject.slice(1)
      : 'the element';
    // A whole page of text is not an answer anyone can read. Say what was
    // looked for, and show what was there only when it is short enough to be
    // the thing someone meant.
    const shown = received && received.trim().length <= 82 ? received.trim() : null;
    if (expected && matcher === 'toContainText') {
      return {
        reason: negated
          ? 'The test expected ' + what + ' not to say ' + expected.trim() + ', but it does.'
          : 'The test expected ' + what + ' to say ' + expected.trim() + ', but ' +
            (shown ? 'it says ' + shown + '.' : 'that text is not there.'),
        advice: 'the wording on the page may have changed, or the step before it did not do what it should.',
      };
    }
    if (expected && received) {
      return {
        reason: negated
          ? 'The test expected ' + what + ' not to be ' + expected.trim() + ', but it is.'
          : 'The test expected ' + what + ' to be ' + expected.trim() + ', but found ' + (shown || 'something else') + '.',
        advice: 'the wording on the page may have changed, or the page shown was not the one expected.',
      };
    }
    return {
      reason: 'A check on ' + what + ' did not match what the test expected.',
      advice: 'the content on the page may have changed since this test was written.',
    };
  }

  // Timeouts. A timeout on its own says nothing about the cause: the deciding
  // signal is whether the call log shows we were still waiting for an element.
  // If it does, the element was never there - that is a missing element, not a
  // slow site. Only a timeout with no such line is genuine slowness.
  if (isTimeoutMessage(msg)) {
    if (waitingForLocator(msg)) {
      return {
        reason: 'Could not find ' + (subject || 'the element') + ' on the page.',
        advice: 'your last change may have renamed, hidden, or removed it.',
      };
    }

    m = msg.match(/(?:[Tt]imeout of (\d+)ms exceeded|Timeout (\d+)ms exceeded)/);
    const ms = m ? Number(m[1] || m[2]) : null;
    const howLong = ms ? ' after ' + Math.max(1, Math.round(ms / 1000)) + ' seconds' : '';
    return {
      reason: 'The test ran out of time' + howLong + ' and was stopped.',
      advice: 'the site may be slower than usual, or the test is waiting for something that never happens.',
    };
  }

  // Anything not recognised: fall back to Playwright's own wording.
  return { reason: firstMeaningfulLine(msg), advice: null, raw: true };
}

// ---------------------------------------------------------------------------
// "Where to look" - only things actually observed in the browser during the
// test. Never a source file or line number, which would be a guess.
// ---------------------------------------------------------------------------

// Plain-language meaning of an HTTP status. The raw code always stays visible
// next to it; this only adds the explanation.
function describeStatus(status) {
  const code = Number(status);
  if (code === 400 || code === 401) {
    return 'the request was rejected - usually wrong credentials, a missing login session, or invalid data being sent';
  }
  if (code === 403) return 'the server refused permission for this action';
  if (code === 404) {
    return 'this address does not exist on the server - the route may have been renamed or removed';
  }
  if (code === 429) return 'too many requests too quickly - the server is rate limiting';
  if (code === 500 || code === 502 || code === 503) {
    return 'the server crashed or is unavailable - the error is in backend code, not the page';
  }
  if (code >= 500) return 'the server could not complete the request';
  if (code >= 400) return 'the server rejected the request';
  return null;
}

// How long ago the test last passed, in words.
function timeAgo(iso, now) {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return null;
  const minutes = Math.round(((now || Date.now()) - then) / 60000);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return minutes + ' minutes ago';
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return hours + ' hours ago';
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : days + ' days ago';
}

function wrapText(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line.length) line = word;
    else if ((line + ' ' + word).length <= width) line += ' ' + word;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// The prompt uses the same host-free formatting as "Where to look".

function readObservations(attachments) {
  const found = (attachments || []).find(function (a) {
    return a.name === 'kryptheon-observations' && a.body;
  });
  if (!found) return null;
  try {
    return JSON.parse(found.body.toString('utf8'));
  } catch (e) {
    return null;
  }
}

// Renamed buttons and fields the replay followed (kryptheon-heal.js), each
// already one sentence. Empty when there were none or the note is unreadable.
function readRenamed(attachments) {
  const found = (attachments || []).find(function (a) {
    return a.name === 'kryptheon-renamed' && a.body;
  });
  if (!found) return [];
  try {
    const list = JSON.parse(found.body.toString('utf8'));
    return Array.isArray(list) ? list.filter(function (e) { return e && e.was && e.now; }) : [];
  } catch (e) {
    return [];
  }
}

function uniq(list) {
  const seen = Object.create(null);
  const out = [];
  for (const item of list || []) {
    const key = typeof item === 'string' ? item : JSON.stringify(item);
    if (!seen[key]) {
      seen[key] = true;
      out.push(item);
    }
  }
  return out;
}

function whereToLookLines(obs) {
  if (!obs) return [];
  const lines = [];

  if (obs.url) lines.push('     - Browser was on: ' + obs.url);
  // Where the flow actually got to, in words. The whole signature stays behind
  // KRYPTHEON_DEBUG_SIGNATURE for when that much detail is wanted.
  if (obs.pageShowed) lines.push('     - Page showed: ' + obs.pageShowed);

  for (const req of uniq(obs.failedRequests).slice(0, 5)) {
    const meaning = describeStatus(req.status);
    lines.push(
      '     - ' + (req.method || 'GET') + ' ' + requestPath(req.url) + ' returned ' + req.status +
        (meaning ? '\n       ' + meaning : '')
    );
  }

  for (const err of uniq(obs.consoleErrors).slice(0, 5)) {
    const text = String(err).replace(/\s+/g, ' ').trim();
    lines.push('     - Console error: ' + (text.length > 160 ? text.slice(0, 157) + '...' : text));
  }

  // Nothing observed at all - the section is omitted entirely.
  if (!lines.length) return [];
  return ['   Where to look:'].concat(lines);
}

// ---------------------------------------------------------------------------
// A prompt the user can paste into their AI coding tool. Built strictly from
// what this run observed: no causes, no theories, no file paths.
// ---------------------------------------------------------------------------

// Reasons arrive in mixed shapes (some end in a full stop, the raw fallback
// may not even start capitalised), so normalise each into a real sentence.
function asSentence(text) {
  let s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[.!?]$/.test(s)) s += '.';
  return s;
}

function buildPromptLines(testTitle, translated, obs, lastPassIso, now) {
  const sentences = [];
  sentences.push('My "' + testTitle + '" flow broke.');

  // What failed.
  if (translated.urlActual && translated.urlExpected) {
    sentences.push(
      'The page stayed on ' + translated.urlActual + ' instead of reaching ' + translated.urlExpected + '.'
    );
  } else {
    sentences.push(translated.reason);
    if (obs && obs.url) sentences.push('The browser was on ' + obs.url + '.');
  }

  // What the browser saw.
  if (obs) {
    for (const req of uniq(obs.failedRequests).slice(0, 3)) {
      sentences.push(
        'The request ' + (req.method || 'GET') + ' ' + requestPath(req.url) + ' returned ' + req.status + '.'
      );
    }
    for (const err of uniq(obs.consoleErrors).slice(0, 2)) {
      const text = String(err).replace(/\s+/g, ' ').trim();
      sentences.push('The browser console reported: "' + (text.length > 140 ? text.slice(0, 137) + '...' : text) + '".');
    }
  }

  // When it last worked.
  const ago = lastPassIso ? timeAgo(lastPassIso, now) : null;
  if (ago) sentences.push('This was working ' + ago + '.');

  sentences.push('Fix only this.');

  const body = wrapText(sentences.map(asSentence).filter(Boolean).join(' '), 72);
  return ['   Paste this into your AI tool:', '   ' + '─'.repeat(29)].concat(
    body.map(function (l) {
      return '   ' + l;
    })
  );
}

// ---------------------------------------------------------------------------
// The first run is a special case: nothing has regressed, because nothing has
// ever passed. Usually the recording itself contains a step that only worked
// the once.
// ---------------------------------------------------------------------------

// Playwright works the error's file out of a stack trace, and its parser
// stops at the first "(" - so a folder called "New folder (2)" arrives as
// "2)\tests\thing.spec.js". The path declared for the test itself is read from
// the file system and is always whole, so prefer that whenever the stack's
// version does not point at a real file.
function trustworthySpecPath(test, errorFile) {
  const declared = (test && test.location && test.location.file) || null;
  if (errorFile && path.isAbsolute(errorFile)) {
    try {
      if (fs.existsSync(errorFile)) return errorFile;
    } catch (err) {
      /* fall through to the declared path */
    }
  }
  if (declared) {
    try {
      if (fs.existsSync(declared)) return declared;
    } catch (err) {
      /* fall through */
    }
  }
  return errorFile || declared || null;
}

// Identity of the recording itself, so history cannot be inherited by a
// different recording that happens to share a name.
function recordingIdFor(specPath) {
  if (!specPath) return null;
  let source;
  try {
    source = fs.readFileSync(specPath, 'utf8');
  } catch (err) {
    return null;
  }
  try {
    return require('./kryptheon-replay.js').recordingId(source);
  } catch (err) {
    return null;
  }
}

function firstRunAdvice(test) {
  const lines = [];
  lines.push('   This is the first run of this recording, so nothing has broken yet -');
  lines.push('   a step that cannot happen twice is the more likely explanation.');

  const file = test && test.location && test.location.file;
  if (!file) return { lines: lines, namedAStep: false };

  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { lines: lines, namedAStep: false };
  }

  let risks = [];
  try {
    risks = require('./kryptheon-replay.js').findReplayRisks(source);
  } catch (err) {
    return { lines: lines, namedAStep: false };
  }
  if (!risks.length) return { lines: lines, namedAStep: false };

  lines.push('   Most likely the step that cannot repeat:');
  for (const risk of risks.slice(0, 3)) {
    lines.push('     - "' + risk.step + '" (line ' + risk.line + ') - ' + risk.why + '.');
  }
  lines.push('   Record again without it, and this should settle down.');
  return { lines: lines, namedAStep: true };
}

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

class KryptheonReporter {
  constructor() {
    this.previousRuns = [];
    this.records = [];
    this.startedAt = new Date();
    // Errors that belong to no test: a spec file that would not load.
    this.loadErrors = [];
    // Set by any test whose page never said what encoding it was in.
    this.sawGuessedEncoding = false;
  }

  // Playwright calls this for anything that happened outside a test: a spec
  // file that would not load, most often. Kept rather than printed here, so
  // the reason lands beside the summary instead of ahead of the run.
  onError(error) {
    this.loadErrors.push(error);
  }

  onBegin() {
    this.startedAt = new Date();
    // Read history before this run is appended, so "was working on" looks
    // only at genuinely earlier runs.
    this.previousRuns = this._readHistory();
    if (!QUIET) {
      process.stdout.write('\nKryptheon test run - ' + formatWhen(this.startedAt.toISOString()) + '\n\n');
    }
  }

  _readHistory() {
    try {
      if (!fs.existsSync(HISTORY_FILE)) return [];
      return fs
        .readFileSync(HISTORY_FILE, 'utf8')
        .split('\n')
        .filter(function (l) {
          return l.trim().length > 0;
        })
        .map(function (line) {
          try {
            return JSON.parse(line);
          } catch (e) {
            return null; // skip malformed lines rather than crashing the run
          }
        })
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  // Most recent earlier run in which THIS recording passed. The name alone is
  // not enough: deleting a recording and making a new one that happens to end
  // up with the same name would otherwise inherit the old one's history, and
  // a brand new recording would be told it "was working" yesterday.
  _lastPassed(title, recordingId) {
    for (let i = this.previousRuns.length - 1; i >= 0; i--) {
      const run = this.previousRuns[i];
      const tests = (run && run.tests) || [];
      for (let j = tests.length - 1; j >= 0; j--) {
        const entry = tests[j];
        if (!entry || entry.title !== title || entry.status !== 'passed') continue;
        // Entries written before recordings were fingerprinted cannot be
        // matched to one, so they are not claimed by any.
        if (!entry.recordingId || !recordingId) continue;
        if (entry.recordingId !== recordingId) continue;
        return entry.timestamp || run.runAt;
      }
    }
    return null;
  }

  onTestEnd(test, result) {
    if ((result.attachments || []).some(function (a) { return a.name === 'kryptheon-encoding'; })) {
      this.sawGuessedEncoding = true;
    }
    const status =
      result.status === 'passed' ? 'passed' : result.status === 'skipped' ? 'skipped' : 'failed';
    const timestamp = (result.startTime instanceof Date ? result.startTime : new Date()).toISOString();

    const specPath = trustworthySpecPath(test, null);
    const recordingId = recordingIdFor(specPath);

    const record = {
      title: test.title,
      status: status,
      durationMs: result.duration,
      timestamp: timestamp,
      recordingId: recordingId,
      specFile: specPath ? path.relative(USER_DIR, specPath) : null,
    };

    if (status === 'skipped') {
      this.records.push(record);
      process.stdout.write('--  ' + test.title + ' (skipped)\n');
      return;
    }

    const renamed = readRenamed(result.attachments);
    if (renamed.length) record.renamed = renamed;
    const renamedLines = renamed.map(function (entry) {
      return '    Renamed: ' + heal.describeRename(entry);
    });

    if (status === 'passed') {
      this.records.push(record);
      if (!QUIET) {
        process.stdout.write('OK  ' + test.title + '  (' + formatDuration(result.duration) + ')\n');
      }
      // Said even when quiet: a pass that followed a rename is still a pass,
      // but the person should hear that their button has a new name.
      if (renamedLines.length) {
        if (QUIET) process.stdout.write('OK  ' + test.title + '\n');
        process.stdout.write(renamedLines.join('\n') + '\n');
        process.stdout.write('    Nothing is broken. To stop seeing this, record the flow again.\n');
      }
      return;
    }

    // On a test-level timeout Playwright reports two errors: a bare
    // "Test timeout of Nms exceeded." with no call log, and a second one
    // carrying the call log that says what we were waiting for. Reading only
    // the first throws away the diagnosis, so combine them and prefer the
    // error that actually carries detail.
    const rawErrors = (result.errors && result.errors.length ? result.errors : [result.error]).filter(Boolean);
    const errors = rawErrors.map(function (e) {
      return {
        message: stripAnsi(e.message || e.value || ''),
        location: e.location,
      };
    });
    const detailed = errors.filter(function (e) {
      return /Call log:|Locator:/.test(e.message);
    });
    const primary = detailed[0] || errors[0] || { message: 'The test failed.' };
    const message = errors
      .map(function (e) {
        return e.message;
      })
      .filter(Boolean)
      .join('\n\n') || 'The test failed.';

    const shot = (result.attachments || []).find(function (a) {
      return a.name === 'screenshot' && a.path;
    });
    const observations = readObservations(result.attachments);
    const located = primary.location || (errors.find(function (e) { return e.location; }) || {}).location;
    const line = located ? located.line : null;
    const file = trustworthySpecPath(test, located ? located.file : null);
    const locator = extractLocator(message);
    const translated = translate(message);

    record.failure = {
      line: line,
      file: file ? path.relative(USER_DIR, file) : null,
      locator: locator,
      assertion: (function () {
        const m = message.match(/expect\([^)]*\)(\.not)?\.(\w+)\(/);
        if (!m) return null;
        return (m[1] ? 'not.' : '') + m[2];
      })(),
      screenshot: shot ? shot.path : null,
      plainLanguage: translated.reason,
      rawMessage: message,
      observations: observations,
    };
    // Whether this ever worked decides more than one line of the report, so it
    // is settled before the record is kept. A recording that has never passed
    // is not a regression - there is nothing for it to have regressed from -
    // and the summary counts it apart from the ones that broke.
    const lastPass = this._lastPassed(test.title, recordingId);
    record.neverPassed = !lastPass;
    this.records.push(record);

    const out = [];
    out.push('');
    out.push('X  ' + test.title);
    out.push('   ' + translated.reason);

    // A difference against a baseline only means something if there is a
    // baseline of this recording's own to differ from. Saying "this has not
    // passed before" and then listing headings that are gone says two things
    // that cannot both be true, and the reader spends their time trying to
    // reconcile them instead of reading the actual failure.
    const aboutBaseline = /Baseline changed|ended up somewhere different/.test(translated.reason || '');
    const details = lastPass || !aboutBaseline ? translated.details || [] : [];
    for (const detail of details) out.push('   ' + detail);

    out.push(lastPass ? '   This was working on ' + formatWhen(lastPass) + '.' : '   This has not passed before.');
    // On the way to the failure. It explains why the steps before it worked
    // even though a name in the recording no longer matches.
    for (const entry of renamed) out.push('   Renamed on the way: ' + heal.describeRename(entry));

    // A first run that fails is a different situation from a regression:
    // nothing has broken, because nothing ever worked. Far more often the
    // recording contains a step that cannot happen twice.
    let blamedTheRecording = false;
    if (!lastPass) {
      const advice = firstRunAdvice(test);
      for (const line of advice.lines) out.push(line);
      blamedTheRecording = advice.namedAStep;
    }

    // On a first run we have already named the step that cannot repeat, and
    // the usual "your last change may have..." advice would contradict it.
    if (blamedTheRecording) {
      /* the first-run block above already says what to do */
    } else if (translated.advice) {
      out.push('   What to check: ' + translated.advice.split('%TEST%').join(test.title));
    } else {
      out.push('   What to check: this is the raw message from the test tool - it was not recognised.');
    }

    for (const observed of whereToLookLines(observations)) out.push(observed);

    if (shot) out.push('   Screenshot: ' + shot.path);
    if (file && line && !translated.hideSource) {
      out.push('   Source: ' + path.relative(USER_DIR, file) + ' line ' + line);
    }
    const technical = firstMeaningfulLine(primary.message);
    if (!translated.raw && !addsNothing(technical, translated.reason)) {
      out.push('   Technical detail: ' + technical);
    }

    out.push('');
    for (const promptLine of buildPromptLines(test.title, translated, observations, lastPass)) {
      out.push(promptLine);
    }
    out.push('');

    process.stdout.write(out.join('\n') + '\n');
  }

  onEnd(result) {
    const passed = this.records.filter(function (r) {
      return r.status === 'passed';
    }).length;
    const failed = this.records.filter(function (r) {
      return r.status === 'failed';
    }).length;

    const entry = {
      runAt: this.startedAt.toISOString(),
      status: result && result.status ? result.status : 'unknown',
      durationMs: Date.now() - this.startedAt.getTime(),
      passed: passed,
      failed: failed,
      tests: this.records,
    };

    // Append only - existing lines are never rewritten.
    try {
      fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      process.stdout.write('\n(could not write ' + path.basename(HISTORY_FILE) + ': ' + err.message + ')\n');
    }

    // "Broken" is kept for recordings that used to work. The ones that never
    // did are counted and explained separately, because reading "4 broken" on
    // the first day - when all four were made while learning the tool and none
    // has ever had a baseline - says the app is at fault when nothing is.
    const counts = recordings.summarise(this.records);

    // A file that would not load is said first, and always - before the quiet
    // shortcut, and whatever else the run managed to do.
    //
    // In practice a file that will not load stops the whole run, so nothing
    // else has anything to report and the block below returns. This is not
    // written as though that were guaranteed: onError also carries errors that
    // arrive outside any test, and one of those turning up after results would
    // otherwise be dropped in silence - which is the bug this whole thing is
    // here to fix.
    const unreadable = this.loadErrors.some(function (e) { return !isNoTestsFound(e); });
    if (unreadable) {
      process.stdout.write(
        String.fromCharCode(10) + loadErrorLines(this.loadErrors, USER_DIR).join(String.fromCharCode(10)),
      );
    }

    // Nothing ran at all. A summary of zero reads as good news, and in quiet
    // mode it would say "0 recordings still working" over the top of a file
    // that does not compile, so neither is printed. If the reason has not
    // already been given above, it is given now.
    if (!this.records.length) {
      if (!unreadable) {
        process.stdout.write(
          String.fromCharCode(10) + loadErrorLines(this.loadErrors, USER_DIR).join(String.fromCharCode(10)),
        );
      }
      return;
    }

    if (QUIET && !counts.broken && !counts.unproven) {
      const s = counts.working === 1 ? '' : 's';
      process.stdout.write('OK  ' + counts.working + ' recording' + s + ' still working.\n');
      return;
    }

    process.stdout.write(
      '\n' + recordings.summaryLines(counts).join('\n') + '\n' +
      'History saved to ' + path.basename(HISTORY_FILE) + '\n\n'
    );

    // Once per run, not once per test: it is one fact about the app, and
    // repeating it under every recording would bury the reports themselves.
    if (this.sawGuessedEncoding) {
      process.stdout.write(
        'Note: this page does not declare a character encoding, so text may look\n' +
        'garbled here and in the browser. Add <meta charset="utf-8"> to the page.\n\n'
      );
    }
  }
}

module.exports = KryptheonReporter;

// Shared with the fixture so baselines strip hosts exactly the same way.
// Attached to the exported class, so `new (require(...))()` keeps working.
module.exports.requestPath = requestPath;

// Exported for the checks: what a file that would not load turns into.
module.exports.readLoadError = readLoadError;
module.exports.loadErrorLines = loadErrorLines;
