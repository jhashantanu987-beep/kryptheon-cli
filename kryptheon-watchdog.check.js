// Checks for the browser-window watchdog.
// Run with:  node kryptheon-watchdog.check.js
//
// The bug behind these: `kryptheon record` said "No browser window appeared"
// on a first run in a fresh folder, and worked immediately on the second. It
// could not be reproduced - launch to a visible window measures about 2.5s on
// a warm machine, against a 30s budget - so what is fixed here is the logic
// that was wrong regardless of what happened that day:
//
//   * a probe that did not answer was counted as "no window"
//   * the budget was counted in ticks, so "30 seconds" was never 30 seconds
//   * codegen's own stderr was read only when it exited by itself
//   * a browser that was running was told it had never opened
//
// The watchdog's decision is driven directly here, with a fake probe and a
// fake clock. Launching a real browser cannot produce a probe that hangs, a
// browser without a window, or a machine slow enough to matter - and those are
// exactly the cases that went wrong.
//
// This file sits outside testDir and does not match Playwright's testMatch
// pattern, so `npx playwright test` ignores it.

const cli = require('./bin/kryptheon.js');

const UP = { known: true, processes: 1, windows: 1 };
const RUNNING_NO_WINDOW = { known: true, processes: 1, windows: 0 };
const NOTHING_RUNNING = { known: true, processes: 0, windows: 0 };
const NO_ANSWER = { known: false, processes: 0, windows: 0 };

/**
 * Drives the watchdog through a scripted sequence.
 *
 * Each step says what the probe returns and how long that tick took, so a
 * slow probe is expressed as time passing rather than as a real delay.
 */
function drive(steps, options) {
  let clock = 0;
  let index = 0;
  const watch = cli.createWindowWatch(
    Object.assign(
      {
        now: () => clock,
        probe: () => {
          const step = steps[Math.min(index, steps.length - 1)];
          clock += step.tookMs == null ? 5000 : step.tookMs;
          index++;
          return step.result;
        },
      },
      options || {},
    ),
  );
  // A generous ceiling on iterations so a stuck watchdog is a failed check
  // rather than a hung one.
  for (let i = 0; i < 500; i++) {
    const outcome = watch.tick();
    if (outcome) return { outcome: outcome, ticks: i + 1, clock: clock, stats: watch.stats() };
  }
  return { outcome: null, ticks: 500, clock: clock, stats: watch.stats() };
}

const cases = [
  {
    name: 'a window that appears stops the wait',
    run: () => {
      const r = drive([{ result: NOTHING_RUNNING }, { result: RUNNING_NO_WINDOW }, { result: UP }]);
      return r.outcome && r.outcome.verdict === 'window' ? [] : ['got ' + JSON.stringify(r.outcome)];
    },
  },
  {
    name: 'a probe that never answers is not read as "no window"',
    run: () => {
      const r = drive([{ result: NO_ANSWER }]);
      if (!r.outcome) return ['it waited forever'];
      const problems = [];
      if (r.outcome.verdict !== 'unclear') {
        problems.push('verdict was "' + r.outcome.verdict + '", wanted "unclear"');
      }
      if (r.stats.spent !== 0) problems.push('it spent ' + r.stats.spent + 'ms of budget on answers it never got');
      return problems;
    },
  },
  {
    name: 'a probe that never answers still ends, at the hard limit',
    run: () => {
      const r = drive([{ result: NO_ANSWER }]);
      const problems = [];
      if (!r.outcome) return ['it never gave up'];
      if (r.clock < cli.WINDOW_HARD_LIMIT_MS) problems.push('gave up after only ' + r.clock + 'ms');
      if (r.clock > cli.WINDOW_HARD_LIMIT_MS + 10000) problems.push('waited ' + r.clock + 'ms, well past the limit');
      return problems;
    },
  },
  {
    name: 'a slow probe does not shorten the budget',
    run: () => {
      // Every probe answers, but each takes four seconds on top of the poll.
      const r = drive([{ result: RUNNING_NO_WINDOW, tookMs: 9000 }]);
      if (!r.outcome) return ['it waited forever'];
      const problems = [];
      if (r.clock < cli.WINDOW_TIMEOUT_MS) {
        problems.push('gave up after ' + r.clock + 'ms of real time, budget is ' + cli.WINDOW_TIMEOUT_MS);
      }
      // Every probe answered, so the budget and the clock must stay together.
      // They are allowed to differ by one probe - a tick is charged from the
      // previous tick, so the last one in flight is not counted yet - but no
      // more. Counting ticks instead lets them drift without bound: six ticks
      // of five would read as 30s spent while 54s had actually gone by.
      const drift = r.clock - r.stats.spent;
      if (drift > 9000) {
        problems.push(
          'budget says ' + r.stats.spent + 'ms but ' + r.clock + 'ms of real time passed' +
            ' - drifting by ' + drift + 'ms, so it is not counting the clock',
        );
      }
      return problems;
    },
  },
  {
    name: 'a run where the probe answers half the time gets the full budget',
    run: () => {
      // Alternating: only the answered ticks may be charged.
      const steps = [];
      for (let i = 0; i < 40; i++) steps.push({ result: i % 2 ? RUNNING_NO_WINDOW : NO_ANSWER });
      const r = drive(steps);
      if (!r.outcome) return ['it waited forever'];
      const problems = [];
      if (r.stats.spent < cli.WINDOW_TIMEOUT_MS) {
        problems.push('gave up having charged only ' + r.stats.spent + 'ms');
      }
      // Half the ticks told us nothing, so twice the wall clock had to pass.
      if (r.clock < cli.WINDOW_TIMEOUT_MS * 1.8) {
        problems.push('unanswered probes still cost the person time: gave up at ' + r.clock + 'ms');
      }
      return problems;
    },
  },
  {
    name: 'a browser that is running without a window says so, not "never opened"',
    run: () => {
      const r = drive([{ result: RUNNING_NO_WINDOW }]);
      if (!r.outcome) return ['it waited forever'];
      return r.outcome.verdict === 'no-window' ? [] : ['verdict was "' + r.outcome.verdict + '"'];
    },
  },
  {
    name: 'a browser that never started is told apart from one with no window',
    run: () => {
      const r = drive([{ result: NOTHING_RUNNING }]);
      if (!r.outcome) return ['it waited forever'];
      return r.outcome.verdict === 'never-started' ? [] : ['verdict was "' + r.outcome.verdict + '"'];
    },
  },
  {
    name: 'the running-browser message leads with the way past the check',
    run: () => {
      const lines = cli.windowUndetectedLines(30);
      const text = lines.join('\n');
      const problems = [];
      if (!/is running, but no window could be seen/.test(text)) problems.push('it does not say the browser is running');
      if (/never/.test(lines[1] || '')) problems.push('the headline still claims nothing opened');
      const force = lines.findIndex((l) => /KRYPTHEON_FORCE_RECORD=1/.test(l));
      const remote = lines.findIndex((l) => /remote session/.test(l));
      if (force === -1) problems.push('it does not mention the way past the check');
      if (remote !== -1 && force > remote) problems.push('the guesses come before the way past the check');
      return problems;
    },
  },
  {
    name: 'the unclear message says nothing was learned, and counts the attempts',
    run: () => {
      const text = cli.probeUnclearLines(2, 7).join('\n');
      const problems = [];
      if (!/Could not tell whether a browser window opened/.test(text)) {
        problems.push('it does not say the check could not tell');
      }
      if (/No browser window appeared/.test(text)) problems.push('it still claims no window appeared');
      if (!/did not answer 7 of its/.test(text)) problems.push('it does not say how many attempts went unanswered');
      if (!/9 attempts/.test(text)) problems.push('it does not say how many attempts there were');
      return problems;
    },
  },
  {
    name: 'what the browser said is lifted out of its noise',
    run: () => {
      const stderr = [
        'Playwright Test v1.63.0',
        'Recording started',
        'Error: net::ERR_CONNECTION_REFUSED at http://localhost:3000/',
        'Error: net::ERR_CONNECTION_REFUSED at http://localhost:3000/',
        '  at Object.<anonymous> (/x/y.js:1:1)',
      ].join('\n');
      const said = cli.codegenComplaints(stderr);
      const problems = [];
      if (!said.length) return ['it found nothing to report'];
      if (!/ERR_CONNECTION_REFUSED/.test(said[0])) problems.push('the error is not first: ' + JSON.stringify(said));
      if (said.length !== 1) problems.push('it repeated the same line: ' + JSON.stringify(said));
      if (said.some((l) => /Recording started/.test(l))) problems.push('it treated ordinary output as an error');
      return problems;
    },
  },
  {
    name: 'silence from the browser reports nothing rather than inventing it',
    run: () => {
      const said = cli.codegenComplaints('Playwright Test v1.63.0\nRecording started\n');
      return said.length === 0 ? [] : ['it invented ' + JSON.stringify(said)];
    },
  },
  {
    name: 'the probe tells a running browser apart from a visible window',
    run: () => {
      const problems = [];
      const three = cli.parseWindowProbe('3 1');
      if (!three.known || three.processes !== 3 || three.windows !== 1) {
        problems.push('"3 1" read as ' + JSON.stringify(three));
      }
      // The case the whole verdict turns on: running, nothing on screen.
      const hidden = cli.parseWindowProbe('1 0');
      if (!hidden.known || hidden.processes !== 1 || hidden.windows !== 0) {
        problems.push('"1 0" read as ' + JSON.stringify(hidden) + ' - a running browser looks like none');
      }
      const none = cli.parseWindowProbe('0 0');
      if (!none.known || none.processes !== 0) problems.push('"0 0" read as ' + JSON.stringify(none));
      return problems;
    },
  },
  {
    name: 'a half-formed answer is not knowledge',
    run: () => {
      const problems = [];
      for (const bad of ['', '1', 'x y', '2 5', '   ']) {
        const seen = cli.parseWindowProbe(bad);
        if (seen.known) problems.push(JSON.stringify(bad) + ' was treated as an answer: ' + JSON.stringify(seen));
      }
      return problems;
    },
  },
  {
    name: 'the real probe answers, and says what it can see',
    run: () => {
      // Not a fake: the shape the watchdog depends on has to hold on this
      // machine, or every decision above is made on a value that never arrives.
      const seen = cli.inspectBrowserWindows();
      const problems = [];
      if (typeof seen.known !== 'boolean') problems.push('known is not a boolean: ' + JSON.stringify(seen));
      if (typeof seen.processes !== 'number') problems.push('processes is not a number');
      if (typeof seen.windows !== 'number') problems.push('windows is not a number');
      if (seen.known && seen.windows > seen.processes) {
        problems.push('more windows than processes: ' + JSON.stringify(seen));
      }
      return problems;
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
console.log('All ' + cases.length + ' watchdog checks passed.');
