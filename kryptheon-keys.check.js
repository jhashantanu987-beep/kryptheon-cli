// Checks kryptheon-keys.js, the read for secret keys written into code.
// Run with:  node kryptheon-keys.check.js
//
// Every key here is made up, and put together at run time: no string in this
// file is a key, so nothing that scans repositories mistakes it for a leak.
// Half the cases are things that must NOT be reported - the anon key, the
// publishable key and a placeholder are in every correct app, and a check
// that flags them is one nobody reads twice.

process.env.KRYPTHEON_HOME = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'kryptheon-home-'));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const keys = require('./kryptheon-keys.js');
const code = require('./kryptheon-code.js');

const results = [];
const check = (name, problems) => results.push({ name, problems });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims) => [b64({ alg: 'HS256', typ: 'JWT' }), b64(claims), 'c2lnbmF0dXJlLW5vdC1yZWFs0123456789ab'].join('.');
const tail = (n) => 'Ab3Cd5Ef7Gh9Jk2Lm4Np6Qr8St1Uv3Wx5Yz7aB9cD2eF4gH6'.slice(0, n);

const SERVICE = jwt({ iss: 'supabase', ref: 'abcdefghijklmnop', role: 'service_role', iat: 1700000000, exp: 2000000000 });
const ANON = jwt({ iss: 'supabase', ref: 'abcdefghijklmnop', role: 'anon', iat: 1700000000, exp: 2000000000 });
const DEMO = jwt({ iss: 'supabase-demo', role: 'service_role', exp: 1983812996 });
const SB_SECRET = 'sb_' + 'secret_' + tail(32);
const SB_PUBLISHABLE = 'sb_' + 'publishable_' + tail(32);
const STRIPE_LIVE = 'sk_' + 'live_' + tail(30);
const STRIPE_TEST = 'sk_' + 'test_' + tail(30);
const STRIPE_PUBLIC = 'pk_' + 'live_' + tail(30);
const OPENAI = 'sk-' + 'proj-' + tail(40);
const ANTHROPIC = 'sk-' + 'ant-' + 'api03-' + tail(40);
const GITHUB = 'gh' + 'p_' + tail(36);
const ODD_SERVICE = 'sb_service_role_' + 'demo_7F4B8C9D2A1E5F6G7H8J9K';
const FIREBASE = 'AIza' + 'Sy' + tail(33);
const EVERY_KEY = [SERVICE, DEMO, SB_SECRET, STRIPE_LIVE, STRIPE_TEST, OPENAI, ANTHROPIC, GITHUB, ODD_SERVICE];

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-keys-check-'));
  for (const rel of Object.keys(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, files[rel], 'utf8');
  }
  return dir;
}

const APP = {
  // A plain site: the page loads config.js, which is where the blind test's
  // fallback key sat.
  'index.html': '<!doctype html>\n<script src="https://cdn.example.com/lib.js"></script>\n<script src="./config.js"></script>\n<script src="/js/app.js"></script>\n',
  'config.js': [
    'window.APP_CONFIG = {',
    '  url: "https://example.supabase.co",',
    '  key: window.__KEY || "' + SERVICE + '",',                        // 3 service_role, reaches the browser
    '  anon: "' + ANON + '",',                                            // 4 anon: public by design
    '  again: "' + SERVICE + '"',                                         // 5 the same key: said once
    '};',
  ].join('\n'),
  'js/app.js': [
    'const publishable = "' + SB_PUBLISHABLE + '";',                     // 1 public by design
    'const stripe = "' + STRIPE_PUBLIC + '";',                           // 2 public by design
    'const firebase = "' + FIREBASE + '";',                              // 3 public by design
    'const secret = "' + SB_SECRET + '";',                               // 4 sb_secret
    'const odd = "' + ODD_SERVICE + '";',                                // 5 unknown format, service-role-like
    'const hint = "sb_secret_...";',                                     // 6 placeholder
    'const blank = "YOUR_SERVICE_ROLE_KEY_GOES_HERE";',                  // 7 placeholder
    'const also = "service_role_key_here_12345678";',                    // 8 placeholder
    'const named = "sb_service_role_key_for_production";',               // 9 no digits: a name, not a key
    'document.body.innerHTML = location.hash;',                           // 10 an HTML finding, to order against
  ].join('\n'),
  // Names that are not read from the environment, and a test, ship nothing.
  // The first is Kryptheon's own code, which reported itself.
  'src/names.js': [
    'const PUBLIC_SECRET_NAME = /x/;',                                    // 1 a constant, not a variable
    'window.label = "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY is wrong";',   // 2 words in a string
    'const k = process.env["NEXT_PUBLIC_ADMIN_SECRET"];',                // 3 read through brackets: ships
  ].join('\n'),
  'src/admin.test.js': 'const k = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;\n',
  'src/routes/+page.svelte': '<script>\n  import { PUBLIC_STRIPE_SECRET } from "$env/static/public";\n</script>\n',
  // Browser code known by what it does, not by a page that loads it.
  'src/App.jsx': 'const [n, setN] = useState(0);\nconst token = "' + GITHUB + '";\n',
  'src/lib/supabase.ts': [
    '"use client";',
    'const url = process.env.NEXT_PUBLIC_SUPABASE_URL;',                 // 2 fine
    'const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;',           // 3 fine
    'const admin = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;',  // 4 ships to the browser
    'const vite = import.meta.env.VITE_STRIPE_SECRET;',                  // 5 ships to the browser
  ].join('\n'),
  'api/pay.js': [
    'const Stripe = require("stripe");',
    'const stripe = Stripe("' + STRIPE_LIVE + '");',                     // 2 server code: HIGH
    'const admin = process.env.SUPABASE_SERVICE_ROLE_KEY;',              // 3 right: server env, no prefix
  ].join('\n'),
  'lib/ai.js': [
    'export const openai = "' + OPENAI + '";',                           // 1 where it runs is unknown
    'export const claude = "' + ANTHROPIC + '";',                        // 2 Anthropic, not OpenAI
    'export const gh = "' + GITHUB + '";',                               // 3
    'export const test = "' + STRIPE_TEST + '";',                        // 4
  ].join('\n'),
  'src/local.js': 'document.title = "dev";\nconst k = "' + DEMO + '";\n', // 2 the local-development key
};

const dir = project(APP);
let keysFound = [];
const byFile = (file) => keysFound.filter((f) => f.file === file);
try {
  const result = code.scanProject(dir);
  if (!result.ran) throw new Error('the read did not run: ' + result.why);
  keysFound = result.findings.filter((f) => f.kind === 'secret-in-code');
  const at = (file, line) => keysFound.find((f) => f.file === file && f.line === line);

  check('1. a service_role key in a script the page loads: CRITICAL, and it says which page loads it', (() => {
    const f = at('config.js', 3);
    if (!f) return ['not reported: ' + JSON.stringify(keysFound.map((k) => k.file + ':' + k.line))];
    const problems = [];
    if (f.severity !== 'CRITICAL') problems.push('severity ' + f.severity);
    if (f.confidence !== 'high') problems.push('confidence ' + f.confidence);
    if (!/reaches the browser/.test(f.headline)) problems.push('headline: ' + f.headline);
    if (!/index\.html loads config\.js/.test(f.fixPrompt.replace(/\s+/g, ' '))) problems.push('it does not say index.html loads it');
    if (!/Rotate it first/.test(f.fixPrompt) || !/API Keys/.test(f.fixPrompt.replace(/\s+/g, ' '))) problems.push('no rotation step');
    if (byFile('config.js').length !== 1) problems.push('config.js reported ' + byFile('config.js').length + ' times - the same key twice is one finding, and the anon key none');
    return problems;
  })());

  check('2. the key itself never appears - not in the finding, the headline or the prompt', (() => {
    const text = JSON.stringify(keysFound);
    const problems = EVERY_KEY.filter((k) => text.includes(k)).map((k) => 'leaked a key starting ' + k.slice(0, 8));
    const f = at('config.js', 3);
    if (f && !/^eyJhbG\.\.\. \(\d+ characters, not shown\)$/.test(f.expression)) problems.push('not masked as expected: ' + f.expression);
    return problems;
  })());

  check('3. keys that are public by design, and placeholders, are never reported', (() => {
    const problems = [];
    for (const line of [1, 2, 3, 6, 7, 8, 9]) if (at('js/app.js', line)) problems.push('js/app.js:' + line + ' was reported: ' + at('js/app.js', line).headline);
    if (at('config.js', 4)) problems.push('the anon key was reported');
    for (const line of [2, 3]) if (at('src/lib/supabase.ts', line)) problems.push('a public URL or anon key variable was reported');
    if (at('api/pay.js', 3)) problems.push('a server-only environment variable was reported');
    return problems;
  })());

  check('4. an sb_secret key is certain; a service-role key in an unknown format is reported as unconfirmed', (() => {
    const problems = [];
    const secret = at('js/app.js', 4);
    if (!secret || secret.confidence !== 'high' || secret.severity !== 'CRITICAL') problems.push('sb_secret: ' + JSON.stringify(secret && [secret.severity, secret.confidence]));
    if (secret && !/index\.html loads js\/app\.js/.test(secret.fixPrompt.replace(/\s+/g, ' '))) problems.push('a script loaded from "/js/app.js" was not traced to its page');
    const odd = at('js/app.js', 5);
    if (!odd) problems.push('the service-role-like key was not reported');
    else {
      if (odd.confidence !== 'medium') problems.push('the unknown format was reported as ' + odd.confidence);
      if (!/What looks like/.test(odd.headline)) problems.push('the unknown format was stated as certain: ' + odd.headline);
    }
    return problems;
  })());

  check('5. a secret in a public build variable ships to the browser, whatever the file', (() => {
    const problems = [];
    const next = at('src/lib/supabase.ts', 4);
    const vite = at('src/lib/supabase.ts', 5);
    if (!next || next.severity !== 'CRITICAL') problems.push('NEXT_PUBLIC_..._SERVICE_ROLE_KEY: ' + JSON.stringify(next && next.severity));
    if (next && !/NEXT_PUBLIC_ is/.test(next.headline)) problems.push('it does not name the prefix: ' + next.headline);
    if (!vite || !/VITE_ is/.test(vite.headline)) problems.push('VITE_..._SECRET: ' + JSON.stringify(vite && vite.headline));
    if (at('src/names.js', 1)) problems.push('a constant named PUBLIC_SECRET_NAME was reported as an environment variable');
    if (at('src/names.js', 2)) problems.push('the name inside a sentence was reported');
    if (!at('src/names.js', 3)) problems.push('process.env["NEXT_PUBLIC_..."] was not reported');
    if (byFile('src/admin.test.js').length) problems.push('a test file was reported for reading a public variable');
    if (!at('src/routes/+page.svelte', 2)) problems.push('a SvelteKit $env/static/public secret was not reported');
    return problems;
  })());

  check('6. server code is HIGH and says so; code whose place is unknown is not called browser code', (() => {
    const problems = [];
    const pay = at('api/pay.js', 2);
    if (!pay || pay.severity !== 'HIGH' || !/server code/.test(pay.headline)) problems.push('api/pay.js: ' + JSON.stringify(pay && [pay.severity, pay.headline]));
    const ai = at('lib/ai.js', 1);
    if (!ai || ai.severity !== 'HIGH' || /reaches the browser/.test(ai.headline)) problems.push('lib/ai.js: ' + JSON.stringify(ai && [ai.severity, ai.headline]));
    const jsx = at('src/App.jsx', 2);
    if (!jsx || jsx.severity !== 'CRITICAL' || !/reaches the browser/.test(jsx.headline)) problems.push('src/App.jsx (useState): ' + JSON.stringify(jsx && [jsx.severity, jsx.headline]));
    return problems;
  })());

  check('7. each format is named for what it is', (() => {
    const want = { 1: /OpenAI/, 2: /Anthropic/, 3: /GitHub/, 4: /Stripe test/ };
    const problems = [];
    for (const line of Object.keys(want)) {
      const f = at('lib/ai.js', Number(line));
      if (!f || !want[line].test(f.headline)) problems.push('lib/ai.js:' + line + ': ' + (f ? f.headline : 'not reported'));
    }
    if (byFile('lib/ai.js').length !== 4) problems.push('lib/ai.js reported ' + byFile('lib/ai.js').length + ' times, expected 4');
    return problems;
  })());

  check('8. the local-development service key is MEDIUM and says it is the published one', (() => {
    const f = at('src/local.js', 2);
    if (!f) return ['not reported'];
    const problems = [];
    if (f.severity !== 'MEDIUM') problems.push('severity ' + f.severity);
    if (!/local-development/.test(f.headline)) problems.push('headline: ' + f.headline);
    return problems;
  })());

  check('9. secret keys come before HTML findings, and the page-loading map ignores other sites', (() => {
    const problems = [];
    const first = result.findings.findIndex((f) => f.kind !== 'secret-in-code');
    const lastKey = result.findings.map((f) => f.kind).lastIndexOf('secret-in-code');
    if (first === -1) problems.push('the HTML finding in js/app.js was not reported, so the order proves nothing');
    else if (lastKey > first) problems.push('an HTML finding came before a key');
    const loaded = keys.scriptsLoadedBy([{ rel: 'site/index.html', source: APP['index.html'] }]);
    if (loaded.get('site/config.js') !== 'site/index.html') problems.push('./config.js from site/index.html resolved to ' + JSON.stringify(Array.from(loaded.keys())));
    if (loaded.get('js/app.js') !== 'site/index.html') problems.push('/js/app.js was not read from the root');
    if (Array.from(loaded.keys()).some((k) => /cdn|lib\.js/.test(k))) problems.push('a script from another site was mapped');
    return problems;
  })());

  // Through the real command: what it prints, and what it saves.
  check('10. the command prints the key section first and never prints or saves a key', (() => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"keys-demo","version":"1.0.0"}', 'utf8');
    const r = spawnSync(process.execPath, [path.join(__dirname, 'bin', 'kryptheon.js'), 'code'], {
      cwd: dir, encoding: 'utf8', timeout: 120000, env: process.env,
    });
    const out = String(r.stdout || '') + String(r.stderr || '');
    const problems = [];
    if (!/secret keys are written into your code\. Fix these first\./.test(out)) problems.push('no key section:\n' + out.slice(0, 600));
    if (EVERY_KEY.some((k) => out.includes(k))) problems.push('a key was printed');
    const store = require('./kryptheon-store.js');
    const saved = fs.readFileSync(store.pathsFor(dir, process.env).codeFindings, 'utf8');
    if (EVERY_KEY.some((k) => saved.includes(k))) problems.push('a key was saved to code-findings.json');
    if (!/secret-in-code/.test(saved)) problems.push('the key findings were not saved');
    return problems;
  })());
} catch (err) {
  check('the read ran', ['it threw: ' + err.stack]);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

let failures = 0;
for (const r of results) {
  if (r.problems.length) {
    failures++;
    console.log('FAIL  ' + r.name);
    r.problems.forEach((p) => console.log('      - ' + p));
  } else {
    console.log('PASS  ' + r.name);
  }
}
console.log('');
if (failures) {
  console.log(failures + ' check(s) failed.');
  process.exit(1);
}
console.log('All ' + results.length + ' secret-key checks passed.');
