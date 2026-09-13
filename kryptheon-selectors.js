// Reading a recording back and asking: will this selector still match tomorrow?
//
// Codegen writes whatever identified the element at the moment it was clicked,
// and on a page full of live figures that means the numbers end up inside the
// selector:
//
//   page.locator('div').filter({ hasText: 'Savings Rate 0%' }).nth(3)
//
// The 0% is a calculated value. Next week it is 4%, the selector matches
// nothing, and the test fails while the app is perfectly fine. That failure is
// a lie, and a red that means nothing is as bad as a green that means nothing.
//
// So this reads the file codegen produced and says which selectors are resting
// on something that moves. It only reports. Nothing here rewrites a selector:
// the right replacement depends on the app, and guessing would trade a visible
// problem for an invisible one.
//
// Pure string work: no Playwright, no filesystem, so the command line and the
// reporter can both use it.

/* --------------------------------------------------------------------------
   What counts as data that moves.
-------------------------------------------------------------------------- */

// Money, in the shapes a UI actually prints it: a currency mark next to a
// number, or a grouped/decimal amount standing on its own.
const CURRENCY = /[$₹€£¥₽]\s*\d|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+\.\d{2}\b/;

const PERCENT = /\d+(?:\.\d+)?\s*%/;

const MONTHS = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;

// Clock times, calendar dates, and the relative stamps that change by the hour.
const DATETIME = new RegExp(
  [
    '\\b\\d{1,2}:\\d{2}\\b',
    '\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b',
    '\\b\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}\\b',
    '\\b\\d+\\s*(?:second|minute|hour|day|week|month|year)s?\\s*ago\\b',
    '\\b(?:just now|yesterday|today|tomorrow)\\b',
  ].join('|'),
  'i',
);

/**
 * What kind of moving data is in this text, if any.
 *
 * The kinds are ordered because they overlap - "$1,234.56" is currency before
 * it is a number - and because only the last of them is a maybe.
 */
function volatileKind(text) {
  const value = String(text || '');
  if (PERCENT.test(value)) return 'percent';
  if (CURRENCY.test(value)) return 'currency';
  if (DATETIME.test(value)) return 'datetime';
  if (MONTHS.test(value) && /\d/.test(value)) return 'datetime';
  // A bare digit is the weakest signal. "Step 2 of 3" is a heading that will
  // very likely still say that tomorrow, so it is reported differently rather
  // than not at all - the reader knows their own app, and this does not.
  if (/\d/.test(value)) return 'number';
  return null;
}

function describeKind(kind) {
  if (kind === 'percent') return 'a percentage that is calculated from live data';
  if (kind === 'currency') return 'an amount of money that changes as the data changes';
  if (kind === 'datetime') return 'a date or time that will not be the same tomorrow';
  return 'a number';
}

/* --------------------------------------------------------------------------
   Pulling the pieces out of a recorded line.
-------------------------------------------------------------------------- */

// Locators that match on text a person can read, and so can move when the
// content moves. getByLabel, getByPlaceholder and getByTestId are deliberately
// absent: a field's label and an author's test id are part of the app, not part
// of its data.
const TEXT_MATCHER = new RegExp(
  [
    'has(?:Not)?Text\\s*:\\s*(["\'])((?:\\\\.|(?!\\1)[^\\\\])*)\\1',
    'getBy(?:Text|Title|AltText)\\s*\\(\\s*(["\'])((?:\\\\.|(?!\\3)[^\\\\])*)\\3',
    'name\\s*:\\s*(["\'])((?:\\\\.|(?!\\5)[^\\\\])*)\\5',
  ].join('|'),
  'g',
);

// text= and :has-text() inside a raw CSS/Playwright selector string.
const INLINE_TEXT = /(?::has-text|:text-is|:text)\s*\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1|\btext\s*=\s*(["'])((?:\\.|(?!\3)[^\\])*)\3/g;

/** Every human-readable string this line matches on. */
function textMatchers(line) {
  const text = String(line || '');
  const found = [];
  let m;

  TEXT_MATCHER.lastIndex = 0;
  while ((m = TEXT_MATCHER.exec(text)) !== null) {
    const value = m[2] !== undefined ? m[2] : m[4] !== undefined ? m[4] : m[6];
    if (value !== undefined) found.push(value);
  }

  INLINE_TEXT.lastIndex = 0;
  while ((m = INLINE_TEXT.exec(text)) !== null) {
    const value = m[2] !== undefined ? m[2] : m[4];
    if (value !== undefined) found.push(value);
  }

  return found;
}

// Tags that say nothing about what the element is for. An element found by
// one of these has no anchor: it is wherever it happened to be that day.
const GENERIC_TAG = /^(?:div|span|p|li|ul|ol|td|tr|th|tbody|thead|table|section|article|main|header|footer|aside|nav|form|small|b|i|em|strong|figure)$/i;

/** The bare generic tag this line locates by, e.g. locator('div') -> div. */
function genericTagIn(line) {
  const m = String(line || '').match(/\.\s*locator\s*\(\s*(["'])\s*([A-Za-z][A-Za-z0-9]*)\s*\1/);
  if (!m) return null;
  return GENERIC_TAG.test(m[2]) ? m[2].toLowerCase() : null;
}

/** The positional step this line leans on, e.g. .nth(3) or .first(). */
function positionalIn(line) {
  const text = String(line || '');
  const nth = text.match(/\.\s*nth\s*\(\s*(-?\d+)\s*\)/);
  if (nth) return '.nth(' + nth[1] + ')';
  if (/\.\s*first\s*\(\s*\)/.test(text)) return '.first()';
  if (/\.\s*last\s*\(\s*\)/.test(text)) return '.last()';
  return null;
}

// The things done to an element, as opposed to the things that find one. The
// selector is everything before these.
const ACTIONS = new RegExp(
  '\\.\\s*(?:click|dblclick|fill|type|press|check|uncheck|selectOption|hover|tap|focus|blur|clear|' +
    'setInputFiles|dragTo|scrollIntoViewIfNeeded|selectText|waitFor|screenshot|' +
    'textContent|innerText|inputValue|isVisible|isChecked|count)\\s*\\(',
);

/**
 * The selector chain on a line, without the plumbing around it.
 *
 * Shown to the reader as-is, so it has to be the thing they will search their
 * file for - not a summary of it.
 */
function selectorChain(line) {
  let text = String(line || '').trim();
  text = text.replace(/^await\s+/, '');
  text = text.replace(/^(?:const|let|var)\s+\w+\s*=\s*/, '');
  text = text.replace(/^expect\s*\(\s*/, '');
  const page = text.match(/\bpage\s*\.\s*([\s\S]*)$/);
  if (page) text = page[1];

  // Cut at the action, so what is left is only how the element was found.
  const action = text.match(ACTIONS);
  if (action && action.index > 0) text = text.slice(0, action.index);

  text = text.replace(/[\s;]+$/, '');
  // An expect(...) wrapper leaves one unmatched closing bracket behind.
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(' || text[i] === '[' || text[i] === '{') depth++;
    else if (text[i] === ')' || text[i] === ']' || text[i] === '}') {
      depth--;
      if (depth < 0) return text.slice(0, i).replace(/[\s.;]+$/, '');
    }
  }
  return text;
}

/* --------------------------------------------------------------------------
   The report.
-------------------------------------------------------------------------- */

const TESTID_FIX =
  'put a data-testid on the element you are clicking, then getByTestId(...)';
const TESTID_FIX_2 = 'will find it whatever the numbers say,';
const TEXT_FIX = 'or match on text in the app that does not change.';

/**
 * Every selector in a recording that is resting on something that moves.
 *
 * A line can be fragile for more than one reason at once, and usually is: the
 * one that started this had live data in its text and a position in the DOM.
 * Both are reported, because fixing one of them still leaves a test that lies.
 */
function findFragileSelectors(source) {
  const findings = [];
  const lines = String(source || '').split('\n');

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!/\bpage\s*\./.test(line)) return;
    // A test id is an anchor the app author put there on purpose. Nothing on
    // such a line is guesswork, so nothing on it is reported.
    if (/getByTestId\s*\(/.test(line)) return;

    const reasons = [];

    for (const text of textMatchers(line)) {
      const kind = volatileKind(text);
      if (!kind) continue;
      reasons.push({
        kind: kind === 'number' ? 'number' : 'data',
        soft: kind === 'number',
        text: text,
        why:
          kind === 'number'
            ? "'" + text + "' has a number in it"
            : "'" + text + "' contains " + describeKind(kind),
      });
    }

    const positional = positionalIn(line);
    if (positional) {
      reasons.push({
        kind: 'positional',
        soft: false,
        text: positional,
        why: positional + ' depends on the order things appear in the page',
      });
    }

    const tag = genericTagIn(line);
    if (tag) {
      reasons.push({
        kind: 'generic',
        soft: false,
        text: tag,
        why: "locator('" + tag + "') is any " + tag + " at all, with nothing to say which one is meant",
      });
    }

    if (!reasons.length) return;

    findings.push({
      line: i + 1,
      selector: selectorChain(line),
      source: line,
      reasons: reasons,
      // A finding is only a maybe when every reason for it is a maybe.
      soft: reasons.every((r) => r.soft),
    });
  });

  return findings;
}

/**
 * The report, as lines, ready to print.
 *
 * Returns nothing at all when there is nothing to say. Silence is the correct
 * output for a clean recording - a tool that always prints something trains
 * people to stop reading it.
 */
function describeFragileSelectors(findings) {
  const list = findings || [];
  if (!list.length) return [];

  const count = list.length;
  const lines = [];
  lines.push('');
  lines.push('  ' + count + (count === 1 ? ' selector rests' : ' selectors rest') + ' on data that can change.');
  lines.push('  If the data changes, this test fails even though the app is fine:');
  lines.push('');

  // The reasons sit directly under the selector they are about, so a line
  // number reaching two digits does not shear the column apart.
  const width = Math.max.apply(null, list.map((f) => String(f.line).length));
  const indent = ' '.repeat('    line '.length + width + ':  '.length);

  for (const finding of list) {
    const label = String(finding.line).padStart(width);
    lines.push('    line ' + label + ':  ' + finding.selector);
    for (const reason of finding.reasons) lines.push(indent + reason.why);
    if (finding.soft) {
      lines.push(indent + 'this one may well be fine - only you know if that text moves');
    }
    lines.push('');
  }

  lines.push('    Better: ' + TESTID_FIX);
  lines.push('            ' + TESTID_FIX_2);
  lines.push('            ' + TEXT_FIX);
  lines.push('');
  lines.push('  The test will still run. Just know that a failure here');
  lines.push('  will not always mean a real bug.');
  lines.push('');
  return lines;
}

module.exports = {
  findFragileSelectors: findFragileSelectors,
  describeFragileSelectors: describeFragileSelectors,
  volatileKind: volatileKind,
  textMatchers: textMatchers,
  selectorChain: selectorChain,
  positionalIn: positionalIn,
  genericTagIn: genericTagIn,
};
