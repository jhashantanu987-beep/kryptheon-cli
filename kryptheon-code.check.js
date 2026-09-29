// Checks kryptheon-code.js, the frontend read for text inserted as HTML.
// Run with:  node kryptheon-code.check.js
//
// Built from a small made-up app, not from any real one: every case below is
// a pattern written from first principles, and half of them are things that
// must NOT be reported. A check that flags every innerHTML is noise, and noise
// is how a real finding gets ignored.

const fs = require('fs');
const os = require('os');
const path = require('path');
const code = require('./kryptheon-code.js');

const results = [];
const check = (name, problems) => results.push({ name, problems });

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-code-check-'));
  for (const rel of Object.keys(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, files[rel], 'utf8');
  }
  return dir;
}

const APP = {
  'src/list.js': [
    'async function load() {',
    '  const res = await fetch("/api/orders");',
    '  const data = await res.json();',
    '  title.innerHTML = `<h2>${data.shopName}</h2>`;',                          // 4 network
    '  count.innerHTML = `<b>${data.orders.length}</b> orders`;',                // 5 safe: a number
    '  safe.innerHTML = `<p>${escapeHtml(data.note)}</p>`;',                     // 6 safe: escaped
    '  clean.innerHTML = DOMPurify.sanitize(data.bio);',                         // 7 safe: sanitised
    '  fixed.innerHTML = "<p>Loading...</p>";',                                   // 8 safe: literal
    '  rows.innerHTML = data.orders.map(o => `<li>${o.item}</li>`).join("");',   // 9 network via map
    '  text.textContent = data.note;',                                            // 10 not a sink
    '  total.innerHTML = `${(data.sum * 1.18).toFixed(2)}`;',                    // 11 safe: toFixed
    '}',
    'function fail(where) {',
    '  try { go(); } catch (err) {',
    '    box.innerHTML = `<p class="err">${err.message}</p>`;',                  // 15 error
    '  }',
    '  panel.insertAdjacentHTML("beforeend", where);',                            // 17 unknown
    '  document.write(where);',                                                   // 18 unknown
    '  $("#x").html(where);',                                                     // 19 unknown
    '  label.innerHTML = where ? "<b>yes</b>" : "<b>no</b>";',                   // 20 safe: literals only
    '  try { go(); } catch (e) { box.innerHTML = `${e}`; }',                      // 21 error, bare
    '}',
  ].join('\n'),
  // A helper that puts whatever it is given into the page. The value is a
  // parameter, so the risk is at the calls: most pass HTML on purpose, one
  // passes an error's message. The finding belongs at that call, and the fix
  // must not be "switch the helper to textContent" - that breaks the rest.
  'src/status.js': [
    'function setStatus(html) {',
    '  statusBox.innerHTML = html;',                                             // 2 the sink
    '}',
    'const show = (markup) => { panel.innerHTML = markup; };',                  // 4 arrow helper
    'async function go() {',
    '  setStatus("<p>Loading...</p>");',                                          // 6 safe call
    '  setStatus(`<p>${items.length} items</p>`);',                             // 7 safe call
    '  try { await work(); } catch (error) {',
    '    setStatus(`<p class="err">${error.message}</p>`);',                     // 9 the risky call
    '  }',
    '  const r = await fetch("/me"); const me = await r.json();',
    '  show(`<b>${me.name}</b>`);',                                               // 12 risky call, network
    '  show("<i>static</i>");',                                                   // 13 safe
    '}',
    'function never(text) { other.innerHTML = text; }',                          // 15 no calls found
    'function put(target, html) { target.innerHTML = html; }',                   // 16 HTML is the 2nd arg
    'async function two() { const r2 = await fetch("/y"); const d2 = await r2.json(); put(panel, "<b>ok</b>"); put(panel, `<i>${d2.title}</i>`); }', // 17
    'async function three() { const r3 = await fetch("/z"); const d3 = await r3.json().catch(() => ({})); note.innerHTML = `${d3.msg}`; }', // 18
  ].join('\n'),
  'src/Card.jsx': [
    'export function Card({ body }) {',
    '  return <div dangerouslySetInnerHTML={{ __html: body }} />;',              // 2 unknown
    '}',
    'export function Fixed() {',
    '  return <div dangerouslySetInnerHTML={{ __html: "<b>hi</b>" }} />;',       // 5 safe
    '}',
  ].join('\n'),
  'public/page.html': [
    '<!doctype html>',
    '<html><body>',
    '<div id="out"></div>',
    '<script src="/lib.js">out.innerHTML = `${ignored}`;</script>',
    '<script type="application/json">{"innerHTML": "not code"}</script>',
    '<script>',
    '  const params = new URLSearchParams(location.search);',
    '  out.innerHTML = `Hello ${params.get("name")}`;',                         // line 8 of the page
    '</script>',
    '</body></html>',
  ].join('\n'),
  'src/Note.vue': '<template><div v-html="note.body"></div><p v-html="\'<b>fixed</b>\'"></p></template>\n',
  'node_modules/lib/x.js': 'a.innerHTML = `${evil}`;\n',
  'src/vendor.min.js': 'a.innerHTML=`${evil}`;\n',
  'src/broken.js': 'function (( {\n',
};

const dir = project(APP);
let result;
try {
  result = code.scanProject(dir, { packageDir: __dirname });
} finally {
  // kept until the checks below have read it
}

const at = (file, line) => result.findings.find((f) => f.file === file && f.line === line);
const listFiles = result.findings.map((f) => f.file + ':' + f.line + ' ' + f.origin).join(', ');

check('it ran with the parser Playwright ships', result.ran ? [] : ['it did not run: ' + result.why]);

check('a server response inserted as HTML is found, and ranked HIGH', (() => {
  const f = at('src/list.js', 4);
  if (!f) return ['list.js:4 not found; found: ' + listFiles];
  const p = [];
  if (f.origin !== 'network') p.push('origin ' + f.origin);
  if (f.severity !== 'HIGH') p.push('severity ' + f.severity);
  return p;
})());

check('an item of a server list built into HTML by map() is found as network', (() => {
  const f = at('src/list.js', 9);
  return !f ? ['list.js:9 not found'] : f.origin === 'network' ? [] : ['origin ' + f.origin];
})());

check("a caught error inserted as HTML is found, by its message or whole", (() => {
  const p = [];
  for (const line of [15, 21]) {
    const f = at('src/list.js', line);
    if (!f) p.push('list.js:' + line + ' not found');
    else if (f.origin !== 'error') p.push('list.js:' + line + ' origin ' + f.origin);
  }
  return p;
})());

check('every other sink is recognised: insertAdjacentHTML, document.write, .html(), React, a page script, v-html', (() => {
  const want = [
    ['src/list.js', 17, 'insertAdjacentHTML'],
    ['src/list.js', 18, 'document.write'],
    ['src/list.js', 19, '.html()'],
    ['src/Card.jsx', 2, 'dangerouslySetInnerHTML'],
    ['public/page.html', 8, 'innerHTML'],
    ['src/Note.vue', 1, 'v-html'],
  ];
  const p = [];
  for (const [file, line, sink] of want) {
    const f = at(file, line);
    if (!f) p.push('missing ' + file + ':' + line + ' (' + sink + ')');
    else if (f.sink !== sink) p.push(file + ':' + line + ' was ' + f.sink + ', expected ' + sink);
  }
  if (p.length) p.push('found: ' + listFiles);
  return p;
})());

check('what is safe is not reported: numbers, escaped, sanitised, literal, textContent, literal branches', (() => {
  const p = [];
  for (const line of [5, 6, 7, 8, 10, 11, 20]) if (at('src/list.js', line)) p.push('list.js:' + line + ' was reported');
  if (at('src/Card.jsx', 5)) p.push('Card.jsx:5 (a literal __html) was reported');
  const vue = result.findings.filter((f) => f.file === 'src/Note.vue');
  if (vue.length !== 1) p.push('Note.vue has ' + vue.length + ' findings, expected 1 (the quoted v-html is text)');
  return p;
})());

check('a helper that takes HTML is judged at its calls, not at its own sink', (() => {
  const p = [];
  const err = at('src/status.js', 9);
  const net = at('src/status.js', 12);
  if (!err) p.push('the setStatus call passing error.message (line 9) was not found');
  else {
    if (err.origin !== 'error') p.push('line 9 origin ' + err.origin);
    if (err.severity !== 'HIGH') p.push('line 9 severity ' + err.severity);
    if (!err.via || err.via.fn !== 'setStatus' || err.via.line !== 2) p.push('line 9 does not say it reaches innerHTML through setStatus at line 2: ' + JSON.stringify(err.via));
  }
  if (!net) p.push('the show() call passing a server value (line 12) was not found');
  else if (net.origin !== 'network') p.push('line 12 origin ' + net.origin);
  // The HTML is the second argument of put(target, html): the first is an
  // element, and judging it would say nothing about what is inserted.
  const second = at('src/status.js', 17);
  if (!second) p.push('the put() call passing a server value as its second argument (line 17) was not found');
  else if (second.origin !== 'network' || !second.via || second.via.fn !== 'put') p.push('line 17: ' + second.origin + ' via ' + JSON.stringify(second.via));
  if (at('src/status.js', 16)) p.push('status.js:16 (the put helper itself) was reported');
  // res.json().catch(() => ({})) is still the response body.
  const guarded = at('src/status.js', 18);
  if (!guarded) p.push('status.js:18 not found');
  else if (guarded.origin !== 'network') p.push('a body read with .catch() was judged ' + guarded.origin);
  // The helpers' own sinks are not reported when every call was judged.
  for (const line of [2, 4, 6, 7, 13]) if (at('src/status.js', line)) p.push('status.js:' + line + ' was reported');
  // A helper nobody calls in this file cannot be judged at its calls, so its
  // sink is reported where it is - unknown, not dropped.
  const lonely = at('src/status.js', 15);
  if (!lonely) p.push('a helper with no calls in the file was dropped instead of reported at its sink');
  else if (lonely.origin !== 'unknown') p.push('line 15 origin ' + lonely.origin);
  if (p.length) p.push('status.js findings: ' + JSON.stringify(result.findings.filter((f) => f.file === 'src/status.js').map((f) => f.line + ' ' + f.origin)));
  return p;
})());

check('the fix for a helper call says to escape at the call, not to change the helper', (() => {
  const f = at('src/status.js', 9);
  if (!f) return ['no finding to read'];
  const p = [];
  const text = f.fixPrompt.replace(/\s+/g, ' ');
  if (!/setStatus\(\)/.test(text)) p.push('it does not name the helper');
  if (!/do not change setStatus\(\) to use textContent/i.test(text)) p.push('it does not warn against switching the helper to textContent');
  if (!/line 2/.test(text)) p.push('it does not say where the helper inserts it');
  return p;
})());

check('exactly the expected findings, no more', (() => {
  const want = [
    'src/status.js:9', 'src/status.js:12', 'src/status.js:15', 'src/status.js:17', 'src/status.js:18',
    'public/page.html:8', 'src/Card.jsx:2', 'src/Note.vue:1',
    'src/list.js:15', 'src/list.js:17', 'src/list.js:21', 'src/list.js:18', 'src/list.js:19', 'src/list.js:4', 'src/list.js:9',
  ];
  const got = result.findings.map((f) => f.file + ':' + f.line).sort();
  return JSON.stringify(got) === JSON.stringify(want.sort()) ? [] : ['expected ' + JSON.stringify(want) + '\n        got      ' + JSON.stringify(got)];
})());

check('dependencies and minified files are not the app, and are not read', (() => {
  const p = [];
  if (result.findings.some((f) => f.file === 'public/page.html' && f.line === 4)) p.push('the body of a <script src> was read - a browser ignores it');
  if (result.findings.some((f) => /node_modules/.test(f.file))) p.push('node_modules was read');
  if (result.findings.some((f) => /\.min\.js$/.test(f.file))) p.push('a .min.js file was read');
  return p;
})());

check('a file that cannot be parsed is listed as unread, not passed over in silence', (() => {
  const broken = result.unreadable.find((u) => u.file === 'src/broken.js');
  return broken ? [] : ['broken.js is not in the unread list: ' + JSON.stringify(result.unreadable)];
})());

check('every finding says it is unproven, and the fix names the exact place and value', (() => {
  const p = [];
  for (const f of result.findings) {
    if (f.status !== 'verification required') p.push(f.file + ':' + f.line + ' status ' + f.status);
    if (f.evidence !== 'code analysis') p.push(f.file + ':' + f.line + ' evidence ' + f.evidence);
    if (f.severity === 'CRITICAL') p.push(f.file + ':' + f.line + ' is CRITICAL without anything having run');
  }
  const f = at('src/list.js', 4);
  if (f) {
    if (f.fixPrompt.indexOf('src/list.js at line 4') === -1) p.push('the fix does not name the file and line');
    if (f.fixPrompt.indexOf('${data.shopName}') === -1) p.push('the fix does not quote the value');
    if (!/textContent/.test(f.fixPrompt)) p.push('the fix does not say textContent');
    if (!/check it rather than assume/.test(f.fixPrompt)) p.push('the fix does not ask for verification first');
    if (!/text containing < and &/.test(f.fixPrompt)) p.push('the fix asks for no test afterwards');
  }
  return p;
})());

// And the one failure that must never read as a pass: no parser at all.
const missing = code.scanProject(dir, { packageDir: path.join(os.tmpdir(), 'no-such-kryptheon') });
check('without the parser it says it did not run - never that nothing was found', (() => {
  const p = [];
  if (missing.ran) p.push('it claimed to have run with no parser available');
  if (!missing.why) p.push('it gave no reason');
  if (missing.findings.length) p.push('it reported findings it could not have made');
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
console.log('All ' + results.length + ' frontend checks passed.');
