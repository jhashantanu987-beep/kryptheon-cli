// Keeping a saved result tied to the recording it came from.
//
// A baseline used to be identified by where the recording lived and what it was
// called. That is not enough. Delete the spec files with `del tests\*.spec.js` -
// which is what anyone does before the tool has taught them `kryptheon remove` -
// record the flow again, and the new recording is handed the same name. Same
// path, same title, same key. It inherits the old recording's saved page and
// fails on its very first run, against a baseline it never created and could
// never have matched.
//
// The report that came out of that said both of these at once:
//
//   This has not passed before.
//   Headings that are gone: "Transactions"
//
// Which cannot both be true. If it has never passed there is no baseline of its
// own to have changed, so there is nothing to show a difference against.
//
// So a saved result now also records a fingerprint of the recording that made
// it. When the recording is gone, or its steps are not the steps the baseline
// was taken from, the saved result describes something that no longer exists
// and is thrown away rather than compared against.
//
// Pure data work: no Playwright, no test runner.

const fs = require('fs');
const path = require('path');
const replay = require('./kryptheon-replay.js');

/** The spec file half of a baseline key, in one consistent shape. */
function specOf(key) {
  return String(key || '').split(' :: ')[0].split('\\').join('/');
}

function titleOf(key) {
  const parts = String(key || '').split(' :: ');
  return parts.length > 1 ? parts.slice(1).join(' :: ') : '';
}

/** The fingerprint of the recording in a file, or null if it cannot be read. */
function fingerprintOf(userDir, specPath) {
  let source;
  try {
    source = fs.readFileSync(path.join(userDir, specPath), 'utf8');
  } catch (e) {
    return null;
  }
  return replay.recordingId(source);
}

/**
 * What each saved result is: still current, orphaned, or stale.
 *
 * `orphan`  - the recording it belongs to is not there any more.
 * `stale`   - a recording of that name exists, but it is not the one this was
 *             taken from. This is the case that cost twenty minutes: the file
 *             is present, so nothing looks wrong.
 * `legacy`  - written before fingerprints existed. There is no way to tell
 *             whether it matches, so it is kept, and a fingerprint is written
 *             in so the question can be answered next time. Guessing here would
 *             mean either throwing away a good baseline or, far worse, quietly
 *             accepting a real regression as the new normal.
 */
function classifyBaselines(baselines, userDir) {
  const all = baselines || {};
  const verdicts = [];

  for (const key of Object.keys(all)) {
    const entry = all[key];
    const spec = specOf(key);
    if (!entry || typeof entry !== 'object') {
      verdicts.push({ key: key, state: 'orphan', spec: spec, title: titleOf(key) });
      continue;
    }

    let exists = false;
    try {
      exists = fs.statSync(path.join(userDir, spec)).isFile();
    } catch (e) {
      exists = false;
    }
    if (!exists) {
      verdicts.push({ key: key, state: 'orphan', spec: spec, title: titleOf(key) });
      continue;
    }

    const now = fingerprintOf(userDir, spec);
    if (!entry.recordingId) {
      verdicts.push({ key: key, state: 'legacy', spec: spec, title: titleOf(key), fingerprint: now });
      continue;
    }
    if (now && entry.recordingId !== now) {
      verdicts.push({ key: key, state: 'stale', spec: spec, title: titleOf(key), fingerprint: now });
      continue;
    }
    verdicts.push({ key: key, state: 'current', spec: spec, title: titleOf(key) });
  }

  return verdicts;
}

/**
 * The saved results with the dead ones taken out.
 *
 * Returns a new object; nothing is written here. The caller decides whether the
 * file is worth rewriting, so a check that changes nothing never touches it.
 */
function pruneBaselines(baselines, userDir) {
  const all = baselines || {};
  const verdicts = classifyBaselines(all, userDir);
  const kept = {};
  const dropped = [];
  let stamped = 0;

  for (const verdict of verdicts) {
    if (verdict.state === 'orphan' || verdict.state === 'stale') {
      dropped.push(verdict);
      continue;
    }
    const entry = all[verdict.key];
    if (verdict.state === 'legacy' && verdict.fingerprint) {
      // Kept as it is, but tied to this recording from now on.
      kept[verdict.key] = Object.assign({}, entry, { recordingId: verdict.fingerprint });
      stamped++;
      continue;
    }
    kept[verdict.key] = entry;
  }

  return { baselines: kept, dropped: dropped, stamped: stamped, changed: dropped.length > 0 || stamped > 0 };
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

/**
 * One line about what was thrown away, said as a fact rather than a warning.
 *
 * Nothing has gone wrong when this happens - a recording was deleted or redone,
 * which is a normal thing to do. It is said out loud only so that a flow which
 * suddenly starts from scratch is not a mystery.
 */
function pruneLines(dropped) {
  const list = dropped || [];
  if (!list.length) return [];

  const orphans = list.filter((d) => d.state === 'orphan');
  const stale = list.filter((d) => d.state === 'stale');
  const lines = [];

  if (orphans.length) {
    lines.push(
      '  ' + plural(orphans.length, 'old baseline') + ' removed - ' +
        (orphans.length === 1 ? 'its recording is' : 'their recordings are') + ' no longer here.',
    );
  }
  if (stale.length) {
    lines.push(
      '  ' + plural(stale.length, 'old baseline') + ' removed - ' +
        (stale.length === 1 ? 'its recording has' : 'those recordings have') +
        ' been recorded again since.',
    );
  }
  lines.push('');
  return lines;
}

/**
 * The last run of one recorded test, from the run history: whether it
 * passed, and where it broke if it did not. Null when it has never run.
 */
function lastRunOf(historyFile, key) {
  let lines = [];
  try {
    lines = fs.readFileSync(historyFile, 'utf8').split('\n').filter(Boolean);
  } catch (e) {
    return null;
  }
  const spec = specOf(key);
  const title = titleOf(key);
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch (e) {
      continue;
    }
    const test = (entry.tests || []).find((t) => t && t.title === title && specOf(t.specFile) === spec);
    if (test) return { status: test.status, at: entry.runAt, failure: test.failure || null };
  }
  return null;
}

/**
 * What accept says when there is nothing it can take, from the last run.
 *
 * Found on a blind test (HelixOps): a step was broken on purpose, and accept
 * answered "it last matched its saved result" - the opposite of what had
 * happened. accept only takes a run that went all the way through and ended
 * on a different page; a step that no longer matches is a changed flow or a
 * broken app, and neither is accepted.
 */
function nothingToAcceptLines(name, last) {
  if (last && last.status === 'failed') {
    const failure = last.failure || {};
    const where = failure.line ? ' at line ' + failure.line + (failure.file ? ' of ' + specOf(failure.file) : '') : '';
    const what = failure.plainLanguage ? ' (' + String(failure.plainLanguage).replace(/\.$/, '') + ')' : '';
    return [
      '"' + name + '" has nothing to accept: its last run broke' + where + ', before the end' + what + '.',
      'accept only covers a run that went all the way through and finished on a different page - ' +
        'a new address or a new title.',
      'A step that no longer matches cannot be accepted. If the flow changed on purpose, record it ' +
        'again (npx kryptheon record). If it did not, the app broke, and npx kryptheon check says what to fix.',
    ];
  }
  if (last && last.status === 'passed') {
    return ['"' + name + '" has no new result waiting.', 'Nothing to accept - its last run matched its saved result.'];
  }
  return ['"' + name + '" has no new result waiting.', 'Nothing to accept - no run has finished on a different page.'];
}

module.exports = {
  specOf: specOf,
  titleOf: titleOf,
  fingerprintOf: fingerprintOf,
  classifyBaselines: classifyBaselines,
  pruneBaselines: pruneBaselines,
  pruneLines: pruneLines,
  lastRunOf: lastRunOf,
  nothingToAcceptLines: nothingToAcceptLines,
};
