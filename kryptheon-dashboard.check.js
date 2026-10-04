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
  findings: [code.describe({ file: 'src/cart.js', line: 12, sink: 'innerHTML', expression: '`<b>${d.name}</b>`', origin: 'network', parts: [{ text: 'd.name', origin: 'network' }] })],
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

check('a frontend finding says which part of the value is the risky one', (() => {
  const f = state.findings.find((x) => x.check === 'frontend');
  if (!f) return ['no frontend finding'];
  return /the risky part: d.name/.test(f.detail) ? [] : ['detail does not name the part: ' + f.detail];
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
  const want = 'frontend:todo record:todo regression:waiting connect:todo data:todo nightly:todo';
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
  if (stepState(all) !== 'frontend:done record:done regression:done connect:done data:done nightly:todo') p.push('all run: ' + stepState(all));
  // The nightly check is offered, never pressed for: done only once it is set up and scheduled.
  const nightly = dashboard.startSteps(allOn, { codeAt: 'a', recordings: 2, lastRunAt: 'b', nightAt: 'c', nightly: { installed: true, active: true, ranAt: 'd' } });
  if (nightly.find((s) => s.id === 'nightly').state !== 'done') p.push('a scheduled nightly check is not done');
  const idle = dashboard.startSteps(allOn, { codeAt: 'a', recordings: 2, lastRunAt: 'b', nightAt: 'c', nightly: { installed: true, active: false } });
  if (idle.find((s) => s.id === 'nightly').state !== 'todo') p.push('a nightly check with nothing scheduled is done');
  if (dashboard.nextAction([], all).kind !== 'quiet') p.push('the optional nightly step is pressed for: ' + JSON.stringify(dashboard.nextAction([], all)));
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
    if (id === 'data') {
      const steps = dashboard.startSteps(allOn.map((c) => (c.id === 'data' ? { id: 'data', enabled: false } : c)), { codeAt: null, recordings: 1, lastRunAt: null, nightAt: null });
      for (const sid of ['connect', 'nightly']) {
        const st = steps.find((x) => x.id === sid);
        if (st.state !== 'off' || st.action) p.push(sid + ' with the database check off: ' + st.state + ' ' + JSON.stringify(st.action));
      }
    }
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

check('the steps say the two things people get wrong: record while it works, and where the database string is', (() => {
  const p = [];
  const steps = dashboard.startSteps(allOn, { codeAt: null, recordings: 0, lastRunAt: null, nightAt: null });
  const rec = steps.find((s) => s.id === 'record');
  const db = steps.find((s) => s.id === 'connect');
  const scan = steps.find((s) => s.id === 'data');
  if (!/Record while your app works/.test(rec.why)) p.push('the record step does not say to record while the app works: ' + rec.why);
  if (!/steps are next to the box/.test(db.why)) p.push('the connect step does not point at the steps for finding the string: ' + db.why);
  if (!/never saved/.test(db.why)) p.push('the connect step does not say the string is never saved');
  if (!/test project first/.test(db.why)) p.push('the connect step does not advise a test project first');
  if (!/waits for your yes/.test(scan.why)) p.push('the database step does not say it waits for a yes');
  // Every step says how often it is done.
  const want = { frontend: 'after every change', record: 'one time', regression: 'after every change', connect: 'one time', data: 'after every change', nightly: 'one time' };
  for (const s of steps) if (s.when !== want[s.id]) p.push(s.id + ' is labelled ' + s.when);
  if (!/only when that flow changes/.test(rec.whenMore || '')) p.push('the record step does not say when to record again');
  // And every button the page draws carries the command that does the same.
  for (const s of steps) if (s.action && ['run', 'record', 'db'].includes(s.action.kind) && !/^npx /.test(s.action.command || '')) p.push(s.id + ' has no terminal command');
  return p;
})());

check('the page is handed the steps and the next action, built from the store', (() => {
  const p = [];
  if (!Array.isArray(state.steps) || state.steps.length !== 6) return ['steps: ' + JSON.stringify(state.steps.map((s) => s.id))];
  if (state.steps.find((s) => s.id === 'frontend').state !== 'done') p.push('the saved read is not step 1 done');
  if (state.steps.find((s) => s.id === 'regression').state !== 'done') p.push('the saved runs are not step 3 done');
  if (!state.next || state.next.kind !== 'fix') p.push('with a broken recording, next is ' + JSON.stringify(state.next));
  return p;
})());

// The nightly run inside the database keeps its own answer, which
// kryptheon-night copies into the store as night-nightly.json. Its own
// project, so the counts above stay what they were.
const nightProject = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-dash-nightly-'));
const nightStore = store.open(nightProject);
const dataOf = (s) => s.checks.find((c) => c.id === 'data');
const writeNightly = (value) => fs.writeFileSync(nightStore.nightNightly, JSON.stringify(value), 'utf8');
const ORDERS = { severity: 'CRITICAL', status: 'confirmed', table: 'orders', kind: 'exposed', headline: 'Your orders table can be read by anyone.', body: 'I read 2 rows.', fixPrompt: 'Fix the orders rule.' };
const INVOICES = { severity: 'HIGH', status: 'confirmed', table: 'invoices', kind: 'crossed', headline: 'Your invoices table lets one customer read another one\'s rows.', body: 'I read 1.', fixPrompt: 'Fix invoices.' };

check('with no nightly answer kept, nothing is said about it', (() => {
  const s = dashboard.buildState(nightProject);
  const p = [];
  if (dataOf(s).nightly !== null) p.push('it said: ' + dataOf(s).nightly);
  if (dataOf(s).state !== 'never run here') p.push('state ' + dataOf(s).state);
  return p;
})());

check('the nightly run\'s findings are shown, marked as nightly, and the check is not "never run"', (() => {
  writeNightly({ readAt: '2026-09-30T09:00:00.000Z', installed: true, scheduled: '0 3 * * *', active: true, source: 'public',
    ranAt: '2026-09-30T03:00:00.000Z', stopped: null, attacksRun: 12, notChecked: [{ table: 'blobs' }],
    findings: [ORDERS, { severity: 'HIGH', status: 'verification required', table: 'lookup_token', kind: 'privileged', headline: 'Anyone can call lookup_token.', body: '', fixPrompt: 'Check it.' }] });
  const s = dashboard.buildState(nightProject);
  const p = [];
  const f = s.findings.find((x) => x.where === 'orders');
  if (!f) return ['the nightly finding is not shown'];
  if (f.from !== 'nightly' || f.check !== 'data' || f.when !== '2026-09-30T03:00:00.000Z') p.push('shown as ' + JSON.stringify({ from: f.from, check: f.check, when: f.when }));
  if (!/npx kryptheon recheck/.test(f.fixPrompt)) p.push('it has no way to prove the fix');
  if (dataOf(s).state !== 'problems found') p.push('state ' + dataOf(s).state);
  const line = dataOf(s).nightly || '';
  // UTC said as UTC, and in this computer's own time - and a function to
  // check counted apart from the problems proven.
  const local = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const want = '2026-09-30 03:00 UTC (' + local('2026-09-30T03:00:00.000Z') + ' your time): 1 problem found. 1 thing to check. 1 part was not tested.';
  if (line.indexOf(want) === -1) p.push('the line: ' + line + ' - wanted ' + want);
  if (line.indexOf('(read ' + local('2026-09-30T09:00:00.000Z') + ')') === -1) p.push('the line does not say when it was read: ' + line);
  if (s.steps.find((x) => x.id === 'data').state !== 'done') p.push('the database step is not done after a nightly run');
  return p;
})());

check('a problem both answers found is shown once, with the newer date', (() => {
  fs.writeFileSync(nightStore.nightLast, JSON.stringify({ findings: [ORDERS] }), 'utf8');
  fs.utimesSync(nightStore.nightLast, new Date('2026-09-29T12:00:00Z'), new Date('2026-09-29T12:00:00Z'));
  writeNightly({ readAt: '2026-09-30T09:00:00.000Z', installed: true, active: true, ranAt: '2026-09-30T03:00:00.000Z',
    stopped: null, attacksRun: 12, notChecked: [], findings: [ORDERS, INVOICES] });
  const s = dashboard.buildState(nightProject);
  const p = [];
  const orders = s.findings.filter((x) => x.where === 'orders');
  if (orders.length !== 1) p.push('orders is shown ' + orders.length + ' times');
  else {
    if (orders[0].from !== 'both') p.push('orders is marked ' + orders[0].from);
    if (orders[0].when !== '2026-09-30T03:00:00.000Z') p.push('orders dated ' + orders[0].when);
  }
  if (!s.findings.some((x) => x.where === 'invoices' && x.from === 'nightly')) p.push('the nightly-only finding is missing');
  fs.unlinkSync(nightStore.nightLast);
  return p;
})());

check('the nightly answers that are not "nothing found" are said as themselves', (() => {
  const p = [];
  const say = (value) => { writeNightly(value); return dashboard.buildState(nightProject); };
  let s = say({ readAt: '2026-09-30T09:00:00.000Z', installed: false });
  if (!/not set up/.test(dataOf(s).nightly || '') || s.findings.length || dataOf(s).state !== 'never run here') p.push('not installed: ' + dataOf(s).nightly + ' / ' + dataOf(s).state);
  s = say({ readAt: '2026-09-30T09:00:00.000Z', installed: true, active: true, ranAt: null });
  if (!/has not run yet/.test(dataOf(s).nightly || '') || dataOf(s).state !== 'never run here') p.push('never run: ' + dataOf(s).nightly + ' / ' + dataOf(s).state);
  s = say({ readAt: '2026-09-30T09:00:00.000Z', installed: true, active: false, ranAt: '2026-09-30T03:00:00.000Z', stopped: null, attacksRun: 4, notChecked: [], findings: [] });
  if (!/nothing got through 4 attacks\..*Nothing is scheduled/.test(dataOf(s).nightly || '') || dataOf(s).state !== 'last run held') p.push('held but unscheduled: ' + dataOf(s).nightly + ' / ' + dataOf(s).state);
  s = say({ readAt: '2026-09-30T09:00:00.000Z', installed: true, active: true, ranAt: '2026-09-30T03:00:00.000Z', stopped: 'no tables', findings: [] });
  if (!/could not check - no tables/.test(dataOf(s).nightly || '') || dataOf(s).state !== 'never run here') p.push('stopped: ' + dataOf(s).nightly + ' / ' + dataOf(s).state);
  return p;
})());

check('switching the database check off hides the nightly findings too', (() => {
  writeNightly({ readAt: '2026-09-30T09:00:00.000Z', installed: true, active: true, ranAt: '2026-09-30T03:00:00.000Z', stopped: null, attacksRun: 1, notChecked: [], findings: [ORDERS] });
  dashboard.setCheck(store.pathsFor(nightProject), 'data', false);
  const s = dashboard.buildState(nightProject);
  dashboard.setCheck(store.pathsFor(nightProject), 'data', true);
  return s.findings.some((x) => x.check === 'data') ? ['a switched-off check still shows nightly findings'] : [];
})());

// What the page may hand the commands it starts: an address to record that
// can only be an address, and a connection string that never comes back out.
check('only a web address is accepted for recording - never an option, never another scheme', (() => {
  const p = [];
  for (const good of ['http://localhost:3000', 'https://my-app.lovable.app/login', 'localhost:5173', 'my-app.vercel.app']) {
    if (dashboard.appAddress(good) !== good) p.push('refused ' + good);
  }
  for (const bad of ['', '   ', '--headed', '-o x', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://x', 'http://a b', 'http://x\nrm', 'x'.repeat(3000), null, 42]) {
    if (dashboard.appAddress(bad) !== null) p.push('accepted ' + JSON.stringify(bad));
  }
  if (dashboard.appAddress('  http://localhost:3000  ') !== 'http://localhost:3000') p.push('spaces around it were not trimmed');
  return p;
})());

const SECRET = 'S3cr3t-pass/word';
const CONN = 'postgresql://postgres.abcdef:' + encodeURIComponent(SECRET) + '@aws-0-eu.pooler.supabase.com:5432/postgres';
check('a connection string is hidden in every form it could leak in', (() => {
  const p = [];
  const secrets = dashboard.secretsOf('"' + CONN + '"');
  const leaks = ['quoted: "' + CONN + '"', 'bare: ' + CONN, 'typed: ' + encodeURIComponent(SECRET), 'decoded: ' + SECRET];
  for (const text of leaks) {
    const hidden = dashboard.hideSecrets(text, secrets);
    if (hidden.includes(SECRET) || hidden.includes(encodeURIComponent(SECRET)) || hidden.includes('postgresql://')) p.push('leaked: ' + hidden);
    if (!hidden.includes('[hidden]')) p.push('nothing hidden in: ' + text);
  }
  const deep = dashboard.hideSecretsIn({ a: [{ b: 'x ' + SECRET }], n: 3, ok: true }, secrets);
  if (JSON.stringify(deep).includes(SECRET) || deep.n !== 3 || deep.ok !== true) p.push('inside a value: ' + JSON.stringify(deep));
  if (dashboard.secretsOf('').length) p.push('an empty string has secrets');
  if (dashboard.secretsOf('not a url at all').indexOf('not a url at all') === -1) p.push('a string that is not a URL is not hidden whole');
  return p;
})());

check('a database re-check is fixed only when the check ran, the finding is gone, and its table was tested', (() => {
  const p = [];
  const target = { id: 'aaaaaaaa', check: 'data', where: 'orders', headline: 'Your orders table can be read by anyone.' };
  const other = { id: 'bbbbbbbb', check: 'data', where: 'invoices', headline: 'x', severity: 'HIGH', status: 'confirmed' };
  const v = (after, ran, saved) => dashboard.databaseVerdict(target, [target], after, ran, saved);
  const ok = { ok: true };
  if (v([], { ok: false, why: 'no connection' }, {}).verdict !== 'could not confirm') p.push('a check that did not run was not "could not confirm"');
  if (v([target], ok, {}).verdict !== 'still open') p.push('a finding still there was not "still open"');
  if (v([Object.assign({}, target, { from: 'nightly' })], ok, {}).verdict !== 'fixed') p.push('an older nightly answer kept it open');
  const untested = v([], ok, { notChecked: [{ table: 'orders.email', why: 'seeding failed' }] });
  if (untested.verdict !== 'could not confirm' || !/seeding failed/.test(untested.why)) p.push('a table that went untested was called fixed: ' + JSON.stringify(untested));
  const fixed = v([other], ok, { notChecked: [{ table: 'invoices', why: 'x' }] });
  if (fixed.verdict !== 'fixed') p.push('gone, and its own table tested: ' + fixed.verdict);
  if (fixed.newProblems.length !== 1 || fixed.newProblems[0].id !== 'bbbbbbbb') p.push('the newly broken one was not named: ' + JSON.stringify(fixed.newProblems));
  if (fixed.check !== 'data' || fixed.where !== 'orders' || !fixed.at) p.push('the record is missing what it is about');
  return p;
})());

// Asynchronous, so it is awaited below with the server checks.
const jobProblems = () => {
  const p = [];
  const jobs = dashboard.createJobs();
  let release;
  const held = new Promise((r) => (release = r));
  let sayLater = null;
  const first = jobs.start('db', 'Checking', 'npx kryptheon-night', (say) => {
    say('Database: ' + CONN + '\x1b[31m red\x1b[0m');
    say('one\ntwo');
    sayLater = say;
    return held.then(() => ({ ok: false, why: 'failed for ' + SECRET }));
  }, dashboard.secretsOf(CONN));
  if (!first || !first.running) p.push('it did not start: ' + JSON.stringify(first));
  if (jobs.start('run', 'Again', '', () => ({ ok: true }))) p.push('a second job started while the first ran');
  // The work starts on the next turn, so its lines are looked at after one.
  return new Promise((r) => setTimeout(r, 20)).then(() => {
    const lines = jobs.get().lines;
    if (lines.join(' ').includes(SECRET) || lines.join(' ').includes('postgresql://')) p.push('a line leaked: ' + lines.join(' | '));
    if (lines.join(' ').includes('\x1b')) p.push('colour codes kept');
    if (lines.length !== 3) p.push('lines were not split: ' + JSON.stringify(lines));
    release();
    return held;
  }).then(() => new Promise((r) => setTimeout(r, 20))).then(() => {
    const done = jobs.get();
    if (done.running || !done.endedAt) p.push('it did not end');
    if (JSON.stringify(done.result).includes(SECRET)) p.push('the result leaked: ' + JSON.stringify(done.result));
    sayLater('late: ' + SECRET);
    if (jobs.get().lines.some((l) => l.includes(SECRET) || /late/.test(l))) p.push('a line said after the end was kept');
    if (!jobs.start('run', 'Next', '', () => ({ ok: true }))) p.push('nothing could start after it ended');
    return p;
  });
};

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

// Follows the job a POST started until it ends, the way the page does.
async function finished(port, host) {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    const r = await request(port, { path: '/api/job', headers: { host: host } });
    const job = r.status === 200 ? JSON.parse(r.body).job : null;
    if (job && !job.running) return job;
    await new Promise((x) => setTimeout(x, 50));
  }
  return null;
}

(async () => {
  check('a job runs alone, its lines are scrubbed, and it lets go of the secret when it ends', await jobProblems());
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
      run: (id, say) => {
        asked.push(id);
        say('said by the runner');
        return asked.length === 1 ? held.then(() => ({ ok: true })) : { ok: true };
      },
    });
    const runPort = await runner.listen(0);
    try {
      const runHost = '127.0.0.1:' + runPort;
      const runPage = await request(runPort, { path: '/', headers: { host: runHost } });
      const runToken = (runPage.body.match(/name="kryptheon-token" content="([0-9a-f]+)"/) || [])[1];
      const run = (id, t) => request(runPort, { method: 'POST', path: '/api/run', headers: { host: runHost, 'content-type': 'application/json', 'x-kryptheon-token': t } }, JSON.stringify({ id: id }));
      const first = await run('frontend', runToken);
      const second = await run('frontend', runToken);
      const during = JSON.parse((await request(runPort, { path: '/api/job', headers: { host: runHost } })).body).job;
      release();
      const firstDone = await finished(runPort, runHost);
      const data = await run('data', runToken);
      const na = await run('performance', runToken);
      const noTok = await run('frontend', 'nope');
      check('checks run from the page: only what can run, one at a time, with the token', (() => {
        const p = [];
        if (first.status !== 202) p.push('starting the frontend run answered ' + first.status + ' ' + first.body);
        if (!during || !during.running || during.kind !== 'run' || during.command !== 'npx kryptheon code') p.push('while it ran, /api/job said ' + JSON.stringify(during));
        if (!during || !/said by the runner/.test((during.lines || []).join(' '))) p.push('the progress line from the runner is not on the job: ' + JSON.stringify(during && during.lines));
        if (!firstDone || firstDone.running || !firstDone.result || !firstDone.result.ok) p.push('the finished job: ' + JSON.stringify(firstDone));
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
      const firstRe = await ask(openId, reToken);
      const busy = await ask(openId, reToken);
      releaseRe();
      const done = await finished(rePort, reHost);
      check('re-check from the page: a real open finding, with the token, one at a time', (() => {
        const p = [];
        if (badShape.status !== 400) p.push('a malformed id answered ' + badShape.status);
        if (notOpen.status !== 404) p.push('an id that is not open answered ' + notOpen.status);
        if (noTok.status !== 403) p.push('no token answered ' + noTok.status);
        if (busy.status !== 409) p.push('a second re-check during the first answered ' + busy.status);
        if (firstRe.status !== 202) p.push('starting the re-check answered ' + firstRe.status + ' ' + firstRe.body);
        if (!done || !done.result || done.result.verdict !== 'fixed' || done.command !== 'npx kryptheon recheck ' + openId) p.push('the re-check job: ' + JSON.stringify(done));
        if (JSON.stringify(rechecked) !== JSON.stringify([openId])) p.push('the re-check ran for ' + JSON.stringify(rechecked));
        return p;
      })());
    } finally {
      await re.close();
    }

    // Record, the database and its words, from the page. Stand-ins that say
    // back what they were handed - including, on purpose, the connection
    // string - so the server can be seen keeping it off the page.
    const handed = [];
    let fixLanded = false;
    const side = dashboard.createServer(project, {
      record: (address, say) => { handed.push(['record', address]); say('opening ' + address); return { ok: true, recordings: ['checkout.spec.js'], summary: 'saved' }; },
      db: (action, connection, say) => {
        handed.push(['db', action, connection === CONN]);
        // The fix landed: the next check finds nothing in orders.
        if (fixLanded) fs.writeFileSync(kept.nightLast, JSON.stringify({ findings: [], notChecked: [] }), 'utf8');
        say('Database: ' + connection);
        return { ok: true, summary: 'nothing got through', echo: connection };
      },
      words: (connection) => {
        handed.push(['words', connection === CONN ? 'CONN' : connection]);
        return { help: ['step 1'], consent: ['I will'], installConsent: ['I stay'], nightlyAt: '0 3 * * *', given: Boolean(connection), warning: connection ? ['about ' + connection] : null, unusable: null };
      },
    });
    const sidePort = await side.listen(0);
    try {
      const sideHost = '127.0.0.1:' + sidePort;
      const sidePage = await request(sidePort, { path: '/', headers: { host: sideHost } });
      const sideToken = (sidePage.body.match(/name="kryptheon-token" content="([0-9a-f]+)"/) || [])[1];
      const ask = (where, body, t) => request(sidePort, { method: 'POST', path: where, headers: { host: sideHost, 'content-type': 'application/json', 'x-kryptheon-token': t === undefined ? sideToken : t } }, JSON.stringify(body));

      const badAddress = await ask('/api/record', { url: '--headed' });
      const noTokRecord = await ask('/api/record', { url: 'http://localhost:3000' }, 'nope');
      const recorded = await ask('/api/record', { url: 'http://localhost:3000' });
      const recordJob = await finished(sidePort, sideHost);
      check('record from the page: an address only, with the token, as a job that names what it saved', (() => {
        const p = [];
        if (badAddress.status !== 400) p.push('an option as the address answered ' + badAddress.status);
        if (noTokRecord.status !== 403) p.push('no token answered ' + noTokRecord.status);
        if (recorded.status !== 202) p.push('recording answered ' + recorded.status + ' ' + recorded.body);
        if (!recordJob || !recordJob.result || JSON.stringify(recordJob.result.recordings) !== '["checkout.spec.js"]') p.push('the record job: ' + JSON.stringify(recordJob));
        if (recordJob && recordJob.command !== 'npx kryptheon record http://localhost:3000') p.push('its terminal command: ' + recordJob.command);
        if (JSON.stringify(handed[0]) !== JSON.stringify(['record', 'http://localhost:3000'])) p.push('the recorder was handed ' + JSON.stringify(handed[0]));
        return p;
      })());

      const help = await ask('/api/db/words', {});
      const judged = await ask('/api/db/words', { connection: CONN });
      check('the database words come from kryptheon-night, and never carry the string back', (() => {
        const p = [];
        if (help.status !== 200 || JSON.parse(help.body).words.help[0] !== 'step 1') p.push('the help: ' + help.status + ' ' + help.body);
        if (judged.status !== 200) p.push('with a string it answered ' + judged.status);
        if (judged.body.includes(SECRET) || judged.body.includes(encodeURIComponent(SECRET)) || judged.body.includes('postgresql://')) p.push('the string came back: ' + judged.body);
        if (!/about \[hidden\]/.test(judged.body)) p.push('the warning was not kept, with the string hidden: ' + judged.body);
        return p;
      })());

      const noConn = await ask('/api/db', { action: 'scan' });
      const badAction = await ask('/api/db', { action: 'drop', connection: CONN });
      const noTokDb = await ask('/api/db', { action: 'scan', connection: CONN }, 'nope');
      const scanned = await ask('/api/db', { action: 'scan', connection: CONN });
      const dbJob = await finished(sidePort, sideHost);
      const later = await request(sidePort, { path: '/api/job', headers: { host: sideHost } });
      const stateAfter = await request(sidePort, { path: '/api/state', headers: { host: sideHost } });
      check('the database check from the page: the string goes to the check, and nowhere back to the page', (() => {
        const p = [];
        if (noConn.status !== 400) p.push('no string answered ' + noConn.status);
        if (badAction.status !== 400) p.push('an unknown action answered ' + badAction.status);
        if (noTokDb.status !== 403) p.push('no token answered ' + noTokDb.status);
        if (scanned.status !== 202) p.push('the check answered ' + scanned.status + ' ' + scanned.body);
        if (!handed.some((h) => h[0] === 'db' && h[1] === 'scan' && h[2] === true)) p.push('the check was not handed the string: ' + JSON.stringify(handed));
        if (!dbJob || dbJob.result.summary !== 'nothing got through' || dbJob.command !== 'npx kryptheon-night') p.push('the job: ' + JSON.stringify(dbJob));
        for (const [what, body] of [['the start', scanned.body], ['the job', later.body], ['the state', stateAfter.body]]) {
          if (body.includes(SECRET) || body.includes(encodeURIComponent(SECRET)) || body.includes('pooler.supabase.com')) p.push(what + ' carried the string back');
        }
        if (dbJob && !dbJob.lines.some((l) => l === 'Database: [hidden]')) p.push('the line saying it was not hidden: ' + JSON.stringify(dbJob.lines));
        return p;
      })());

      // A database finding re-checked from the page: the check runs again and
      // that finding is judged and recorded like any other re-check.
      await ask('/api/check', { id: 'data', on: true });
      const dbFinding = dashboard.buildState(project).findings.find((f) => f.check === 'data');
      const notData = dashboard.buildState(project).findings.find((f) => f.check !== 'data');
      const wrongKind = await ask('/api/db', { action: 'recheck', id: notData.id, connection: CONN });
      fixLanded = true;
      const reStart = await ask('/api/db', { action: 'recheck', id: dbFinding ? dbFinding.id : 'x', connection: CONN });
      const reJob = await finished(sidePort, sideHost);
      let kept2 = [];
      try { kept2 = fs.readFileSync(kept.fixes, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l)); } catch (err) { kept2 = []; }
      check('a database finding is re-checked through the database, judged, and recorded', (() => {
        const p = [];
        if (!dbFinding) return ['no database finding to re-check'];
        if (wrongKind.status !== 404) p.push('a finding that is not a database one answered ' + wrongKind.status);
        if (reStart.status !== 202) p.push('the re-check answered ' + reStart.status + ' ' + reStart.body);
        if (!reJob || !reJob.result || reJob.result.verdict !== 'fixed' || reJob.result.id !== dbFinding.id) p.push('the job: ' + JSON.stringify(reJob && reJob.result));
        if (handed[handed.length - 1][1] !== 'scan') p.push('the database was asked for ' + handed[handed.length - 1][1]);
        const rec = kept2.find((a) => a.id === dbFinding.id);
        if (!rec || rec.verdict !== 'fixed') p.push('not recorded: ' + JSON.stringify(kept2));
        if (reJob && (JSON.stringify(reJob).includes(SECRET) || JSON.stringify(reJob).includes(encodeURIComponent(SECRET)))) p.push('the string came back');
        return p;
      })());

      // Nothing about the string reached the store either.
      check('the connection string is written to no file', (() => {
        const p = [];
        const walk = (dir) => {
          for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            if (fs.statSync(full).isDirectory()) walk(full);
            else {
              const text = fs.readFileSync(full, 'latin1');
              if (text.includes(SECRET) || text.includes(encodeURIComponent(SECRET))) p.push(full + ' holds it');
            }
          }
        };
        walk(process.env.KRYPTHEON_HOME);
        walk(project);
        return p;
      })());
    } finally {
      await side.close();
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
  const opened = path.join(project, '..', path.basename(project) + '-opened.txt');
  const opener = path.join(project, '..', path.basename(project) + '-opener.js');
  fs.writeFileSync(opener, 'require("fs").writeFileSync(' + JSON.stringify(opened) + ', process.argv[2]);\n', 'utf8');
  // A stand-in for kryptheon-night, outside the project and the store.
  const fakeNight = path.join(project, '..', path.basename(project) + '-night.js');
  fs.writeFileSync(fakeNight, [
    'const args = process.argv.slice(2);',
    'if (args[0] === "words") { console.log(JSON.stringify({ help: ["from the stand-in"], consent: [], installConsent: [], nightlyAt: "0 3 * * *", given: !!process.env.KN_DATABASE_URL, warning: null, unusable: null })); process.exit(0); }',
    'console.log("args: " + JSON.stringify(args));',
    'console.log("env: " + (process.env.KN_DATABASE_URL === ' + JSON.stringify(CONN) + ' ? "same" : "different"));',
    'if (process.argv.join(" ").includes(' + JSON.stringify(SECRET) + ')) console.log("argv-has-secret");',
    'console.log("echo: " + process.env.KN_DATABASE_URL);',
  ].join(String.fromCharCode(10)), 'utf8');
  const child = spawn(process.execPath, [cli, 'dashboard'], { cwd: project, env: Object.assign({}, process.env, { KRYPTHEON_BROWSER: opener, KRYPTHEON_NO_OPEN: '', KRYPTHEON_NIGHT_BIN: fakeNight }) });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  try {
    const started = Date.now();
    while (!/http:\/\/127\.0\.0\.1:\d+\//.test(out) && Date.now() - started < 20000) await new Promise((r) => setTimeout(r, 100));
    const address = (out.match(/http:\/\/127\.0\.0\.1:(\d+)\//) || [])[1];
    let saved = null;
    let ran = null;
    let ranJob = null;
    if (address) {
      const cliHost = '127.0.0.1:' + address;
      const cliPage = await request(Number(address), { path: '/', headers: { host: cliHost } });
      const cliToken = (cliPage.body.match(/name="kryptheon-token" content="([0-9a-f]+)"/) || [])[1];
      ran = await request(Number(address), { method: 'POST', path: '/api/run', headers: { host: cliHost, 'content-type': 'application/json', 'x-kryptheon-token': cliToken } }, JSON.stringify({ id: 'frontend' }));
      ranJob = await finished(Number(address), cliHost);
      try { saved = JSON.parse(fs.readFileSync(kept.codeFindings, 'utf8')); } catch (err) { saved = null; }
    }
    check('the dashboard command starts, opens the page in the browser by itself, and still prints the address', (() => {
      if (!address) return ['no address printed: ' + out.slice(0, 400)];
      const p = [];
      let got = null;
      for (let i = 0; i < 50 && got === null; i++) {
        try { got = fs.readFileSync(opened, 'utf8'); } catch (err) { require('child_process').spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},100)']); }
      }
      if (got !== 'http://127.0.0.1:' + address + '/') p.push('the browser was asked to open ' + JSON.stringify(got));
      if (!/opening in your browser/.test(out)) p.push('it does not say it is opening the browser: ' + out.slice(0, 400));
      return p;
    })());
    check('the dashboard command starts, and its Run now saves a real read to the store', (() => {
      const p = [];
      if (!address) return ['no address printed: ' + out.slice(0, 400)];
      if (!ran || ran.status !== 202) p.push('Run now answered ' + (ran && ran.status) + ' ' + (ran && ran.body));
      if (!ranJob || !ranJob.result || !ranJob.result.ok || !/Read \d+ files?\./.test(ranJob.lines.join(' '))) p.push('the run job: ' + JSON.stringify(ranJob));
      const found = saved && (saved.findings || []).find((f) => f.file === 'src/offer.js');
      if (!found) p.push('no read of src/offer.js was saved: ' + JSON.stringify(saved && saved.findings));
      else if (found.origin !== 'network') p.push('the saved finding says ' + found.origin);
      const now = fs.readdirSync(project).sort().join(',');
      if (now !== beforeCli) p.push('the project changed: ' + now);
      return p;
    })());

    // The database check through the real command, with a stand-in for
    // kryptheon-night that says back what it was started with: its words,
    // whether the string arrived in its environment, and - on purpose - the
    // string itself, which must reach the page only as [hidden].
    let dbRun = null;
    let dbWords = null;
    if (address) {
      const cliHost = '127.0.0.1:' + address;
      const cliPage = await request(Number(address), { path: '/', headers: { host: cliHost } });
      const cliToken = (cliPage.body.match(/name="kryptheon-token" content="([0-9a-f]+)"/) || [])[1];
      const ask = (where, body) => request(Number(address), { method: 'POST', path: where, headers: { host: cliHost, 'content-type': 'application/json', 'x-kryptheon-token': cliToken } }, JSON.stringify(body));
      dbWords = await ask('/api/db/words', { connection: CONN });
      await ask('/api/db', { action: 'install', connection: CONN });
      dbRun = await finished(Number(address), cliHost);
    }
    check('the dashboard command runs kryptheon-night with the string in its environment only, and keeps it off the page', (() => {
      if (!dbRun) return ['no database job finished'];
      const p = [];
      const said = dbRun.lines.join('\n');
      if (!/args: \["install","--yes"\]/.test(said)) p.push('kryptheon-night was not started with install --yes: ' + said);
      if (!/env: same/.test(said)) p.push('the string did not arrive in its environment: ' + said);
      if (/argv-has-secret/.test(said)) p.push('the string was on its command line');
      if (said.includes(SECRET) || said.includes(encodeURIComponent(SECRET))) p.push('the string reached the page');
      if (!/echo: \[hidden\]/.test(said)) p.push('the echoed string was not hidden: ' + said);
      if (!dbWords || dbWords.status !== 200 || !/"help":\["from the stand-in"\]/.test(dbWords.body)) p.push('the words: ' + (dbWords && dbWords.body));
      if (dbWords && (dbWords.body.includes(SECRET) || dbWords.body.includes(encodeURIComponent(SECRET)))) p.push('the words carried the string back');
      if (/KN_DATABASE_URL/.test(out) || out.includes(SECRET) || out.includes(encodeURIComponent(SECRET))) p.push('the dashboard\'s own terminal printed it');
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
    fs.rmSync(opened, { force: true });
    fs.rmSync(opener, { force: true });
    fs.rmSync(fakeNight, { force: true });
  }

  // Run by a script, with no command, it must not start a server that never
  // exits - it prints the usage and ends, as it always did.
  const bare = spawnSync(process.execPath, [cli], { cwd: project, env: process.env, encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] });
  check('with no command and no terminal, it prints the usage and exits', (() => {
    const p = [];
    if (bare.error) p.push('it did not exit: ' + bare.error.message);
    if (bare.status !== 0) p.push('exit ' + bare.status);
    if (!/npx kryptheon@latest dashboard/.test(bare.stdout || '')) p.push('the usage does not mention the dashboard');
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
