// The local dashboard: one page on this machine that shows everything
// Kryptheon knows about one project, and switches its checks on and off.
//
//   npx kryptheon            (in a terminal)  or  npx kryptheon dashboard
//
// Everything here reads the project's store (kryptheon-store.js); nothing is
// kept anywhere else, and nothing leaves the machine. The server listens on
// 127.0.0.1 only.
//
// Two rules the page is built around:
//
// - A check that does not exist yet is shown as "not available". Never as
//   passed, never as green, never counted. An empty row that looks like a
//   clean one is the most expensive lie this product could tell.
// - Every value shown comes from a file that may hold text from the app being
//   checked - a failing page's heading, a line of the app's own code. The page
//   writes all of it with textContent, so the dashboard cannot become the XSS
//   it is there to find. Its own code is read by kryptheon-code.js in its check.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const store = require('./kryptheon-store.js');
const changes = require('./kryptheon-changes.js');

/**
 * Every check the dashboard knows the name of, in the order the person asked
 * for them. `available` is true only for what is actually built. What runs it
 * and where its results come from is said here, once.
 */
const CHECKS = [
  { id: 'regression', label: 'Regression (recorded flows)', available: true,
    what: 'Replays every recording in tests/ and compares each page with the last time it worked.' },
  { id: 'frontend', label: 'Frontend: text inserted as HTML', available: true,
    what: 'Reads your frontend code for values put into the page with innerHTML and similar (npx kryptheon code).' },
  { id: 'data', label: 'Database: access rules, duplicates, orphans', available: true,
    what: 'Attacks a copy of your Postgres/Supabase database (kryptheon-night). Paste the connection string in Start here; it is used for one run and never saved.' },
  { id: 'build', label: 'Build', available: false },
  { id: 'backend', label: 'Backend', available: false },
  { id: 'api', label: 'API', available: false },
  { id: 'integration', label: 'Integration', available: false },
  { id: 'dependency', label: 'Dependencies', available: false },
  { id: 'runtime', label: 'Runtime', available: false },
  { id: 'performance', label: 'Performance', available: false },
  { id: 'edge', label: 'Input and edge cases', available: false },
  { id: 'reliability', label: 'Reliability', available: false },
  { id: 'synthetic', label: 'Synthetic test users', available: false },
  { id: 'eligibility', label: 'Age and eligibility rules', available: false },
];

const CHECK_IDS = new Set(CHECKS.map((c) => c.id));

function readJson(file) {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function readHistory(file, keep) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return [];
  }
  const runs = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      runs.push(JSON.parse(line));
    } catch (err) {
      /* a damaged line is skipped, not fatal */
    }
  }
  return runs.slice(-keep);
}

/** Which checks are switched on. Available checks default to on; others can never be. */
function readConfig(paths) {
  const saved = readJson(paths.config) || {};
  const enabled = {};
  for (const c of CHECKS) {
    enabled[c.id] = c.available ? (saved.enabled && typeof saved.enabled[c.id] === 'boolean' ? saved.enabled[c.id] : true) : false;
  }
  return { enabled: enabled };
}

/**
 * Switches one check on or off, and keeps it. Refuses what does not exist and
 * what is not built: a "not available" check switched on would read as a
 * promise that something is being checked.
 */
function setCheck(paths, id, on) {
  if (!CHECK_IDS.has(id)) return { ok: false, why: 'there is no check called "' + id + '"' };
  const check = CHECKS.find((c) => c.id === id);
  if (!check.available) return { ok: false, why: check.label + ' is not available yet, so it cannot be switched on' };
  if (typeof on !== 'boolean') return { ok: false, why: 'on must be true or false' };
  const config = readConfig(paths);
  config.enabled[id] = on;
  fs.mkdirSync(path.dirname(paths.config), { recursive: true });
  fs.writeFileSync(paths.config, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return { ok: true, config: config };
}

/** What git says changed, read only. Null when this is not a git repository. */
function recentChanges(root) {
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000 });
    return r.status === 0 ? String(r.stdout || '') : null;
  };
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.trim() !== 'true') return null;
  const log = git(['log', '-5', '--pretty=format:%h%x09%cI%x09%s']) || '';
  const status = git(['status', '--porcelain']) || '';
  return {
    commits: log.split('\n').filter(Boolean).map((l) => {
      const [hash, when, subject] = l.split('\t');
      return { hash: hash, when: when, subject: subject };
    }),
    uncommitted: status.split('\n').filter(Boolean).map((l) => ({ state: l.slice(0, 2).trim(), file: l.slice(3) })),
  };
}

/** "  -  the risky part: x" for a frontend finding that names one, else "". */
function riskyPartsLine(f) {
  const parts = (f.parts || []).filter((p) => p && p.text && p.text !== f.expression);
  if (!parts.length) return '';
  return '  -  the risky part' + (parts.length === 1 ? ': ' : 's: ') + parts.map((p) => p.text).join(', ');
}

/** When this flow last passed, from the run history, or null. */
function lastPassOf(history, title) {
  for (let i = history.length - 1; i >= 0; i--) {
    const t = (history[i].tests || []).find((x) => x.title === title);
    if (t && t.status === 'passed') return history[i].runAt;
  }
  return null;
}

/**
 * The fix prompt for a broken recorded flow, from what the run kept: what was
 * seen, what was expected, where, the evidence, and how to see it again. Only
 * what the run recorded is said; nothing is guessed.
 */
function flowPrompt(t, lastPass) {
  const f = t.failure || {};
  const o = f.observations || {};
  const file = String(f.file || t.specFile || 'tests').split('\\').join('/');
  const extra = String(f.rawMessage || '').split(/\r?\n/).slice(1)
    .map((l) => l.trim()).filter((l) => l && !/^\s*at\s/.test(l) && l.length < 200).slice(0, 6);
  const lines = [
    'My app has a broken flow. Please fix the app - and nothing else.',
    '',
    'Kryptheon replayed the recorded flow "' + t.title + '" (' + file + (f.line ? ', line ' + f.line : '') + ') and it failed.',
    '',
    'Observed: ' + (f.plainLanguage || 'the replay failed'),
  ].concat(extra.map((l) => '  ' + l), [
    'Expected: the same result as ' + (lastPass ? 'the last time it passed (' + lastPass + ')' : 'when it was recorded') + '.',
  ]);
  if (o.url) lines.push('Where: the browser was on ' + o.url + (o.pageShowed ? ', and the page showed ' + o.pageShowed : '') + '.');
  if (f.locator) lines.push('Step that failed: ' + f.locator);
  if (o.failedRequests && o.failedRequests.length) lines.push('Failed requests: ' + o.failedRequests.slice(0, 5).map((r) => (r.method || 'GET') + ' ' + (r.path || r.url) + ' -> ' + r.status).join('; '));
  if (o.consoleErrors && o.consoleErrors.length) lines.push('Console errors: ' + o.consoleErrors.slice(0, 3).join(' | '));
  if (f.screenshot) lines.push('Evidence: a screenshot of the failure at ' + f.screenshot);
  lines.push('');
  lines.push('To see it yourself: open ' + (o.url || 'the app') + ' and repeat the steps in ' + file + ', or run  npx kryptheon check');
  lines.push('');
  lines.push('Fix the app so this flow works again. Do not edit the recording to make it pass. If the new behaviour ' +
    'is intended, say so instead of changing code - it can be accepted with  npx kryptheon accept "' + t.title + '"');
  return lines.join('\n');
}

function countRecordings(root) {
  try {
    return fs.readdirSync(path.join(root, 'tests')).filter((n) => /\.(spec|test)\.[cm]?[jt]s$/.test(n)).length;
  } catch (err) {
    return 0;
  }
}

/**
 * The order someone new should go in, one step at a time. A step is "done"
 * only when it has actually run and left a record - never because nothing was
 * found - and a switched-off check says "off", so an empty list is never read
 * as a clean one.
 */
// How often a step is done. Said on every step and button, because the two
// kinds are done at different moments and mixing them up is how a check stops
// being run: "one time" is setting up, "after every change" is the habit.
const ONE_TIME = 'one time';
const EVERY_CHANGE = 'after every change';

function startSteps(checks, seen) {
  const on = (id) => (checks.find((c) => c.id === id) || {}).enabled;
  const nightly = seen.nightly || null;
  return [
    {
      id: 'frontend',
      title: 'Read your frontend code',
      when: EVERY_CHANGE,
      why: 'Finds places where text could be put into your page as HTML. Needs nothing from you.',
      state: !on('frontend') ? 'off' : seen.codeAt ? 'done' : 'todo',
      at: seen.codeAt,
      action: on('frontend') ? { kind: 'run', check: 'frontend', label: seen.codeAt ? 'Read it again' : 'Read my code', command: RUN_COMMAND.frontend } : null,
    },
    {
      id: 'record',
      title: 'Record your main flows',
      when: ONE_TIME,
      whenMore: 'again only when that flow changes',
      // The lesson of a test where 26 bugs were planted before recording and
      // none was caught: what is recorded is taken as right.
      why: 'Sign up, log in, pay - do each once while Kryptheon watches. Record while your app works: what it sees is taken as right, so a bug already there when you record becomes part of "working". Start your app first, then put its address here.',
      state: seen.recordings ? 'done' : 'todo',
      at: null,
      count: seen.recordings,
      action: { kind: 'record', label: seen.recordings ? 'Record another' : 'Record', command: 'npx kryptheon record <your app address>' },
    },
    {
      id: 'regression',
      title: 'Replay them',
      when: EVERY_CHANGE,
      why: 'Runs every recording against your app and compares each page with the last time it worked. Start your app first.',
      state: !on('regression') ? 'off' : !seen.recordings ? 'waiting' : seen.lastRunAt ? 'done' : 'todo',
      at: seen.lastRunAt,
      action: on('regression') && seen.recordings ? { kind: 'run', check: 'regression', label: seen.lastRunAt ? 'Replay again' : 'Replay now', command: RUN_COMMAND.regression } : null,
    },
    {
      id: 'connect',
      title: 'Connect your database',
      when: ONE_TIME,
      why: 'Paste your connection string - the steps are next to the box. It goes only to this dashboard on your machine and to kryptheon-night for the length of one run. It is never saved and never shown again; reload the page and it is gone. Try it on a test project first.',
      state: !on('data') ? 'off' : seen.nightAt ? 'done' : 'todo',
      at: null,
      action: on('data') ? { kind: 'connect' } : null,
    },
    {
      id: 'data',
      title: 'Check your database',
      when: EVERY_CHANGE,
      why: 'Attacks a copy inside your Postgres or Supabase database and reports what got in; your own rows are not touched. You are shown exactly what it will do, and it waits for your yes.',
      state: !on('data') ? 'off' : seen.nightAt ? 'done' : 'todo',
      at: seen.nightAt,
      action: on('data') ? { kind: 'db', action: 'scan', label: 'Check my database', command: DB_ACTIONS.scan.command } : null,
    },
    {
      id: 'nightly',
      title: 'Check it every night',
      when: ONE_TIME,
      // Offered, never pressed for: an app can be checked well without it,
      // so it is not what "do this next" points at.
      optional: true,
      why: 'Sets the same check up inside your database, to run by itself every night, and keeps the answer there for this page. It stays until you remove it.',
      state: !on('data') ? 'off' : nightly && nightly.installed && nightly.active ? 'done' : 'todo',
      at: nightly && nightly.ranAt ? nightly.ranAt : null,
      action: on('data') ? { kind: 'nightly', installed: Boolean(nightly && nightly.installed), at: nightly ? nightly.scheduled || null : null } : null,
    },
  ];
}

/**
 * The one thing to do now. Open confirmed problems come before everything; then
 * the first step not taken; then what only needs a look; then nothing.
 */
function nextAction(findings, steps) {
  const confirmed = findings.filter((f) => f.status === 'confirmed').length;
  const toVerify = findings.length - confirmed;
  if (confirmed) {
    return { kind: 'fix', view: 'findings', count: confirmed,
      title: confirmed === 1 ? 'Fix 1 confirmed problem' : 'Fix ' + confirmed + ' confirmed problems' };
  }
  const step = steps.find((s) => s.state === 'todo' && !s.optional);
  if (step) return { kind: 'step', step: step.id, title: step.title };
  if (toVerify) {
    return { kind: 'verify', view: 'findings', count: toVerify,
      title: toVerify === 1 ? 'Look at 1 thing to verify' : 'Look at ' + toVerify + ' things to verify' };
  }
  return { kind: 'quiet', title: 'Nothing open' };
}

/**
 * One sentence about the nightly run inside the database, or null when
 * kryptheon-night has never been asked. Its four states are four different
 * answers, and none of the other three may read as "nothing found": not set
 * up, set up and never run, set up with nothing scheduled, and stopped.
 */
function nightlyLine(nightly) {
  if (!nightly) return null;
  const day = (iso) => String(iso || '').slice(0, 16).replace('T', ' ');
  const read = ' (as of ' + day(nightly.readAt) + ')';
  if (!nightly.installed) return 'Nightly run in your database: not set up. Press "Set up nightly check" in Start here.' + read;
  const idle = nightly.active ? '' : ' Nothing is scheduled, so it is not running - press "Set it up again" in Start here.';
  if (!nightly.ranAt) return 'Nightly run in your database: set up, and it has not run yet.' + idle + read;
  const when = 'Nightly run in your database, ' + day(nightly.ranAt) + ': ';
  if (nightly.stopped) return when + 'it could not check - ' + nightly.stopped + idle + read;
  const n = (nightly.findings || []).length;
  const skipped = (nightly.notChecked || []).length;
  return when + (n ? n + (n === 1 ? ' problem found.' : ' problems found.')
    : 'nothing got through ' + (nightly.attacksRun || 0) + ' attacks.') +
    (skipped ? ' ' + skipped + ' ' + (skipped === 1 ? 'part was' : 'parts were') + ' not tested.' : '') + idle + read;
}

/**
 * Everything the page shows, from the store alone. Findings from every check
 * are put into one list, each carrying the same fields - severity, status,
 * evidence, confidence, where, what, and the fix - so the page can show them
 * the same way whichever check found them.
 */
function buildState(root, env) {
  const paths = store.pathsFor(root, env);
  const config = readConfig(paths);
  const history = readHistory(paths.history, 20);
  const baselines = readJson(paths.baselines) || {};
  const code = readJson(paths.codeFindings);
  const night = readJson(paths.nightLast);
  // What the nightly run inside the database last said, kept by
  // kryptheon-night whenever it connects. Not the same answer as night:
  // that one is the scan last run from this terminal.
  const nightly = readJson(paths.nightNightly);

  const findings = [];

  // Recorded flows: the last run's broken tests are the findings. They were
  // replayed in a real browser, so they are confirmed at runtime.
  const lastRun = history.length ? history[history.length - 1] : null;
  if (lastRun && config.enabled.regression) {
    for (const t of lastRun.tests || []) {
      if (t.status !== 'failed' && t.status !== 'timedOut') continue;
      findings.push({
        check: 'regression',
        severity: 'HIGH',
        status: 'confirmed',
        evidence: 'runtime confirmed',
        confidence: 'high',
        where: String((t.failure && t.failure.file) || t.specFile || 'tests').split('\\').join('/') +
          (t.failure && t.failure.line ? ':' + t.failure.line : ''),
        headline: 'The recorded flow "' + t.title + '" broke.',
        detail: (t.failure && t.failure.plainLanguage) || '',
        fixPrompt: flowPrompt(t, lastPassOf(history, t.title)),
        when: lastRun.runAt,
      });
    }
  }

  if (code && config.enabled.frontend) {
    for (const f of code.findings || []) {
      findings.push({
        check: 'frontend',
        severity: f.severity,
        status: f.status,
        evidence: f.evidence,
        confidence: f.confidence,
        where: f.file + ':' + f.line,
        headline: f.headline,
        // The part of a long template that decides it, so the person reading
        // it looks at one value instead of sixty lines of markup.
        detail: f.sink + ': ' + f.expression + riskyPartsLine(f),
        fixPrompt: f.fixPrompt,
        when: code.checkedAt,
      });
    }
  }

  let nightWhen = null;
  try {
    nightWhen = fs.statSync(paths.nightLast).mtime.toISOString();
  } catch (err) {
    /* never run */
  }
  if (night && config.enabled.data) {
    for (const f of night.findings || []) {
      findings.push({
        check: 'data',
        severity: f.severity,
        status: f.status || 'confirmed',
        evidence: (f.status || 'confirmed') === 'confirmed' ? 'runtime confirmed' : 'code analysis',
        confidence: (f.status || 'confirmed') === 'confirmed' ? 'high' : 'medium',
        where: f.table + (f.column ? '.' + f.column : ''),
        headline: f.headline,
        detail: f.body || '',
        fixPrompt: f.fixPrompt || '',
        when: nightWhen,
      });
    }
  }

  // The nightly run's findings, said as coming from it. One both answers
  // share is shown once, with the newer date - the same problem found twice
  // is still one problem to fix.
  if (nightly && nightly.ranAt && config.enabled.data) {
    for (const f of nightly.findings || []) {
      const item = {
        check: 'data',
        from: 'nightly',
        severity: f.severity,
        status: f.status || 'confirmed',
        evidence: (f.status || 'confirmed') === 'confirmed' ? 'runtime confirmed' : 'code analysis',
        confidence: (f.status || 'confirmed') === 'confirmed' ? 'high' : 'medium',
        where: f.table + (f.column ? '.' + f.column : ''),
        headline: f.headline,
        detail: f.body || '',
        fixPrompt: f.fixPrompt || '',
        when: nightly.ranAt,
      };
      const same = findings.find((o) => o.check === 'data' && changes.findingKey(o) === changes.findingKey(item));
      if (!same) findings.push(item);
      else {
        same.from = 'both';
        if (!same.when || item.when > same.when) same.when = item.when;
      }
    }
  }

  const rank = { 'HIGH CRITICAL': 0, CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  findings.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) ||
    (a.status === 'confirmed' ? 0 : 1) - (b.status === 'confirmed' ? 0 : 1));

  // Every finding gets a short id and the last word of its fix prompt: how to
  // prove the fix. Added here, where the loop lives, so every check's prompt
  // ends the same way and the detection code itself stays untouched.
  const attempts = readHistory(paths.fixes, 500);
  for (const f of findings) {
    f.id = changes.findingId(f);
    f.attempts = attempts.filter((a) => a.id === f.id).map((a) => ({ at: a.at, verdict: a.verdict, why: a.why || '', newProblems: (a.newProblems || []).length }));
    if (f.fixPrompt) {
      f.fixPrompt += '\n\nWhen you have fixed it, prove it: run  npx kryptheon recheck ' + f.id +
        '  (or press Re-check on this finding in the Kryptheon dashboard). It is fixed only when that says FIXED.';
    }
  }
  // Fixes that were proven, newest first, while their finding is still gone.
  const open = new Set(findings.map((f) => f.id));
  const proven = attempts.filter((a) => a.verdict === 'fixed' && !open.has(a.id)).reverse().slice(0, 10)
    .map((a) => ({ id: a.id, at: a.at, where: a.where, headline: a.headline, newProblems: (a.newProblems || []).length }));

  const recordings = countRecordings(root);
  const checks = CHECKS.map((c) => {
    let state;
    if (!c.available) state = 'not available';
    else if (!config.enabled[c.id]) state = 'switched off';
    else if (c.id === 'regression') state = !recordings ? 'no recordings yet' : !lastRun ? 'never run' : lastRun.failed ? 'problems found' : 'last run held';
    else if (c.id === 'frontend') state = !code ? 'never run' : (code.findings || []).length ? 'things to check' : 'nothing found';
    else if (c.id === 'data') {
      const ranNightly = nightly && nightly.ranAt && !nightly.stopped;
      state = !night && !ranNightly ? 'never run here'
        : findings.some((f) => f.check === 'data') ? 'problems found' : 'last run held';
    }
    return {
      id: c.id, label: c.label, available: c.available, enabled: config.enabled[c.id], state: state, what: c.what || '',
      nightly: c.id === 'data' ? nightlyLine(nightly) : null,
      // Runnable from the page: what needs nothing the page cannot supply. The
      // database check needs a connection string, which stays in the terminal.
      runnable: c.available && (c.id === 'frontend' || (c.id === 'regression' && recordings > 0)),
    };
  });

  const steps = startSteps(checks, {
    codeAt: code ? code.checkedAt : null,
    recordings: recordings,
    lastRunAt: lastRun ? lastRun.runAt : null,
    nightAt: [night ? nightWhen : null, nightly && nightly.ranAt].filter(Boolean).sort().pop() || null,
    nightly: nightly,
  });

  // Every look Kryptheon took - by `verify`, or by the dashboard's own watch -
  // newest first: what changed, what was run, and what came of it.
  const looks = readHistory(paths.changes, 15).reverse().map((e) => ({
    at: e.at,
    by: e.by || 'verify',
    first: !!e.first,
    files: (e.files || []).slice(0, 30),
    fileCount: (e.files || []).length,
    parts: e.parts || [],
    dependencies: e.dependencies || [],
    checks: e.checks || [],
    newFindings: e.newFindings || 0,
    fixed: e.fixed || 0,
    goneWithFile: e.goneWithFile || 0,
  }));

  return {
    project: { name: path.basename(root), root: root, storeDir: paths.dir },
    looks: looks,
    proven: proven,
    checks: checks,
    findings: findings,
    runs: history.slice().reverse().map((r) => ({ runAt: r.runAt, status: r.status, passed: r.passed, failed: r.failed, durationMs: r.durationMs })),
    recordings: recordings,
    steps: steps,
    next: nextAction(findings, steps),
    baselines: Object.keys(baselines).length,
    changes: recentChanges(root),
    // Part 3 is where a version gets verified. Until then this says so,
    // rather than leaving a blank that could be read either way.
    verification: { state: 'not verified', why: 'Kryptheon Verified is not built yet. No version of this project has been verified.' },
  };
}

/* --------------------------------------------------------------------------
   Jobs: what the page starts, one at a time, with its progress and its end.
-------------------------------------------------------------------------- */

// What each run is called on the page, and the command that does the same in
// a terminal - shown under every button, for when the page cannot be used.
const RUN_TITLE = { frontend: 'Reading your code', regression: 'Replaying your recordings' };
const RUN_COMMAND = { frontend: 'npx kryptheon code', regression: 'npx kryptheon check' };
const DB_ACTIONS = {
  scan: { title: 'Checking your database', command: 'npx kryptheon-night' },
  install: { title: 'Setting up the nightly check', command: 'npx kryptheon-night install' },
  night: { title: 'Reading last night\'s result', command: 'npx kryptheon-night night' },
  uninstall: { title: 'Removing the nightly check', command: 'npx kryptheon-night uninstall' },
  recheck: { title: 'Re-checking in your database', command: 'npx kryptheon-night' },
};

/**
 * What a fresh database check says about one database finding. Fixed only
 * when the check ran, the finding is gone, and nothing about its table went
 * untested - a table that could not be tested loses its findings too, and
 * that is not a fix. A finding still shown only from the nightly run is the
 * nightly run's older answer, not this one's.
 */
function databaseVerdict(target, before, after, ran, saved) {
  const tableOf = (where) => String(where || '').split('.')[0];
  let verdict;
  let why = '';
  const untested = ((saved && saved.notChecked) || []).find((n) => tableOf(n.table) === tableOf(target.where));
  if (!ran || !ran.ok) {
    verdict = 'could not confirm';
    why = (ran && ran.why) || 'the database check could not run';
  } else if (after.some((f) => f.id === target.id && f.from !== 'nightly')) {
    verdict = 'still open';
  } else if (untested) {
    verdict = 'could not confirm';
    why = 'part of ' + tableOf(target.where) + ' could not be tested this time: ' + untested.why;
  } else {
    verdict = 'fixed';
  }
  const had = new Set(before.map((f) => f.id));
  return {
    id: target.id,
    at: new Date().toISOString(),
    check: 'data',
    where: target.where,
    headline: target.headline,
    verdict: verdict,
    why: why,
    newProblems: after.filter((f) => !had.has(f.id) && f.check === 'data').map((f) => ({
      id: f.id, check: f.check, severity: f.severity, status: f.status, where: f.where, headline: f.headline,
    })),
  };
}
const JOB_LINES = 400;

/**
 * The address to record, or null. Refused: anything that is not one line,
 * anything that could be read as an option by the command it is passed to,
 * and anything with a scheme other than http(s).
 */
function appAddress(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 2000 || /[\s\x00-\x1f]/.test(text) || text.startsWith('-')) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return /^https?:\/\/[^/]/i.test(text) ? text : null;
  return /^[a-z0-9.-]+(:\d{1,5})?(\/\S*)?$/i.test(text) ? text : null;
}

/** The connection string as given, or null when there is none or it is absurd. */
function connectionFrom(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= 4000 ? text : null;
}

/**
 * Every form in which a connection string could leak back out: the whole
 * string, without the quotes it may have been pasted with, and its password
 * both as typed and decoded. Longest first, so a password inside the whole
 * string is never left half-hidden.
 */
function secretsOf(connection) {
  const raw = String(connection || '').trim();
  if (!raw) return [];
  const found = [raw, raw.replace(/^["']|["']$/g, '')];
  try {
    const password = new URL(found[1]).password;
    if (password) {
      found.push(password);
      try { found.push(decodeURIComponent(password)); } catch (err) { /* kept as typed */ }
    }
  } catch (err) {
    /* not a URL: the string itself is still hidden */
  }
  return Array.from(new Set(found.filter((s) => s.length >= 4))).sort((a, b) => b.length - a.length);
}

function hideSecrets(text, secrets) {
  let out = String(text);
  for (const s of secrets || []) out = out.split(s).join('[hidden]');
  return out;
}

/** The same, through every string in a value. */
function hideSecretsIn(value, secrets) {
  if (!secrets || !secrets.length) return value;
  if (typeof value === 'string') return hideSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((v) => hideSecretsIn(v, secrets));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = hideSecretsIn(value[k], secrets);
    return out;
  }
  return value;
}

/**
 * The one job that may run, and the last one that did. Its lines are what the
 * work said as it went, scrubbed of any secret it was given before they are
 * kept; when it ends, the secrets are let go.
 */
function createJobs() {
  let current = null;
  let count = 0;
  const view = (job) => job && {
    id: job.id, kind: job.kind, title: job.title, command: job.command,
    startedAt: job.startedAt, endedAt: job.endedAt, running: job.running,
    lines: job.lines.slice(), result: job.result,
  };
  return {
    get: () => view(current),
    busy: () => Boolean(current && current.running),
    start(kind, title, command, work, givenSecrets) {
      if (current && current.running) return null;
      let secrets = givenSecrets || [];
      const job = {
        id: ++count, kind: kind, title: title, command: command || '',
        startedAt: new Date().toISOString(), endedAt: null, running: true, lines: [], result: null,
      };
      current = job;
      const say = (text) => {
        if (!job.running) return;
        // Colour codes are for terminals; on the page they are noise.
        const clean = hideSecrets(String(text == null ? '' : text), secrets).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
        for (const line of clean.split(/\r?\n/)) job.lines.push(line.slice(0, 500));
        if (job.lines.length > JOB_LINES) job.lines.splice(0, job.lines.length - JOB_LINES);
      };
      const finish = (result) => {
        job.result = hideSecretsIn(result && typeof result === 'object' ? result : { ok: false, why: 'the run gave no answer' }, secrets);
        job.running = false;
        job.endedAt = new Date().toISOString();
        secrets = null;
      };
      Promise.resolve()
        .then(() => work(say))
        .then(finish, (err) => finish({ ok: false, why: err && err.message ? err.message : String(err) }));
      return view(job);
    },
  };
}

/**
 * The server. Local only, and closed to other web pages:
 *   - it listens on 127.0.0.1, never on the network;
 *   - it answers only when the Host header is this address, so a page on some
 *     other site cannot reach it through DNS rebinding;
 *   - anything that changes something needs the token that is written into the
 *     page this server hands out, which another site cannot read.
 */
function createServer(root, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const token = crypto.randomBytes(24).toString('hex');
  const page = fs.readFileSync(path.join(__dirname, 'kryptheon-dashboard.html'), 'utf8');
  let port = 0;
  const jobs = createJobs();

  const allowedHosts = () => new Set(['127.0.0.1:' + port, 'localhost:' + port]);
  const send = (res, code, type, body) => {
    res.writeHead(code, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // The page loads nothing from anywhere else, and says so.
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(body);
  };
  // Files served as they are from next to this one. A missing one is a
  // missing picture or font, never a stopped dashboard.
  const ASSETS = {
    '/logo.png': ['image/png', opts.logoFile || path.join(__dirname, 'kryptheon-logo.png')],
    '/fonts/archivo.woff2': ['font/woff2', path.join(__dirname, 'kryptheon-archivo.woff2')],
    '/fonts/spacemono.woff2': ['font/woff2', path.join(__dirname, 'kryptheon-spacemono.woff2')],
  };
  const json = (res, code, value) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(value));

  const server = http.createServer((req, res) => {
    if (!allowedHosts().has(String(req.headers.host || ''))) return send(res, 403, 'text/plain', 'Forbidden');
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, 'text/html; charset=utf-8', page.replace('%%TOKEN%%', token));
    }
    if (req.method === 'GET' && url.pathname === '/dashboard.js') {
      return send(res, 200, 'text/javascript; charset=utf-8', fs.readFileSync(path.join(__dirname, 'kryptheon-dashboard-page.js'), 'utf8'));
    }
    if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(ASSETS, url.pathname)) {
      const [type, file] = ASSETS[url.pathname];
      let body;
      try {
        body = fs.readFileSync(file);
      } catch (err) {
        return send(res, 404, 'text/plain', 'Not found');
      }
      return send(res, 200, type, body);
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(res, 200, buildState(root, env));
    }
    if (req.method === 'GET' && url.pathname === '/api/job') {
      return json(res, 200, { job: jobs.get() });
    }
    if (req.method === 'POST') {
      if (req.headers['x-kryptheon-token'] !== token) return json(res, 403, { ok: false, why: 'missing or wrong token' });
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 10000) req.destroy();
      });
      req.on('end', () => {
        let input;
        try {
          input = JSON.parse(body || '{}');
        } catch (err) {
          return json(res, 400, { ok: false, why: 'not JSON' });
        }
        if (url.pathname === '/api/check') {
          const r = setCheck(store.pathsFor(root, env), String(input.id || ''), input.on);
          return json(res, r.ok ? 200 : 400, r);
        }
        // Everything below starts a job: it answers at once with the job, and
        // the page follows it on /api/job. One at a time - two browsers
        // replaying against one app, or two attacks on one database, would
        // interfere, and the results would describe neither.
        const begin = (kind, title, command, work, secrets) => {
          const job = jobs.start(kind, title, command, work, secrets);
          return job ? json(res, 202, { ok: true, job: job }) : json(res, 409, { ok: false, why: 'a run is already going', job: jobs.get() });
        };
        if (url.pathname === '/api/recheck' && typeof opts.recheck === 'function') {
          const id = String(input.id || '');
          if (!/^[0-9a-f]{8}$/.test(id)) return json(res, 400, { ok: false, why: 'not a finding id' });
          const open = buildState(root, env).findings.find((f) => f.id === id);
          if (!open) return json(res, 404, { ok: false, why: 'no open finding with that id' });
          return begin('recheck', 'Re-checking: ' + open.headline, 'npx kryptheon recheck ' + id, (say) => opts.recheck(id, say));
        }
        if (url.pathname === '/api/run' && typeof opts.run === 'function') {
          const id = String(input.id || '');
          const check = buildState(root, env).checks.find((c) => c.id === id);
          if (!check || !check.runnable || !check.enabled) {
            return json(res, 400, { ok: false, why: (check ? check.label : '"' + id + '"') + ' cannot be run from here' });
          }
          return begin('run', RUN_TITLE[id] || check.label, RUN_COMMAND[id] || '', (say) => opts.run(id, say));
        }
        if (url.pathname === '/api/record' && typeof opts.record === 'function') {
          const address = appAddress(input.url);
          if (!address) return json(res, 400, { ok: false, why: 'that is not a web address - it should look like http://localhost:3000' });
          return begin('record', 'Recording ' + address, 'npx kryptheon record ' + address, (say) => opts.record(address, say));
        }
        if (url.pathname === '/api/db' && typeof opts.db === 'function') {
          const action = String(input.action || '');
          if (!DB_ACTIONS[action]) return json(res, 400, { ok: false, why: 'no database action called "' + action + '"' });
          const connection = connectionFrom(input.connection);
          if (!connection) return json(res, 400, { ok: false, why: 'paste your connection string first' });
          if (action === 'recheck') {
            // One database finding, re-checked: the check runs again and that
            // finding is judged, the way `npx kryptheon recheck` judges the rest.
            const id = String(input.id || '');
            if (!/^[0-9a-f]{8}$/.test(id)) return json(res, 400, { ok: false, why: 'not a finding id' });
            const target = buildState(root, env).findings.find((f) => f.id === id && f.check === 'data');
            if (!target) return json(res, 404, { ok: false, why: 'no open database finding with that id' });
            return begin('db', 'Re-checking: ' + target.headline, DB_ACTIONS.recheck.command, (say) => {
              const before = buildState(root, env).findings;
              return Promise.resolve(opts.db('scan', connection, say)).then((ran) => {
                const attempt = databaseVerdict(target, before, buildState(root, env).findings, ran, readJson(store.pathsFor(root, env).nightLast));
                try {
                  fs.appendFileSync(store.pathsFor(root, env).fixes, JSON.stringify(attempt) + '\n', 'utf8');
                } catch (err) {
                  attempt.saveError = err.message;
                }
                return Object.assign({ ok: true, summary: attempt.verdict }, attempt);
              });
            }, secretsOf(connection));
          }
          // Handed to the job and nowhere else. The job's lines and result are
          // scrubbed of it, and it is dropped the moment the job ends.
          return begin('db', DB_ACTIONS[action].title, DB_ACTIONS[action].command,
            (say) => opts.db(action, connection, say), secretsOf(connection));
        }
        if (url.pathname === '/api/db/words' && typeof opts.words === 'function') {
          // What kryptheon-night itself would say about this string - its help,
          // its consent screens, its warnings - asked of it without connecting.
          const connection = input.connection == null || input.connection === '' ? '' : connectionFrom(input.connection);
          if (connection === null) return json(res, 400, { ok: false, why: 'that connection string is too long' });
          const secrets = secretsOf(connection);
          return Promise.resolve(opts.words(connection)).then(
            (words) => json(res, 200, hideSecretsIn({ ok: true, words: words }, secrets)),
            (err) => json(res, 500, hideSecretsIn({ ok: false, why: err.message }, secrets)),
          );
        }
        return json(res, 404, { ok: false, why: 'no such action' });
      });
      return;
    }
    return send(res, 404, 'text/plain', 'Not found');
  });

  return {
    server: server,
    token: token,
    listen(wanted) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(wanted || 0, '127.0.0.1', () => {
          port = server.address().port;
          resolve(port);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = {
  CHECKS: CHECKS,
  buildState: buildState,
  flowPrompt: flowPrompt,
  appAddress: appAddress,
  secretsOf: secretsOf,
  hideSecrets: hideSecrets,
  hideSecretsIn: hideSecretsIn,
  createJobs: createJobs,
  DB_ACTIONS: DB_ACTIONS,
  databaseVerdict: databaseVerdict,
  startSteps: startSteps,
  nextAction: nextAction,
  readConfig: readConfig,
  setCheck: setCheck,
  createServer: createServer,
};
