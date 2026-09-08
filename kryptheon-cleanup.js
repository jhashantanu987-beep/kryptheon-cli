// Taking the fumbling out of a recording before it becomes a baseline.
//
// Codegen records every keystroke, including the wrong ones. A username typed
// once with a typo and again correctly comes out as two fills of the same box:
//
//   await page.getByRole('textbox', { name: 'Username' }).fill('shantanu892');
//   await page.getByRole('textbox', { name: 'Username' }).fill('shantanu89');
//
// Kept as-is, that is not a tidiness problem. The first fill is a whole wrong
// login attempt performed on every run from then on, and the mistake is baked
// into the baseline as if it were the intended flow.
//
// The same happens with a stray click on nothing - getByRole('img') with no
// name and no text identifies nothing, and clicking it does nothing - and with
// the same button clicked twice because the first one seemed not to take.
//
// Everything here follows one rule: when in doubt, keep it. Leaving a pointless
// step in a recording costs a moment. Removing a real one silently changes what
// the test does, and nobody finds out until the thing it was covering breaks
// unnoticed. So every removal below needs the steps to be adjacent, to be the
// same action on the same element, and to have nothing between them - anything
// less certain is left alone.
//
// Pure string work: no Playwright, no filesystem.

const selectors = require('./kryptheon-selectors.js');

/* --------------------------------------------------------------------------
   Reading the recording as steps.
-------------------------------------------------------------------------- */

// Only the things a person does to the page.
//
// Assertions end in toBeVisible, toHaveText and the like, none of which are
// here, so an assertion is never read as a step in the first place. There was
// an explicit guard against them as well; mutation testing showed removing it
// changed nothing, and a line that reads like the reason something is safe -
// while not being the reason - is worse than no line at all. This list is the
// reason. Anything added to it has to be a thing a person actually did.
const ACTION = /\.\s*(click|dblclick|fill|type|press|check|uncheck|selectOption|hover|tap|setInputFiles|clear|goto)\s*\(/;

/**
 * Every line that does something to the page, with the parts that matter.
 *
 * `chain` is how the element was found, which is what makes two steps "the
 * same element". It comes from the same reader the fragile-selector report
 * uses, so the two can never disagree about what a step points at.
 */
function readSteps(source) {
  const steps = [];
  String(source || '')
    .split('\n')
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!/\bpage\s*\./.test(line)) return;
      const match = line.match(ACTION);
      if (!match) return;
      steps.push({
        line: i + 1,
        text: line,
        action: match[1],
        chain: selectors.selectorChain(line),
      });
    });
  return steps;
}

/** The readable name of the thing a step acts on, for saying what went. */
function labelFor(chain) {
  const text = String(chain || '');
  let m = text.match(/name:\s*(['"])(.*?)\1/);
  if (m) return m[2];
  m = text.match(/getBy(?:Label|Placeholder|Text|TestId|Title|AltText)\(\s*(['"])(.*?)\1/);
  if (m) return m[2];
  m = text.match(/getByRole\(\s*(['"])(.*?)\1/);
  if (m) return 'the ' + m[2];
  m = text.match(/locator\(\s*(['"])(.*?)\1/);
  if (m) return m[2];
  return 'it';
}

/* --------------------------------------------------------------------------
   A step that points at nothing.
-------------------------------------------------------------------------- */

// Anything that says which element is meant. One of these present is enough
// for a step to be left alone.
const IDENTIFYING = /name\s*:|getByLabel|getByPlaceholder|getByTestId|getByTitle|getByAltText|getByText/;

// What a .filter({ hasText: ... }) is matching on, if anything.
const HAS_TEXT = /has(?:Not)?Text\s*:\s*(\/(?:\\.|[^/\\])*\/[a-z]*|(['"])(?:\\.|(?!\2).)*\2)/;

/**
 * Whether a text filter actually narrows anything down.
 *
 * `hasText: /^$/` is the one codegen writes when there was no text to match
 * on - it says "an element with empty text", which is every empty element on
 * the page. Written out as a test rather than folded into the pattern above,
 * because a lookahead there can slide along and match at the space instead,
 * which quietly reads an empty filter as identifying.
 */
function narrowsAnything(chain) {
  const m = String(chain || '').match(HAS_TEXT);
  if (!m) return false;
  const value = m[1];
  if (value[0] !== '/') return value.length > 2; // a non-empty string
  const body = value.slice(1, value.lastIndexOf('/'));
  return body !== '' && body !== '^$';
}

// A CSS selector that picks something out: an id, a class, an attribute.
const ANCHORED = /locator\(\s*(['"])[^'"]*[#.\[][^'"]*\1/;

// Roles that are not there to be used. A click on one of these does nothing,
// which is why codegen only ever writes them by accident. Interactive roles -
// button, link, textbox - are deliberately absent even when unnamed: an
// unnamed button is still a button, and removing a click on one would change
// what the recording does.
const INERT_ROLE = /getByRole\(\s*(['"])(img|image|generic|presentation|none|paragraph|separator|figure)\1/;

/**
 * A click on something with nothing to identify it.
 *
 * Both halves are required: the step must name nothing at all, and the element
 * must be of a kind that does nothing when clicked. Either one on its own is
 * not enough to be sure.
 */
function pointsAtNothing(step) {
  if (!step || step.action !== 'click') return false;
  const chain = step.chain;
  if (IDENTIFYING.test(chain)) return false;
  if (narrowsAnything(chain)) return false;
  if (ANCHORED.test(chain)) return false;
  return INERT_ROLE.test(chain);
}

/* --------------------------------------------------------------------------
   The clean-up.
-------------------------------------------------------------------------- */

/**
 * The steps to take out, and why, in the words they will be reported in.
 *
 * Nothing here looks at the values that were typed. They are not needed to
 * decide anything, and by this point a password may already have been moved
 * into an environment variable - printing "typed X then Y" would put the very
 * thing that was just hidden back on the screen.
 */
function findRedundantSteps(source) {
  const steps = readSteps(source);
  const removals = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const next = steps[i + 1];

    if (pointsAtNothing(step)) {
      removals.push({
        line: step.line,
        text: step.text,
        kind: 'points-at-nothing',
        why: 'a click on something with nothing to identify it',
      });
      continue;
    }

    if (!next || next.chain !== step.chain || step.action === 'goto') continue;

    // Adjacent in the list, so nothing happened in between. A fill with
    // another action between it and the next one is somebody going back to a
    // field on purpose, and both are kept.
    if (step.action === 'fill' && next.action === 'fill') {
      removals.push({
        line: step.line,
        text: step.text,
        kind: 'typed-twice',
        why: labelFor(step.chain) + ' was typed twice in a row, and only the last one counts',
      });
      continue;
    }

    if (step.action === 'click' && next.action === 'click') {
      // The second click is the one dropped: the first is what the person
      // meant to do, and it is the one whose effect the rest of the recording
      // was made against.
      removals.push({
        line: next.line,
        text: next.text,
        kind: 'clicked-twice',
        why: labelFor(step.chain) + ' was clicked twice in a row, and once is enough',
      });
      i++;
    }
  }

  return removals;
}

/**
 * The recording with the fumbling taken out.
 *
 * Lines are removed by number and nothing else is touched, so what comes back
 * is the file as it was minus whole lines - never reformatted, never rewritten.
 */
function cleanRecording(source) {
  const text = String(source || '');
  const removed = findRedundantSteps(text);
  if (!removed.length) return { source: text, removed: [] };

  const drop = new Set(removed.map((r) => r.line));
  const kept = text.split('\n').filter((line, i) => !drop.has(i + 1));
  return { source: kept.join('\n'), removed: removed };
}

/**
 * What was taken out, said plainly.
 *
 * Never silent about it. A tool that edits what you recorded and does not say
 * so is worse than one that leaves the mess in - the next time the recording
 * does something unexpected, you have no way of knowing it was changed.
 */
function describeCleanup(removed) {
  const list = removed || [];
  if (!list.length) return [];

  const lines = [];
  lines.push('');
  lines.push(
    '  ' + list.length + (list.length === 1 ? ' step was' : ' steps were') + ' taken out of the recording:',
  );
  for (const item of list) lines.push('    - ' + item.why);
  lines.push('');
  lines.push('  Everything else was left exactly as you did it.');
  lines.push('');
  return lines;
}

module.exports = {
  readSteps: readSteps,
  findRedundantSteps: findRedundantSteps,
  cleanRecording: cleanRecording,
  describeCleanup: describeCleanup,
  pointsAtNothing: pointsAtNothing,
  labelFor: labelFor,
};
