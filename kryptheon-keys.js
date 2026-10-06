// Reads a project's code for keys that must never be in it.
//
// One key does more damage than any other mistake in an app built on
// Supabase: the service_role key. It skips every row level security rule, so
// whoever holds it can read, change and delete every row in every table. Put
// in code that the browser downloads, it belongs to anyone who opens the
// developer tools. Found on a blind test: a config.js fallback held one, and
// every rule the database attack checked was beside the point - with that key
// in the page, none of them apply.
//
// This is a read of the files, never a use of what is found: nothing is sent
// anywhere and no key is tried. The key itself is never printed, saved or put
// in a prompt - only its first characters and its length, enough for a person
// to find it and too little for anyone to use it.
//
// Narrow on purpose, as the HTML read is. Only formats that are secret by
// construction are reported as certain. Keys that are public by design - the
// Supabase anon or publishable key, a Firebase web key - are never reported.

const path = require('path');

// A variable the build copies into the browser bundle, named as a secret.
// Next, Vite, Create React App, Expo, Nuxt, SvelteKit and Gatsby all inline
// anything with these prefixes, so the value ships whatever the file is.
const PUBLIC_SECRET_NAME = /\b(NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|NUXT_PUBLIC|GATSBY|PUBLIC)_[A-Z0-9_]*(?:SERVICE_ROLE|SECRET)[A-Z0-9_]*\b/g;

const SUPABASE_ROTATE = 'in the Supabase dashboard, open Project Settings, then API Keys, and roll the ' +
  'service_role (secret) key';
const SUPABASE_OPENS = 'It skips every row level security rule: anyone who has it can read, change ' +
  'and delete every row in every table, and act as any user.';
const SUPABASE_INSTEAD = 'the anon (publishable) key, with row level security doing the protecting';

// Formats that are a secret whatever they are called. Each needs a real
// length after its prefix, so a placeholder like "sb_secret_..." is not one.
const FORMATS = [
  {
    re: /\bsb_secret_[A-Za-z0-9_-]{20,}/g,
    label: 'Supabase secret key',
    opens: SUPABASE_OPENS,
    rotate: SUPABASE_ROTATE,
    instead: SUPABASE_INSTEAD,
  },
  {
    re: /\b[sr]k_live_[A-Za-z0-9]{20,}/g,
    label: 'Stripe live secret key',
    opens: 'It can charge cards, issue refunds and read every customer and payment in your Stripe account.',
    rotate: 'in the Stripe dashboard, open Developers, then API keys, and roll it',
    instead: 'the publishable key (pk_live_...), with every charge made from your server',
  },
  {
    re: /\b[sr]k_test_[A-Za-z0-9]{20,}/g,
    label: 'Stripe test secret key',
    opens: 'It controls your Stripe test account. It moves no real money, but a live key in the same place would.',
    rotate: 'in the Stripe dashboard, open Developers, then API keys, and roll it',
    instead: 'the publishable key (pk_test_...), with every charge made from your server',
  },
  {
    re: /\bsk-ant-[A-Za-z0-9_-]{32,}/g,
    label: 'Anthropic API key',
    opens: 'Anyone who has it can run requests on your account and your bill.',
    rotate: 'in the Anthropic Console, open API Keys, and delete it',
    instead: 'a call to your own server, which holds the key',
  },
  {
    re: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g,
    label: 'OpenAI API key',
    opens: 'Anyone who has it can run requests on your account and your bill.',
    rotate: 'in the OpenAI dashboard, open API keys, and revoke it',
    instead: 'a call to your own server, which holds the key',
  },
  {
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g,
    label: 'GitHub token',
    opens: 'It acts as you on GitHub, with whatever access it was given - often every repository you have.',
    rotate: 'on GitHub, open Settings, then Developer settings, then Personal access tokens, and delete it',
    instead: 'nothing - a GitHub token has no business in app code at all',
  },
];

const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/** The claims of a JWT, or null when it is not one this can read. */
function claimsOf(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
    return claims && typeof claims === 'object' ? claims : null;
  } catch (err) {
    return null;
  }
}

// A quoted value that is shaped like a key and says it is a service-role one,
// in a format this does not know. Digits are required: "YOUR_SERVICE_ROLE_KEY"
// is somebody's placeholder, not a key. Reported as unconfirmed, because the
// format cannot say whether it is real.
const QUOTED = /(["'`])([A-Za-z0-9_.-]{24,})\1/g;
function looksLikeServiceRoleKey(value) {
  if (!/service[_-]?role/i.test(value)) return false;
  if (/your|example|placeholder|changeme|x{4,}|here/i.test(value)) return false;
  return (value.match(/[0-9]/g) || []).length >= 4;
}

// A quoted value given to something named as a secret, in a format this does
// not know. Found on a blind test (HarborLine): api.js held
// `const replaySigningKey = 'hl_replay_8JQ4-...'` in code every visitor
// downloads, and the read named nothing - it knew only famous formats. The
// name says what it is meant to be; the value has to look like one too:
// long, letters and digits, no spaces, not a placeholder. Names that are
// public by design (anon, publishable, public) are left alone.
const NAMED_SECRET = /\b([A-Za-z_$][\w$]*)\s*[:=]\s*(["'`])([^"'`\s]{16,})\2/g;
const SECRET_NAME = /(secret|signingkey|privatekey|apikey|accesstoken|authtoken|refreshtoken|password|passwd|clientsecret|webhooksecret|encryptionkey|hmackey)$/;
function looksLikeNamedSecret(name, value) {
  const bare = name.toLowerCase().replace(/[_$]/g, '');
  if (!SECRET_NAME.test(bare) || /anon|publishable|public/.test(bare)) return false;
  if (/your|example|placeholder|changeme|x{4,}|here|dummy|redacted|<|\$\{/i.test(value)) return false;
  if (/^(https?:|\/|\.)/i.test(value) || /^eyJ/.test(value)) return false; // an address or a path; JWTs are read above
  return (value.match(/[0-9]/g) || []).length >= 3 && (value.match(/[A-Za-z]/g) || []).length >= 3;
}

/** First characters and length - enough to find it, too little to use it. */
function masked(value) {
  return value.slice(0, 6) + '... (' + value.length + ' characters, not shown)';
}

// Wrapped here, as the HTML read's prompts are: pasted into a chat box as
// often as read in a terminal, and a long line is a wall in both.
function wrap(text, width) {
  const out = [];
  let current = '';
  for (const word of String(text).split(' ')) {
    if (current && (current + ' ' + word).length > width) {
      out.push(current);
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  out.push(current);
  return out.join('\n');
}

function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

// Where a file runs. A page, a file a page loads, or code that touches the
// document is browser code; a file under api/, server/ or functions/, or one
// that starts a server, is not. Anything else is said as it is: unknown.
const SERVER_PATH = /(^|\/)(api|server|backend|functions|scripts|cron|workers?)\//i;
const SERVER_CODE = /['"]use server['"]|require\(\s*['"](express|fastify|koa|http)['"]\s*\)|from\s+['"](express|fastify|koa)['"]|Deno\.serve\s*\(/;
const BROWSER_CODE = /\b(?:document|window|localStorage|sessionStorage)\s*\.|['"]use client['"]|\buse(?:State|Effect)\s*\(/;

function whereItRuns(rel, source, loadedBy) {
  if (/\.(html?|vue|svelte)$/i.test(rel)) return { browser: true, why: rel + ' is a page, so every visitor downloads it' };
  if (loadedBy && loadedBy.get(rel)) {
    return { browser: true, why: loadedBy.get(rel) + ' loads ' + rel + ', so every visitor downloads it' };
  }
  if (SERVER_PATH.test(rel) || SERVER_CODE.test(source)) return { browser: false, why: null };
  if (BROWSER_CODE.test(source)) return { browser: true, why: rel + ' runs in the browser' };
  return { browser: null, why: null };
}

/**
 * Which pages load which scripts: <script src="..."> read out of every page,
 * resolved against the page's folder. A full URL is skipped - it is not ours.
 */
function scriptsLoadedBy(pages) {
  const loaded = new Map();
  for (const page of pages) {
    const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(page.source))) {
      const src = m[1].split('?')[0].split('#')[0];
      if (/^[a-z]+:|^\/\//i.test(src)) continue;
      const rel = src.startsWith('/')
        ? path.posix.normalize(src.slice(1))
        : path.posix.normalize(path.posix.join(path.posix.dirname(page.rel), src));
      if (!loaded.has(rel)) loaded.set(rel, page.rel);
    }
  }
  return loaded;
}

function keyFinding(rel, source, index, value, kind, confidence, runs) {
  const line = lineAt(source, index);
  const severity = kind.severity || (runs.browser === false ? 'HIGH' : runs.browser ? 'CRITICAL' : 'HIGH');
  const shown = masked(value);
  const a = confidence === 'high' ? 'A ' : 'What looks like a ';
  const f = {
    kind: 'secret-in-code',
    status: 'verification required',
    evidence: 'code analysis',
    severity: severity,
    confidence: confidence,
    file: rel,
    line: line,
    sink: 'secret key',
    expression: shown,
    origin: 'code',
    parts: [],
    via: null,
    headline: a + kind.label + ' is written into ' + rel + ':' + line +
      (runs.browser ? ', and it reaches the browser.'
        : runs.browser === false ? ' (server code - still in every copy of the repository).' : '.'),
  };
  f.fixPrompt = [
    'My app has a secret key written into its code. Please fix it - and do not paste the key back to me.',
    '',
    'In ' + rel + ' at line ' + line + ' there is ' + a.toLowerCase() + kind.label +
      ' (it starts with "' + value.slice(0, 6) + '").' + (runs.why ? ' ' + runs.why + '.' : ''),
    kind.opens,
    '',
    '1. Rotate it first: ' + kind.rotate + '. Taking it out of the code is not enough - it is already in ' +
      'the deployed site and in the git history.',
    '2. Remove it from this file and from anything that reads it. Code that runs in the browser should only ' +
      'ever use ' + kind.instead + '.',
    '3. Anything that truly needs the secret moves to server code - an API route or a Supabase Edge Function - ' +
      'reading it from an environment variable with no public prefix (not NEXT_PUBLIC_, VITE_ or REACT_APP_).',
    '4. Search the whole project, config files and HTML included, for any other copy of it.',
  ].map((l) => wrap(l, 72)).join('\n');
  return f;
}

function publicNameFinding(rel, source, index, name, prefix) {
  const line = lineAt(source, index);
  const supabase = /SUPABASE|SERVICE_ROLE/.test(name);
  return {
    kind: 'secret-in-code',
    status: 'verification required',
    evidence: 'code analysis',
    severity: 'CRITICAL',
    confidence: 'high',
    file: rel,
    line: line,
    sink: 'secret in a public variable',
    expression: name,
    origin: 'code',
    parts: [],
    via: null,
    headline: rel + ':' + line + ' reads ' + name + ' - every variable starting ' + prefix +
      ' is copied into the browser, so the secret ships with the site.',
    fixPrompt: [
      'My app puts a secret into the browser through an environment variable. Please fix it - and do not ' +
        'paste the value back to me.',
      '',
      'In ' + rel + ' at line ' + line + ' the code reads ' + name + '. The build copies every variable ' +
        'starting ' + prefix + ' into the JavaScript each visitor downloads, whatever file reads it.',
      supabase ? SUPABASE_OPENS : 'Whoever opens the browser tools has the secret.',
      '',
      '1. Rotate the secret first' + (supabase ? ': ' + SUPABASE_ROTATE : '') + '. The built site already contains it.',
      '2. Rename the variable without the public prefix and read it only in server code - an API route or a ' +
        'Supabase Edge Function.',
      '3. Code that runs in the browser should only ever use ' +
        (supabase ? SUPABASE_INSTEAD : 'values that are safe to publish') + '.',
      '4. Search the whole project for every other place that reads it.',
    ].map((l) => wrap(l, 72)).join('\n'),
  };
}

/** Every secret in one file. `loadedBy` maps a script to a page that loads it. */
function secretsIn(rel, source, loadedBy) {
  const out = [];
  const seen = new Set();
  const runs = whereItRuns(rel, source, loadedBy);
  const add = (index, value, kind, confidence) => {
    if (seen.has(value)) return;
    seen.add(value);
    out.push(keyFinding(rel, source, index, value, kind, confidence, runs));
  };

  for (const format of FORMATS) {
    format.re.lastIndex = 0;
    let m;
    while ((m = format.re.exec(source))) add(m.index, m[0], format, 'high');
  }

  JWT.lastIndex = 0;
  let j;
  while ((j = JWT.exec(source))) {
    const claims = claimsOf(j[0]);
    if (!claims || claims.role !== 'service_role') continue; // anon and user tokens are public by design
    // Supabase's local development key is the same published value on every
    // machine: harmless against a laptop, but a sign of where a real one goes.
    const demo = claims.iss === 'supabase-demo';
    add(j.index, j[0], demo
      ? {
        label: 'Supabase service_role key (the published local-development one)',
        opens: 'Against a laptop it does no harm. But this is the place a real project\'s service_role key ' +
          'would go, and there it would open every table to anyone.',
        rotate: 'nothing to rotate for the local key itself - check that no real key is used the same way',
        instead: SUPABASE_INSTEAD,
        severity: 'MEDIUM',
      }
      : { label: 'Supabase service_role key', opens: SUPABASE_OPENS, rotate: SUPABASE_ROTATE, instead: SUPABASE_INSTEAD },
    'high');
  }

  QUOTED.lastIndex = 0;
  let q;
  while ((q = QUOTED.exec(source))) {
    if (!looksLikeServiceRoleKey(q[2])) continue;
    add(q.index + 1, q[2], {
      label: 'Supabase service_role key',
      opens: SUPABASE_OPENS + ' Its format is not one I know, so check whether it is a real key.',
      rotate: SUPABASE_ROTATE,
      instead: SUPABASE_INSTEAD,
    }, 'medium');
  }

  // Never in a test, whose secrets are made up for it and ship nowhere.
  const inTest = /(^|\/)__tests__\/|\.(test|spec|check)\.[cm]?[jt]sx?$/i.test(rel);
  NAMED_SECRET.lastIndex = 0;
  let s;
  while (!inTest && (s = NAMED_SECRET.exec(source))) {
    if (!looksLikeNamedSecret(s[1], s[3])) continue;
    add(s.index + s[0].indexOf(s[3]), s[3], {
      label: 'secret ("' + s[1] + '")',
      opens: 'Its name says it is a secret, and whoever has it can do whatever it signs or unlocks. ' +
        'Its format is not one I know, so check whether it is a real one.',
      rotate: 'wherever it was issued, issue a new one and revoke this one',
      instead: 'a call to your own server, which holds the secret',
      severity: runs.browser ? 'HIGH' : 'MEDIUM',
    }, 'medium');
  }

  // Only where it is read from the environment, and never in a test: found on
  // Kryptheon's own code, a constant called PUBLIC_SECRET_NAME is a name in a
  // program, not a variable the build ships - and a test file ships nothing.
  const isTest = /(^|\/)__tests__\/|\.(test|spec|check)\.[cm]?[jt]sx?$/i.test(rel);
  const svelteEnv = /from\s+['"]\$env\/(static|dynamic)\/public['"]/.test(source);
  PUBLIC_SECRET_NAME.lastIndex = 0;
  let n;
  while (!isTest && (n = PUBLIC_SECRET_NAME.exec(source))) {
    const before = source.slice(Math.max(0, n.index - 40), n.index);
    const read = /(process\.env|import\.meta\.env|\benv)\s*(\.|\[\s*['"])$/.test(before) || svelteEnv;
    if (!read || seen.has(n[0])) continue;
    seen.add(n[0]);
    out.push(publicNameFinding(rel, source, n.index, n[0], n[1] + '_'));
  }

  return out;
}

module.exports = {
  secretsIn: secretsIn,
  scriptsLoadedBy: scriptsLoadedBy,
  whereItRuns: whereItRuns,
  masked: masked,
  claimsOf: claimsOf,
};
