// One look at a project: what changed since the last look, which checks that
// calls for, run the ones that can run, and what is new, fixed or merely
// deleted. Shared by `npx kryptheon verify` and the dashboard's own watch, so
// the command and the page can never tell two different stories.
//
// Printing is not done here; the caller decides how to say it.

const fs = require('fs');
const path = require('path');
const store = require('./kryptheon-store.js');
const changes = require('./kryptheon-changes.js');
const dash = require('./kryptheon-dashboard.js');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

/**
 * Looks once. `runners` does the work that needs the caller's tools:
 *   runners.frontend()   -> { ran, why }          (the code read)
 *   runners.regression() -> exit code, or null     (replaying the recordings)
 * `options.replay` false keeps the recordings from being replayed - the
 * dashboard's automatic look does that by default, because a replay while the
 * app is not running reports every flow broken, and that would be a lie.
 */
function look(root, runners, options) {
  const opts = options || {};
  const paths = store.pathsFor(root);
  const previous = readJson(paths.snapshot);
  const now = changes.takeSnapshot(root, previous);
  const diff = changes.compare(previous, now);
  const before = dash.buildState(root);
  const enabled = dash.readConfig(paths).enabled;
  const available = new Set(dash.CHECKS.filter((c) => c.available).map((c) => c.id));

  // On a first look, every check that can run, so the next look has
  // something to compare against.
  const wanted = diff.first ? ['frontend', 'regression', 'data'] : diff.checks;
  const plan = wanted.map((id) => {
    if (!available.has(id)) return { id: id, state: 'not available yet' };
    if (!enabled[id]) return { id: id, state: 'switched off in the dashboard' };
    if (id === 'data') return { id: id, state: 'needs your database - run npx kryptheon-night' };
    if (id === 'regression' && !before.recordings) return { id: id, state: 'no recordings yet - npx kryptheon record <url>' };
    if (id === 'regression' && opts.replay === false) return { id: id, state: 'not replayed automatically - press Run now when your app is running' };
    return { id: id, state: 'run', run: true };
  });

  // What changed is said before anything runs: a replay can take a minute,
  // and the person should not sit through it without knowing why.
  if (typeof runners.beforeRun === 'function') runners.beforeRun(diff, now);

  let regressionExit = null;
  for (const step of plan.filter((s) => s.run)) {
    if (step.id === 'frontend') {
      const r = runners.frontend();
      step.state = r.ran ? 'ran' : 'could not run: ' + r.why;
    } else if (step.id === 'regression') {
      regressionExit = runners.regression();
      step.state = regressionExit === 0 ? 'ran - every recording held'
        : regressionExit === 1 ? 'ran - something broke'
        : 'could not run (exit ' + regressionExit + ')';
    }
  }

  const after = dash.buildState(root);
  const fresh = changes.newFindings(before.findings, after.findings);
  const gone = changes.goneFindings(before.findings, after.findings);
  // A finding whose file was deleted is gone, not fixed - the same rule as a
  // dropped table in the database check. Kept apart, so deleting the code a
  // finding points at is never mistaken for making it safe.
  const fileOf = (f) => path.join(root, String(f.where || '').replace(/:\d+$/, ''));
  const removed = gone.filter((f) => f.check !== 'data' && !fs.existsSync(fileOf(f)));
  const fixed = gone.filter((f) => removed.indexOf(f) === -1);
  const openConfirmed = after.findings.filter((f) => f.status === 'confirmed');

  const event = {
    at: now.takenAt,
    by: opts.by || 'verify',
    first: diff.first,
    files: diff.files,
    parts: diff.parts,
    dependencies: diff.dependencies,
    checks: plan.map((s) => ({ id: s.id, state: s.state })),
    newFindings: fresh.length,
    fixed: fixed.length,
    goneWithFile: removed.length,
    openConfirmed: openConfirmed.length,
  };
  let saveError = null;
  try {
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.snapshot, JSON.stringify(now) + '\n', 'utf8');
    fs.appendFileSync(paths.changes, JSON.stringify(event) + '\n', 'utf8');
  } catch (err) {
    saveError = err.message;
  }

  return {
    diff: diff,
    snapshot: now,
    plan: plan,
    fresh: fresh,
    fixed: fixed,
    removed: removed,
    openConfirmed: openConfirmed,
    after: after,
    regressionExit: regressionExit,
    event: event,
    saveError: saveError,
  };
}

/**
 * Whether anything changed since the last look, without looking. Cheap enough
 * to poll: unchanged files keep their hash without being read. The signature
 * carries each changed file's content hash, so a file still being written
 * keeps changing it - which is what tells a pause from the end of a task.
 */
function pending(root) {
  const paths = store.pathsFor(root);
  const previous = readJson(paths.snapshot);
  if (!previous) return { changed: false, first: true };
  const now = changes.takeSnapshot(root, previous);
  const diff = changes.compare(previous, now);
  const signature = JSON.stringify(diff.files.map((f) => [f.path, f.state, now.files[f.path] ? now.files[f.path].hash : null]));
  return { changed: diff.files.length > 0, files: diff.files.length, signature: signature };
}

/**
 * Looks by itself whenever the project changes, and waits for the change to
 * settle first. An AI tool writes a dozen files over half a minute; looking
 * after the first one would report a half-finished task as broken. So a look
 * happens once the changed files have stayed the same for `quietMs`.
 *
 * Recorded flows are not replayed here unless `replay` is true: an automatic
 * replay while the app is not running reports every flow broken.
 */
function startWatch(root, runners, options) {
  const opts = options || {};
  const intervalMs = opts.intervalMs || 2000;
  const quietMs = opts.quietMs || 4000;
  let seen = null;
  let since = 0;
  let busy = false;
  const doLook = () => {
    busy = true;
    try {
      const result = look(root, runners, { by: 'watch', replay: opts.replay === true });
      if (typeof opts.onLook === 'function') opts.onLook(result);
    } catch (err) {
      if (typeof opts.onError === 'function') opts.onError(err);
    } finally {
      busy = false;
    }
  };
  const tick = () => {
    if (busy) return;
    const p = pending(root);
    // Nothing to compare against yet: this first look is the starting point.
    if (p.first) return doLook();
    if (!p.changed) {
      seen = null;
      return;
    }
    if (p.signature !== seen) {
      seen = p.signature;
      since = Date.now();
      return;
    }
    if (Date.now() - since >= quietMs) doLook();
  };
  const timer = setInterval(tick, intervalMs);
  if (timer.unref && opts.unref) timer.unref();
  // Now, not one interval from now: a change made in the first seconds after
  // the page opened would otherwise land in the starting point and never be
  // seen as a change at all.
  tick();
  return {
    tick: tick,
    stop() {
      clearInterval(timer);
    },
  };
}

module.exports = { look: look, pending: pending, startWatch: startWatch };
