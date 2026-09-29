// Checks kryptheon-changes.js: what changed, where it sits in the app, and
// which checks that calls for. Run with:  node kryptheon-changes.check.js
//
// Real folders on disk; nothing here needs a store or a browser.

const fs = require('fs');
const os = require('os');
const path = require('path');
const changes = require('./kryptheon-changes.js');

const results = [];
const check = (name, problems) => results.push({ name, problems });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-changes-check-'));
function write(rel, body) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
}
// Moves a file's modified time forward, as a real save does, so the size and
// time shortcut cannot hide an edit that happens inside one clock tick.
function touch(rel) {
  const full = path.join(dir, rel);
  const later = new Date(fs.statSync(full).mtimeMs + 5000);
  fs.utimesSync(full, later, later);
}

check('each file is put in the part of the app it belongs to', (() => {
  const want = {
    'src/components/Cart.jsx': 'frontend',
    'public/index.html': 'frontend',
    'styles/site.css': 'frontend',
    'src/pages/checkout.js': 'frontend',
    'backend/routes/orders.js': 'backend',
    'server.js': 'backend',
    'api/pay.ts': 'backend',
    'supabase/migrations/001_init.sql': 'database',
    'backend/db/fix.sql': 'database',
    'prisma/schema.prisma': 'database',
    'tests/checkout.spec.js': 'tests',
    'src/cart.test.ts': 'tests',
    'package.json': 'dependencies',
    'package-lock.json': 'dependencies',
    '.env.example': 'config',
    'vite.config.ts': 'config',
    'README.md': 'docs',
    'img/logo.png': 'assets',
    'utils/format.js': 'code',
  };
  const p = [];
  for (const rel of Object.keys(want)) {
    const got = changes.partOf(rel);
    if (got !== want[rel]) p.push(rel + ' is ' + got + ', expected ' + want[rel]);
  }
  return p;
})());

write('package.json', JSON.stringify({ name: 'shop', dependencies: { express: '4.18.0', left: '1.0.0' } }));
write('src/cart.js', 'export const total = 1;\n');
write('backend/routes/orders.js', 'module.exports = 1;\n');
write('supabase/migrations/001.sql', 'create table a (id int);\n');
write('README.md', '# shop\n');
write('.env', 'SECRET_KEY=do-not-read\n');
write('.env.example', 'SECRET_KEY=\n');
write('node_modules/x/index.js', 'module.exports = 1;\n');

const first = changes.takeSnapshot(dir, null);

check('the first look has nothing to compare with, and says so - not "everything changed"', (() => {
  const c = changes.compare(null, first);
  const p = [];
  if (!c.first) p.push('first is not set');
  if (c.files.length) p.push(c.files.length + ' files reported as changed on the first look');
  return p;
})());

check('a real .env is never read; its example is; node_modules is not the project', (() => {
  const p = [];
  if (first.files['.env']) p.push('.env was hashed');
  if (!first.files['.env.example']) p.push('.env.example was left out');
  if (Object.keys(first.files).some((f) => f.startsWith('node_modules/'))) p.push('node_modules was read');
  return p;
})());

// The changes an AI task typically makes, plus one file saved unchanged.
write('src/cart.js', 'export const total = 2;\n');
touch('src/cart.js');
write('src/new-banner.jsx', 'export default () => null;\n');
fs.unlinkSync(path.join(dir, 'backend/routes/orders.js'));
write('supabase/migrations/002.sql', 'alter table a add column b int;\n');
write('README.md', '# shop\n');
touch('README.md');
write('package.json', JSON.stringify({ name: 'shop', dependencies: { express: '4.19.2', right: '2.0.0' } }));
touch('package.json');

const second = changes.takeSnapshot(dir, first);
const diff = changes.compare(first, second);
const by = (rel) => diff.files.find((f) => f.path === rel);

check('added, modified and deleted files are all found, with their part of the app', (() => {
  const p = [];
  const expect = [
    ['src/cart.js', 'modified', 'frontend'],
    ['src/new-banner.jsx', 'added', 'frontend'],
    ['backend/routes/orders.js', 'deleted', 'backend'],
    ['supabase/migrations/002.sql', 'added', 'database'],
    ['package.json', 'modified', 'dependencies'],
  ];
  for (const [rel, state, part] of expect) {
    const f = by(rel);
    if (!f) p.push(rel + ' not found');
    else if (f.state !== state || f.part !== part) p.push(rel + ' is ' + f.state + '/' + f.part + ', expected ' + state + '/' + part);
  }
  return p;
})());

check('a file saved with the same content is not a change', (() => {
  return by('README.md') ? ['README.md was reported although its content is the same'] : [];
})());

check('exactly the changed files, no more', (() => {
  const got = diff.files.map((f) => f.path).sort();
  const want = ['backend/routes/orders.js', 'package.json', 'src/cart.js', 'src/new-banner.jsx', 'supabase/migrations/002.sql'];
  return JSON.stringify(got) === JSON.stringify(want) ? [] : ['got ' + JSON.stringify(got)];
})());

check('the checks a change calls for follow from the parts it touched', (() => {
  const p = [];
  for (const id of ['frontend', 'regression', 'data', 'backend', 'api', 'dependency', 'build']) {
    if (!diff.checks.includes(id)) p.push(id + ' is not called for');
  }
  const docsOnly = changes.compare({ files: { 'README.md': { hash: 'a' } } }, { files: { 'README.md': { hash: 'b' } } });
  if (docsOnly.checks.length) p.push('a docs-only change calls for ' + JSON.stringify(docsOnly.checks));
  return p;
})());

check('a package added, removed or moved to another version is named', (() => {
  const d = diff.dependencies;
  const p = [];
  const find = (name) => d.find((x) => x.name === name);
  if (!find('express') || find('express').change !== 'changed' || find('express').to !== '4.19.2') p.push('express 4.18.0 -> 4.19.2 not reported: ' + JSON.stringify(find('express')));
  if (!find('right') || find('right').change !== 'added') p.push('right was not reported as added');
  if (!find('left') || find('left').change !== 'removed') p.push('left was not reported as removed');
  if (d.length !== 3) p.push(d.length + ' dependency changes, expected 3');
  return p;
})());

check('an unchanged file is not read again, and a new snapshot of an unchanged project finds nothing', (() => {
  const third = changes.takeSnapshot(dir, second);
  const again = changes.compare(second, third);
  const p = [];
  if (again.files.length) p.push('an unchanged project reported ' + JSON.stringify(again.files));
  if (third.files['src/cart.js'] !== second.files['src/cart.js']) p.push('an unchanged file was hashed again instead of reused');
  return p;
})());

check('a finding that only moved lines is not new; a new one is; a fixed one is gone', (() => {
  const before = [
    { check: 'frontend', where: 'src/a.js:10', headline: 'Text read from a server response is inserted as HTML in src/a.js:10.', detail: 'innerHTML: `${d.x}`' },
    { check: 'regression', where: 'tests/a.spec.js:7', headline: 'The recorded flow "Pay" broke.', detail: 'Could not find the Pay button.' },
  ];
  const after = [
    { check: 'frontend', where: 'src/a.js:14', headline: 'Text read from a server response is inserted as HTML in src/a.js:14.', detail: 'innerHTML: `${d.x}`' },
    { check: 'frontend', where: 'src/b.js:3', headline: 'Text read from a server response is inserted as HTML in src/b.js:3.', detail: 'innerHTML: `${d.y}`' },
  ];
  const p = [];
  const fresh = changes.newFindings(before, after);
  const gone = changes.goneFindings(before, after);
  if (fresh.length !== 1 || fresh[0].where !== 'src/b.js:3') p.push('new: ' + JSON.stringify(fresh.map((f) => f.where)));
  if (gone.length !== 1 || gone[0].check !== 'regression') p.push('gone: ' + JSON.stringify(gone.map((f) => f.where)));
  return p;
})());

fs.rmSync(dir, { recursive: true, force: true });

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
console.log('All ' + results.length + ' change checks passed.');
