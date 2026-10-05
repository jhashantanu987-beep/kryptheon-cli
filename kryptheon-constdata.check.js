// Checks that fixed data a file of the project exports - a list of labels, a
// demo workspace - is read as the fixed text it is, and that the moment it can
// hold anything else it is not.
// Run with:  node kryptheon-constdata.check.js
//
// Found on a blind test (LaunchRail): `export const demo = { changes: [...] }`
// in mock-data.js, every value a literal, imported and rendered into a shell()
// helper. The import was read as "unknown", so the helper's own innerHTML was
// reported - on an app whose decoy list says, rightly, that it is safe.
//
// The other half matters more. A constant is only fixed while nothing writes
// to it, and a write can come from any file that imports it, under any name it
// is given. Every case below that writes to it, or that could not be read,
// must still be reported: quiet about a value that is not fixed would be the
// one mistake this tool must never make.

const fs = require('fs');
const os = require('os');
const path = require('path');
const code = require('./kryptheon-code.js');

const results = [];
const check = (name, problems) => results.push({ name, problems });

const made = [];
function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-constdata-check-'));
  made.push(dir);
  for (const rel of Object.keys(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, files[rel], 'utf8');
  }
  return dir;
}

// The LaunchRail shape: fixed data, a shell() helper that puts its argument
// into the page, a call that builds that argument from the data with one value
// (c.risk, in a class) not escaped, and an api.js that returns the data.
const DATA = [
  'export const demo = {',
  "  changes: [{ id: 'CR-1', title: 'Enable checkout', risk: 'high' }, { id: 'CR-2', title: 'Disable nav', risk: 'low' }],",
  "  org: { name: 'Northstar Labs' },",
  '};',
].join('\n');
const UI = [
  "import { demo } from './data.js';",
  'function escapeHtml(value) {',
  "  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\"', '&quot;');",
  '}',
  'function shell(content) {',
  '  app.innerHTML = `<main>${content}</main>`;',
  '}',
  'export function page() {',
  '  shell(`<h1>${demo.org.name}</h1>${demo.changes.map((c) => `<span class="pill ${c.risk}">${escapeHtml(c.title)}</span>`).join(\'\')}`);',
  '}',
].join('\n');
const API = [
  "import { demo } from './data.js';",
  'export function listChanges() {',
  '  return demo.changes;',
  '}',
].join('\n');

const base = { 'src/data.js': DATA, 'src/ui.js': UI, 'src/api.js': API };
const variant = (changes) => Object.assign({}, base, changes);

function findingsOf(files) {
  const dir = project(files);
  const r = code.scanProject(dir);
  return { ran: r.ran, why: r.why, html: (r.findings || []).filter((f) => f.kind !== 'secret' && f.file), unreadable: r.unreadable || [] };
}

const fixed = findingsOf(base);
check('it ran', fixed.ran ? [] : ['did not run: ' + fixed.why]);
check('fixed data from another file, rendered through a helper, is not reported', fixed.html.length
  ? ['reported ' + JSON.stringify(fixed.html.map((f) => f.file + ':' + f.line))] : []);

// Reading it as the argument of a method that only reads its argument -
// list.concat(demo.changes) - is not a write. LaunchRail's audit page did
// exactly this, and it kept the whole page reported.
const concatUI = UI.replace('${demo.changes.map(', '${demo.changes.concat(demo.changes).map(');
const concatRead = findingsOf(variant({ 'src/ui.js': concatUI }));
check('...and reading it through concat(), includes() or indexOf() is still a read', (() => {
  const p = [];
  if (concatUI === UI) p.push('the fixture did not change');
  if (concatRead.html.length) p.push('concat: reported ' + JSON.stringify(concatRead.html.map((f) => f.file + ':' + f.line)));
  const others = findingsOf(variant({ 'src/api.js': API + "\nexport function has(x) { return [x].includes(demo.org) || [x].indexOf(demo.changes) > -1; }" }));
  if (others.html.length) p.push('includes/indexOf: reported ' + JSON.stringify(others.html.map((f) => f.file + ':' + f.line)));
  return p;
})());

// Each of these can put something other than the literals into what is rendered.
const unsafe = [
  ['the importing file pushes into it', { 'src/ui.js': UI + '\nexport function add() { demo.changes.push({ risk: location.hash }); }' }],
  ['the file that defines it writes to it', { 'src/data.js': DATA + "\ndemo.changes.push({ risk: window.name });" }],
  ['a third file writes to it through a name of its own', { 'src/store.js': "import { demo } from './data.js';\nconst list = demo.changes;\nexport function add(x) { list.push(x); }" }],
  ['a namespace import writes to it', { 'src/store.js': "import * as data from './data.js';\nexport function set(x) { data.demo.org.name = x; }" }],
  ['Object.assign writes into it', { 'src/store.js': "import { demo } from './data.js';\nexport function load(x) { Object.assign(demo.org, x); }" }],
  ['one item is changed by index', { 'src/store.js': "import { demo } from './data.js';\nexport function set(x) { demo.changes[0].risk = x; }" }],
  ['a property is deleted', { 'src/store.js': "import { demo } from './data.js';\nexport function drop() { delete demo.org.name; }" }],
  ['part of it is pushed into another list, which is then written', { 'src/store.js': "import { demo } from './data.js';\nconst all = [];\nexport function set(x) { all.push(demo.org); all[0].name = x; }" }],
  ['it is handed to a function of the project', { 'src/store.js': "import { demo } from './data.js';\nimport { fill } from './fill.js';\nfill(demo.org);", 'src/fill.js': 'export function fill(o) { o.name = window.name; }' }],
  ['one value in it is not a literal', { 'src/data.js': DATA.replace("risk: 'high'", 'risk: location.hash') }],
  ['it is declared with let', { 'src/data.js': DATA.replace('export const demo', 'export let demo') }],
  ['a file of the project cannot be read, so a write could be hiding there', { 'src/broken.js': "import { demo } from './data.js';\ndemo.changes.push(( ;" }],
];
for (const [what, changes] of unsafe) {
  const got = findingsOf(variant(changes));
  check('still reported when ' + what, got.html.some((f) => f.file === 'src/ui.js')
    ? [] : ['nothing reported in src/ui.js; findings ' + JSON.stringify(got.html.map((f) => f.file + ':' + f.line))]);
}

for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });

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
console.log('All ' + results.length + ' fixed-data checks passed.');
