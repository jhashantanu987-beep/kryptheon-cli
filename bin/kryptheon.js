#!/usr/bin/env node
// The kryptheon CLI. A thin wrapper so nobody has to remember Playwright's
// command line or edit a config file. Everything here shells out to the
// Playwright binary that ships with this package.
//
// Two roots matter, and they are not the same once this is installed:
//   PACKAGE_DIR - the tool's own files (fixture, reporter, config, this file)
//   USER_DIR    - the folder the command was run in, which owns tests/,
//                 kryptheon-baselines.json, kryptheon-history.jsonl and .env

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const replay = require('../kryptheon-replay.js');

const PACKAGE_DIR = path.join(__dirname, '..');
const USER_DIR = process.cwd();
const CONFIG = path.join(PACKAGE_DIR, 'playwright.config.js');
const TESTS_DIR = path.join(USER_DIR, 'tests');

const MIN_NODE = [20, 6, 0];

// How long to wait for a browser window to appear before giving up.
const WINDOW_POLL_MS = 3000;
const WINDOW_TIMEOUT_MS = 30000;

function nodeIsTooOld(version) {
  const parts = String(version || process.versions.node).split('.').map(Number);
  for (let i = 0; i < MIN_NODE.length; i++) {
    if ((parts[i] || 0) > MIN_NODE[i]) return false;
    if ((parts[i] || 0) < MIN_NODE[i]) return true;
  }
  return false;
}

function usage() {
  console.log('');
  console.log('  kryptheon - record and check your app');
  console.log('');
  console.log('  kryptheon record <url>   open your app and record what you do as a test');
  console.log('  kryptheon check          run every recorded test and report in plain language');
  console.log('  kryptheon accept <name>  agree that one test\'s new result is the correct one');
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
function looksLikeNoDesktop() {
  if (process.env.KRYPTHEON_FORCE_RECORD) return false;
  return !process.stdout.isTTY;
}

function explainNoWindow(url) {
  console.error('');
  console.error('  Recording needs a real browser window on your screen.');
  console.error('');
  console.error('  This terminal cannot show one - that is what happens inside an');
  console.error('  AI coding assistant, or any window-less session.');
  console.error('');
  console.error('  Open Command Prompt (or PowerShell) yourself and run:');
  console.error('    npx kryptheon record ' + url);
  console.error('');
  console.error('  Nothing was recorded.');
  console.error('');
}

// Is a Playwright-controlled browser actually showing a window?
function browserWindowIsUp() {
  try {
    if (process.platform === 'win32') {
      const probe = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          "@(Get-Process chrome,msedge -ErrorAction SilentlyContinue | " +
            "Where-Object { $_.Path -like '*ms-playwright*' -and $_.MainWindowHandle -ne 0 }).Count",
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 8000 }
      );
      return Number(String(probe.stdout || '').trim()) > 0;
    }
    const probe = spawnSync('ps', ['-A', '-o', 'command'], { encoding: 'utf8', timeout: 8000 });
    return /ms-playwright/.test(String(probe.stdout || ''));
  } catch (err) {
    return true; // cannot tell - do not block the user
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

function reportSecrets(replacements) {
  if (!replacements || !replacements.length) return;
  console.log('  What you typed into the password box was not saved in the test.');
  console.log('');
  console.log('  Put it in a file called .env next to your tests, like this:');
  for (const item of replacements) {
    console.log('    ' + item.envName + '=your ' + String(item.field).toLowerCase() + ' here');
  }
  console.log('');
  console.log('  Keep .env out of version control - it holds the real value.');
  console.log('');
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

    const named = await nameRecording(outFile);
    console.log('');
    console.log('  Saved to ' + named);
    console.log('  Run it any time with:  kryptheon check');
    console.log('');

    reportSecrets(secrets);
    await offerToDropLogout(named);
    reportReplayRisks(named);

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

  if (ctx.reason === 'no-window') {
    explainNoWindow(ctx.target);
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

async function record(url) {
  if (!url) {
    console.error('');
    console.error('  Which address should I open?');
    console.error('');
    console.error('  Add the web address of your app, for example:');
    console.error('    kryptheon record https://www.example.com');
    console.error('');
    return 1;
  }

  const target = normaliseRecordUrl(url);

  // No desktop means no window means nothing to record. Say so now rather
  // than hanging until something kills us.
  if (looksLikeNoDesktop()) {
    explainNoWindow(target);
    return 1;
  }

  // Fail early and kindly rather than letting codegen throw a stack trace.
  const reach = await reachability(target);
  if (!reach.ok) {
    explainUnreachable(target, reach.kind);
    return 1;
  }

  if (!ensureBrowser()) return 1;

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
  const finalise = async (reason) => {
    if (finished) return 1;
    finished = true;
    const outcome = await finaliseRecording(outFile, {
      hadTestsDir: hadTestsDir,
      target: target,
      stderr: stderr,
      reason: reason,
    });
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
    let waited = 0;
    const watchdog = setInterval(() => {
      waited += WINDOW_POLL_MS;
      if (browserWindowIsUp()) {
        clearInterval(watchdog);
        return;
      }
      if (waited >= WINDOW_TIMEOUT_MS) {
        clearInterval(watchdog);
        stopChild();
        finalise('no-window').then(resolve);
      }
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
// Deliberately a filesystem walk, not require.resolve: this file lives inside
// the kryptheon package, and a package with a name and an "exports" map can
// always resolve itself by name, so require.resolve would answer "yes" even
// when the user's tests have no way to find it.
function fixtureResolvesForUser() {
  let dir = USER_DIR;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'node_modules', 'kryptheon', 'kryptheon-fixture.js'))) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
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
    runnable.push(name);
  }

  return {
    repaired: repaired,
    notRecordings: notRecordings,
    runnable: runnable,
    withSecrets: withSecrets,
  };
}

function check() {
  if (!listSpecFiles().length) {
    console.log('');
    console.log('  There is nothing to check yet.');
    console.log('');
    console.log('  Record something first, for example:');
    console.log('    kryptheon record https://www.example.com');
    console.log('');
    console.log('  Use your app in the browser that opens, then close it.');
    console.log('');
    return 1;
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
    console.log('  Then run "kryptheon check" again.');
    console.log('');
    return 1;
  }
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

  for (const name of triage.notRecordings) {
    console.log('');
    console.log('  Skipped ' + path.join('tests', name));
    console.log('  This is not a real recording - it only opens a page and stops,');
    console.log('  so it cannot tell you whether anything works.');
    console.log('  Record it again:  kryptheon record <url>');
  }

  if (!triage.runnable.length) {
    console.log('');
    console.log('  Nothing could be checked.');
    console.log('');
    console.log('  None of the files in tests/ is a usable recording.');
    console.log('  Record one with:  kryptheon record <url>');
    console.log('');
    return 1;
  }

  if (!ensureBrowser()) return 1;

  // Only the usable recordings are handed to the test runner, so a file that
  // cannot produce diagnostics can never be counted as passing.
  const only = triage.runnable.map((name) => path.join('tests', name).split(path.sep).join('/'));
  const status = runPlaywright(['test', '--config', CONFIG].concat(only)).status;

  // Without this, a green summary could still hide a recording that checked
  // nothing at all.
  if (triage.notRecordings.length) {
    const many = triage.notRecordings.length > 1;
    console.log(
      '  Note: ' + triage.notRecordings.length + ' recording' + (many ? 's' : '') +
        ' above checked nothing and ' + (many ? 'were' : 'was') + ' skipped.'
    );
    console.log('');
  }
  return status;
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
    console.log('  Run "kryptheon check" once and they will be saved automatically.');
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
  console.log('    kryptheon accept "<name>"');
  console.log('');
  return 0;
}

function accept(name) {
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
    console.error('  Run "kryptheon accept" on its own to see the names.');
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
    case 'check':
      return finishWith(check());
      break;
    case 'accept':
      return finishWith(accept(rest.join(' ').trim()));
      break;
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
  record: record,
  finaliseRecording: finaliseRecording,
  takeOutSecrets: takeOutSecrets,
  reportReplayRisks: reportReplayRisks,
  offerToDropLogout: offerToDropLogout,
  looksLikeNoDesktop: looksLikeNoDesktop,
  classifyFetchError: classifyFetchError,
  normaliseRecordUrl: normaliseRecordUrl,
  isLocalAddress: isLocalAddress,
  nodeIsTooOld: nodeIsTooOld,
};

if (require.main === module) main();
