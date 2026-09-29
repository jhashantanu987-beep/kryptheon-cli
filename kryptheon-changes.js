// What changed in a project since Kryptheon last looked, and what that means
// for which checks have to run.
//
// A snapshot is a content hash of every file that is the project's own - its
// source, its database migrations, its dependency list - kept in the store,
// never in the project. Comparing two snapshots answers the first question a
// person has after an AI tool says "done": what did it actually touch?
//
// Content, not timestamps and not git: an editor that saves a file unchanged
// is not a change, and a landing page with no git repository still has one.
//
// Each changed file is put in a part of the app (frontend, backend, database,
// tests, dependencies, config, docs), and each part names the checks that
// can speak to it. The mapping is written here, once, and deliberately
// plain: a path-based guess that is right for how most projects are laid
// out, and said as a guess ("likely affected") rather than a proof.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', 'coverage',
  '.vercel', '.netlify', '.turbo', '.cache', 'test-results', 'playwright-report', '.kryptheon',
]);
const MAX_BYTES = 5 * 1024 * 1024;

// Where a file sits in the app. The first rule that matches wins, so the
// specific ones come first: a .sql file inside backend/ is a database change.
const PARTS = [
  { part: 'dependencies', test: (p) => /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|requirements\.txt|poetry\.lock|Gemfile\.lock|go\.sum)$/i.test(p) },
  { part: 'database', test: (p) => /\.sql$/i.test(p) || /(^|\/)(migrations|supabase|prisma|drizzle|db\/schema)(\/|$)/i.test(p) || /(^|\/)schema\.prisma$/i.test(p) },
  { part: 'tests', test: (p) => /(^|\/)(tests?|__tests__|e2e|cypress)\//i.test(p) || /\.(spec|test)\.[cm]?[jt]sx?$/i.test(p) },
  { part: 'docs', test: (p) => /\.(md|mdx|txt|rst)$/i.test(p) || /(^|\/)docs\//i.test(p) },
  { part: 'config', test: (p) => /(^|\/)(\.env\.example|\.env\.sample|tsconfig[^/]*\.json|jsconfig\.json|vercel\.json|netlify\.toml|dockerfile|docker-compose[^/]*\.ya?ml)$/i.test(p) || /\.config\.[cm]?[jt]s$/i.test(p) || /(^|\/)\.github\//i.test(p) },
  { part: 'backend', test: (p) => /(^|\/)(server|backend|api|routes|controllers|services|middleware|functions|workers|jobs|lib\/server)(\/|\.[cm]?[jt]s$)/i.test(p) || /(^|\/)(server|app|index)\.[cm]?[jt]s$/i.test(p) && !/(^|\/)(src|public|frontend|client|pages|components)\//i.test(p) },
  { part: 'frontend', test: (p) => /\.(html?|css|scss|sass|less|jsx|tsx|vue|svelte|astro)$/i.test(p) || /(^|\/)(frontend|client|public|src|pages|components|app|views|static)\//i.test(p) && /\.[cm]?[jt]s$/i.test(p) },
  { part: 'assets', test: (p) => /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|mp4|webm|mp3|pdf)$/i.test(p) },
];

// Which checks can speak to a change in each part. Ids are the dashboard's.
const CHECKS_FOR = {
  frontend: ['frontend', 'regression'],
  backend: ['backend', 'api', 'regression'],
  database: ['data', 'regression'],
  dependencies: ['dependency', 'build', 'regression'],
  tests: ['regression'],
  config: ['build', 'regression'],
  code: ['regression'],
  docs: [],
  assets: [],
};

function partOf(rel) {
  const p = rel.split(path.sep).join('/');
  const hit = PARTS.find((r) => r.test(p));
  if (hit) return hit.part;
  return /\.[cm]?[jt]sx?$/i.test(p) ? 'code' : 'other';
}

/** Every file that is the project's own, as relative paths with forward slashes. */
function listFiles(root) {
  const out = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        // A real .env holds secrets; its content is never hashed or kept.
        if (/^\.env(\..+)?$/i.test(entry.name) && !/\.(example|sample)$/i.test(entry.name)) continue;
        out.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  })(root);
  return out.sort();
}

/** The dependency lists of package.json, kept so a change can say which package moved. */
function dependenciesOf(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
  } catch (err) {
    return null;
  }
}

/**
 * The project as it is now. Files whose size and modified time match the
 * previous snapshot keep its hash without being read again - on a large
 * project that is the difference between milliseconds and seconds, and an
 * unchanged size and time is the same bytes for every editor that exists.
 */
function takeSnapshot(root, previous) {
  const before = (previous && previous.files) || {};
  const files = {};
  for (const rel of listFiles(root)) {
    let stat;
    try {
      stat = fs.statSync(path.join(root, rel));
    } catch (err) {
      continue;
    }
    const old = before[rel];
    if (old && old.size === stat.size && old.mtimeMs === stat.mtimeMs) {
      files[rel] = old;
      continue;
    }
    let hash;
    if (stat.size > MAX_BYTES) {
      hash = 'size:' + stat.size + ':' + stat.mtimeMs;
    } else {
      try {
        hash = crypto.createHash('sha1').update(fs.readFileSync(path.join(root, rel))).digest('hex');
      } catch (err) {
        continue;
      }
    }
    files[rel] = { hash: hash, size: stat.size, mtimeMs: stat.mtimeMs };
  }
  return { takenAt: new Date().toISOString(), files: files, dependencies: dependenciesOf(root) };
}

/** Packages added, removed or moved to another version between two snapshots. */
function dependencyChanges(before, after) {
  const a = (before && before.dependencies) || {};
  const b = (after && after.dependencies) || {};
  const out = [];
  for (const name of new Set(Object.keys(a).concat(Object.keys(b)))) {
    if (!(name in a)) out.push({ name: name, change: 'added', to: b[name] });
    else if (!(name in b)) out.push({ name: name, change: 'removed', from: a[name] });
    else if (a[name] !== b[name]) out.push({ name: name, change: 'changed', from: a[name], to: b[name] });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

/**
 * What changed between two snapshots, by part of the app, and which checks
 * that calls for. With no earlier snapshot there is nothing to compare, and
 * that is said - it is not reported as "everything changed".
 */
function compare(before, after) {
  if (!before) return { first: true, files: [], parts: [], checks: [], dependencies: [] };
  const files = [];
  const a = before.files || {};
  const b = after.files || {};
  for (const rel of Object.keys(b)) {
    if (!a[rel]) files.push({ path: rel, state: 'added' });
    else if (a[rel].hash !== b[rel].hash) files.push({ path: rel, state: 'modified' });
  }
  for (const rel of Object.keys(a)) if (!b[rel]) files.push({ path: rel, state: 'deleted' });
  files.sort((x, y) => x.path.localeCompare(y.path));
  for (const f of files) f.part = partOf(f.path);

  const parts = [];
  for (const f of files) if (!parts.includes(f.part)) parts.push(f.part);
  const checks = [];
  for (const part of parts) for (const id of CHECKS_FOR[part] || []) if (!checks.includes(id)) checks.push(id);
  return {
    first: false,
    files: files,
    parts: parts,
    checks: checks,
    dependencies: dependencyChanges(before, after),
  };
}

/**
 * Findings that were not there last time. Keyed by what they are about rather
 * than by line number: a line added above a known finding moves it, and a
 * moved finding reported as new would teach a person to ignore this list.
 */
function findingKey(f) {
  return [f.check || '', f.where ? String(f.where).replace(/:\d+$/, '') : '', f.headline ? String(f.headline).replace(/:\d+\b/g, '') : '', f.detail || ''].join('|');
}

function newFindings(before, after) {
  const seen = new Set((before || []).map(findingKey));
  return (after || []).filter((f) => !seen.has(findingKey(f)));
}

function goneFindings(before, after) {
  const now = new Set((after || []).map(findingKey));
  return (before || []).filter((f) => !now.has(findingKey(f)));
}

module.exports = {
  PARTS: PARTS,
  CHECKS_FOR: CHECKS_FOR,
  partOf: partOf,
  listFiles: listFiles,
  takeSnapshot: takeSnapshot,
  compare: compare,
  dependencyChanges: dependencyChanges,
  findingKey: findingKey,
  newFindings: newFindings,
  goneFindings: goneFindings,
};
