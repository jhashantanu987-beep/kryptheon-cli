// Telling apart the two things a red line can mean.
//
// A recording that used to pass and now does not is a regression: something
// changed and it is worth looking at. A recording that has never passed once is
// not a regression - there is nothing to regress from. Usually it was made
// while learning the tool, or it contains a step that cannot happen twice.
//
// Counting them together is what makes the first day miserable. Someone records
// three or four flows while working out what this is, runs check, and reads
// "2 working, 4 broken" - so the tool looks like it is reporting four faults in
// an app that is fine. Nothing is broken. Four recordings simply never had a
// baseline.
//
// Pure string and number work: no filesystem, no Playwright, so the reporter,
// the command line and the unit checks all use the same rules.

/**
 * How a run actually went, in the three states that mean different things.
 *
 * `unproven` is deliberately not folded into `broken`. It is the whole point.
 */
function summarise(records) {
  const list = records || [];
  let working = 0;
  let broken = 0;
  let unproven = 0;

  for (const record of list) {
    if (!record) continue;
    if (record.status === 'passed') {
      working++;
    } else if (record.status === 'failed') {
      if (record.neverPassed) unproven++;
      else broken++;
    }
  }
  return { working: working, broken: broken, unproven: unproven };
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

/**
 * The lines that explain a set of recordings that have never passed.
 *
 * Said as a state of the recordings rather than a fault in the app, because
 * that is what it is, and because the reader's next move is to make each one
 * pass once - not to go looking through their code.
 */
function unprovenLines(count) {
  if (!count) return [];
  const is = count === 1 ? 'has' : 'have';
  const it = count === 1 ? 'it' : 'they';
  return [
    plural(count, 'recording') + ' ' + is + ' no baseline yet - ' + it + ' ' + is + ' never passed.',
    'Each one has to pass once before it can tell you anything. Until then',
    'nothing is known to be broken.',
  ];
}

/**
 * The summary at the end of a run, in two parts when the second part applies.
 *
 * The first line only ever counts recordings that once worked, so a green
 * "0 broken" stays honest: it means nothing regressed, and the line underneath
 * says what is still unproven rather than hiding it.
 */
function summaryLines(counts) {
  const c = counts || { working: 0, broken: 0, unproven: 0 };
  const lines = ['Summary: ' + c.working + ' working, ' + c.broken + ' broken.'];
  for (const line of unprovenLines(c.unproven)) lines.push(line);
  return lines;
}

/**
 * The baseline keys belonging to one recording file.
 *
 * Baselines are keyed "tests/thing.spec.js :: Title", so removing a recording
 * without removing these would leave the saved results of a file that is no
 * longer there.
 */
function baselineKeysForSpec(baselines, specPath) {
  const wanted = String(specPath || '').split('\\').join('/');
  if (!wanted) return [];
  return Object.keys(baselines || {}).filter((key) => {
    const file = String(key).split(' :: ')[0].split('\\').join('/');
    return file === wanted;
  });
}

/**
 * What a person meant by their answer to a numbered list.
 *
 * Accepts a number, a file name, "all", or nothing at all. Anything else is
 * reported as not understood rather than guessed at - these answers delete
 * files, so a near-miss must never be treated as a choice.
 */
function chooseFromList(names, answer) {
  const list = names || [];
  const said = String(answer == null ? '' : answer).trim();
  if (!said) return { action: 'cancel' };
  if (/^(a|all)$/i.test(said)) return { action: 'remove', names: list.slice() };

  if (/^\d+$/.test(said)) {
    const index = Number(said);
    if (index < 1 || index > list.length) {
      return { action: 'unclear', said: said, why: 'there is no recording numbered ' + index };
    }
    return { action: 'remove', names: [list[index - 1]] };
  }

  const lower = said.toLowerCase();
  const matches = list.filter((name) => {
    const n = String(name).toLowerCase();
    return n === lower || n === lower + '.spec.js' || n.replace(/\.spec\.js$/, '') === lower;
  });
  if (matches.length === 1) return { action: 'remove', names: matches };
  if (matches.length > 1) {
    return { action: 'unclear', said: said, why: 'more than one recording is called that' };
  }
  return { action: 'unclear', said: said, why: 'there is no recording called that' };
}

/**
 * What to ask when a project already has recordings and another is starting.
 *
 * Keeping is the default because it is the answer that cannot lose work.
 */
function existingRecordingsQuestion(count) {
  return [
    '',
    '  This project already has ' + plural(count, 'recording') + '.',
    '',
    '    k  keep them, and add this new one   (default)',
    '    r  replace them - delete ' + (count === 1 ? 'it' : 'all ' + count) + ' and keep only this one',
    '',
  ];
}

module.exports = {
  summarise: summarise,
  summaryLines: summaryLines,
  unprovenLines: unprovenLines,
  baselineKeysForSpec: baselineKeysForSpec,
  chooseFromList: chooseFromList,
  existingRecordingsQuestion: existingRecordingsQuestion,
  plural: plural,
};
