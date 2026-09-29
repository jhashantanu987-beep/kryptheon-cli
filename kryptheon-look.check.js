// Checks the dashboard's own watch (kryptheon-look.js startWatch): it notices
// a change by itself, waits for the change to settle, looks once, and does not
// replay recordings behind the person's back. Run with:
//   node kryptheon-look.check.js

process.env.KRYPTHEON_HOME = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'kryptheon-home-'));

const fs = require('fs');
const os = require('os');
const path = require('path');
const looker = require('./kryptheon-look.js');

const results = [];
const check = (name, problems) => results.push({ name, problems });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-look-'));
const write = (rel, body, bump) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body, 'utf8');
  const t = new Date(Date.now() + (bump || 0));
  fs.utimesSync(path.join(dir, rel), t, t);
};
write('package.json', '{"name":"watched","private":true}\n');
write('tests/flow.spec.js', '// a recording\n');
write('src/app.js', 'export const a = 1;\n');

const looks = [];
const asked = { frontend: 0, regression: 0 };
const runners = {
  frontend: () => { asked.frontend++; return { ran: true }; },
  regression: () => { asked.regression++; return 0; },
};
// Driven by hand: tick() is what the timer calls. A long interval keeps the
// timer itself out of the way; the clock is real, so quiet is kept short.
const watch = looker.startWatch(dir, runners, { intervalMs: 3600000, quietMs: 300, onLook: (r) => looks.push(r) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try {
    watch.tick();
    check('the first tick sets the starting point by itself', (() => {
      const p = [];
      if (looks.length !== 1) p.push(looks.length + ' looks, expected 1');
      else if (!looks[0].diff.first) p.push('the first look was not marked first');
      return p;
    })());

    watch.tick();
    check('with nothing changed, it does not look again', looks.length === 1 ? [] : [looks.length + ' looks']);

    // A task in progress: a file written, then written again before it settles.
    write('src/app.js', 'export const a = 2;\n', 5000);
    watch.tick();
    await wait(150);
    write('src/app.js', 'export const a = 3;\n', 10000);
    watch.tick();
    await wait(200);
    watch.tick();
    check('while files are still changing, it waits', looks.length === 1 ? [] : ['it looked in the middle of a change']);

    await wait(400);
    watch.tick();
    check('once the change has settled, it looks exactly once, and says it was the watch', (() => {
      const p = [];
      if (looks.length !== 2) return [looks.length + ' looks, expected 2'];
      const last = looks[1];
      if (last.event.by !== 'watch') p.push('by ' + last.event.by);
      if (!last.diff.files.some((f) => f.path === 'src/app.js' && f.state === 'modified')) p.push('the change is not in it: ' + JSON.stringify(last.diff.files));
      return p;
    })());

    check('it runs the fast check, and does not replay recordings on its own', (() => {
      const p = [];
      const last = looks[1];
      if (!last) return ['no second look'];
      const reg = last.plan.find((s) => s.id === 'regression');
      if (asked.regression !== 0) p.push('the recordings were replayed ' + asked.regression + ' time(s)');
      if (!reg || !/not replayed automatically/.test(reg.state)) p.push('the report does not say the recordings were not replayed: ' + JSON.stringify(reg));
      if (asked.frontend < 2) p.push('the frontend read ran ' + asked.frontend + ' time(s), expected on the first look and after the change');
      return p;
    })());

    watch.tick();
    await wait(400);
    watch.tick();
    check('after looking, it is quiet until the next change', looks.length === 2 ? [] : [looks.length + ' looks']);
  } finally {
    watch.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

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
  console.log('All ' + results.length + ' watch checks passed.');
})();
