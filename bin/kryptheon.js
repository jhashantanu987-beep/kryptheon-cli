#!/usr/bin/env node
// The kryptheon CLI. A thin wrapper so nobody has to remember Playwright's
// command line or edit a config file. Everything here shells out to the
// Playwright binary that ships with this package.
//
// Two roots matter, and they are not the same once this is installed:
//   PACKAGE_DIR - the tool's own files (fixture, reporter, config, this file)
//   USER_DIR    - the folder the command was run in, which owns tests/ and .env
//
// Everything Kryptheon remembers about USER_DIR - baselines, history, the last
// run's screenshots - is kept in its store under ~/.kryptheon, never in the
// project (kryptheon-store.js).

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const os = require('os');
const secrets = require(require('path').join(__dirname, '..', 'kryptheon-secrets.js'));
const replay = require('../kryptheon-replay.js');
const selectors = require('../kryptheon-selectors.js');
const recordings = require('../kryptheon-recordings.js');
const cleanup = require('../kryptheon-cleanup.js');
const baselines = require('../kryptheon-baselines.js');
const project = require('../kryptheon-project.js');
const store = require('../kryptheon-store.js');

// The first version that keeps its records in the store. An older copy in a
// project folder still looks for them inside the project.
const FIRST_STORE_VERSION = '0.1.20';

const PACKAGE_DIR = path.join(__dirname, '..');
const USER_DIR = process.cwd();
const CONFIG = path.join(PACKAGE_DIR, 'playwright.config.js');
const TESTS_DIR = path.join(USER_DIR, 'tests');

const MIN_NODE = [20, 6, 0];

// How long to wait for a browser window to appear before giving up.
//
// The budget is spent only on time we could actually see. A probe that does
// not answer tells us nothing about the browser, so it must not count against
// the person running the command - and the hard limit is there so that a probe
// which never answers still ends the wait rather than hanging forever.
//
// Measured on a warm machine, launch to a detectable window is about 2.5s, so
// 30s is generous; the number that used to matter more was how the waiting was
// counted, which was by ticks rather than by the clock.
const WINDOW_POLL_MS = 5000;
const WINDOW_TIMEOUT_MS = 30000;
const WINDOW_HARD_LIMIT_MS = 90000;
// This was 4 seconds, kept under the poll interval so a probe never held the
// loop past the next one. Measured since, on a Windows 11 machine: the probe
// takes 2.5-3 seconds with nothing else running, and while the browser was
// starting it ran past 4 seconds three times in a row. On a slower machine
// every probe ran out of time and nothing was ever learned. A probe that
// answers late is worth more than one that never answers; the budget is
// counted by the clock, so a slow tick costs nothing extra.
const WINDOW_PROBE_TIMEOUT_MS = 10000;

function nodeIsTooOld(version) {
  const parts = String(version || process.versions.node).split('.').map(Number);
  for (let i = 0; i < MIN_NODE.length; i++) {
    if ((parts[i] || 0) > MIN_NODE[i]) return false;
    if ((parts[i] || 0) < MIN_NODE[i]) return true;
  }
  return false;
}

// Read from the package rather than repeated here, so it cannot go stale.
// Someone filing a bug report has to be able to say which version they have.
function packageVersion() {
  try {
    return require(path.join(PACKAGE_DIR, 'package.json')).version || 'unknown';
  } catch (err) {
    return 'unknown';
  }
}

function usage() {
  console.log('');
  console.log('  kryptheon - record and check your app');
  console.log('');
  console.log('  npx kryptheon record <url>   open your app and record what you do as a test');
  console.log('  npx kryptheon check          run every recorded test and report in plain language');
  console.log('  npx kryptheon accept <name>  agree that one test\'s new result is the correct one');
  console.log('  npx kryptheon remove [name]  list the recordings, or remove one you no longer want');
  console.log('  npx kryptheon setup-ai       tell your AI assistant to check its work');
  console.log('  npx kryptheon code           read your frontend code for text inserted as HTML');
  console.log('');
  console.log('  add --quiet to check for one line when everything passes');
  console.log('  npx kryptheon --version      print the version you have installed');
  console.log('');
}

// Resolve Playwright's own CLI and run it on this Node binary, rather than
// relying on a `playwright` executable being on PATH.
// The package's "exports" map exposes "./cli" (no .js), so that specifier is
// the one that resolves; the package.json route is the fallback.
function findPlaywrightCli() {
  try {
    return require.resolve('@playwright/test/cli', { paths: [PACKAGE_DIR] });
  } catch (err) {
    /* fall through */
  }
  try {
    const pkg = require.resolve('@playwright/test/package.json', { paths: [PACKAGE_DIR] });
    return path.join(path.dirname(pkg), 'cli.js');
  } catch (err) {
    return null;
  }
}

// Always runs with the user's folder as the working directory, so tests,
// baselines and .env are found where they actually live.
// Returns { status, stderr }. With quietErrors the child's stderr is captured
// rather than inherited, so a Node or Playwright stack trace never reaches the
// person running the command.
function runPlaywright(args, options) {
  const quiet = !!(options && options.quietErrors);
  const cli = findPlaywrightCli();
  if (!cli) {
    console.error('');
    console.error('  The testing engine is missing from this install.');
    console.error('  Reinstalling usually fixes it:  npm install -g kryptheon');
    console.error('');
    return { status: 1, stderr: '' };
  }

  const result = spawnSync(process.execPath, [cli].concat(args), {
    cwd: USER_DIR,
    stdio: quiet ? ['inherit', 'inherit', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });

  if (result.error) {
    console.error('');
    console.error('  Could not start the testing engine: ' + result.error.message);
    console.error('');
    return { status: 1, stderr: String(result.stderr || '') };
  }
  return {
    status: result.status === null ? 1 : result.status,
    stderr: String(result.stderr || ''),
  };
}

// Chromium is a separate download from the npm package, so the first run on a
// new machine has to fetch it.
function ensureBrowser() {
  let executable = null;
  try {
    executable = require('@playwright/test').chromium.executablePath();
  } catch (err) {
    return true; // cannot tell - let Playwright speak for itself
  }
  if (executable && fs.existsSync(executable)) return true;

  console.log('');
  console.log('  Downloading a browser to run your app in.');
  console.log('  This is about 200MB and only happens once.');
  console.log('');
  const status = runPlaywright(['install', 'chromium']).status;
  if (status !== 0) {
    console.error('');
    console.error('  The browser download did not finish.');
    console.error('  Check your internet connection and try again.');
    console.error('');
    return false;
  }
  return true;
}

function listSpecFiles() {
  if (!fs.existsSync(TESTS_DIR)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(TESTS_DIR, { recursive: true });
  } catch (err) {
    try {
      entries = fs.readdirSync(TESTS_DIR);
    } catch (err2) {
      return [];
    }
  }
  return entries
    .map(String)
    .filter((name) => /\.(spec|test)\.(c|m)?[jt]sx?$/.test(name));
}

// A plain GET on Node's own http/https, deliberately NOT fetch. fetch keeps
// its sockets alive in a pool, and those were still open at exit - handles
// being torn down while the process is ending is how libuv assertions happen
// on Windows. agent:false closes the socket as soon as we are done with it.
function httpGet(url, timeoutMs, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return reject(Object.assign(new Error('bad address'), { code: 'ERR_INVALID_URL' }));
    }
    const lib = parsed.protocol === 'https:' ? require('https') : require('http');
    const req = lib.get(url, { agent: false, timeout: timeoutMs || 8000 }, (res) => {
      const location = res.headers && res.headers.location;
      if (location && res.statusCode >= 300 && res.statusCode < 400 && (redirectsLeft || 0) > 0) {
        res.resume();
        req.destroy();
        return resolve(httpGet(new URL(location, url).toString(), timeoutMs, redirectsLeft - 1));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (body.length < 300000) body += chunk;
      });
      res.on('end', () => {
        req.destroy();
        resolve({ status: res.statusCode, body: body });
      });
    });
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
  });
}

// --- is the address actually there? ----------------------------------------

// "localhost:3000" is what people type; give it a scheme before using it.
function normaliseRecordUrl(url) {
  const s = String(url == null ? '' : url).trim();
  if (!s) return s;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return s;
  return 'http://' + s;
}

function isLocalAddress(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (err) {
    return false;
  }
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.local') ||
    host.endsWith('.localhost')
  );
}

// Turns a fetch failure into one of a few plain kinds. Split out from the
// network call so it can be checked without a network.
function classifyFetchError(err) {
  const code = (err && err.cause && err.cause.code) || (err && err.code) || null;
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'unknown-address';
  if (err && err.name === 'AbortError') return 'timeout';
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET') return 'timeout';
  // A certificate complaint means something IS answering there. Let the
  // browser deal with it rather than blocking the recording.
  if (code && /CERT|SSL|SELF_SIGNED|VERIFY/i.test(String(code))) return 'reachable';
  return 'other';
}

async function reachability(url, timeoutMs) {
  try {
    await httpGet(url, timeoutMs || 8000, 0);
    return { ok: true, kind: 'reachable' };
  } catch (err) {
    const kind = classifyFetchError(err);
    return kind === 'reachable' ? { ok: true, kind: kind } : { ok: false, kind: kind };
  }
}

// One place that explains an address not answering, used both before codegen
// starts and if codegen itself reports the same thing.
function explainUnreachable(url, kind) {
  const local = isLocalAddress(url);
  console.error('');
  console.error('  Nothing answered at ' + url);
  console.error('');

  if (kind === 'unknown-address') {
    console.error('  That web address could not be found.');
    console.error('  Check the spelling, and that you are connected to the internet.');
  } else if (kind === 'timeout') {
    console.error('  The address did not answer in time.');
    console.error('  It may be slow, or blocked by a firewall or VPN.');
  } else if (local) {
    console.error('  Your app does not look like it is running.');
    console.error('');
    console.error('  For an app on your own machine, start it first - usually:');
    console.error('    npm run dev');
    console.error('');
    console.error('  Then check the address and port match what it printed.');
  } else {
    console.error('  Nothing is listening at that address.');
    console.error('  Check the address, including the port number, and that the site is up.');
  }

  console.error('');
  console.error('  Nothing was recorded.');
  console.error('');
}

// Codegen writes Node/Playwright traces to stderr. We never show those; we
// pick out the part that means something and say it in plain words.
/**
 * The lines codegen wrote that look like a real complaint, shown verbatim.
 *
 * Playwright's stderr also carries banners and progress noise, so only lines
 * that read as an error are lifted out - a wall of unrelated output would be
 * worse than none. Nothing is invented here: if it said nothing, nothing is
 * printed and the usual explanation follows.
 */
function codegenComplaints(stderr, limit) {
  const seen = Object.create(null);
  const out = [];
  for (const raw of String(stderr || '').split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (!/(^|\b)(Error|error:|ERR_|EACCES|EPERM|ENOENT|Failed|failed to|Timeout|not found)/.test(line)) continue;
    if (seen[line]) continue;
    seen[line] = true;
    out.push(line.length > 160 ? line.slice(0, 157) + '...' : line);
    if (out.length >= (limit || 3)) break;
  }
  return out;
}

function reportCodegenSaid(stderr) {
  const said = codegenComplaints(stderr);
  if (!said.length) return false;
  console.error('');
  console.error('  The browser reported:');
  for (const line of said) console.error('    ' + line);
  return true;
}

function explainCodegenFailure(url, stderr) {
  const text = String(stderr || '');
  if (/ERR_CONNECTION_REFUSED/.test(text)) return explainUnreachable(url, 'refused');
  if (/ERR_NAME_NOT_RESOLVED/.test(text)) return explainUnreachable(url, 'unknown-address');
  if (/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/.test(text)) return explainUnreachable(url, 'timeout');
  if (/ERR_INTERNET_DISCONNECTED/.test(text)) {
    console.error('');
    console.error('  There is no internet connection.');
    console.error('');
    console.error('  Nothing was recorded.');
    console.error('');
    return;
  }
  console.error('');
  console.error('  The browser closed before anything could be recorded.');
  console.error('');
  console.error('  Check that ' + url + ' opens normally in your own browser,');
  console.error('  then try again.');
  console.error('');
  console.error('  Nothing was recorded.');
  console.error('');
}

// A recording is only worth keeping if the browser actually did something.
// An abandoned or failed run leaves a test body with no page calls at all.
function countRecordedActions(source) {
  const found = String(source || '').match(/\bpage\s*\.\s*[A-Za-z_$][\w$]*\s*\(/g);
  return found ? found.length : 0;
}

// A spec that pulls Playwright in directly gets none of our diagnostics.
function importsPlaywrightDirectly(source) {
  const text = String(source || '');
  // The literal specifier is what matters; import and require both carry it.
  return text.indexOf("'@playwright/test'") !== -1 || text.indexOf('"@playwright/test"') !== -1;
}

// codegen always writes the opening page.goto. A recording is only real if
// something else happened as well.
function isRealRecording(source) {
  return countRecordedActions(source) >= 2;
}

function timestampName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    'recorded-' +
    d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
    '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) +
    '.spec.js'
  );
}

// Codegen imports from '@playwright/test'. Point the new file at the shared
// fixture instead, so a recorded test gets the same failure diagnostics
// (failed requests, console errors) as every other spec. Imported by package
// name, because the user's tests folder is not next to the installed package.
function pointAtFixture(relativeFile) {
  const full = path.join(USER_DIR, relativeFile);
  let src;
  try {
    src = fs.readFileSync(full, 'utf8');
  } catch (err) {
    return false;
  }
  const updated = src
    .replace(/from (['"])@playwright\/test\1/, "from 'kryptheon/kryptheon-fixture'")
    .replace(/require\((['"])@playwright\/test\1\)/, "require('kryptheon/kryptheon-fixture')");
  if (updated === src) return false;
  try {
    fs.writeFileSync(full, updated, 'utf8');
    return true;
  } catch (err) {
    return false;
  }
}

// "about-us.html" -> "About Us";  "/" -> null
function humanisePath(pathname) {
  const last = String(pathname || '')
    .split('?')[0]
    .split('#')[0]
    .split('/')
    .filter(Boolean)
    .pop();
  if (!last) return null;
  const words = last
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_+]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  if (!words) return null;
  return words
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Titles are usually "Site | Page". The page half is the useful one, and a
// very long tail is prose rather than a name, so it is rejected.
function nameFromTitle(title) {
  const parts = String(title || '')
    .split(/[|–—•:]|\s-\s/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const tail = parts[parts.length - 1];
  if (tail && tail.split(' ').length <= 4) return tail;
  return null;
}

// Reads the title of a page over plain HTTP. Best effort: the name falls back
// to the recorded path if this cannot be reached.
async function fetchTitle(url) {
  try {
    const res = await httpGet(url, 5000, 2);
    if (!res || res.status < 200 || res.status >= 300) return null;
    const m = String(res.body).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? m[1].replace(/\s+/g, ' ').trim() : null;
  } catch (err) {
    return null;
  }
}

function lastGoto(source) {
  const gotos = [...String(source).matchAll(/page\.goto\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  return gotos.length ? gotos[gotos.length - 1] : null;
}

// Codegen calls every recording "test". Give it a name taken from what was
// actually recorded: the last page navigated to, else the last thing clicked.
function deriveTestName(source) {
  const gotos = [...String(source).matchAll(/page\.goto\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (let i = gotos.length - 1; i >= 0; i--) {
    let pathname = gotos[i];
    try {
      pathname = new URL(gotos[i]).pathname;
    } catch (e) {
      /* already a path */
    }
    const name = humanisePath(pathname);
    if (name) return name;
  }

  // The first thing done describes a recording better than the last, and the
  // last is often "Sign Out", which would name every recording after the way
  // it ended rather than what it was for.
  const names = [...String(source).matchAll(/name:\s*['"]([^'"]+)['"]/g)]
    .map((m) => m[1].trim())
    .filter((name) => name && !/(log|sign)[\s_-]?out/i.test(name));
  if (names.length) return names[0];

  const hosts = [...String(source).matchAll(/page\.goto\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  if (hosts.length) {
    try {
      const host = new URL(hosts[hosts.length - 1]).hostname.replace(/^www\./, '');
      const label = humanisePath('/' + host.split('.')[0]);
      if (label) return label;
    } catch (e) {
      /* fall through */
    }
  }
  return null;
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'recording';
}

// Renames the test inside the file, and the file to match. Only ever touches
// the file codegen just wrote.
async function nameRecording(relativeFile) {
  const full = path.join(USER_DIR, relativeFile);
  let src;
  try {
    src = fs.readFileSync(full, 'utf8');
  } catch (err) {
    return relativeFile;
  }
  // Only rename codegen's placeholder, never a name someone chose.
  if (!/\btest\(\s*(['"])test\1/.test(src)) return relativeFile;

  // The page title is the friendliest source; the recorded path is the
  // fallback when the site cannot be reached.
  const visited = lastGoto(src);
  const name = (visited ? nameFromTitle(await fetchTitle(visited)) : null) || deriveTestName(src);
  if (!name) return relativeFile;

  const safeName = name.replace(/'/g, "\\'");
  const updated = src.replace(/\btest\(\s*(['"])test\1/, "test('" + safeName + "'");

  let target = path.join('tests', slugify(name) + '.spec.js');
  let attempt = 1;
  while (fs.existsSync(path.join(USER_DIR, target)) && path.join(USER_DIR, target) !== full) {
    attempt += 1;
    target = path.join('tests', slugify(name) + '-' + attempt + '.spec.js');
  }

  try {
    fs.writeFileSync(full, updated, 'utf8');
    if (path.join(USER_DIR, target) !== full) {
      fs.renameSync(full, path.join(USER_DIR, target));
      return target;
    }
  } catch (err) {
    return relativeFile;
  }
  return target;
}
// Recording needs a real browser window on someone's screen. Inside an AI
// coding assistant there is no desktop to draw it on, so codegen would sit
// there forever and the run would be killed before anything was tidied up.
// There is deliberately no up-front refusal here.
//
// This used to check process.stdout.isTTY and refuse before launching. That
// was wrong: isTTY is falsy in plenty of perfectly good terminals depending on
// how the process was started, and a real user in Command Prompt was told to
// go and run the command in Command Prompt. Refusing on a guess is far worse
// than trying and waiting - so we always launch, and the watchdog below
// reports only when a window genuinely never appears.

// Only ever shown after actually trying: the browser was launched and no
// window arrived. It must never tell someone to go and run the command they
// have plainly just run.
function noWindowLines(seconds) {
  return [
    '',
    '  No browser window appeared.',
    '',
    '  The browser was started, but nothing showed up on screen within ' + seconds,
    '  seconds, so there was nowhere to record.',
    '',
    '  The usual reasons:',
    '    - there is no desktop to draw on - a remote or SSH session, a',
    '      container, or an AI coding assistant running the command for you',
    '    - security software stopped the browser from opening',
    '    - the machine is slow and the browser had not finished starting',
    '',
    '  If you are sitting at the screen, run the same command again - a slow',
    '  first start is the most common cause, and the second attempt usually',
    '  works.',
    '',
    '  If you are connected to a different machine, run it on the machine',
    '  that has the screen.',
    '',
    '  If the window really is open and this keeps happening, set',
    '  KRYPTHEON_FORCE_RECORD=1 to skip this check.',
    '',
    '  Nothing was recorded.',
    '',
  ];
}

function explainNoWindow() {
  for (const line of noWindowLines(Math.round(WINDOW_TIMEOUT_MS / 1000))) {
    console.error(line);
  }
}

// The browser is there and running; only the window could not be seen. Telling
// this person their browser never opened would be plainly wrong, so the way
// past the check comes first rather than buried at the bottom of a list.
function windowUndetectedLines(seconds) {
  return [
    '',
    '  The browser is running, but no window could be seen.',
    '',
    '  A browser process started and was still going after ' + seconds + ' seconds,',
    '  so this is most likely the check being wrong rather than the browser.',
    '',
    '  If the window is open in front of you, run it again with the check off:',
    '    KRYPTHEON_FORCE_RECORD=1 npx kryptheon record <url>',
    '',
    '  If there is no window on screen, the browser may have opened somewhere',
    '  with no desktop to draw on - a remote session, a container, or an AI',
    '  assistant running the command for you.',
    '',
    '  Nothing was recorded.',
    '',
  ];
}

/**
 * What to do with a browser whose window the watchdog could not confirm:
 * 'leave' it running, or 'stop' it.
 *
 * Found on the first run by somebody new, on Windows 10: the browser opened,
 * they used their app, and it closed under them - "almost the whole thing" -
 * with nothing recorded. The probe is a fresh PowerShell each time: measured on
 * a Windows 11 machine it takes 2.5-3 seconds idle, and ran past its 4 second
 * limit three times in a row while the browser was starting. On a slower
 * machine every probe runs out of time, the watchdog learns nothing for 90
 * seconds, calls that 'unclear' - and the browser somebody was using was
 * stopped on a guess.
 *
 * So the browser is only ever stopped on something known, and never when a
 * person is at the keyboard to close it themselves:
 *
 *   window                       leave - it is up
 *   unclear                      leave - nothing was learned, so nothing is done
 *   no-window / never-started    leave with a keyboard, stop without one
 *
 * The watchdog exists for the case with no keyboard: an AI assistant, where
 * there is no desktop and codegen would wait for ever. isTTY can be false in a
 * perfectly good terminal, so false is not taken as proof of anything - that
 * case keeps the old behaviour. True is taken as a person being there.
 */
function whenWindowUnconfirmed(verdict, atKeyboard) {
  if (verdict === 'window' || verdict === 'unclear') return 'leave';
  return atKeyboard ? 'leave' : 'stop';
}

// Said once, while the person may still be recording, instead of taking the
// browser away from them.
function windowUnconfirmedLines() {
  return [
    '',
    '  (I could not confirm the browser window from here - that check is slow',
    '  on some machines - so I am leaving it alone. If it is on your screen,',
    '  carry on and close it when you are done. If there is no window',
    '  anywhere, press Ctrl+C to stop.)',
    '',
  ];
}

// The probe kept failing to answer. Nothing was learned about the browser
// either way, and saying "no window appeared" would be inventing a fact.
function probeUnclearLines(answered, unanswered) {
  return [
    '',
    '  Could not tell whether a browser window opened.',
    '',
    '  The check that looks for the window did not answer ' + unanswered + ' of its',
    '  ' + (answered + unanswered) + ' attempts, so there is nothing to go on. This is usually a',
    '  machine under load, or security software holding up the check itself.',
    '',
    '  If the window is open in front of you, run it again with the check off:',
    '    KRYPTHEON_FORCE_RECORD=1 npx kryptheon record <url>',
    '',
    '  Otherwise just run the same command again.',
    '',
    '  Nothing was recorded.',
    '',
  ];
}

/**
 * Decides, tick by tick, whether to keep waiting for the browser window.
 *
 * Kept apart from the timer and the process so it can be driven directly: the
 * cases worth checking are a probe that answers slowly, one that never answers,
 * and a browser that runs without a window, none of which are reachable by
 * launching a real browser and hoping.
 *
 * Returns null to keep waiting, or a verdict:
 *   'window'        - a window is up, stop watching
 *   'no-window'     - the browser ran for the whole budget without one
 *   'never-started' - no browser process ever appeared
 *   'unclear'       - the probe mostly did not answer, so nothing is known
 */
function createWindowWatch(options) {
  const opts = options || {};
  const probe = opts.probe || inspectBrowserWindows;
  const clock = opts.now || Date.now;
  const budgetMs = opts.budgetMs == null ? WINDOW_TIMEOUT_MS : opts.budgetMs;
  const hardLimitMs = opts.hardLimitMs == null ? WINDOW_HARD_LIMIT_MS : opts.hardLimitMs;

  const started = clock();
  let lastTick = started;
  // Time we could actually see, in milliseconds. Counted from the clock rather
  // than by adding the poll interval per tick: a probe that takes four seconds
  // used to cost the budget three, so "thirty seconds" was never thirty.
  let spent = 0;
  let answered = 0;
  let unanswered = 0;
  let sawProcess = false;

  return {
    tick: function () {
      const now = clock();
      const elapsed = now - lastTick;
      lastTick = now;

      const seen = probe();
      if (seen && seen.known) {
        answered++;
        if (seen.windows > 0) return { verdict: 'window' };
        if (seen.processes > 0) sawProcess = true;
        spent += elapsed;
      } else {
        // Nothing was learned, so nothing is charged.
        unanswered++;
      }

      const outOfBudget = spent >= budgetMs;
      const outOfPatience = now - started >= hardLimitMs;
      if (!outOfBudget && !outOfPatience) return null;

      if (unanswered > answered) {
        return { verdict: 'unclear', answered: answered, unanswered: unanswered };
      }
      return {
        verdict: sawProcess ? 'no-window' : 'never-started',
        seconds: Math.round((now - started) / 1000),
      };
    },
    stats: function () {
      return { spent: spent, answered: answered, unanswered: unanswered, sawProcess: sawProcess };
    },
  };
}

// What can be seen of the browser right now.
//
//   known     - whether the question could be answered at all
//   processes - Playwright browser processes running
//   windows   - how many of those are actually showing a window
//
// The three are kept apart on purpose. The old version returned one boolean,
// so "there is no window" and "the probe did not answer" were the same value,
// and a slow machine could be told its browser had never opened. They are
// different facts and they deserve different answers.
//
// One command returns both counts: asking twice would double the cost of the
// most expensive thing in this loop.
/**
 * Turns the probe's two numbers into the shape the watchdog reads.
 *
 * Anything that is not two numbers means the answer did not arrive intact, and
 * an answer that did not arrive must never read as "nothing is running" - that
 * conflation is the whole bug this replaced.
 */
function parseWindowProbe(stdout) {
  const unknown = { known: false, processes: 0, windows: 0 };
  const parts = String(stdout == null ? '' : stdout).trim().split(/\s+/);
  if (parts.length < 2) return unknown;
  const processes = Number(parts[0]);
  const windows = Number(parts[1]);
  if (!Number.isFinite(processes) || !Number.isFinite(windows)) return unknown;
  if (processes < 0 || windows < 0 || windows > processes) return unknown;
  return { known: true, processes: processes, windows: windows };
}

function inspectBrowserWindows() {
  const unknown = { known: false, processes: 0, windows: 0 };
  try {
    if (process.platform === 'win32') {
      const probe = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          "$p = @(Get-Process chrome,msedge -ErrorAction SilentlyContinue | " +
            "Where-Object { $_.Path -like '*ms-playwright*' }); " +
            "$w = @($p | Where-Object { $_.MainWindowHandle -ne 0 }); " +
            'Write-Output ("{0} {1}" -f $p.Count, $w.Count)',
        ],
        { encoding: 'utf8', windowsHide: true, timeout: WINDOW_PROBE_TIMEOUT_MS }
      );
      // A timeout, a missing shell, or a non-zero exit all mean the same thing:
      // nothing was learned. Only a well formed answer counts as knowing.
      if (probe.error || probe.status !== 0) return unknown;
      return parseWindowProbe(probe.stdout);
    }

    const probe = spawnSync('ps', ['-A', '-o', 'command'], {
      encoding: 'utf8',
      timeout: WINDOW_PROBE_TIMEOUT_MS,
    });
    if (probe.error || probe.status !== 0) return unknown;
    const running = String(probe.stdout || '')
      .split('\n')
      .filter(function (line) {
        return line.indexOf('ms-playwright') !== -1;
      }).length;
    // ps cannot see windows, so a running browser is taken at its word here.
    return { known: true, processes: running, windows: running };
  } catch (err) {
    return unknown;
  }
}

// Runs codegen without blocking the event loop, so SIGINT and SIGTERM can
// still be handled. spawnSync would freeze the loop and no handler would run.
function startCodegen(args) {
  const cli = findPlaywrightCli();
  if (!cli) {
    console.error('');
    console.error('  The testing engine is missing from this install.');
    console.error('  Reinstalling usually fixes it:  npm install -g kryptheon');
    console.error('');
    return null;
  }
  return spawn(process.execPath, [cli].concat(args), {
    cwd: USER_DIR,
    stdio: ['inherit', 'inherit', 'pipe'],
  });
}

// --- making a recording fit to run twice ------------------------------------

function readSpec(relativeFile) {
  try {
    return fs.readFileSync(path.join(USER_DIR, relativeFile), 'utf8');
  } catch (err) {
    return null;
  }
}

function writeSpec(relativeFile, source) {
  try {
    fs.writeFileSync(path.join(USER_DIR, relativeFile), source, 'utf8');
    return true;
  } catch (err) {
    return false;
  }
}

// Passwords typed during recording land in the file as plain text. Swap them
// for environment variables before the file is left lying around.
function takeOutSecrets(relativeFile) {
  const source = readSpec(relativeFile);
  if (source === null) return [];
  const result = replay.scrubSecrets(source);
  if (!result.replacements.length) return [];
  return writeSpec(relativeFile, result.source) ? result.replacements : [];
}

// The password file is the one thing of kryptheon's in a project that must not
// be committed. If there is already a .gitignore, it belongs in it - but only
// once there is a password to protect: a .env here, or a recording that just
// had one taken out. A landing page with no sign-in has nothing to hide, and
// an edit to its .gitignore would be one more change of Kryptheon's in the repo.
function keepArtefactsOutOfGit(passwordTakenOut) {
  if (!passwordTakenOut && !fs.existsSync(path.join(USER_DIR, '.env'))) return;
  const added = secrets.updateGitignore(USER_DIR);
  if (!added.length) return;
  console.log('  Added to .gitignore: ' + added.join(', '));
  console.log('');
}

// The project's store, opened before anything reads a record, so whatever an
// older version left in this folder is moved out first - and said once, here,
// rather than by the fixture or the reporter, which run inside the test runner.
//
// Returns null when the store cannot be made. Carrying on would mean every
// recording is compared against nothing, which reads as "all fine" and is
// the one answer that must never be given by accident.
function openStore() {
  let opened;
  try {
    opened = store.open(USER_DIR);
  } catch (err) {
    console.error('');
    console.error('  Kryptheon keeps what it remembers about this project in');
    console.error('    ' + store.dirFor(USER_DIR));
    console.error('  and could not write there: ' + err.message);
    console.error('');
    console.error('  Without it every recording would look new, so nothing was checked.');
    console.error('  Set KRYPTHEON_HOME to a folder you can write to, and run this again.');
    console.error('');
    return null;
  }
  const lines = store.migrationLines(opened);
  if (lines.length) {
    console.log('');
    for (const line of lines) console.log(line);
  }
  return opened;
}

function reportSecrets(replacements) {
  if (!replacements || !replacements.length) return;
  const names = replacements.map((item) => item.envName);
  console.log('  What you typed into the password box was not saved in the test.');
  console.log('');

  // Written rather than described. Asked to make the file themselves, most
  // people on Windows reach for Notepad or Out-File, both of which add a byte
  // order mark that makes the first line unreadable.
  const hasEnv = fs.existsSync(path.join(USER_DIR, '.env'));
  const example = hasEnv ? null : secrets.writeEnvExample(USER_DIR, names);
  if (example) {
    console.log('  A file called .env.example has been written here:');
    for (const name of names) console.log('    ' + name + '=yourpassword');
    console.log('');
    console.log('  Put your real password in it and save it as .env, in this folder.');
  } else {
    console.log('  Before this can be checked, put it in a file called .env next to');
    console.log('  your tests, like this:');
    for (const item of replacements) {
      console.log('    ' + item.envName + '=your ' + String(item.field).toLowerCase() + ' here');
    }
  }
  console.log('');
  // Said plainly, because the alternative is signing in with a blank password
  // and spending an afternoon looking at the wrong thing.
  console.log('  Until that file exists, "npx kryptheon check" will skip this recording');
  console.log('  rather than sign in with a blank password.');
  console.log('');
  console.log('  Keep .env out of version control - it holds the real value.');
  console.log('');
}

// One keypress, no Enter, because the safe answer is the default and getting
// out of the way should cost nothing.
//
// Falls back to the default where there is no terminal to read keys from - a
// CI job, a pipe, an assistant running the command - rather than waiting for
// an answer that will never arrive.
function askKey(question, keys, fallback) {
  return new Promise((resolve) => {
    const allowed = keys.map((k) => k.toLowerCase());
    if (!process.stdin.isTTY || !process.stdin.setRawMode) return resolve(fallback);
    process.stdout.write(question);

    const finish = (answer) => {
      process.stdin.removeListener("data", onKey);
      try {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      } catch (err) {
        /* nothing more to do */
      }
      process.stdout.write(answer + String.fromCharCode(10));
      resolve(answer);
    };

    const onKey = (chunk) => {
      const key = String(chunk);
      // In raw mode Ctrl-C arrives as a keystroke rather than a signal, so it
      // has to be turned back into one. Sent as a signal rather than exiting
      // here, because exiting would cut off whatever is still buffered - and
      // it must not be read as an answer either: stopping is not "keep going".
      if (key === String.fromCharCode(3)) {
        process.stdin.removeListener('data', onKey);
        try {
          process.stdin.setRawMode(false);
          process.stdin.pause();
        } catch (err) {
          /* nothing more to do */
        }
        process.stdout.write(String.fromCharCode(10));
        process.kill(process.pid, 'SIGINT');
        return;
      }
      if (key === String.fromCharCode(13) || key === String.fromCharCode(10)) return finish(fallback);
      const pressed = key.toLowerCase();
      if (allowed.indexOf(pressed) === -1) return; // an unknown key: keep waiting
      finish(pressed);
    };

    try {
      process.stdin.setRawMode(true);
    } catch (err) {
      return resolve(fallback);
    }
    process.stdin.resume();
    process.stdin.on("data", onKey);
  });
}

// Removing a recording means removing what was remembered about it too, or
// the saved results of a file that no longer exists stay behind for ever.
function deleteRecording(name) {
  const relative = path.join("tests", name).split(path.sep).join("/");
  try {
    fs.unlinkSync(path.join(TESTS_DIR, name));
  } catch (err) {
    return { ok: false, name: name, why: err.message };
  }

  try {
    const api = require(path.join(PACKAGE_DIR, "kryptheon-fixture.js"));
    const all = api.readBaselines(api.BASELINE_FILE);
    const keys = recordings.baselineKeysForSpec(all, relative);
    if (keys.length) {
      for (const key of keys) delete all[key];
      fs.writeFileSync(api.BASELINE_FILE, JSON.stringify(all, null, 2) + String.fromCharCode(10), "utf8");
    }
  } catch (err) {
    // The recording is gone either way, and a leftover baseline is not worth
    // failing the command over.
  }
  return { ok: true, name: name, file: relative };
}

function askYesNo(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(false);
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      // Let the loop finish later: stdin stays open otherwise.
      try {
        process.stdin.pause();
      } catch (err) {
        /* nothing to do */
      }
      resolve(!/^\s*n/i.test(String(answer)));
    });
  });
}

// A typed answer, for questions whose answers are not single letters.
function askLine(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve("");
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      try {
        process.stdin.pause();
      } catch (err) {
        /* nothing to do */
      }
      resolve(String(answer));
    });
  });
}

// Ending on a logout means the next run starts somewhere else. Almost nobody
// wants that, so ask.
async function offerToDropLogout(relativeFile) {
  const source = readSpec(relativeFile);
  if (source === null) return false;
  const trimmed = replay.dropTrailingLogout(source);
  if (!trimmed.removed) return false;

  console.log('  The recording ends by logging out ("' + trimmed.removed + '").');
  console.log('  That means the next run would not start where this one did.');
  console.log('');

  const drop = await askYesNo('  Leave that last step out? [Y/n] ');
  if (!drop) {
    console.log('');
    console.log('  Kept it. If checks fail from the second run onwards, this is why.');
    console.log('');
    return false;
  }
  writeSpec(relativeFile, trimmed.source);
  console.log('');
  console.log('  Removed the sign-out step.');
  console.log('');
  return true;
}

// Codegen writes whatever identified the element at the moment it was clicked,
// which on a page of live figures means the figures end up in the selector. Say
// so, and say nothing when there is nothing to say.
// Codegen records the wrong keystrokes along with the right ones, so a typo
// corrected on the second attempt becomes a wrong login performed on every
// run. This takes those out and says what it took, because a tool that edits
// your recording without telling you is worse than one that leaves the mess.
// A saved result whose recording is gone, or has been recorded again since,
// describes a page nothing here visits any more. Left in place it is handed
// to whichever new recording lands on the same name, which then fails on its
// first run against a baseline it never created.
function dropDeadBaselines() {
  const api = (function () {
    try {
      return require(path.join(PACKAGE_DIR, 'kryptheon-fixture.js'));
    } catch (err) {
      return null;
    }
  })();
  if (!api) return [];

  let all;
  try {
    all = api.readBaselines(api.BASELINE_FILE);
  } catch (err) {
    return [];
  }
  if (!all || !Object.keys(all).length) return [];

  const result = baselines.pruneBaselines(all, USER_DIR);
  if (!result.changed) return [];
  try {
    fs.writeFileSync(api.BASELINE_FILE, JSON.stringify(result.baselines, null, 2) + String.fromCharCode(10), "utf8");
  } catch (err) {
    return [];
  }
  for (const line of baselines.pruneLines(result.dropped)) console.log(line);
  return result.dropped;
}

function tidyRecording(relativeFile) {
  const source = readSpec(relativeFile);
  if (source === null) return [];
  const result = cleanup.cleanRecording(source);
  if (!result.removed.length) return [];
  if (!writeSpec(relativeFile, result.source)) return [];
  return result.removed;
}

// Said after the file has its name, with the other closing notes, so the
// order on screen matches the order things happened in.
function reportTidying(removed) {
  for (const line of cleanup.describeCleanup(removed)) console.log(line);
  return removed || [];
}

function reportFragileSelectors(relativeFile) {
  const source = readSpec(relativeFile);
  if (source === null) return [];
  const findings = selectors.findFragileSelectors(source);
  for (const line of selectors.describeFragileSelectors(findings)) console.log(line);
  return findings;
}

function reportReplayRisks(relativeFile) {
  const source = readSpec(relativeFile);
  if (source === null) return [];
  const risks = replay.findReplayRisks(source);
  if (!risks.length) return [];

  console.log('  Before you rely on this recording, one thing to know:');
  console.log('');
  for (const risk of risks) {
    console.log('    "' + risk.step + '" (line ' + risk.line + ')');
    console.log('      ' + risk.why + '.');
    console.log('      What to do: ' + risk.fix + '.');
    console.log('');
  }
  console.log('  Everything else in the recording will run again fine.');
  console.log('');
  return risks;
}

// Everything that has to happen to whatever codegen left behind, however
// the run ended. Module level so it can be exercised directly.
async function finaliseRecording(outFile, context) {
  const ctx = context || {};
  const specPath = path.join(USER_DIR, outFile);
  let source = null;
  try {
    source = fs.readFileSync(specPath, 'utf8');
  } catch (err) {
    source = null;
  }

  if (source !== null && isRealRecording(source)) {
    // Import rewrite first: it is instant, so even a second interruption
    // leaves behind a spec that works.
    pointAtFixture(outFile);

    // Anything typed into a password box is still a literal in this file at
    // this point. Take it out before doing anything else with the file.
    const secrets = takeOutSecrets(outFile);

    // After the secrets, deliberately. By this point a password is an
    // environment variable rather than a literal, so nothing that is said
    // about a field that was typed twice can put the value back on screen.
    const tidied = tidyRecording(outFile);

    const named = await nameRecording(outFile);
    console.log('');
    console.log('  Saved to ' + named);
    // npx, not the bare name: somebody who started with `npx kryptheon record`
    // has no `kryptheon` command, and would be told it does not exist.
    console.log('  Run it any time with:  npx kryptheon check');
    console.log('');

    reportTidying(tidied);
    reportSecrets(secrets);
    keepArtefactsOutOfGit(!!(secrets && secrets.length));
    await offerToDropLogout(named);
    reportReplayRisks(named);
    reportFragileSelectors(named);

    return { code: 0, savedAs: named };
  }

  if (source !== null) {
    try {
      fs.unlinkSync(specPath);
    } catch (err) {
      /* nothing more we can do */
    }
  }
  if (!ctx.hadTestsDir) {
    try {
      if (fs.readdirSync(TESTS_DIR).length === 0) fs.rmdirSync(TESTS_DIR);
    } catch (err) {
      /* only tidying up */
    }
  }

  if (ctx.reason === 'no-window' || ctx.reason === 'never-started' || ctx.reason === 'unclear') {
    // What the browser itself said comes first. It used to be read only when
    // codegen exited on its own, so on this path a real error - a bad address,
    // a refused connection - was captured and then thrown away, and the reader
    // got a list of guesses instead of the answer.
    reportCodegenSaid(ctx.stderr);
    const detail = ctx.detail || {};
    if (ctx.reason === 'unclear') {
      for (const line of probeUnclearLines(detail.answered || 0, detail.unanswered || 0)) {
        console.error(line);
      }
    } else if (ctx.reason === 'no-window') {
      for (const line of windowUndetectedLines(detail.seconds || Math.round(WINDOW_TIMEOUT_MS / 1000))) {
        console.error(line);
      }
    } else {
      explainNoWindow();
    }
  } else if (ctx.reason === 'signal') {
    console.log('');
    console.log('  Recording stopped before anything was saved.');
    console.log('');
    console.log('  Nothing was recorded.');
    console.log('');
  } else if (source === null || /ERR_|Error:/.test(String(ctx.stderr || ''))) {
    explainCodegenFailure(ctx.target, ctx.stderr);
  } else {
    console.log('');
    console.log('  Nothing was recorded.');
    console.log('');
    console.log('  The browser closed before anything was clicked or typed.');
    console.log('  Run the same command again and use your app before closing it.');
    console.log('');
  }
  return { code: 1, savedAs: null };
}

// Every record writes another file and check runs all of them, so a first day
// spent learning the tool leaves a pile of recordings that never worked and a
// check that reads like a wall of failures. This is the moment asking costs
// nothing.
//
// Keeping is the default because it is the answer that cannot lose work, and
// the other one is a single keypress away. Where there is no terminal to
// answer with - a CI job, an assistant running the command - nothing is asked
// and nothing is deleted: a question nobody can see is not a question.
async function askAboutExisting(names) {
  if (!names.length || !process.stdin.isTTY) return false;

  for (const line of recordings.existingRecordingsQuestion(names.length)) console.log(line);
  const answer = await askKey("  Keep or replace? [K/r] ", ["k", "r"], "k");
  if (answer !== "r") return false;

  console.log("");
  console.log("  They will be deleted once this new recording is saved.");
  return true;
}

// The old recordings, once the new one is safely on disk. The new file is
// never in this list, but it is checked by name anyway - deleting the thing
// just recorded is the one mistake here that cannot be undone.
function dropOldRecordings(names, savedAs) {
  const keep = path.basename(String(savedAs || ""));
  const gone = [];
  for (const name of names) {
    if (path.basename(name) === keep) continue;
    const result = deleteRecording(name);
    if (result.ok) gone.push(name);
  }
  if (!gone.length) return gone;
  console.log("  Removed " + recordings.plural(gone.length, "older recording") + ":");
  for (const name of gone) console.log("    " + path.join("tests", name));
  console.log("");
  return gone;
}

// --- remove -----------------------------------------------------------------
//
// Recordings pile up. Without a way to take one out, the only way to stop a
// half-finished experiment being run for ever is to know where the files live
// and delete one by hand.

function listRecordings(names) {
  console.log("");
  console.log("  " + recordings.plural(names.length, "recording") + " in this project:");
  console.log("");
  names.forEach((name, i) => {
    console.log("    " + String(i + 1).padStart(2) + "  " + path.join("tests", name));
  });
  console.log("");
}

async function remove(name) {
  const names = listSpecFiles();
  if (!names.length) {
    console.log("");
    console.log("  There are no recordings to remove.");
    console.log("");
    return 0;
  }

  let choice;
  if (name) {
    choice = recordings.chooseFromList(names, name);
  } else {
    listRecordings(names);
    if (!process.stdin.isTTY) {
      console.log("  To remove one, run:  npx kryptheon remove <name>");
      console.log("");
      return 0;
    }
    const answer = await askLine("  Which one? [number, a for all, Enter to cancel] ");
    choice = recordings.chooseFromList(names, answer);
  }

  if (choice.action === "cancel") {
    console.log("");
    console.log("  Nothing was removed.");
    console.log("");
    return 0;
  }
  if (choice.action === "unclear") {
    console.error("");
    console.error("  " + choice.why + ": " + JSON.stringify(choice.said));
    console.error("  Run \"npx kryptheon remove\" on its own to see the list.");
    console.error("");
    return 1;
  }
  if (!openStore()) return 1;

  const gone = [];
  const failed = [];
  for (const target of choice.names) {
    const result = deleteRecording(target);
    if (result.ok) gone.push(target);
    else failed.push(result);
  }

  console.log("");
  if (gone.length) {
    console.log("  Removed " + recordings.plural(gone.length, "recording") + ":");
    for (const g of gone) console.log("    " + path.join("tests", g));
    console.log("");
    console.log(
      gone.length === 1
        ? "  Its saved result was removed too, so nothing is left behind."
        : "  Their saved results were removed too, so nothing is left behind.",
    );
    console.log("");
  }
  for (const f of failed) {
    console.error("  Could not remove " + path.join("tests", f.name) + ": " + f.why);
    console.error("");
  }
  return failed.length ? 1 : 0;
}

// --- setting the folder up --------------------------------------------------
//
// See the setup section of kryptheon-project.js for why this exists. That file
// decides; this one asks, writes and installs.

function writeOwnPackageJson(dir) {
  // 'wx': never over the top of one that appeared since the folder was looked
  // at. Somebody's package.json is not ours to replace.
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true }, null, 2) + '\n', { flag: 'wx' });
    return true;
  } catch (err) {
    return err.code === 'EEXIST';
  }
}

// `npm install --save-dev <spec>` in a folder. npm is npm.cmd on Windows, and
// Node will not start a .cmd directly (spawnSync EINVAL), so there it goes
// through cmd.exe. The spec is always "kryptheon" or "kryptheon@" and a
// version made of digits and dots; nothing anybody typed reaches this line.
function npmInstallDev(dir, spec) {
  const args = ['install', '--save-dev', spec, '--no-audit', '--no-fund', '--loglevel=error'];
  return process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm'].concat(args), { cwd: dir, encoding: 'utf8' })
    : spawnSync('npm', args, { cwd: dir, encoding: 'utf8' });
}

function installKryptheonIn(dir) {
  console.log('  Installing kryptheon here - this usually takes under a minute.');
  const result = npmInstallDev(dir, 'kryptheon');
  // Judged by what is on disk afterwards, not by npm's exit code alone.
  const ok = !result.error && result.status === 0 && project.kryptheonInstalledIn(dir);
  if (ok) {
    console.log('  Installed.');
    console.log('');
  }
  return ok;
}

// A folder `record` is about to use, made ready: its own package.json, its own
// copy of kryptheon. Returns false, having said why, if either did not happen.
function makeReady(dir) {
  if (!project.hasPackageJson(dir) && !writeOwnPackageJson(dir)) {
    console.error('');
    console.error('  Could not create package.json in:  ' + dir);
    console.error('  This folder may be read-only. Make a new folder of your own and');
    console.error('  run the same command from there.');
    console.error('');
    return false;
  }
  if (!project.kryptheonInstalledIn(dir) && !installKryptheonIn(dir)) {
    for (const line of project.installFailedLines()) console.error(line);
    return false;
  }
  return true;
}

// Run again from inside the new folder rather than moving this process there:
// every path in this file is worked out once, from the folder the command
// started in.
async function recordFromHome(plan, url) {
  try {
    fs.mkdirSync(plan.into, { recursive: true });
  } catch (err) {
    console.error('');
    console.error('  Could not make the folder:  ' + plan.into);
    console.error('  Make a new folder of your own, open a terminal in it, and run the');
    console.error('  same command again.');
    console.error('');
    return 1;
  }
  if (!makeReady(plan.into)) return 1;

  const child = spawn(process.execPath, [__filename, 'record', url], { cwd: plan.into, stdio: 'inherit' });
  // Ctrl-C reaches the child too, and the child is the one that saves what was
  // recorded. This process waits for it rather than exiting under it.
  const wait = () => {};
  process.on('SIGINT', wait);
  process.on('SIGTERM', wait);
  const code = await new Promise((resolve) => {
    child.on('error', () => resolve(1));
    child.on('close', (status) => resolve(status === null ? 1 : status));
  });
  process.removeListener('SIGINT', wait);
  process.removeListener('SIGTERM', wait);

  if (code === 0) for (const line of project.homeDoneLines(plan.into)) console.log(line);
  return code;
}

// Before the browser: it is a 200MB download on a new machine, and a
// recording that cannot be checked afterwards is somebody's five minutes
// thrown away. Returns null to carry on recording, or an exit code to stop.
async function prepareFolder(url) {
  const plan = project.setupPlan(USER_DIR);
  if (plan.action === 'ready') return null;

  const refusing = plan.action === 'refuse';
  for (const line of project.setupLines(plan, url)) (refusing ? console.error : console.log)(line);
  if (refusing) return 1;

  // Asked where there is a keyboard. Where there is not, the question's own
  // default is taken rather than refusing: isTTY is false in plenty of
  // perfectly good terminals (see noWindowLines), and a command that refuses
  // there can never work for the person who ran it. The one question whose
  // default is no - a second project inside somebody's first - stays no.
  const question = project.setupQuestion(plan);
  const yes = process.stdin.isTTY
    ? project.answeredYes(await askLine(question.text), question.yesByDefault)
    : question.yesByDefault;
  if (!yes) {
    console.log('');
    console.log('  Nothing was changed, and nothing was recorded.');
    console.log('');
    return 1;
  }

  if (plan.action === 'home') return await recordFromHome(plan, url);
  return makeReady(USER_DIR) ? null : 1;
}

async function record(url) {
  if (!url) {
    console.error('');
    console.error('  Which address should I open?');
    console.error('');
    console.error('  Add the web address of your app, for example:');
    console.error('    npx kryptheon record https://www.example.com');
    console.error('');
    return 1;
  }

  const target = normaliseRecordUrl(url);

  // Fail early and kindly rather than letting codegen throw a stack trace.
  const reach = await reachability(target);
  if (!reach.ok) {
    explainUnreachable(target, reach.kind);
    return 1;
  }

  // After the address is known to answer, so a typo is not the thing that
  // gets a folder set up; before the browser, which is the expensive part.
  const setup = await prepareFolder(url);
  if (setup !== null) return setup;
  // Before an old recording can be replaced, because replacing one also drops
  // its saved result - which has to be found where it now lives.
  if (!openStore()) return 1;

  if (!ensureBrowser()) return 1;

  const existingBefore = listSpecFiles();
  const replaceExisting = await askAboutExisting(existingBefore);

  const hadTestsDir = fs.existsSync(TESTS_DIR);
  try {
    fs.mkdirSync(TESTS_DIR, { recursive: true });
  } catch (err) {
    /* codegen will report if it cannot write */
  }

  const outFile = path.join('tests', timestampName());
  const specPath = path.join(USER_DIR, outFile);

  console.log('');
  console.log('  Opening ' + target + ' in a browser.');
  console.log('');
  console.log('  Use your app normally - click, type, sign in, whatever you want');
  console.log('  covered. Every step is recorded as you go.');
  console.log('');
  console.log('  When you are done, close the browser window to save the test.');
  console.log('');

  const child = startCodegen(['codegen', '--target', 'playwright-test', '-o', outFile, target]);
  if (!child) return 1;

  let stderr = '';
  if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  // Everything that has to happen no matter how this ends: tidy the file,
  // wire it up, name it. Runs once, whether codegen exits on its own or we
  // are interrupted.
  let finished = false;
  const finalise = async (reason, detail) => {
    if (finished) return 1;
    finished = true;
    const outcome = await finaliseRecording(outFile, {
      hadTestsDir: hadTestsDir,
      target: target,
      detail: detail || null,
      stderr: stderr,
      reason: reason,
    });
    // Only now, and only if something was actually saved. Deleting first
    // would mean a recording that went wrong takes the old ones with it.
    if (replaceExisting && outcome.savedAs) dropOldRecordings(existingBefore, outcome.savedAs);
    return outcome.code;
  };

  const stopChild = () => {
    try {
      child.kill();
    } catch (err) {
      /* already gone */
    }
  };

  return await new Promise((resolve) => {
    // If no window ever appears, stop instead of waiting for someone to kill us.
    // Someone whose window is real but undetectable can turn this off.
    const watchdogOff = !!process.env.KRYPTHEON_FORCE_RECORD;
    const watch = createWindowWatch();
    const watchdog = setInterval(() => {
      if (watchdogOff) {
        clearInterval(watchdog);
        return;
      }
      // A child that has already gone is the close handler's business, not
      // this one's: it knows the exit code and what was written.
      if (child.exitCode !== null || child.signalCode !== null) {
        clearInterval(watchdog);
        return;
      }
      const outcome = watch.tick();
      if (!outcome) return;
      clearInterval(watchdog);
      if (whenWindowUnconfirmed(outcome.verdict, !!process.stdin.isTTY) === 'leave') {
        if (outcome.verdict !== 'window') {
          for (const line of windowUnconfirmedLines()) console.log(line);
        }
        return;
      }
      stopChild();
      finalise(outcome.verdict, outcome).then(resolve);
    }, WINDOW_POLL_MS);

    const onSignal = () => {
      clearInterval(watchdog);
      stopChild();
      finalise('signal').then(resolve);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    process.once('SIGHUP', onSignal);

    child.on('error', () => {
      clearInterval(watchdog);
      finalise('error').then(resolve);
    });

    child.on('close', () => {
      clearInterval(watchdog);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGHUP', onSignal);
      finalise('exit').then(resolve);
    });
  });
}

// Recordings import the fixture by package name, which only resolves if
// kryptheon is in the user's own node_modules. Running through a bare `npx`
// puts the package somewhere the tests cannot see.
// One walk, shared with record's setup, so that record and check can never
// disagree about whether a folder is ready.
function fixtureResolvesForUser() {
  return project.kryptheonReachableFrom(USER_DIR);
}

// Only a problem if a recording actually asks for it: specs written against a
// relative path (as in this repo) resolve on their own.
function specsNeedThePackage() {
  return listSpecFiles().some(function (name) {
    try {
      return fs.readFileSync(path.join(TESTS_DIR, name), 'utf8').indexOf('kryptheon/kryptheon-fixture') !== -1;
    } catch (err) {
      return false;
    }
  });
}

// Older versions, and any run that was killed part way, left specs behind that
// import Playwright directly (so they produce no diagnostics) or that contain
// nothing but the opening navigation (so they verify nothing). Repair the
// first kind and refuse to run the second, rather than reporting a false OK.
function triageSpecs() {
  const repaired = [];
  const notRecordings = [];
  const runnable = [];
  const withSecrets = [];
  const missingSecrets = [];

  for (const name of listSpecFiles()) {
    const full = path.join(TESTS_DIR, name);
    let source;
    try {
      source = fs.readFileSync(full, 'utf8');
    } catch (err) {
      continue;
    }

    if (/(from|require\()\s*(['"])@playwright\/test\2/.test(source)) {
      const relative = path.join('tests', name);
      if (pointAtFixture(relative)) {
        repaired.push(name);
        try {
          source = fs.readFileSync(full, 'utf8');
        } catch (err) {
          /* keep what we had */
        }
      }
    }

    if (!isRealRecording(source)) {
      notRecordings.push(name);
      continue;
    }
    // Recordings made before secrets were stripped still hold the real value.
    // Say so rather than rewriting: a spec that works today should keep
    // working until the person has somewhere to put the password.
    if (replay.scrubSecrets(source).replacements.length) {
      withSecrets.push({ name: name, fields: replay.scrubSecrets(source).replacements });
    }

    // A recording that falls back to an empty password is not run at all. It
    // would sign in blank, fail, and send the reader looking at their app.
    const needed = secrets.requiredSecrets(source);
    const absent = needed.length
      ? secrets.missingSecrets(needed, { envFile: secrets.envFileFor(USER_DIR) })
      : [];
    if (absent.length) {
      missingSecrets.push({ name: name, names: absent });
      continue;
    }

    runnable.push(name);
  }

  return {
    repaired: repaired,
    notRecordings: notRecordings,
    runnable: runnable,
    withSecrets: withSecrets,
    missingSecrets: missingSecrets,
  };
}

function check(options) {
  const quiet = !!(options && options.quiet);

  // Before anything else. Recordings and results are read out of whatever
  // folder this was run in, so being in the wrong one does not fail - it
  // succeeds, about the wrong project. That is the one outcome worth exiting
  // non-zero over even though nothing was tested.
  const here = project.inspectProject(USER_DIR);
  if (!here.ok) {
    for (const line of project.noProjectLines(here)) console.error(line);
    return 1;
  }
  if (!openStore()) return 1;

  // Deliberately not a failure. An assistant told to run this after every
  // change will read a non-zero exit as "something broke" and start fixing
  // code that is perfectly fine. Nothing has been recorded, so there is
  // nothing to verify and nothing to repair.
  if (!listSpecFiles().length) {
    for (const line of project.noRecordingsLines()) console.log(line);
    return 0;
  }
  if (!fixtureResolvesForUser() && specsNeedThePackage()) {
    console.log('');
    console.log('  Your recordings cannot find kryptheon.');
    console.log('');
    console.log('  They are saved in this folder, but kryptheon itself is installed');
    console.log('  somewhere else, so they have nothing to load. Add it here:');
    console.log('');
    console.log('    npm i -D kryptheon');
    console.log('');
    console.log('  Then run "npx kryptheon check" again.');
    console.log('');
    return 1;
  }
  keepArtefactsOutOfGit();
  dropDeadBaselines();

  const triage = triageSpecs();

  for (const name of triage.repaired) {
    console.log('');
    console.log('  Repaired ' + path.join('tests', name));
    console.log('  It was saved without the part that explains failures. Fixed now.');
  }

  for (const item of triage.withSecrets) {
    console.log('');
    console.log('  Careful: ' + path.join('tests', item.name) + ' has a real password written into it.');
    console.log('  Anyone who can read that file can read the password.');
    console.log('  Re-record it to have the password moved into .env automatically.');
  }

  for (const item of triage.missingSecrets) {
    console.log('');
    const example = fs.existsSync(path.join(USER_DIR, '.env.example')) ? '.env.example' : null;
    for (const line of secrets.missingSecretLines(path.join('tests', item.name), item.names, { examplePath: example })) {
      console.log(line);
    }
  }

  for (const name of triage.notRecordings) {
    console.log('');
    console.log('  Skipped ' + path.join('tests', name));
    console.log('  This is not a real recording - it only opens a page and stops,');
    console.log('  so it cannot tell you whether anything works.');
    console.log('  Record it again:  npx kryptheon record <url>');
  }

  if (!triage.runnable.length) {
    console.log('');
    console.log('  Nothing could be checked.');
    console.log('');
    if (triage.missingSecrets.length) {
      console.log('  Every recording here needs a password that is not set yet.');
      console.log('  Create the .env file above and run this again.');
    } else {
      console.log('  None of the files in tests/ is a usable recording.');
      console.log('  Record one with:  npx kryptheon record <url>');
    }
    console.log('');
    return 1;
  }

  if (!ensureBrowser()) return 1;

  // Only the usable recordings are handed to the test runner, so a file that
  // cannot produce diagnostics can never be counted as passing.
  const only = triage.runnable.map((name) => path.join('tests', name).split(path.sep).join('/'));
  if (quiet) process.env.KRYPTHEON_QUIET = '1';

  // Debug signatures. The workers cannot print: Playwright pipes their
  // descriptors and hands the output to reporter stdio hooks that this
  // reporter does not implement, so it is dropped. They write to this file
  // instead and it is printed here, on stderr, where the reporter's own
  // output on stdout is left completely alone.
  const signatures = require(path.join(PACKAGE_DIR, 'kryptheon-signature.js'));
  let sink = null;
  if (signatures.signatureEnabled()) {
    sink = path.join(os.tmpdir(), 'kryptheon-signature-' + process.pid + '.jsonl');
    process.env[signatures.SINK_ENV] = sink;
  }

  const status = runPlaywright(['test', '--config', CONFIG].concat(only)).status;

  if (sink) signatures.drainSignatures(sink);

  // Without this, a green summary could still hide a recording that checked
  // nothing at all.
  if (triage.missingSecrets.length) {
    const many = triage.missingSecrets.length > 1;
    console.log(
      '  Note: ' + triage.missingSecrets.length + ' recording' + (many ? 's were' : ' was') +
        ' skipped because a password is not set.'
    );
    console.log('');
  }

  if (triage.notRecordings.length) {
    const many = triage.notRecordings.length > 1;
    console.log(
      '  Note: ' + triage.notRecordings.length + ' recording' + (many ? 's' : '') +
        ' above checked nothing and ' + (many ? 'were' : 'was') + ' skipped.'
    );
    console.log('');
  }
  // Skipped for a missing password is not a pass. The fix is one file away,
  // and reporting zero would let it be mistaken for a clean run.
  return status || (triage.missingSecrets.length ? 1 : 0);
}

// --- setup-ai ---------------------------------------------------------------
//
// An assistant that only reads code will happily call a change finished. These
// files are the ones the common assistants read on their own, so the rule ends
// up in front of them without anyone having to remember it.

const RULES_START = 'kryptheon:start';
const RULES_END = 'kryptheon:end';

// Every assistant reads at least one of these.
const RULES_TARGETS = [
  { file: 'CLAUDE.md', comment: 'html' },
  { file: 'AGENTS.md', comment: 'html' },
  { file: '.cursorrules', comment: 'hash' },
];

function rulesBody() {
  return [
    '## Checking your work with kryptheon',
    '',
    'After making any change to this app:',
    '',
    '1. Run `npx kryptheon check` and show its output.',
    '2. Do not report the work as done until it passes.',
    '3. If it fails, fix what broke and run it again.',
    '4. If it says nothing has been recorded yet, stop and ask the user to run',
    '   `npx kryptheon record <url>` themselves in their own terminal. That',
    '   opens a browser window and cannot be done from your terminal. It is not',
    '   a failure, so do not try to fix it.',
    '',
    'Reading the code is not enough. The check runs the app in a real browser,',
    'which is the only thing that shows whether the change actually works.',
  ];
}

// Wrapped in markers so a second run replaces the block instead of stacking
// another copy underneath the first.
function rulesBlock(style) {
  const open = style === 'hash' ? '# ' + RULES_START : '<!-- ' + RULES_START + ' -->';
  const close = style === 'hash' ? '# ' + RULES_END : '<!-- ' + RULES_END + ' -->';
  const body = style === 'hash' ? rulesBody().map((l) => (l ? '# ' + l : '#')) : rulesBody();
  return [open].concat(body, [close]).join('\n');
}

// Returns the new contents, and what happened, without touching the disk.
function applyRules(existing, style) {
  const block = rulesBlock(style);
  if (existing === null || existing === undefined) {
    return { contents: block + '\n', action: 'created' };
  }
  const text = String(existing);
  const startAt = text.indexOf(RULES_START);
  const endAt = text.indexOf(RULES_END);

  if (startAt !== -1 && endAt !== -1 && endAt > startAt) {
    // Replace the previous block, keeping everything around it.
    const lines = text.split('\n');
    const first = lines.findIndex((l) => l.indexOf(RULES_START) !== -1);
    let last = lines.findIndex((l) => l.indexOf(RULES_END) !== -1);
    if (first === -1 || last === -1 || last < first) return { contents: text, action: 'unchanged' };
    const rebuilt = lines.slice(0, first).concat(block.split('\n'), lines.slice(last + 1));
    const contents = rebuilt.join('\n');
    return { contents: contents, action: contents === text ? 'unchanged' : 'updated' };
  }

  // Never overwrite what someone else wrote: add to the end.
  const padded = text.replace(/\s*$/, '');
  return { contents: padded + '\n\n' + block + '\n', action: 'appended' };
}

function setupAi() {
  const results = [];
  for (const target of RULES_TARGETS) {
    const full = path.join(USER_DIR, target.file);
    let existing = null;
    try {
      existing = fs.readFileSync(full, 'utf8');
    } catch (err) {
      existing = null;
    }
    const outcome = applyRules(existing, target.comment);
    if (outcome.action === 'unchanged') {
      results.push({ file: target.file, action: 'unchanged' });
      continue;
    }
    try {
      fs.writeFileSync(full, outcome.contents, 'utf8');
      results.push({ file: target.file, action: outcome.action });
    } catch (err) {
      results.push({ file: target.file, action: 'failed' });
    }
  }

  console.log('');
  console.log('  Your AI assistant now has a rule to check its work.');
  console.log('');
  for (const r of results) {
    const said =
      r.action === 'created' ? 'written'
      : r.action === 'appended' ? 'added a section to your existing file'
      : r.action === 'updated' ? 'updated the section it wrote before'
      : r.action === 'unchanged' ? 'already up to date'
      : 'could not be written';
    console.log('    ' + r.file.padEnd(14) + said);
  }
  console.log('');
  console.log('  The rule: after any change, run "npx kryptheon check", show the');
  console.log('  output, and do not call the work done until it passes.');
  console.log('');
  console.log('  Nothing outside the marked section was touched.');
  console.log('');
  return results.some((r) => r.action === 'failed') ? 1 : 0;
}

// --- code -------------------------------------------------------------------
//
// A read of the project's own frontend code for text inserted as HTML
// (kryptheon-code.js). Nothing is run and nothing is sent; every finding is
// "verification required", so the exit code is 0 unless the read could not
// happen at all - a script must never take an unproven risk for a break.

// How many fix prompts are printed in full. The rest are saved in the store
// and shown by the dashboard; forty prompts in a terminal is a wall nobody reads.
const CODE_PROMPTS_SHOWN = 5;

function codeRead() {
  const here = project.inspectProject(USER_DIR);
  if (!here.ok) {
    for (const line of project.noProjectLines(here)) console.error(line);
    return 1;
  }
  const opened = openStore();
  if (!opened) return 1;

  const reader = require(path.join(PACKAGE_DIR, 'kryptheon-code.js'));
  const result = reader.scanProject(USER_DIR, { packageDir: PACKAGE_DIR });
  if (!result.ran) {
    console.error('');
    console.error('  I could not read your code this time: ' + result.why + '.');
    console.error('  Nothing was checked - this is not a pass.');
    console.error('');
    return 2;
  }

  try {
    fs.writeFileSync(opened.codeFindings, JSON.stringify({
      checkedAt: new Date().toISOString(),
      filesRead: result.filesRead,
      findings: result.findings,
      unreadable: result.unreadable,
    }, null, 2) + String.fromCharCode(10), 'utf8');
  } catch (err) {
    console.error('  (could not save this read: ' + err.message + ')');
  }

  const high = result.findings.filter((f) => f.severity === 'HIGH');
  const medium = result.findings.filter((f) => f.severity !== 'HIGH');
  console.log('');
  console.log('  I read ' + result.filesRead + ' file' + (result.filesRead === 1 ? '' : 's') + ' of your app\'s code.');
  if (!result.findings.length) {
    console.log('  I found no place where text that could come from outside the page is');
    console.log('  inserted as HTML. That is what this read looks for, and only that.');
  } else {
    console.log('  ' + result.findings.length + ' place' + (result.findings.length === 1 ? '' : 's') +
      ' where text may be inserted as HTML (' + high.length + ' HIGH, ' + medium.length + ' MEDIUM).');
    console.log('  I did not run anything, so each one needs a look before it is called a bug.');
    for (const f of high.concat(medium)) {
      console.log('');
      console.log('  ' + f.severity + '   ' + f.file + ':' + f.line + '   (verification required)');
      console.log('    ' + f.headline);
      console.log('    ' + f.sink + ':  ' + f.expression);
    }
    const prompted = high.slice(0, CODE_PROMPTS_SHOWN);
    if (prompted.length) {
      console.log('');
      console.log('  ' + '-'.repeat(68));
      console.log('  For the HIGH ones, paste this into your AI tool - one at a time:');
      for (const f of prompted) {
        console.log('');
        f.fixPrompt.split(String.fromCharCode(10)).forEach((l) => console.log('    ' + l));
      }
    }
    if (result.findings.length > prompted.length) {
      console.log('');
      console.log('  The fix for every one is saved in:');
      console.log('    ' + opened.codeFindings);
    }
  }
  if (result.unreadable.length) {
    console.log('');
    console.log('  What I could not read (unknown, not clear):');
    for (const u of result.unreadable) console.log('    ' + u.file + ' - ' + u.why);
  }
  console.log('');
  return 0;
}

// --- accept -----------------------------------------------------------------

function baselineApi() {
  try {
    return require(path.join(PACKAGE_DIR, 'kryptheon-fixture.js'));
  } catch (err) {
    console.error('');
    console.error('  Could not read the saved results: ' + err.message);
    console.error('');
    return null;
  }
}

// A key looks like "tests/login.spec.js :: Login".
function titleOf(key) {
  const at = key.indexOf(' :: ');
  return at === -1 ? key : key.slice(at + 4);
}

function listBaselines(api) {
  const all = api.readBaselines(api.BASELINE_FILE);
  const keys = Object.keys(all);

  console.log('');
  if (!keys.length) {
    console.log('  No tests have a saved result yet.');
    console.log('  Run "npx kryptheon check" once and they will be saved automatically.');
    console.log('');
    return 0;
  }

  console.log('  Tests with a saved result:');
  console.log('');
  for (const key of keys) {
    const waiting = all[key] && all[key].pending ? '   (has a new result waiting)' : '';
    console.log('    ' + titleOf(key) + waiting);
    console.log('      from ' + key.split(' :: ')[0]);
  }
  console.log('');
  console.log('  To agree that a new result is correct:');
  console.log('    npx kryptheon accept "<name>"');
  console.log('');
  return 0;
}

function accept(name) {
  // Only where there are recordings: anywhere else there is nothing to accept,
  // and no reason to make a store for a folder that is not a project.
  if (fs.existsSync(TESTS_DIR) && !openStore()) return 1;
  const api = baselineApi();
  if (!api) return 1;
  if (!name) return listBaselines(api);

  const all = api.readBaselines(api.BASELINE_FILE);
  const wanted = String(name).trim().toLowerCase();
  const matches = Object.keys(all).filter(function (key) {
    return titleOf(key).toLowerCase() === wanted || key.toLowerCase() === wanted;
  });

  if (!matches.length) {
    console.error('');
    console.error('  No saved result for a test called "' + name + '".');
    console.error('  Run "npx kryptheon accept" on its own to see the names.');
    console.error('');
    return 1;
  }
  if (matches.length > 1) {
    console.error('');
    console.error('  More than one test is called "' + name + '":');
    matches.forEach((k) => console.error('    ' + k));
    console.error('');
    console.error('  Pass the full line above instead.');
    console.error('');
    return 1;
  }

  const key = matches[0];
  const result = api.acceptBaseline(api.BASELINE_FILE, key);

  if (result.ok) {
    console.log('');
    console.log('  Updated the saved result for "' + titleOf(key) + '".');
    console.log('    Address: ' + result.entry.url);
    console.log('    Title:   ' + result.entry.title);
    console.log('');
    console.log('  Every other test was left alone.');
    console.log('');
    return 0;
  }

  console.error('');
  if (result.reason === 'nothing-pending') {
    console.error('  "' + titleOf(key) + '" has no new result waiting.');
    console.error('  Nothing to accept - it last matched its saved result.');
  } else if (result.reason === 'no-entry') {
    console.error('  "' + titleOf(key) + '" has no saved result yet.');
  } else {
    console.error('  Could not update the saved result for "' + titleOf(key) + '".');
  }
  console.error('');
  return 1;
}

const [command, ...rest] = process.argv.slice(2);

// process.exit() cuts the process off mid-teardown. On Windows a terminal's
// output is written asynchronously, so exiting while the last line is still
// queued tears down a handle that is already closing - which is what produces
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" in libuv. Setting
// the code and letting Node wind down on its own avoids that entirely, and
// still reports the same exit status.
async function finishWith(code) {
  process.exitCode = code;
  const streams = [process.stdout, process.stderr];
  await Promise.all(
    streams.map(
      (stream) =>
        new Promise((resolve) => {
          if (!stream || typeof stream.write !== 'function' || !stream.writableLength) return resolve();
          const done = () => resolve();
          stream.once('drain', done);
          const guard = setTimeout(done, 1000);
          if (guard.unref) guard.unref();
        })
    )
  );
}

// The copy that must run `check` is the one the recordings load. Measured: in
// a folder `record` set up, `npx kryptheon@latest check` ran npx's copy, whose
// Playwright loads the config, while the recordings loaded the folder's copy -
// two Playwrights, and "Requiring @playwright/test second time" before a single
// recording ran. `npx kryptheon check` worked in the same folder only because
// npx happened to pick the local copy.
//
// So when this is not the folder's copy, the folder's copy does the work.
// Returns its exit code, or null to carry on here.
function handToFolderCopy() {
  if (process.env.KRYPTHEON_HANDED_OVER) return null; // once, never in a loop
  const theirs = project.kryptheonCopyFor(USER_DIR);
  if (!theirs) return null;
  let same = false;
  try {
    same = fs.realpathSync(theirs) === fs.realpathSync(PACKAGE_DIR);
  } catch (err) {
    same = path.resolve(theirs) === path.resolve(PACKAGE_DIR);
  }
  if (same) return null;

  let theirVersion = 'unknown';
  try {
    theirVersion = JSON.parse(fs.readFileSync(path.join(theirs, 'package.json'), 'utf8')).version;
  } catch (err) {
    /* said as unknown */
  }
  const mine = packageVersion();

  // An older copy is brought up to this one first. Found the day 0.1.18
  // shipped: the fix was on the registry, `npx kryptheon@latest check` and
  // every AI tool asked for it, and the folder's 0.1.17 ran anyway - the
  // person would have had to type an npm command to get what they had
  // already asked for. Never downwards: a folder that is ahead of a cached
  // npx copy keeps what it has.
  if (project.olderVersion(theirVersion, mine)) {
    const root = path.dirname(path.dirname(theirs)); // <root>/node_modules/kryptheon
    if (project.hasPackageJson(root)) {
      console.log('');
      console.log('  This folder has kryptheon ' + theirVersion + ' and this is ' + mine + '. Updating the folder\'s');
      console.log('  copy, because your recordings load that one - usually under a minute.');
      const result = npmInstallDev(root, 'kryptheon@' + mine);
      let now = null;
      try {
        now = JSON.parse(fs.readFileSync(path.join(theirs, 'package.json'), 'utf8')).version;
      } catch (err) {
        now = null;
      }
      // Believed only when the folder now holds exactly this version.
      if (!result.error && result.status === 0 && now === mine && project.kryptheonCopyFor(USER_DIR) === theirs) {
        console.log('  Updated.');
        theirVersion = now;
      } else {
        console.log('  Could not update it just now (no internet?), so the ' + (now || theirVersion) + ' that is here runs.');
        if (now) theirVersion = now;
      }
    }
  }

  // A copy from before the store looks for its records inside the project. If
  // they have already moved out, it finds none, takes every recording as new,
  // and learns whatever the app does today as correct - a broken page would
  // pass. So it is not run; the one fix is to bring it up to date.
  if (project.olderVersion(theirVersion, FIRST_STORE_VERSION)) {
    const kept = store.pathsFor(USER_DIR);
    if (fs.existsSync(kept.baselines) || fs.existsSync(kept.history)) {
      console.error('');
      console.error('  This folder has kryptheon ' + theirVersion + ', which looks for its saved results');
      console.error('  inside the project. They have moved out, to');
      console.error('    ' + kept.dir);
      console.error('  so ' + theirVersion + ' would see none, treat every recording as new, and could');
      console.error('  miss a real change. Nothing was checked. Update this folder\'s copy:');
      console.error('    npm i -D kryptheon@latest');
      console.error('  then run this again.');
      console.error('');
      return 1;
    }
  }

  if (theirVersion !== mine) {
    // Not an error: the folder's copy is the one its recordings are written
    // against. Said, so an older one is never mistaken for this one.
    console.log('');
    console.log('  Running the kryptheon installed in this folder (' + theirVersion + '), because your');
    console.log('  recordings load that one. ' + (mine !== 'unknown' ? 'To move this folder to ' + mine + ':' : 'To update it:'));
    console.log('    npm i -D kryptheon@latest');
  }
  const result = spawnSync(process.execPath, [path.join(theirs, 'bin', 'kryptheon.js')].concat(process.argv.slice(2)), {
    cwd: USER_DIR,
    stdio: 'inherit',
    env: Object.assign({}, process.env, { KRYPTHEON_HANDED_OVER: '1' }),
  });
  if (result.error) {
    console.error('');
    console.error('  Could not run the kryptheon installed in this folder: ' + result.error.message);
    console.error('  Reinstalling it usually fixes this:  npm i -D kryptheon@latest');
    console.error('');
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

async function main() {
  if (nodeIsTooOld()) {
    console.error('');
    console.error('  This tool needs a newer version of Node.');
    console.error('    You have:  ' + process.versions.node);
    console.error('    You need:  20.6.0 or later');
    console.error('');
    console.error('  Download the latest from https://nodejs.org and try again.');
    console.error('');
    return finishWith(1);
  }

  switch (command) {
    case 'record':
      return finishWith(await record(rest[0]));
      break;
    case 'check': {
      const handedOver = handToFolderCopy();
      if (handedOver !== null) return finishWith(handedOver);
      return finishWith(check({ quiet: rest.indexOf('--quiet') !== -1 || rest.indexOf('-q') !== -1 }));
    }
    case 'remove':
    case 'rm':
      return finishWith(await remove(rest.join(" ").trim()));
    case 'setup-ai':
      return finishWith(setupAi());
    case 'accept':
      return finishWith(accept(rest.join(' ').trim()));
      break;
    case 'code':
      return finishWith(codeRead());
    case '-v':
    case '--version':
    case 'version':
      console.log(packageVersion());
      return finishWith(0);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      usage();
      return finishWith(0);
      break;
    default:
      console.error('');
      console.error('  Unknown command: ' + command);
      usage();
      return finishWith(1);
  }
}

// Exported so the naming logic can be checked without opening a browser.
module.exports = {
  packageVersion: packageVersion,
  humanisePath: humanisePath,
  nameFromTitle: nameFromTitle,
  deriveTestName: deriveTestName,
  slugify: slugify,
  nameRecording: nameRecording,
  pointAtFixture: pointAtFixture,
  listSpecFiles: listSpecFiles,
  countRecordedActions: countRecordedActions,
  isRealRecording: isRealRecording,
  importsPlaywrightDirectly: importsPlaywrightDirectly,
  triageSpecs: triageSpecs,
  applyRules: applyRules,
  rulesBlock: rulesBlock,
  record: record,
  prepareFolder: prepareFolder,
  handToFolderCopy: handToFolderCopy,
  finaliseRecording: finaliseRecording,
  takeOutSecrets: takeOutSecrets,
  reportSecrets: reportSecrets,
  reportReplayRisks: reportReplayRisks,
  offerToDropLogout: offerToDropLogout,
  noWindowLines: noWindowLines,
  windowUndetectedLines: windowUndetectedLines,
  probeUnclearLines: probeUnclearLines,
  createWindowWatch: createWindowWatch,
  inspectBrowserWindows: inspectBrowserWindows,
  parseWindowProbe: parseWindowProbe,
  codegenComplaints: codegenComplaints,
  reportFragileSelectors: reportFragileSelectors,
  tidyRecording: tidyRecording,
  dropDeadBaselines: dropDeadBaselines,
  reportTidying: reportTidying,
  remove: remove,
  deleteRecording: deleteRecording,
  dropOldRecordings: dropOldRecordings,
  askAboutExisting: askAboutExisting,
  askKey: askKey,
  whenWindowUnconfirmed: whenWindowUnconfirmed,
  windowUnconfirmedLines: windowUnconfirmedLines,
  WINDOW_TIMEOUT_MS: WINDOW_TIMEOUT_MS,
  WINDOW_HARD_LIMIT_MS: WINDOW_HARD_LIMIT_MS,
  WINDOW_POLL_MS: WINDOW_POLL_MS,
  WINDOW_PROBE_TIMEOUT_MS: WINDOW_PROBE_TIMEOUT_MS,
  classifyFetchError: classifyFetchError,
  normaliseRecordUrl: normaliseRecordUrl,
  isLocalAddress: isLocalAddress,
  nodeIsTooOld: nodeIsTooOld,
};

if (require.main === module) main();
