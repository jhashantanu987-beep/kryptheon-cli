// Does the package that would ship match the repo it was built from?
// Run with:  node kryptheon-package.check.js
//
// This exists because of a day it would have caught. The repo lived inside a
// synced folder, and the sync client resolved a conflict by renaming the edited
// bin/kryptheon.js to bin/kryptheon-Shantanu.js and restoring an older copy
// under the real name. The checks were reading the working tree and passing -
// all 124 of them - while npm packed the older file. Version 0.1.8 shipped
// without the fix it was named after, and nothing anywhere said so.
//
// So this asks the only question that would have failed: is what npm is about
// to send byte-for-byte the same as what is on disk, and is there anything in
// the repo that looks like a sync conflict?
//
// It runs in `npm run check` and again in `prepublishOnly`, so a publish stops
// rather than shipping a package nobody has compared.
//
// This file sits outside testDir and does not match Playwright's testMatch
// pattern, so `npx playwright test` ignores it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const ROOT = __dirname;

/* --------------------------------------------------------------------------
   Reading the tarball.

   Done here rather than by shelling out to `tar`, because a check that quietly
   skips when a tool is missing is the same failure it is guarding against. The
   file list is cross-checked against npm's own, so a bug in this reader shows
   up as a loud disagreement rather than as a pass.
-------------------------------------------------------------------------- */

function readTar(buffer) {
  const files = new Map();
  let offset = 0;
  let longName = null;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    // Two consecutive zero blocks end the archive.
    if (header.every((b) => b === 0)) break;

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156]);
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');

    const blocks = Math.ceil(size / 512) * 512;
    const body = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + blocks;

    if (type === 'L') {
      // GNU long name: the next header's real name is in this body.
      longName = body.toString('utf8').replace(/\0.*$/, '');
      continue;
    }
    if (type === 'x' || type === 'g') {
      // pax header. Only "path" matters here.
      const text = body.toString('utf8');
      const match = text.match(/\d+ path=([^\n]+)\n/);
      if (match) longName = match[1];
      continue;
    }

    const name = longName || (prefix ? prefix + '/' + rawName : rawName);
    longName = null;
    if (type === '0' || type === '\0' || type === '') files.set(name, Buffer.from(body));
  }
  return files;
}

/** A copy of the environment with npm's inherited --dry-run removed. */
function withoutDryRun(env) {
  const copy = Object.assign({}, env);
  for (const key of Object.keys(copy)) {
    if (/^npm_config_dry_run$/i.test(key)) delete copy[key];
  }
  return copy;
}

/**
 * The last JSON value in a stream of output.
 *
 * npm --json prints one report, but anything a prepack script writes lands on
 * the same stdout, so the report is located instead of assumed.
 */
function lastJson(text) {
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch !== '[' && ch !== '{') continue;
    try {
      return JSON.parse(text.slice(i).trim());
    } catch (e) {
      /* not the start of the report; keep looking */
    }
  }
  return null;
}

/** Builds the tarball npm would publish, and returns its files. */
function packAndRead() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-pack-'));
  try {
    // One command string, not an args array: npm is a .cmd on Windows and
    // cannot be spawned without a shell, and shell + args array concatenates
    // without escaping. The temp path is quoted because it can contain spaces.
    const packed = spawnSync('npm pack --pack-destination "' + dir + '" --json', {
      cwd: ROOT,
      encoding: 'utf8',
      shell: true,
      timeout: 180000,
      // Run under `npm publish --dry-run` and npm passes its own --dry-run
      // down through the environment, so this pack would write no tarball and
      // the check would report a failure it invented. The flag is dropped for
      // the child; nothing here writes to the registry either way.
      env: withoutDryRun(process.env),
    });
    if (packed.error) return { error: 'npm pack could not be run: ' + packed.error.message };
    if (packed.status !== 0) {
      const said = String(packed.stderr || packed.stdout || '').trim();
      return {
        error:
          'npm pack exited with ' + packed.status +
          (said ? ': ' + said.slice(0, 400) : ' and said nothing'),
      };
    }

    // A prepack script can print ahead of npm's JSON, so the report is found
    // rather than assumed to start at the first bracket.
    const meta = lastJson(String(packed.stdout || ''));
    if (!meta) return { error: 'could not read what npm said it packed' };
    const first = Array.isArray(meta) ? meta[0] : meta;
    if (!first || !Array.isArray(first.files)) {
      return { error: 'npm did not report a file list' };
    }
    const reported = first.files.map((f) => f.path);

    const tarballs = fs.readdirSync(dir).filter((n) => n.endsWith('.tgz'));
    if (tarballs.length !== 1) return { error: 'expected one tarball, found ' + tarballs.length };
    const raw = zlib.gunzipSync(fs.readFileSync(path.join(dir, tarballs[0])));
    const files = readTar(raw);
    return { files: files, reported: reported };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      /* temp dir cleanup is best effort */
    }
  }
}

/* --------------------------------------------------------------------------
   Looking for sync conflict copies.
-------------------------------------------------------------------------- */

const SKIP_DIRS = new Set(['node_modules', '.git', 'test-results', 'playwright-report']);

function walk(dir, found) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return found;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), found);
    } else if (entry.isFile()) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

// The shapes cloud clients and Windows use when they duplicate a file.
const NAMED_PATTERNS = [
  { re: /-conflict(ed)?\b/i, why: 'named as a conflict' },
  { re: /-copy\b/i, why: 'named as a copy' },
  { re: / - Copy(\s*\(\d+\))?\./i, why: 'a Windows "- Copy" duplicate' },
  { re: /\(\d+\)\./, why: 'a numbered duplicate' },
  { re: /\bconflicted copy\b/i, why: 'a Dropbox conflicted copy' },
];

/**
 * A file whose name is another file's name with a tag appended.
 *
 * This is the shape that actually bit. OneDrive appends the account or the
 * machine name - kryptheon-Shantanu.js, kryptheon-DESKTOP-A1B2.js - and no
 * fixed list of suffixes can predict either. So the test is structural: the
 * file it would be a copy of has to exist beside it, and the appended part has
 * to look like a name or a number rather than an ordinary word. That is what
 * keeps kryptheon-reporter.js and package-lock.json out of it.
 */
function looksLikeTwinOf(file, siblings) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const ext = path.extname(base);
  if (!ext) return null;
  const stemFull = base.slice(0, -ext.length);

  // Every hyphen is a candidate split, because the tag itself can contain one.
  for (let i = stemFull.indexOf('-'); i !== -1; i = stemFull.indexOf('-', i + 1)) {
    const stem = stemFull.slice(0, i);
    const tag = stemFull.slice(i + 1);
    if (!stem || !tag) continue;
    // A dot in the tag means this is a compound extension, not a copy tag.
    if (tag.indexOf('.') !== -1) continue;
    const named = /^[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/.test(tag);
    const numeric = /^\d+$/.test(tag);
    const copyish = /^(copy|conflict|conflicted|old|bak|backup)$/i.test(tag);
    if (!named && !numeric && !copyish) continue;
    if (!siblings.has(path.join(dir, stem + ext))) continue;
    return path.relative(ROOT, path.join(dir, stem + ext)).split(path.sep).join('/');
  }
  return null;
}

function findConflictCopies() {
  const all = walk(ROOT, []);
  const siblings = new Set(all);
  const hits = [];
  for (const file of all) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const base = path.basename(file);
    let why = null;
    for (const pattern of NAMED_PATTERNS) {
      if (pattern.re.test(base)) {
        why = pattern.why;
        break;
      }
    }
    if (!why) {
      const twin = looksLikeTwinOf(file, siblings);
      if (twin) why = 'a duplicate of ' + twin;
    }
    if (why) hits.push({ file: rel, why: why });
  }
  return hits;
}

/* --------------------------------------------------------------------------
   The checks.
-------------------------------------------------------------------------- */

const packed = packAndRead();

const cases = [
  {
    name: 'the package can be built and read',
    run: () => (packed.error ? [packed.error] : []),
  },
  {
    name: 'every file npm says it packs is in the tarball this check read',
    run: () => {
      if (packed.error) return ['the package could not be built'];
      const inTar = new Set([...packed.files.keys()].map((n) => n.replace(/^package\//, '')));
      const missing = packed.reported.filter((f) => !inTar.has(f));
      const extra = [...inTar].filter((f) => !packed.reported.includes(f));
      const problems = [];
      // A disagreement means this check is reading the archive wrongly, and
      // everything below it would be worthless. Say so rather than pass.
      if (missing.length) problems.push('npm packed but this check did not see: ' + missing.join(', '));
      if (extra.length) problems.push('this check saw files npm did not report: ' + extra.join(', '));
      return problems;
    },
  },
  {
    name: 'every shipped file is byte-for-byte the file in the repo',
    run: () => {
      if (packed.error) return ['the package could not be built'];
      const problems = [];
      for (const [name, contents] of packed.files) {
        const rel = name.replace(/^package\//, '');
        const onDisk = path.join(ROOT, rel);
        let actual;
        try {
          actual = fs.readFileSync(onDisk);
        } catch (e) {
          problems.push(rel + ' is in the package but not in the repo');
          continue;
        }
        if (actual.equals(contents)) continue;
        // package.json is the one file npm is entitled to rewrite, so it is
        // compared as data. Everything else must match exactly.
        if (rel === 'package.json') {
          try {
            const a = JSON.parse(actual.toString('utf8'));
            const b = JSON.parse(contents.toString('utf8'));
            for (const key of ['name', 'version', 'main', 'bin', 'files', 'exports', 'scripts', 'engines']) {
              if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
                problems.push('package.json "' + key + '" differs between the repo and the package');
              }
            }
            continue;
          } catch (e) {
            problems.push('package.json could not be compared: ' + e.message);
            continue;
          }
        }
        problems.push(
          rel + ' differs: the repo has ' + actual.length + ' bytes, the package has ' + contents.length +
            ' - the package would ship something other than what is checked here',
        );
      }
      return problems;
    },
  },
  {
    name: 'nothing in the repo looks like a cloud-sync conflict copy',
    run: () => {
      const hits = findConflictCopies();
      if (!hits.length) return [];
      const problems = hits.map((h) => h.file + ' - ' + h.why);
      problems.push(
        'a cloud sync client renames the file it could not merge and puts an older ' +
          'copy back under the real name, so the checks read one file and npm ships ' +
          'another. Work out which is yours, keep it under the real name, and delete ' +
          'the rest before publishing.',
      );
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
console.log('All ' + cases.length + ' package checks passed.');
