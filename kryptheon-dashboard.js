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
    what: 'Attacks a copy of your Postgres/Supabase database (npx kryptheon-night). Needs a connection string, so it is run from the terminal and read here.' },
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

function countRecordings(root) {
  try {
    return fs.readdirSync(path.join(root, 'tests')).filter((n) => /\.(spec|test)\.[cm]?[jt]s$/.test(n)).length;
  } catch (err) {
    return 0;
  }
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
        // The run's history keeps what broke, not the paste-ready prompt; the
        // terminal report has that. Said on the page rather than invented here.
        fixPrompt: '',
        fixWhere: 'npx kryptheon check prints the prompt for this one',
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
        detail: f.sink + ': ' + f.expression,
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

  const rank = { 'HIGH CRITICAL': 0, CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  findings.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) ||
    (a.status === 'confirmed' ? 0 : 1) - (b.status === 'confirmed' ? 0 : 1));

  const recordings = countRecordings(root);
  const checks = CHECKS.map((c) => {
    let state;
    if (!c.available) state = 'not available';
    else if (!config.enabled[c.id]) state = 'switched off';
    else if (c.id === 'regression') state = !recordings ? 'no recordings yet' : !lastRun ? 'never run' : lastRun.failed ? 'problems found' : 'last run held';
    else if (c.id === 'frontend') state = !code ? 'never run' : (code.findings || []).length ? 'things to check' : 'nothing found';
    else if (c.id === 'data') state = !night ? 'never run here' : (night.findings || []).length ? 'problems found' : 'last run held';
    return {
      id: c.id, label: c.label, available: c.available, enabled: config.enabled[c.id], state: state, what: c.what || '',
      // Runnable from the page: what needs nothing the page cannot supply. The
      // database check needs a connection string, which stays in the terminal.
      runnable: c.available && (c.id === 'frontend' || (c.id === 'regression' && recordings > 0)),
    };
  });

  return {
    project: { name: path.basename(root), root: root, storeDir: paths.dir },
    checks: checks,
    findings: findings,
    runs: history.slice().reverse().map((r) => ({ runAt: r.runAt, status: r.status, passed: r.passed, failed: r.failed, durationMs: r.durationMs })),
    recordings: recordings,
    baselines: Object.keys(baselines).length,
    changes: recentChanges(root),
    // Part 3 is where a version gets verified. Until then this says so,
    // rather than leaving a blank that could be read either way.
    verification: { state: 'not verified', why: 'Kryptheon Verified is not built yet. No version of this project has been verified.' },
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
  let running = false;

  const allowedHosts = () => new Set(['127.0.0.1:' + port, 'localhost:' + port]);
  const send = (res, code, type, body) => {
    res.writeHead(code, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // The page loads nothing from anywhere else, and says so.
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(body);
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
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(res, 200, buildState(root, env));
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
        if (url.pathname === '/api/run' && typeof opts.run === 'function') {
          const id = String(input.id || '');
          const check = buildState(root, env).checks.find((c) => c.id === id);
          if (!check || !check.runnable || !check.enabled) {
            return json(res, 400, { ok: false, why: (check ? check.label : '"' + id + '"') + ' cannot be run from here' });
          }
          // One run at a time: two browsers replaying the same flows against
          // one app would interfere, and the results would describe neither.
          if (running) return json(res, 409, { ok: false, why: 'a run is already going' });
          running = true;
          return Promise.resolve(opts.run(id)).finally(() => { running = false; }).then(
            (r) => json(res, r && r.ok ? 200 : 400, r || { ok: false }),
            (err) => json(res, 500, { ok: false, why: err.message }),
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
  readConfig: readConfig,
  setCheck: setCheck,
  createServer: createServer,
};
