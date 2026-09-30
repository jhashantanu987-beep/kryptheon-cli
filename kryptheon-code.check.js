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
  // Precision: things that look dynamic but cannot carry new markup, next to
  // look-alikes that can and must still be reported.
  'src/ui.js': [
    'function saving(button) {',
    '  const original = button.innerHTML;',
    '  button.innerHTML = "Saving...";',                                          // 3 safe: literal
    '  button.innerHTML = original;',                                             // 4 safe: the page's own HTML put back
    '}',
    'function badge(kind) {',
    '  const map = { ok: { label: "Done", color: "green" }, bad: { label: "Failed", color: "red" } };',
    '  return map[kind] || map.ok;',
    '}',
    'function describeUser(u) { return { name: u.name, since: 2020 }; }',
    'async function paint(kind) {',
    '  const b = badge(kind);',
    '  tag.innerHTML = `<span style="color:${b.color}">${b.label}</span>`;',       // 13 safe: only constants
    '  const me = await (await fetch("/me")).json();',
    '  const d = describeUser(me);',
    '  who.innerHTML = `<b>${d.name}</b>`;',                                      // 16 reported: carries a parameter
    '  const typed = input.textContent;',
    '  echo.innerHTML = typed;',                                                  // 18 reported: text, not HTML
    '}',
    'function loop(v) { return loop(v); }',
    'function spin() { ring.innerHTML = loop(1); }',                              // 21 reported, and must not hang
    'function labels() { const fmt = function (x) { return x.name; }; return { title: "Orders", count: 3 }; }',
    'function head() { title.innerHTML = `<h1>${labels().title}</h1>`; }',        // 23 safe: an inner function is not what it returns
    'async function inline() { box.innerHTML = (await (await fetch("/x")).json()).name; }', // 24 network, read in place
  ].join('\n'),
  // Precision inside map() callbacks and escaping helpers. Each quiet case has
  // a look-alike next to it that must still be reported.
  'src/precise.js': [
    'async function paintRows() {',
    '  const res = await fetch("/api/rows");',
    '  const rows = await res.json();',
    '  bars.innerHTML = rows.map((r) => { const color = r.ok ? "#1a1" : "#a11"; const h = Math.max(8, Math.round(r.n * 2)); return `<i style="color:${color};height:${h}px"></i>`; }).join("");', // 4 safe: locals are constants and numbers
    '  nums.innerHTML = rows.map((r, i) => `<li data-i="${i}">#${i + 1}</li>`).join("");',   // 5 safe: the index
    '  names.innerHTML = rows.map((r) => { const t = r.title; return `<li>${t}</li>`; }).join("");', // 6 network: a local carrying the item
    '  const esc = (s) => String(s).replace(/[&<>"\']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", \'"\': "&quot;", "\'": "&#39;" }[c]));',
    '  who.innerHTML = `<b title="${esc(rows[0].title)}">${esc(rows[0].name)}</b>`;',       // 8 safe: escapes by what it does, not by its name
    '  function escText(t) { return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }',
    '  plain.innerHTML = `<p>${escText(rows[0].note)}</p>`;',                                 // 10 safe: tags escaped, not inside an attribute
    '  attr.innerHTML = `<a title="${escText(rows[0].note)}">x</a>`;',                       // 11 network: quotes left alone, inside an attribute
    '  const half = (s) => String(s).replace(/</g, "&lt;");',
    '  partial.innerHTML = `<p>${half(rows[0].note)}</p>`;',                                 // 13 reported: only < replaced
    '  const same = (s) => { const out = s.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/&/g, "&amp;"); return s; };',
    '  fake.innerHTML = `<p>${same(rows[0].note)}</p>`;',                                     // 15 reported: escapes, then returns the original
    '  multi.innerHTML = rows.map((r) => { if (r.flag) { return `<b>${r.secret}</b>`; } return ""; }).join("");', // 16 network: the risky return is not the first one
    '  function goUrl(v) { return `/go?next=${encodeURIComponent(v)}`; }',
    '  link.innerHTML = `<a href="${goUrl(rows[0].id)}">go</a>`;',                           // 18 safe: the "=" in a URL is not an attribute
    '  bare.innerHTML = `<a title=${esc(rows[0].t)}>x</a>`;',                                // 19 network: an unquoted attribute is broken by a space
    '  function paintGrad(color, id) { grad.innerHTML = `<stop id="${id}" stop-color="${color}"/>`; }', // 20 safe: every call passes constants
    '  paintGrad("#f40", "a"); paintGrad("#0f0", "b");',
    '  function paintName(name) { nm.innerHTML = `<b>${name}</b>`; }',                     // 22 network: one call passes a server value
    '  paintName("x"); paintName(rows[0].name);',
    '  function paintAny(v) { any.innerHTML = `<i>${v}</i>`; }',                           // 24 reported: handed on as a callback, its calls cannot be seen
    '  [1, 2].forEach(paintAny);',
    '  pair.innerHTML = `<a href="${goUrl(1)}" title="${escText(rows[0].t)}">x</a>`;',  // 26 network: the attribute opened in an earlier piece of the template
    '  note2.innerHTML = `<p>Filter: tag="${escText(rows[0].tag)}"</p>`;',             // 27 safe: tag=" here is text between tags, not an attribute
    '}',
  ].join('\n'),
  // Where a value came from when it is not read in place: a database query,
  // and a variable given its real value later. The first is the blind test's
  // shape (StudyNest), ranked MEDIUM "unknown" when it was the server's rows.
  'src/origins.js': [
    'let feed = [];',
    'async function loadFeed() {',
    '  const { data } = await supabase.from("notes").select("id, title").order("id");',
    '  feed = data ?? [];',
    '  paintFeed(feed);',
    '}',
    'function paintFeed(items) { list.innerHTML = items.map((n) => `<h3>${n.title}</h3>`).join(""); }', // 7 network: rows from the database, via a reassigned variable
    'function search(q) { paintFeed(feed.filter((n) => n.title.includes(q))); }',
    'let label = "Loading";',
    'function ready() { label = "Ready"; top.innerHTML = `<b>${label}</b>`; }',       // 10 safe: every value it is given is a literal
    'let html = "";',
    'async function page() { html += await (await fetch("/p")).text(); box.innerHTML = html; }', // 12 network: added to with +=
    'let count = 0;',
    'function bump() { count++; count = count + 1; c.innerHTML = `<i>${count}</i>`; }', // 14 safe: only ever a number
    'async function rpcRows() { const { data: rows } = await supabase.rpc("top_notes"); r.innerHTML = rows[0].body; }', // 15 network: an RPC
    'async function ax() { const res = await axios.get("/api/x"); a.innerHTML = res.data.name; }', // 16 network: axios
    'const local = { from: (x) => x };',
    'lc.innerHTML = local.from("<b>hi</b>").trim();',                                  // 18 not the database: .from() with no query after it
    'let pick; pick = "<b>fixed</b>"; pk.innerHTML = pick;',                           // 19 safe: no first value, one literal
    'let mixed = "a"; for (mixed of window.names) {} mx.innerHTML = mixed;',           // 20 unknown: a for-of assigns it
    'async function done() { const { data } = await supabase.from("tasks").select("*"); dn.innerHTML = data.filter((t) => t.done).map((t) => `<li>${t.name}</li>`).join(""); }', // 21 network: filter keeps the same rows
  ].join('\n'),
  // Redirects to an address the page's own URL chose (blind test: VaultBoard's
  // ?next= after login and on logout). Each reported case has a quiet twin.
  'src/redirects.js': [
    'const params = new URLSearchParams(location.search);',
    'function afterLogin() { location.href = params.get("next") || "/"; }',                                    // 2 reported
    'function out() { window.location = new URLSearchParams(window.location.search).get("to"); }',            // 3 reported: window.location =
    'function back() { const next = params.get("next"); if (next && next.startsWith("/") && !next.startsWith("//")) location.href = next; }', // 4 quiet: checked
    'function early() { const n = params.get("n"); if (!n.startsWith("/")) return; location.assign(n); }',   // 5 quiet: checked by an earlier if
    'function loose() { const n = params.get("n"); if (n) location.replace(n); }',                            // 6 reported: "is there one" checks nothing
    'function fixed() { location.href = `/login?next=${encodeURIComponent(location.pathname)}`; }',          // 7 quiet: starts at a fixed page
    'function hashNav() { location.href = location.hash.slice(1); }',                                         // 8 reported: the hash
    'function vetted() { location.href = safeRedirect(params.get("next")); }',                               // 9 quiet: somebody's own check
    'function tab() { window.open(document.referrer); }',                                                     // 10 reported: the referrer
    'function nextPage() { const q = useSearchParams(); router.push(q.get("returnTo")); }',                  // 11 reported: Next router
    'function reload() { location.href = location.href; }',                                                   // 12 quiet: the same page
    'const [sp] = useSearchParams(); function rr() { router.replace(sp.get("next") ?? "/"); }',              // 13 reported: React Router params, Next router
    'function menu() { navigate(params.get("next")); }',                                                      // 14 quiet: navigate() stays on the site
    'function find() { location.href = `/search?q=${params.get("q")}`; }',                                    // 15 quiet: the URL's value only fills in the query of a fixed page
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

check("precision: the page's own HTML and constant-only helpers are not reported", (() => {
  const p = [];
  for (const line of [3, 4, 13, 23]) if (at('src/ui.js', line)) p.push('ui.js:' + line + ' was reported: ' + at('src/ui.js', line).expression);
  return p;
})());

check('precision does not become blindness: a helper passing a parameter through, and text read back as HTML, are still reported', (() => {
  const p = [];
  if (!at('src/ui.js', 16)) p.push("ui.js:16 (describeUser returns the user's name) was not reported");
  if (!at('src/ui.js', 18)) p.push('ui.js:18 (textContent inserted as HTML) was not reported');
  const looped = at('src/ui.js', 21);
  if (!looped) p.push('ui.js:21 (a function that only returns itself) was not reported');
  else if (looped.origin !== 'unknown') p.push('ui.js:21 origin ' + looped.origin);
  const inline = at('src/ui.js', 24);
  if (!inline) p.push('ui.js:24 (a response body read in place) was not reported');
  else if (inline.origin !== 'network') p.push('ui.js:24 origin ' + inline.origin + ', expected network');
  return p;
})());

check('rows from a Supabase query, an RPC or axios are network, also through a variable given its value later', (() => {
  const p = [];
  for (const line of [7, 12, 15, 16, 21]) {
    const f = at('src/origins.js', line);
    if (!f) p.push('origins.js:' + line + ' was not reported');
    else if (f.origin !== 'network' || f.severity !== 'HIGH') p.push('origins.js:' + line + ' was ' + f.origin + '/' + f.severity + ', expected network/HIGH');
  }
  return p;
})());

check('...and a later value is followed, not guessed: literals and numbers stay quiet, .from() alone is not the database', (() => {
  const p = [];
  for (const line of [10, 14, 19]) if (at('src/origins.js', line)) p.push('origins.js:' + line + ' was reported (' + at('src/origins.js', line).origin + ')');
  const own = at('src/origins.js', 18);
  if (own && own.origin === 'network') p.push('origins.js:18 - somebody\'s own .from() was read as a database query');
  const loop = at('src/origins.js', 20);
  if (!loop || loop.origin !== 'unknown') p.push('origins.js:20 (assigned by a for-of) should stay unknown, was ' + (loop ? loop.origin : 'not reported'));
  return p;
})());

check('a redirect to an address from the page\'s own URL is found, as open-redirect, with a fix that allows only own pages', (() => {
  const p = [];
  const want = { 2: 'location.href', 3: 'location', 6: 'location.replace()', 8: 'location.href', 10: 'window.open()', 11: 'router.push()', 13: 'router.replace()' };
  for (const line of Object.keys(want)) {
    const f = at('src/redirects.js', Number(line));
    if (!f) p.push('redirects.js:' + line + ' was not reported');
    else if (f.kind !== 'open-redirect' || f.sink !== want[line] || f.severity !== 'HIGH') p.push('redirects.js:' + line + ' was ' + [f.kind, f.sink, f.severity].join('/'));
  }
  const f = at('src/redirects.js', 2);
  if (f && !/single "\/"/.test(f.fixPrompt.replace(/\s+/g, ' '))) p.push('the fix does not say to allow only own pages');
  return p;
})());

check('...and a checked, fixed, vetted or same-page redirect is not', (() => {
  const p = [];
  for (const line of [1, 4, 5, 7, 9, 12, 14, 15]) if (at('src/redirects.js', line)) p.push('redirects.js:' + line + ' was reported: ' + at('src/redirects.js', line).expression);
  return p;
})());

check('precision in map() callbacks: locals that are constants or numbers, and the index, are not reported', (() => {
  const p = [];
  for (const line of [4, 5]) {
    const f = at('src/precise.js', line);
    if (f) p.push('precise.js:' + line + ' was reported (' + f.origin + '): ' + f.expression.slice(0, 90));
  }
  return p;
})());

check('...but a local that carries the item, or a later return that does, is still found as network', (() => {
  const p = [];
  for (const line of [6, 16]) {
    const f = at('src/precise.js', line);
    if (!f) p.push('precise.js:' + line + ' was not reported');
    else if (f.origin !== 'network') p.push('precise.js:' + line + ' origin ' + f.origin + ', expected network');
  }
  return p;
})());

check('an escaping helper is known by what it does, whatever it is called', (() => {
  const p = [];
  for (const line of [8, 10, 18, 27]) {
    const f = at('src/precise.js', line);
    if (f) p.push('precise.js:' + line + ' was reported (' + f.origin + '): ' + f.expression.slice(0, 90));
  }
  return p;
})());

check('...and one that does not really escape, or not enough for where the value lands, is still reported', (() => {
  const p = [];
  const attr = at('src/precise.js', 11);
  if (!attr) p.push('precise.js:11 (tags escaped, quotes not, value inside an attribute) was not reported');
  else if (attr.origin !== 'network') p.push('precise.js:11 origin ' + attr.origin + ', expected network');
  if (!at('src/precise.js', 13)) p.push('precise.js:13 (only < replaced) was not reported');
  if (!at('src/precise.js', 15)) p.push('precise.js:15 (escapes, then returns the original) was not reported');
  const pair = at('src/precise.js', 26);
  if (!pair) p.push('precise.js:26 (quotes not escaped, attribute opened earlier in the template) was not reported');
  else if (pair.origin !== 'network') p.push('precise.js:26 origin ' + pair.origin + ', expected network');
  const bare = at('src/precise.js', 19);
  if (!bare) p.push('precise.js:19 (escaped, but in an unquoted attribute) was not reported');
  else if (bare.origin !== 'network') p.push('precise.js:19 origin ' + bare.origin + ', expected network');
  return p;
})());

check('a parameter is judged by what every call passes it: constants everywhere is quiet, one server value is not', (() => {
  const p = [];
  const grad = at('src/precise.js', 20);
  if (grad) p.push('precise.js:20 (every call passes constants) was reported: ' + grad.origin);
  const name = at('src/precise.js', 22);
  if (!name) p.push('precise.js:22 (one call passes a server value) was not reported');
  else if (name.origin !== 'network') p.push('precise.js:22 origin ' + name.origin + ', expected network');
  const any = at('src/precise.js', 24);
  if (!any) p.push('precise.js:24 (a function passed on as a callback) was not reported');
  else if (any.origin !== 'unknown') p.push('precise.js:24 origin ' + any.origin + ', expected unknown');
  return p;
})());

check('a finding names the part of a long value that makes it risky, so the fix touches only that', (() => {
  const p = [];
  const f = at('src/precise.js', 6);
  if (!f) return ['precise.js:6 not found'];
  const parts = (f.parts || []).map((x) => x.text);
  if (!parts.includes('t')) p.push('parts do not name t: ' + JSON.stringify(f.parts));
  if (!/Only this part/.test(f.fixPrompt) || f.fixPrompt.indexOf('${t}') === -1) p.push('the fix prompt does not name the part: ' + f.fixPrompt.slice(0, 400));
  const multi = at('src/precise.js', 16);
  if (multi && !(multi.parts || []).some((x) => x.text === 'r.secret')) p.push('line 16 parts do not name r.secret: ' + JSON.stringify(multi.parts));
  const whole = at('src/list.js', 4);
  if (whole && !(whole.parts || []).some((x) => x.text === 'data.shopName')) p.push('list.js:4 parts do not name data.shopName: ' + JSON.stringify(whole.parts));
  return p;
})());

check('exactly the expected findings, no more', (() => {
  const want = [
    'src/precise.js:6', 'src/precise.js:11', 'src/precise.js:13', 'src/precise.js:15', 'src/precise.js:16', 'src/precise.js:19', 'src/precise.js:22', 'src/precise.js:24', 'src/precise.js:26',
    'src/ui.js:16', 'src/ui.js:18', 'src/ui.js:21', 'src/ui.js:24',
    'src/status.js:9', 'src/status.js:12', 'src/status.js:15', 'src/status.js:17', 'src/status.js:18',
    'public/page.html:8', 'src/Card.jsx:2', 'src/Note.vue:1',
    'src/list.js:15', 'src/list.js:17', 'src/list.js:21', 'src/list.js:18', 'src/list.js:19', 'src/list.js:4', 'src/list.js:9',
    'src/origins.js:7', 'src/origins.js:12', 'src/origins.js:15', 'src/origins.js:16', 'src/origins.js:18', 'src/origins.js:20', 'src/origins.js:21',
    'src/redirects.js:2', 'src/redirects.js:3', 'src/redirects.js:6', 'src/redirects.js:8', 'src/redirects.js:10', 'src/redirects.js:11', 'src/redirects.js:13',
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
