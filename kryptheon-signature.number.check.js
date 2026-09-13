// Checks that a number in a page is a number, whatever shape it is written in.
// Run with:  node kryptheon-signature.number.check.js
//
// This exists because of a real run. The normaliser replaced each run of digits
// rather than each value, so a savings rate of 0% normalised to "#%" and the
// same rate at 100.0% normalised to "#.#%". Two different strings, so the
// signature reported the page as changed:
//
//   Headings that are gone: "#%"
//   Headings that are new: "#.#%"
//
// Nothing was wrong with the app. A number had moved, which is the one thing
// normalising was supposed to absorb.
//
// The last case is the important one. It is easy to fix the above by blurring
// everything, and a normaliser that turns text into marks as well as numbers
// would pass every check above it while quietly hiding the changes this is here
// to catch.
//
// This file sits outside testDir and does not match Playwright's testMatch
// pattern, so `npx playwright test` ignores it.

const signature = require('./kryptheon-signature.js');

const norm = signature.normaliseText;

/** All of these must normalise to one and the same string. */
function allAlike(label, values) {
  const seen = values.map((v) => norm(v));
  const first = seen[0];
  const problems = [];
  values.forEach((value, i) => {
    if (seen[i] !== first) {
      problems.push(
        label + ': ' + JSON.stringify(value) + ' becomes ' + JSON.stringify(seen[i]) +
          ', but ' + JSON.stringify(values[0]) + ' becomes ' + JSON.stringify(first),
      );
    }
  });
  return problems;
}

// Six headings. Three of them carry numbers that move between runs.
const BEFORE = signature.buildSignature({
  headings: [
    'Overview',
    'Savings Rate 0%',
    'Monthly Spend $0',
    'Accounts',
    '3 transactions',
    'Settings',
  ],
  actions: ['Refresh', 'Export'],
  fields: ['Search'],
});

const AFTER_NUMBERS_MOVED = signature.buildSignature({
  headings: [
    'Overview',
    'Savings Rate 100.0%',
    'Monthly Spend $1,234.56',
    'Accounts',
    '1,208 transactions',
    'Settings',
  ],
  actions: ['Refresh', 'Export'],
  fields: ['Search'],
});

const AFTER_WORD_CHANGED = signature.buildSignature({
  headings: [
    'Overview',
    'Savings Rate 0%',
    'Monthly Spend $0',
    'Accounts',
    '3 transactions',
    // The only difference: a word. Numbers untouched.
    'Sign in to continue',
  ],
  actions: ['Refresh', 'Export'],
  fields: ['Search'],
});

const cases = [
  {
    name: '1. the one from the real run: 0% and 100.0% are the same page',
    run: () => {
      const problems = allAlike('a rate', ['Savings Rate 0%', 'Savings Rate 100.0%']);
      if (norm('Savings Rate 0%') !== 'Savings Rate #%') {
        problems.push('0% normalises to ' + JSON.stringify(norm('Savings Rate 0%')));
      }
      // The exact pair that was reported as gone and new.
      if (norm('100.0%') === '#.#%') problems.push('a decimal still leaves two marks behind: "#.#%"');
      return problems;
    },
  },
  {
    name: '2. $0 and $1,234.56 are the same amount as far as this is concerned',
    run: () => {
      const problems = allAlike('an amount', ['$0', '$1,234.56', '$1,234', '$0.99']);
      // The currency mark is not a digit and has to survive.
      if (norm('$0') !== '$#') problems.push('$0 normalises to ' + JSON.stringify(norm('$0')));
      return problems;
    },
  },
  {
    name: '3. 0.5% and 50% are the same',
    run: () => allAlike('a percentage', ['0.5%', '50%', '100.00%', '0%']),
  },
  {
    name: '4. a sign or a leading zero makes no difference',
    run: () => allAlike('a signed number', ['-42', '+3.14', '007', '0', '1,234', '1 234', '100.0']),
  },
  {
    name: '5. six headings, three with different numbers: nothing has changed',
    run: () => {
      const result = signature.compareSignatures(BEFORE, AFTER_NUMBERS_MOVED);
      if (result === null) return [];
      return ['it reported a change when only numbers moved:', ...String(result).split('\n')];
    },
  },
  {
    name: '6. one heading with different words: that IS a change',
    run: () => {
      const result = signature.compareSignatures(BEFORE, AFTER_WORD_CHANGED);
      if (result === null) {
        return ['a heading changed from "Settings" to "Sign in to continue" and it said nothing'];
      }
      const problems = [];
      const text = String(result);
      if (!/Settings/.test(text)) problems.push('it did not name the heading that went: ' + text);
      if (!/Sign in to continue/.test(text)) problems.push('it did not name the heading that arrived: ' + text);
      // The headings that only differ by their numbers must stay out of it.
      if (/Savings Rate|Monthly Spend|transactions/.test(text)) {
        problems.push('it also reported headings whose numbers merely moved: ' + text);
      }
      return problems;
    },
  },
  {
    name: '7. only digits are touched - the words come through untouched',
    run: () => {
      const problems = [];
      const pairs = [
        ['Overview', 'Overview'],
        ['Sign in to continue', 'Sign in to continue'],
        ['Accounts & Cards', 'Accounts & Cards'],
        ['3 items', '# items'],
        ['Step 2 of 3', 'Step # of #'],
      ];
      for (const [input, expected] of pairs) {
        const actual = norm(input);
        if (actual !== expected) {
          problems.push(JSON.stringify(input) + ' becomes ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
        }
      }
      // Two different words must stay two different strings.
      if (norm('Savings Rate 0%') === norm('Spending Rate 0%')) {
        problems.push('two different labels normalise to the same string');
      }
      return problems;
    },
  },
  {
    name: '8. a version number is taken whole, not left half-marked',
    run: () => {
      const problems = [];
      const v = norm('v1.2.3');
      if (/#\.#/.test(v)) problems.push('a version is left part-normalised: ' + JSON.stringify(v));
      // Whatever it does, it has to do the same to every version.
      const same = allAlike('a version', ['v1.2.3', 'v10.0.1', 'v1.2.3']);
      return problems.concat(same);
    },
  },
];

let failures = 0;
for (const c of cases) {
  let problems;
  try {
    problems = c.run();
  } catch (err) {
    problems = ['threw: ' + err.message];
  }
  if (problems.length) {
    failures++;
    console.log('FAIL  ' + c.name);
    problems.forEach((p) => console.log('      - ' + p));
  } else {
    console.log('PASS  ' + c.name);
  }
}

console.log('');
if (failures) {
  console.log(failures + ' check(s) failed.');
  process.exit(1);
}
console.log('All ' + cases.length + ' number-normalisation checks passed.');
