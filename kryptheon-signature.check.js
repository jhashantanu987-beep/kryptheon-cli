// Unit checks for the DOM signature.
// Run with:  node kryptheon-signature.check.js
//
// The problem this feature exists for: a login flow stopped logging anyone in
// after a backend field was renamed, and kryptheon still said OK. The app is a
// single-page app with a catch-all route, so the final address and the page
// title were identical either way and the baseline saw no difference. What did
// change was the words on the page - which is what a signature records.
//
// This file sits outside testDir and does not match Playwright's testMatch
// pattern, so `npx playwright test` ignores it.

const sig = require('./kryptheon-signature.js');

const cases = [
  {
    name: 'digit sequences collapse, so a moving number is not a difference',
    run: () => {
      const a = sig.normaliseText('Savings Rate 0%');
      const b = sig.normaliseText('Savings Rate 12%');
      if (a !== b) return ['"' + a + '" and "' + b + '" should normalise the same'];
      return a === 'Savings Rate #%' ? [] : ['unexpected: ' + a];
    },
  },
  {
    name: 'whitespace is collapsed and the text trimmed',
    run: () => {
      const out = sig.normaliseText('\n  Sign   in  \t');
      return out === 'Sign in' ? [] : ['got: "' + out + '"'];
    },
  },
  {
    name: 'text longer than the cap is cut to the cap',
    run: () => {
      const out = sig.normaliseText('x'.repeat(300));
      return out.length === sig.MAX_TEXT ? [] : ['length was ' + out.length + ', wanted ' + sig.MAX_TEXT];
    },
  },
  {
    name: 'headings keep document order, actions and fields are sorted',
    run: () => {
      const s = sig.buildSignature({
        headings: ['Zebra', 'Apple'],
        actions: ['Sign in', 'Cancel'],
        fields: ['Password', 'Email'],
      });
      const problems = [];
      if (s.headings.join('|') !== 'Zebra|Apple') problems.push('headings reordered: ' + s.headings.join('|'));
      if (s.actions.join('|') !== 'Cancel|Sign in') problems.push('actions not sorted: ' + s.actions.join('|'));
      if (s.fields.join('|') !== 'Email|Password') problems.push('fields not sorted: ' + s.fields.join('|'));
      return problems;
    },
  },
  {
    name: 'repeats collapse and empty strings are dropped',
    run: () => {
      const s = sig.buildSignature({
        headings: ['Dashboard', ' Dashboard ', '', '   '],
        actions: ['Save', 'Save'],
      });
      const problems = [];
      if (s.headings.length !== 1) problems.push('headings: ' + JSON.stringify(s.headings));
      if (s.actions.length !== 1) problems.push('actions: ' + JSON.stringify(s.actions));
      return problems;
    },
  },
  {
    name: 'the action list is capped',
    run: () => {
      const many = [];
      for (let i = 0; i < 90; i++) many.push('Button ' + String.fromCharCode(97 + (i % 26)) + '-' + i);
      const s = sig.buildSignature({ actions: many });
      return s.actions.length <= sig.MAX_ACTIONS ? [] : ['kept ' + s.actions.length];
    },
  },
  {
    name: 'a request path carries no host, query string or fragment',
    run: () => {
      const out = sig.signaturePath('https://app.example.com/api/login?token=secret&next=/x#frag');
      return out === '/api/login' ? [] : ['got: ' + out];
    },
  },
  {
    name: 'a relative request path is stripped the same way',
    run: () => {
      const out = sig.signaturePath('/api/session?id=99');
      return out === '/api/session' ? [] : ['got: ' + out];
    },
  },
  {
    name: 'only 4xx and 5xx responses are recorded',
    run: () => {
      const s = sig.buildSignature({
        failedRequests: [
          { method: 'POST', url: 'https://x.test/api/login?u=a', status: 401 },
          { method: 'GET', url: 'https://x.test/api/me', status: 200 },
          { method: 'GET', url: 'https://x.test/api/boom', status: 500 },
          { method: 'GET', url: 'https://x.test/api/redir', status: 302 },
        ],
      });
      const problems = [];
      if (s.failedRequests.length !== 2) problems.push('kept ' + JSON.stringify(s.failedRequests));
      const login = s.failedRequests[0];
      if (login && login.path !== '/api/login') problems.push('the path kept a query string: ' + login.path);
      if (login && Object.keys(login).sort().join(',') !== 'method,path,status') {
        problems.push('unexpected fields: ' + Object.keys(login).join(','));
      }
      return problems;
    },
  },
  {
    name: 'the same failed request twice is recorded once',
    run: () => {
      const s = sig.buildSignature({
        failedRequests: [
          { method: 'POST', url: 'https://x.test/api/login?a=1', status: 401 },
          { method: 'POST', url: 'https://x.test/api/login?a=2', status: 401 },
        ],
      });
      return s.failedRequests.length === 1 ? [] : ['kept ' + s.failedRequests.length];
    },
  },
  {
    name: 'a signature built from nothing has the full shape',
    run: () => {
      const s = sig.buildSignature();
      const shape = Object.keys(s).sort().join(',');
      return shape === 'actions,failedRequests,fields,headings' ? [] : ['shape: ' + shape];
    },
  },
  {
    name: 'collection is off unless the flag is exactly 1',
    run: () => {
      const problems = [];
      if (sig.signatureEnabled({})) problems.push('enabled with no flag set');
      if (sig.signatureEnabled({ KRYPTHEON_DEBUG_SIGNATURE: '0' })) problems.push('enabled at 0');
      if (sig.signatureEnabled({ KRYPTHEON_DEBUG_SIGNATURE: 'true' })) problems.push('enabled at "true"');
      if (!sig.signatureEnabled({ KRYPTHEON_DEBUG_SIGNATURE: '1' })) problems.push('not enabled at 1');
      return problems;
    },
  },
  {
    name: 'a page that cannot be read yields null, never a throw',
    run: async () => {
      const closed = () => Promise.reject(new Error('Target page has been closed'));
      const dead = { waitForLoadState: closed, waitForTimeout: closed, evaluate: closed };
      const out = await sig.collectSignature(dead, []);
      return out === null ? [] : ['expected null, got ' + JSON.stringify(out)];
    },
  },
  {
    name: 'the failed requests seen by the run reach the signature',
    run: async () => {
      const page = {
        waitForLoadState: async () => {},
        waitForTimeout: async () => {},
        evaluate: async () => ({ headings: ['Sign in'], actions: ['Sign in'], fields: ['Email'] }),
      };
      const out = await sig.collectSignature(page, [
        { method: 'POST', url: 'https://x.test/api/login?a=1', status: 401 },
      ]);
      if (!out) return ['got null'];
      const problems = [];
      if (out.headings.join('|') !== 'Sign in') problems.push('headings: ' + JSON.stringify(out.headings));
      if (out.failedRequests.length !== 1) problems.push('requests: ' + JSON.stringify(out.failedRequests));
      return problems;
    },
  },
  {
    name: 'reordering the same items is not a difference',
    run: () => {
      const before = sig.buildSignature({
        headings: ['Your workspace', 'Recent activity'],
        actions: ['Sign out', 'Settings'],
        fields: ['Email', 'Password'],
      });
      const after = sig.buildSignature({
        headings: ['Recent activity', 'Your workspace'],
        actions: ['Settings', 'Sign out'],
        fields: ['Password', 'Email'],
      });
      const message = sig.compareSignatures(before, after);
      return message === null ? [] : ['reported a change for a reorder:' + message];
    },
  },
  {
    name: 'a number moving is not a difference',
    run: () => {
      const before = sig.buildSignature({ headings: ['Savings Rate 0%'] });
      const after = sig.buildSignature({ headings: ['Savings Rate 12%'] });
      const message = sig.compareSignatures(before, after);
      return message === null ? [] : ['reported a change for a moving number:' + message];
    },
  },
  {
    name: 'a page that swapped its content is a difference, and says what moved',
    run: () => {
      const before = sig.buildSignature({ headings: ['Your workspace'], actions: ['Sign out'] });
      const after = sig.buildSignature({ headings: ['Sign in'], fields: ['Password'] });
      const message = sig.compareSignatures(before, after);
      if (!message) return ['no change was reported'];
      const problems = [];
      if (!/ended up somewhere different than before/.test(message)) problems.push('wrong headline: ' + message.split(String.fromCharCode(10))[0]);
      if (!/Headings that are gone: "Your workspace"/.test(message)) problems.push('does not name the missing heading');
      if (!/Headings that are new: "Sign in"/.test(message)) problems.push('does not name the new heading');
      if (!/Buttons and links that are gone: "Sign out"/.test(message)) problems.push('does not name the missing button');
      if (!/Form fields that are new: "Password"/.test(message)) problems.push('does not name the new field');
      return problems;
    },
  },
  {
    name: 'a newly failing request is a difference',
    run: () => {
      const before = sig.buildSignature({ headings: ['Dashboard'] });
      const after = sig.buildSignature({
        headings: ['Dashboard'],
        failedRequests: [{ method: 'POST', url: 'https://x.test/api/login?t=1', status: 401 }],
      });
      const message = sig.compareSignatures(before, after);
      if (!message) return ['a new 401 was not reported'];
      return message.indexOf('Requests that failed this time: POST /api/login 401') !== -1
        ? []
        : ['unexpected wording: ' + message];
    },
  },
  {
    name: 'a request that used to fail and now does not is never a difference',
    run: () => {
      const before = sig.buildSignature({
        headings: ['Dashboard'],
        failedRequests: [{ method: 'GET', url: 'https://x.test/api/flaky', status: 500 }],
      });
      const after = sig.buildSignature({ headings: ['Dashboard'] });
      const message = sig.compareSignatures(before, after);
      return message === null ? [] : ['a fixed request was reported as a regression:' + message];
    },
  },
  {
    name: 'a missing signature on either side is never a difference',
    run: () => {
      const real = sig.buildSignature({ headings: ['Dashboard'] });
      const problems = [];
      // An old baseline, recorded before signatures existed.
      if (sig.compareSignatures(undefined, real) !== null) problems.push('an old baseline was treated as a change');
      // A run whose capture failed knows nothing about the page.
      if (sig.compareSignatures(real, null) !== null) problems.push('a failed capture was treated as a change');
      if (sig.compareSignatures(null, null) !== null) problems.push('two absences were treated as a change');
      return problems;
    },
  },
  {
    name: 'printing a missing signature says so instead of throwing',
    run: () => {
      const lines = [];
      sig.printSignature(null, 'login flow', (l) => lines.push(l));
      return /could not read the page/.test(lines.join('\n')) ? [] : ['printed: ' + lines.join('|')];
    },
  },
  {
    name: 'a printed signature carries the test name and the whole object',
    run: () => {
      const lines = [];
      sig.printSignature(sig.buildSignature({ headings: ['Dashboard'] }), 'login flow', (l) => lines.push(l));
      const text = lines.join('\n');
      const problems = [];
      if (!/login flow/.test(text)) problems.push('the test name is missing');
      if (!/"headings"/.test(text) || !/Dashboard/.test(text)) problems.push('the signature is missing');
      return problems;
    },
  },
];

(async () => {
  let failures = 0;
  for (const c of cases) {
    let problems;
    try {
      problems = await c.run();
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
  console.log('All ' + cases.length + ' signature checks passed.');
})();
