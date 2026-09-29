// Checks the local dashboard: what it shows, what it refuses, and who can
// reach it. Run with:  node kryptheon-dashboard.check.js
//
// A throwaway project and a scratch store (KRYPTHEON_HOME), so nothing here
// touches the real ~/.kryptheon or a real project.

process.env.KRYPTHEON_HOME = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'kryptheon-home-'));

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const store = require('./kryptheon-store.js');
const dashboard = require('./kryptheon-dashboard.js');
const code = require('./kryptheon-code.js');

const results = [];
const check = (name, problems) => results.push({ name, problems });

// A project with one recording, and a store holding one run of each kind.
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-dash-project-'));
fs.writeFileSync(path.join(project, 'package.json'), '{"name":"shop","private":true}\n', 'utf8');
fs.mkdirSync(path.join(project, 'tests'));
fs.writeFileSync(path.join(project, 'tests', 'checkout.spec.js'), '// a recording\n', 'utf8');
const before = fs.readdirSync(project).sort().join(',');

const kept = store.open(project);
fs.writeFileSync(kept.history, [
  JSON.stringify({ runAt: '2026-09-28T10:00:00.000Z', status: 'passed', passed: 1, failed: 0, tests: [{ title: 'Checkout', status: 'passed' }] }),
  JSON.stringify({ runAt: '2026-09-29T10:00:00.000Z', status: 'failed', passed: 0, failed: 1, tests: [{
    title: 'Checkout', status: 'failed', specFile: 'tests\\checkout.spec.js',
    failure: { line: 7, file: 'tests\\checkout.spec.js', plainLanguage: 'Could not find the Pay button on the page.' },
  }] }),
].join('\n') + '\n', 'utf8');
fs.writeFileSync(kept.codeFindings, JSON.stringify({
  checkedAt: '2026-09-29T11:00:00.000Z',
  findings: [code.describe({ file: 'src/cart.js', line: 12, sink: 'innerHTML', expression: '`<b>${d.name}</b>`', origin: 'network' })],
}), 'utf8');
fs.writeFileSync(kept.nightLast, JSON.stringify({
  findings: [{ severity: 'CRITICAL', status: 'confirmed', table: 'orders', kind: 'exposed', headline: 'Your orders table can be read by anyone.', body: 'I read 2 rows.', fixPrompt: 'Fix the orders rule.' }],
}), 'utf8');

const state = dashboard.buildState(project);

check('every check the person asked for is listed, by name', (() => {
  const want = ['regression', 'frontend', 'data', 'build', 'backend', 'api', 'integration', 'dependency', 'runtime',
    'performance', 'edge', 'reliability', 'synthetic', 'eligibility'];
  const got = state.checks.map((c) => c.id);
  return JSON.stringify(got) === JSON.stringify(want) ? [] : ['got ' + JSON.stringify(got)];
})());

check('a check that is not built says "not available" - never passed, never on', (() => {
  const p = [];
  for (const c of state.checks.filter((x) => !x.available)) {
    if (c.state !== 'not available') p.push(c.id + ' says "' + c.state + '"');
    if (c.enabled) p.push(c.id + ' is switched on');
  }
  if (!state.checks.some((x) => !x.available)) p.push('no check is marked not available at all');
  return p;
})());

check('findings from all three checks arrive, each with severity, status, evidence and confidence', (() => {
  const p = [];
  const by = (id) => state.findings.find((f) => f.check === id);
  for (const id of ['regression', 'frontend', 'data']) {
    const f = by(id);
    if (!f) { p.push('no ' + id + ' finding'); continue; }
    for (const field of ['severity', 'status', 'evidence', 'confidence', 'where', 'headline']) {
      if (!f[field]) p.push(id + ' has no ' + field);
    }
  }
  const reg = by('regression');
  if (reg && reg.where !== 'tests/checkout.spec.js:7') p.push('regression where: ' + reg.where);
  const fe = by('frontend');
  if (fe && fe.status !== 'verification required') p.push('a code-read finding is shown as ' + fe.status);
  const db = by('data');
  if (db && db.evidence !== 'runtime confirmed') p.push('an attack that ran is shown as ' + db.evidence);
  // Worst first, and within one severity a proven break before an unproven one.
  if (state.findings[0] && state.findings[0].severity !== 'CRITICAL') p.push('the first finding is ' + state.findings[0].severity);
  const order = state.findings.map((f) => f.check);
  if (order.indexOf('regression') > order.indexOf('frontend')) {
    p.push('a HIGH that needs verification is listed above a HIGH that was confirmed: ' + JSON.stringify(order));
  }
  return p;
})());

check('a broken recording gets a fix prompt built only from what the run recorded', (() => {
  const reg = state.findings.find((f) => f.check === 'regression');
  if (!reg) return ['no regression finding'];
  const p = [];
  const t = reg.fixPrompt || '';
  if (!/Observed: Could not find the Pay button on the page\./.test(t)) p.push('the observed failure is not in it');
  if (!/tests\/checkout\.spec\.js, line 7/.test(t)) p.push('the recording and line are not in it');
  if (!/last time it passed \(2026-09-28T10:00:00\.000Z\)/.test(t)) p.push('the last pass is not in it');
  if (!/Do not edit the recording/.test(t)) p.push('it does not forbid editing the recording to pass');
  if (!/npx kryptheon recheck [0-9a-f]{8}/.test(t)) p.push('it does not end with how to prove the fix');
  // This run kept no address, requests, errors or screenshot: none may appear.
  for (const [re, what] of [[/Where: the browser/, 'an address'], [/Failed requests/, 'failed requests'], [/Console errors/, 'console errors'], [/screenshot/i, 'a screenshot']]) {
    if (re.test(t)) p.push('it mentions ' + what + ' the run never recorded');
  }
  return p;
})());

check('when the run kept more evidence, the prompt carries it', (() => {
  const t = { title: 'Pay', status: 'failed', specFile: 'tests/pay.spec.js', failure: {
    file: 'tests\\pay.spec.js', line: 4, locator: "getByRole('button', { name: 'Pay' })",
    plainLanguage: 'Could not find the Pay button on the page.',
    rawMessage: 'Error: locator.click\nHeadings that are gone: "Total"',
    screenshot: 'C:/store/test-results/pay/test-failed-1.png',
    observations: { url: 'http://localhost:3000/cart', pageShowed: '"Cart"', failedRequests: [{ method: 'POST', path: '/api/pay', status: 500 }], consoleErrors: ['TypeError: x is undefined'] },
  } };
  const prompt = dashboard.flowPrompt(t, null);
  const p = [];
  for (const want of ['http://localhost:3000/cart', 'POST /api/pay -> 500', 'TypeError: x is undefined', 'test-failed-1.png', 'Headings that are gone: "Total"', "getByRole('button', { name: 'Pay' })", 'when it was recorded']) {
    if (prompt.indexOf(want) === -1) p.push('missing: ' + want);
  }
  return p;
})());

check('runs are listed newest first, and nothing is verified yet', (() => {
  const p = [];
  if (state.runs.length !== 2 || state.runs[0].runAt !== '2026-09-29T10:00:00.000Z') p.push('runs: ' + JSON.stringify(state.runs));
  if (state.verification.state !== 'not verified') p.push('verification: ' + state.verification.state);
  return p;
})());

check('switching a check off keeps it off, in the store, and hides its findings', (() => {
  const p = [];
  const r = dashboard.setCheck(kept, 'frontend', false);
  if (!r.ok) return ['refused: ' + r.why];
  const saved = JSON.parse(fs.readFileSync(kept.config, 'utf8'));
  if (saved.enabled.frontend !== false) p.push('config.json does not say frontend is off');
  const after = dashboard.buildState(project);
  if (after.findings.some((f) => f.check === 'frontend')) p.push('frontend findings still shown while it is off');
  if (after.checks.find((c) => c.id === 'frontend').state !== 'switched off') p.push('frontend is not said to be off');
  dashboard.setCheck(kept, 'frontend', true);
  if (!dashboard.buildState(project).findings.some((f) => f.check === 'frontend')) p.push('switching it back on did not bring them back');
  return p;
})());

check('what cannot be switched is refused, and says why', (() => {
  const p = [];
  if (dashboard.setCheck(kept, 'nonsense', true).ok) p.push('an unknown check was accepted');
  const na = dashboard.setCheck(kept, 'performance', true);
  if (na.ok) p.push('a not-available check was switched on');
  else if (!/not available/.test(na.why)) p.push('the reason does not say not available: ' + na.why);
  if (dashboard.setCheck(kept, 'frontend', 'yes').ok) p.push('a non-boolean was accepted');
  return p;
})());

// "Start here": the steps, in order, and the one thing to do now.
const allOn = dashboard.CHECKS.map((c) => ({ id: c.id, enabled: c.available }));
const stepState = (steps) => steps.map((s) => s.id + ':' + s.state).join(' ');

check('a new project starts at step 1, and nothing is done that has not run', (() => {
  const p = [];
  const steps = dashboard.startSteps(allOn, { codeAt: null, recordings: 0, lastRunAt: null, nightAt: null });
  const want = 'frontend:todo record:todo regression:waiting data:todo';
  if (stepState(steps) !== want) p.push('steps: ' + stepState(steps) + ', wanted ' + want);
  const next = dashboard.nextAction([], steps);
  if (next.kind !== 'step' || next.step !== 'frontend') p.push('next: ' + JSON.stringify(next));
  const replay = steps.find((s) => s.id === 'regression');
  if (replay.action) p.push('with no recordings, replay still offers: ' + JSON.stringify(replay.action));
  return p;
})());

check('each step is done only once it has run, whatever it found, and the next one follows', (() => {
  const p = [];
  const read = dashboard.startSteps(allOn, { codeAt: '2026-09-29T10:00:00.000Z', recordings: 0, lastRunAt: null, nightAt: null });
  if (read[0].state !== 'done') p.push('a read that found nothing is not done: ' + read[0].state);
  if (dashboard.nextAction([], read).step !== 'record') p.push('after the read, next is not recording: ' + JSON.stringify(dashboard.nextAction([], read)));
  const recorded = dashboard.startSteps(allOn, { codeAt: '2026-09-29T10:00:00.000Z', recordings: 2, lastRunAt: null, nightAt: null });
  const replay = recorded.find((s) => s.id === 'regression');
  if (replay.state !== 'todo' || !replay.action || replay.action.check !== 'regression') p.push('recorded but never replayed: ' + JSON.stringify(replay));
  if (dashboard.nextAction([], recorded).step !== 'regression') p.push('next is not replaying');
  const all = dashboard.startSteps(allOn, { codeAt: 'a', recordings: 2, lastRunAt: 'b', nightAt: 'c' });
  if (stepState(all) !== 'frontend:done record:done regression:done data:done') p.push('all run: ' + stepState(all));
  const allowed = new Set(['done', 'todo', 'off', 'waiting']);
  for (const s of [].concat(read, recorded, all)) if (!allowed.has(s.state)) p.push(s.id + ' says ' + s.state);
  return p;
})());

check('a switched-off check is "off" - never done, never asked for next', (() => {
  const p = [];
  const noDb = allOn.map((c) => (c.id === 'data' ? { id: 'data', enabled: false } : c));
  const steps = dashboard.startSteps(noDb, { codeAt: 'a', recordings: 1, lastRunAt: 'b', nightAt: null });
  const db = steps.find((s) => s.id === 'data');
  if (db.state !== 'off') p.push('database step says ' + db.state);
  if (db.action) p.push('an off step still offers ' + JSON.stringify(db.action));
  const next = dashboard.nextAction([], steps);
  if (next.kind !== 'quiet') p.push('with the rest done, next is ' + JSON.stringify(next));
  // Every check that can be switched off, never run and never recorded.
  for (const id of ['frontend', 'regression', 'data']) {
    const off = allOn.map((c) => (c.id === id ? { id: id, enabled: false } : c));
    const s = dashboard.startSteps(off, { codeAt: null, recordings: 1, lastRunAt: null, nightAt: null }).find((x) => x.id === id);
    if (s.state !== 'off') p.push(id + ' switched off says ' + s.state);
    if (s.action) p.push(id + ' switched off still offers ' + JSON.stringify(s.action));
  }
  return p;
})());

check('what to do now: confirmed problems first, then steps, then things to verify, then nothing', (() => {
  const p = [];
  const todo = dashboard.startSteps(allOn, { codeAt: null, recordings: 0, lastRunAt: null, nightAt: null });
  const done = dashboard.startSteps(allOn, { codeAt: 'a', recordings: 1, lastRunAt: 'b', nightAt: 'c' });
  const confirmed = { status: 'confirmed' };
  const verify = { status: 'verification required' };
  const a = dashboard.nextAction([verify, confirmed, confirmed], todo);
  if (a.kind !== 'fix' || a.count !== 2 || a.view !== 'findings') p.push('with confirmed problems: ' + JSON.stringify(a));
  const b = dashboard.nextAction([verify], todo);
  if (b.kind !== 'step') p.push('a step not taken should come before a thing to verify: ' + JSON.stringify(b));
  const c = dashboard.nextAction([verify], done);
  if (c.kind !== 'verify' || c.count !== 1) p.push('only a thing to verify: ' + JSON.stringify(c));
  const d = dashboard.nextAction([], done);
  if (d.kind !== 'quiet') p.push('nothing at all: ' + JSON.stringify(d));
  return p;
})());

check('the page is handed the steps and the next action, built from the store', (() => {
  const p = [];
  if (!Array.isArray(state.steps) || state.steps.length !== 4) return ['steps: ' + JSON.stringify(state.steps)];
  if (state.steps.find((s) => s.id === 'frontend').state !== 'done') p.push('the saved read is not step 1 done');
  if (state.steps.find((s) => s.id === 'regression').state !== 'done') p.push('the saved runs are not step 3 done');
  if (!state.next || state.next.kind !== 'fix') p.push('with a broken recording, next is ' + JSON.stringify(state.next));
  return p;
})());

check('the dashboard writes nothing into the project', (() => {
  const now = fs.readdirSync(project).sort().join(',');
  return now === before ? [] : ['the project now holds: ' + now];
})());

check("the dashboard's own page and code have nothing to report to the frontend check", (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-dash-self-'));
  for (const f of ['kryptheon-dashboard.html', 'kryptheon-dashboard-page.js', 'kryptheon-dashboard.js']) {
    fs.copyFileSync(path.join(__dirname, f), path.join(d, f));
  }
  const r = code.scanProject(d, { packageDir: __dirname });
  fs.rmSync(d, { recursive: true, force: true });
  if (!r.ran) return ['the read did not run: ' + r.why];
  return r.findings.map((f) => f.file + ':' + f.line + ' ' + f.sink + ' ' + f.expression);
})());

// Every request gives up after 10s and says so: a server that never answers
// is a failure, and a check that waits for it for ever reports nothing at all.
function request(port, options, body) {
  return new Promise((resolve) => {
    const req = http.request(Object.assign({ host: '127.0.0.1', port: port }, options), (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ status: -1, body: 'no answer within 10s', headers: {} });
    });
    req.on('error', (err) => resolve({ status: 0, body: err.message, headers: {} }));
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const app = dashboard.createServer(project);
  const port = await app.listen(0);
  try {
    const host = '127.0.0.1:' + port;
    const page = await request(port, { path: '/', headers: { host: host } });
    const token = (page.body.match(/name="kryptheon-token" content="([0-9a-f]+)"/) || [])[1];
    check('the page is served on this machine, with its token and its locks', (() => {
      const p = [];
      if (app.server.address().address !== '127.0.0.1') p.push('listening on ' + app.server.address().address);
      if (page.status !== 200) p.push('GET / answered ' + page.status);
      if (!token || token !== app.token) p.push('the page does not carry this server\'s token');
      if (!/default-src 'none'/.test(page.headers['content-security-policy'] || '')) p.push('no content security policy');
      if (page.headers['access-control-allow-origin']) p.push('it allows other origins: ' + page.headers['access-control-allow-origin']);
      return p;
    })());

    const logo = await request(port, { path: '/logo.png', headers: { host: host } });
    check('the logo the page shows is served by this same server', (() => {
      const p = [];
      if (!/src="\/logo\.png"/.test(page.body)) p.push('the page does not show /logo.png');
      if (logo.status !== 200) p.push('GET /logo.png answered ' + logo.status);
      if (logo.headers['content-type'] !== 'image/png') p.push('served as ' + logo.headers['content-type']);
      if (!/^.PNG/.test(logo.body)) p.push('what came back is not a PNG');
      return p;
    })());

    // The page's two fonts come from this server too - the policy must let
    // them in, and nothing else: no font from anywhere but here.
    const fonts = await Promise.all(['/fonts/archivo.woff2', '/fonts/spacemono.woff2'].map((p) => request(port, { path: p, headers: { host: host } })));
    check('the fonts the page uses are served by this same server, and allowed only from it', (() => {
      const p = [];
      const csp = page.headers['content-security-policy'] || '';
      if (!/font-src 'self'(;|$)/.test(csp)) p.push('the policy does not allow fonts from this server: ' + csp);
      if (/font-src[^;]*(https?:|\*|data:)/.test(csp)) p.push('the policy lets fonts in from elsewhere: ' + csp);
      for (const [i, f] of fonts.entries()) {
        const name = i ? 'spacemono' : 'archivo';
        if (!page.body.includes('/fonts/' + name + '.woff2')) p.push('the page does not use /fonts/' + name + '.woff2');
        if (f.status !== 200) p.push(name + ' answered ' + f.status);
        if (f.headers['content-type'] !== 'font/woff2') p.push(name + ' served as ' + f.headers['content-type']);
        if (!/^wOF2/.test(f.body)) p.push(name + ' is not a woff2 file');
      }
      return p;
    })());

    const rebound = await request(port, { path: '/api/state', headers: { host: 'attacker.example:' + port } });
    check('a request that arrives under another name is refused (DNS rebinding)', rebound.status === 403 ? [] : ['answered ' + rebound.status]);

    const post = (headers, body) => request(port, { method: 'POST', path: '/api/check', headers: Object.assign({ host: host, 'content-type': 'application/json' }, headers) }, body);
    const noToken = await post({}, JSON.stringify({ id: 'data', on: false }));
    const wrongToken = await post({ 'x-kryptheon-token': 'deadbeef' }, JSON.stringify({ id: 'data', on: false }));
    const cfgBefore = fs.readFileSync(kept.config, 'utf8');
    check('a change without this page\'s token is refused, and changes nothing', (() => {
      const p = [];
      if (noToken.status !== 403) p.push('no token: ' + noToken.status);
      if (wrongToken.status !== 403) p.push('wrong token: ' + wrongToken.status);
      if (JSON.parse(cfgBefore).enabled.data !== true) p.push('the config changed anyway');
      return p;
    })());

    const good = await post({ 'x-kryptheon-token': token }, JSON.stringify({ id: 'data', on: false }));
    check('a change with the token is saved', (() => {
      const p = [];
      if (good.status !== 200) p.push('answered ' + good.status + ' ' + good.body);
      if (JSON.parse(fs.readFileSync(kept.config, 'utf8')).enabled.data !== false) p.push('not saved');
      return p;
    })());

    const api = await request(port, { path: '/api/state', headers: { host: host } });
    check('the state the page reads is the state built from the store', (() => {
      if (api.status !== 200) return ['answered ' + api.status];
      const s = JSON.parse(api.body);
      const p = [];
      if (s.project.storeDir !== kept.dir) p.push('store: ' + s.project.storeDir);
      if (s.findings.some((f) => f.check === 'data')) p.push('data findings shown although data was switched off');
      return p;
    })());

    // Running a check from the page. The runner here is a stand-in that records
    // what it was asked to run and holds the first run open, so a second one
    // arriving meanwhile can be seen being turned away.
    const asked = [];
    let release;
    const held = new Promise((r) => (release = r));
    const runner = dashboard.createServer(project, {
      run: (id) => {
        asked.push(id);
        return asked.length === 1 ? held.then(() => ({ ok: true })) : { ok: true };
      },
    });
    const runPort = await runner.listen(0);
    try {
      const runHost = '127.0.0.1:' + runPort;
      const runPage = await request(runPort, { path: '/', headers: { host: runHost } });
      const runToken = (runPage.body.match(/name="kryptheon-token" content="([0-9a-f]+)"/) || [])[1];
      const run = (id, t) => request(runPort, { method: 'POST', path: '/api/run', headers: { host: runHost, 'content-type': 'application/json', 'x-kryptheon-token': t } }, JSON.stringify({ id: id }));
      const first = run('frontend', runToken);
      await new Promise((r) => setTimeout(r, 150));
      const second = await run('frontend', runToken);
      release();
      const firstDone = await first;
      const data = await run('data', runToken);
      const na = await run('performance', runToken);
      const noTok = await run('frontend', 'nope');
      check('checks run from the page: only what can run, one at a time, with the token', (() => {
        const p = [];
        if (firstDone.status !== 200) p.push('frontend run answered ' + firstDone.status + ' ' + firstDone.body);
        if (second.status !== 409) p.push('a second run during the first answered ' + second.status);
        if (data.status !== 400) p.push('the database check, which needs a connection string, answered ' + data.status);
        if (na.status !== 400) p.push('a not-available check answered ' + na.status);
        if (noTok.status !== 403) p.push('a run without the token answered ' + noTok.status);
        if (JSON.stringify(asked) !== JSON.stringify(['frontend'])) p.push('the runner was asked for ' + JSON.stringify(asked));
        return p;
      })());
    } finally {
      await runner.close();
    }

    // Re-check from the page: only a real open finding, only with the token,
    // one at a time.
    const rechecked = [];
    let releaseRe;
    const heldRe = new Promise((r) => (releaseRe = r));
    const re = dashboard.createServer(project, {
      recheck: (rid) => {
        rechecked.push(rid);
        return heldRe.then(() => ({ id: rid, verdict: 'fixed', newProblems: [] }));
      },
    });
    const rePort = await re.listen(0);
    try {
      const reHost = '127.0.0.1:' + rePort;
      const rePage = await request(rePort, { path: '/', headers: { host: reHost } });
      const reToken = (rePage.body.match(/name="kryptheon-token" content="([0-9a-f]+)"/) || [])[1];
      const openId = dashboard.buildState(project).findings[0].id;
      const ask = (rid, t) => request(rePort, { method: 'POST', path: '/api/recheck', headers: { host: reHost, 'content-type': 'application/json', 'x-kryptheon-token': t } }, JSON.stringify({ id: rid }));
      const badShape = await ask('../../x', reToken);
      const notOpen = await ask('deadbeef', reToken);
      const noTok = await ask(openId, 'nope');
      const firstRe = ask(openId, reToken);
      await new Promise((r) => setTimeout(r, 150));
      const busy = await ask(openId, reToken);
      releaseRe();
      const done = await firstRe;
      check('re-check from the page: a real open finding, with the token, one at a time', (() => {
        const p = [];
        if (badShape.status !== 400) p.push('a malformed id answered ' + badShape.status);
        if (notOpen.status !== 404) p.push('an id that is not open answered ' + notOpen.status);
        if (noTok.status !== 403) p.push('no token answered ' + noTok.status);
        if (busy.status !== 409) p.push('a second re-check during the first answered ' + busy.status);
        if (done.status !== 200 || JSON.parse(done.body).verdict !== 'fixed') p.push('the re-check answered ' + done.status + ' ' + done.body);
        if (JSON.stringify(rechecked) !== JSON.stringify([openId])) p.push('the re-check ran for ' + JSON.stringify(rechecked));
        return p;
      })());
    } finally {
      await re.close();
    }

    // And after every request above: still nothing of Kryptheon's in the project.
    check('the running dashboard wrote nothing into the project either', (() => {
      const now = fs.readdirSync(project).sort().join(',');
      return now === before ? [] : ['the project now holds: ' + now];
    })());
  } finally {
    await app.close();
  }

  // A logo that is not there costs the picture, not the dashboard.
  const noLogo = dashboard.createServer(project, { logoFile: path.join(project, 'no-such-logo.png') });
  const noLogoPort = await noLogo.listen(0);
  try {
    const h = { host: '127.0.0.1:' + noLogoPort };
    const missing = await request(noLogoPort, { path: '/logo.png', headers: h });
    const after = await request(noLogoPort, { path: '/api/state', headers: h });
    check('a missing logo answers 404, and the dashboard keeps answering', (() => {
      const p = [];
      if (missing.status !== 404) p.push('GET /logo.png answered ' + missing.status);
      if (after.status !== 200) p.push('after it, /api/state answered ' + after.status);
      return p;
    })());
  } finally {
    await noLogo.close();
  }

  // The real command, in a real project: `kryptheon dashboard` prints its
  // address, and the page's "Run now" for the frontend leaves a saved read.
  const { spawn, spawnSync } = require('child_process');
  const cli = path.join(__dirname, 'bin', 'kryptheon.js');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'offer.js'),
    'async function f(){ const r = await fetch("/o"); const o = await r.json(); box.innerHTML = `${o.text}`; }\n', 'utf8');
  const beforeCli = fs.readdirSync(project).sort().join(',');
  const child = spawn(process.execPath, [cli, 'dashboard'], { cwd: project, env: process.env });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  try {
    const started = Date.now();
    while (!/http:\/\/127\.0\.0\.1:\d+\//.test(out) && Date.now() - started < 20000) await new Promise((r) => setTimeout(r, 100));
    const address = (out.match(/http:\/\/127\.0\.0\.1:(\d+)\//) || [])[1];
    let saved = null;
    let ran = null;
    if (address) {
      const cliHost = '127.0.0.1:' + address;
      const cliPage = await request(Number(address), { path: '/', headers: { host: cliHost } });
      const cliToken = (cliPage.body.match(/name="kryptheon-token" content="([0-9a-f]+)"/) || [])[1];
      ran = await request(Number(address), { method: 'POST', path: '/api/run', headers: { host: cliHost, 'content-type': 'application/json', 'x-kryptheon-token': cliToken } }, JSON.stringify({ id: 'frontend' }));
      try { saved = JSON.parse(fs.readFileSync(kept.codeFindings, 'utf8')); } catch (err) { saved = null; }
    }
    check('the dashboard command starts, and its Run now saves a real read to the store', (() => {
      const p = [];
      if (!address) return ['no address printed: ' + out.slice(0, 400)];
      if (!ran || ran.status !== 200) p.push('Run now answered ' + (ran && ran.status) + ' ' + (ran && ran.body));
      const found = saved && (saved.findings || []).find((f) => f.file === 'src/offer.js');
      if (!found) p.push('no read of src/offer.js was saved: ' + JSON.stringify(saved && saved.findings));
      else if (found.origin !== 'network') p.push('the saved finding says ' + found.origin);
      const now = fs.readdirSync(project).sort().join(',');
      if (now !== beforeCli) p.push('the project changed: ' + now);
      return p;
    })());

    // With the page open, a change is noticed by itself: no command typed.
    // The watch polls every 2s and waits 4s of quiet, so this allows 20s.
    let watched = null;
    if (address) {
      const cliHost = '127.0.0.1:' + address;
      fs.writeFileSync(path.join(project, 'src', 'promo.js'),
        'async function p(){ const r = await fetch("/p"); const d = await r.json(); el.innerHTML = `${d.t}`; }\n', 'utf8');
      const started = Date.now();
      while (Date.now() - started < 20000) {
        await new Promise((r) => setTimeout(r, 1000));
        const s = await request(Number(address), { path: '/api/state', headers: { host: cliHost } });
        const state = s.status === 200 ? JSON.parse(s.body) : null;
        const hit = state && state.looks.find((l) => l.by === 'watch' && l.files.some((f) => f.path === 'src/promo.js'));
        if (hit) {
          watched = { look: hit, finding: state.findings.find((f) => /src\/promo\.js/.test(f.where)) };
          break;
        }
      }
    }
    check('with the dashboard open, a change is noticed and checked with no command typed', (() => {
      if (!watched) return ['no look by the watch saw src/promo.js within 20s'];
      const p = [];
      if (watched.look.newFindings !== 1) p.push('the look counted ' + watched.look.newFindings + ' new findings, expected 1');
      if (!watched.finding) p.push('the new file\'s finding is not on the page');
      const reg = watched.look.checks.find((c) => c.id === 'regression');
      if (reg && /^ran/.test(reg.state)) p.push('the watch replayed the recordings by itself');
      return p;
    })());
  } finally {
    child.kill();
  }

  // Run by a script, with no command, it must not start a server that never
  // exits - it prints the usage and ends, as it always did.
  const bare = spawnSync(process.execPath, [cli], { cwd: project, env: process.env, encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] });
  check('with no command and no terminal, it prints the usage and exits', (() => {
    const p = [];
    if (bare.error) p.push('it did not exit: ' + bare.error.message);
    if (bare.status !== 0) p.push('exit ' + bare.status);
    if (!/npx kryptheon dashboard/.test(bare.stdout || '')) p.push('the usage does not mention the dashboard');
    if (/127\.0\.0\.1:\d+/.test(bare.stdout || '')) p.push('it started a server');
    return p;
  })());
  fs.rmSync(project, { recursive: true, force: true });

  let failures = 0;
  for (const r of results) {
    if (r.problems.length) {
      failures++;
      console.log('FAIL  ' + r.name);
      r.problems.forEach((x) => console.log('      - ' + x));
    } else {
      console.log('PASS  ' + r.name);
    }
  }
  console.log('');
  if (failures) {
    console.log(failures + ' check(s) failed.');
    process.exit(1);
  }
  console.log('All ' + results.length + ' dashboard checks passed.');
})();
