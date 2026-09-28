// Where Kryptheon keeps what it remembers about a project.
//
// It used to be the project itself: kryptheon-baselines.json,
// kryptheon-history.jsonl, test-results/ and .kryptheon-last.json all appeared
// next to the person's own code. A plain landing page picked up six or seven
// files that way, and an AI assistant that commits "everything that changed"
// commits them too - the repo grows because Kryptheon is watching it.
//
// So every record now lives in one folder per project, outside it:
//
//   ~/.kryptheon/projects/<folder-name>-<hash>/     (KRYPTHEON_HOME moves ~/.kryptheon)
//     project.json    which folder this store belongs to
//     baselines.json  was kryptheon-baselines.json
//     history.jsonl   was kryptheon-history.jsonl
//     test-results/   was test-results/ (Playwright's screenshots of a failure)
//     night-last.json was .kryptheon-last.json (kryptheon-night)
//
// Only tests/ - the recordings the person made - stays in the project.
//
// The hash is of the project's full path, so two folders that happen to share
// a name are never mixed. kryptheon-night carries a copy of this file and must
// land in the same folder for the same project; both packages check the ids
// below against the same fixed examples, so the two copies cannot drift apart.
//
// Records an older version left in a project are moved here the first time a
// project is opened, and only moved: nothing is thrown away, and when both
// places already hold a file the project's copy is kept in parked/ rather than
// overwriting what is here.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME_ENV = 'KRYPTHEON_HOME';

const FILES = {
  project: 'project.json',
  baselines: 'baselines.json',
  history: 'history.jsonl',
  testResults: 'test-results',
  nightLast: 'night-last.json',
};

// What older versions wrote into the project, and where each one goes now.
//   append - history: lines the store does not have yet are added to it
//   park   - both exist: the project's copy goes to parked/, the store's stays
const LEGACY = [
  { from: 'kryptheon-baselines.json', to: FILES.baselines, onBoth: 'park' },
  { from: 'kryptheon-history.jsonl', to: FILES.history, onBoth: 'append' },
  { from: '.kryptheon-last.json', to: FILES.nightLast, onBoth: 'park' },
  { from: 'test-results', to: FILES.testResults, onBoth: 'park', dir: true },
];

// A project with a Playwright config of its own owns its test-results/ -
// Playwright's default output folder. Moving that would take the person's own
// screenshots away, so it is left exactly where it is.
const OWN_PLAYWRIGHT = /^playwright\.config\.(js|cjs|mjs|ts|cts|mts)$/;

/** ~/.kryptheon, or wherever KRYPTHEON_HOME points. */
function home(env) {
  const source = env || process.env;
  const set = source[HOME_ENV];
  if (set && String(set).trim()) return path.resolve(String(set).trim());
  return path.join(os.homedir(), '.kryptheon');
}

/** The project folder as one exact path, whatever form it was given in. */
function canonicalRoot(dir) {
  const resolved = path.resolve(dir || process.cwd());
  try {
    return fs.realpathSync.native(resolved);
  } catch (err) {
    return resolved;
  }
}

/**
 * <folder-name>-<12 hex>. Pure: the same path always gives the same id.
 *
 * Windows paths are compared without regard to case, because C:\Users\a and
 * c:\users\a are the same folder there and must be the same project.
 */
function projectId(root, platform) {
  const plat = platform || process.platform;
  const P = plat === 'win32' ? path.win32 : path.posix;
  // resolve() also drops a trailing separator and turns / into \ on Windows.
  let key = P.resolve(String(root));
  if (plat === 'win32') key = key.toLowerCase();
  const hash = crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12);
  const base = P.basename(key) || 'project';
  const name = base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 40) || 'project';
  return name + '-' + hash;
}

/**
 * The store folder for a project. Only reads: nothing is created or moved, so
 * the fixture and the reporter can ask for it just by being loaded.
 */
function dirFor(dir, env) {
  const root = canonicalRoot(dir);
  const short = path.join(home(env), 'projects', projectId(root));
  const owner = readProject(path.join(short, FILES.project));
  if (!owner || !owner.root || sameRoot(owner.root, root)) return short;
  // Two different folders with the same short hash. Astronomically rare, but
  // the one thing a store must never do is hold two projects, so the second
  // one gets the full hash instead.
  const full = crypto.createHash('sha256').update(root, 'utf8').digest('hex');
  return short.replace(/-[0-9a-f]{12}$/, '-' + full);
}

/** Every file in a project's store, by name. Only reads, like dirFor. */
function pathsFor(dir, env) {
  return pathsIn(dirFor(dir, env));
}

function pathsIn(dir) {
  return {
    dir: dir,
    project: path.join(dir, FILES.project),
    baselines: path.join(dir, FILES.baselines),
    history: path.join(dir, FILES.history),
    testResults: path.join(dir, FILES.testResults),
    nightLast: path.join(dir, FILES.nightLast),
  };
}

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (err) {
    return false;
  }
}

function hasOwnPlaywright(root) {
  try {
    return fs.readdirSync(root).some((name) => OWN_PLAYWRIGHT.test(name));
  } catch (err) {
    return false;
  }
}

// rename is the whole move when both sides are on one drive. Across drives it
// fails with EXDEV, and then it is copy, check the copy, and only then remove.
function move(from, to, isDir) {
  try {
    fs.renameSync(from, to);
    return;
  } catch (err) {
    // Anything else - a file held open by an editor, say - is reported and the
    // record stays where it is, whole.
    if (err.code !== 'EXDEV') throw err;
  }
  if (isDir) {
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(from, { recursive: true, force: true });
    return;
  }
  const tmp = to + '.moving';
  fs.copyFileSync(from, tmp);
  if (fs.statSync(tmp).size !== fs.statSync(from).size) {
    fs.rmSync(tmp, { force: true });
    throw new Error('the copy of ' + from + ' came out a different size');
  }
  fs.renameSync(tmp, to);
  fs.rmSync(from, { force: true });
}

// Lines of the project's history the store does not have yet, in their order.
// Checked line by line so moving twice - say the project file could not be
// removed the first time - never writes a run down twice.
function appendHistory(from, to) {
  const have = new Set(fs.readFileSync(to, 'utf8').split('\n').filter((l) => l.trim()));
  const extra = fs.readFileSync(from, 'utf8').split('\n').filter((l) => l.trim() && !have.has(l));
  if (extra.length) {
    const current = fs.readFileSync(to, 'utf8');
    const lead = current.length && !current.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(to, lead + extra.join('\n') + '\n', 'utf8');
  }
  fs.rmSync(from, { force: true });
  return extra.length;
}

function stamp(now) {
  return (now || new Date()).toISOString().replace(/[:.]/g, '-');
}

/**
 * Moves what an older version left in the project into the store.
 * Returns { moved: [names], parked: [{ name, to }], appended: [{ name, lines }],
 * kept: [{ name, why }], failed: [{ name, why }] }.
 */
function migrate(root, dir, options) {
  const out = { moved: [], parked: [], appended: [], kept: [], failed: [] };
  const ownPlaywright = hasOwnPlaywright(root);
  for (const item of LEGACY) {
    const from = path.join(root, item.from);
    if (!exists(from)) continue;
    const label = item.from + (item.dir ? '/' : '');
    if (item.dir && ownPlaywright) {
      out.kept.push({ name: label, why: 'this project has its own Playwright config, so it is theirs' });
      continue;
    }
    const to = path.join(dir, item.to);
    try {
      if (!exists(to)) {
        move(from, to, item.dir);
        out.moved.push(label);
      } else if (item.onBoth === 'append') {
        out.appended.push({ name: label, lines: appendHistory(from, to) });
      } else {
        const parkedDir = path.join(dir, 'parked');
        fs.mkdirSync(parkedDir, { recursive: true });
        const parked = path.join(parkedDir, stamp(options && options.now) + '-' + item.from.replace(/^\./, ''));
        move(from, parked, item.dir);
        out.parked.push({ name: label, to: parked });
      }
    } catch (err) {
      out.failed.push({ name: label, why: err.message });
    }
  }
  return out;
}

/**
 * The store for the project in `dir` (default: the current folder), created if
 * it is not there yet, with anything an older version left in the project moved
 * into it. Safe to call again: once moved, there is nothing left to move.
 *
 * Throws when the store cannot be created. A record that silently cannot be
 * written makes every run look like the first one - which reads as "nothing to
 * compare against, all fine" - so that is never swallowed here.
 */
function open(dir, options) {
  const env = (options && options.env) || process.env;
  const root = canonicalRoot(dir);
  const storeDir = dirFor(root, env);
  fs.mkdirSync(storeDir, { recursive: true });
  const paths = pathsIn(storeDir);
  if (!exists(paths.project)) {
    fs.writeFileSync(paths.project, JSON.stringify({
      root: root,
      name: path.basename(root),
      id: path.basename(storeDir),
      createdAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8');
  }
  return Object.assign({ root: root, id: path.basename(storeDir) }, paths, {
    migration: migrate(root, storeDir, options),
  });
}

function sameRoot(a, b, platform) {
  const plat = platform || process.platform;
  const norm = (p) => {
    const r = path.resolve(String(p)).replace(/[\\/]+$/, '');
    return plat === 'win32' ? r.split('/').join('\\').toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

function readProject(file) {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}

/** What to tell the person about a migration, or nothing when nothing moved. */
function migrationLines(store) {
  const m = store && store.migration;
  if (!m) return [];
  const lines = [];
  const movedNames = m.moved.concat(m.appended.map((a) => a.name)).concat(m.parked.map((p) => p.name));
  if (movedNames.length) {
    lines.push('  Kryptheon now keeps its records outside your project, so they can never');
    lines.push('  end up in your repo. Moved out of this folder:');
    for (const name of movedNames) lines.push('    ' + name);
    lines.push('  They are now in:');
    lines.push('    ' + store.dir);
    for (const p of m.parked) {
      lines.push('  ' + p.name + ' was already there too, so this folder\'s copy is kept aside in:');
      lines.push('    ' + p.to);
    }
    lines.push('');
  }
  for (const k of m.kept) {
    lines.push('  Left ' + k.name + ' where it is: ' + k.why + '.');
    lines.push('');
  }
  for (const f of m.failed) {
    lines.push('  Could not move ' + f.name + ' out of this folder: ' + f.why);
    lines.push('  It is still here. Close anything that has it open and run this again.');
    lines.push('');
  }
  return lines;
}

module.exports = {
  HOME_ENV: HOME_ENV,
  FILES: FILES,
  LEGACY: LEGACY,
  home: home,
  canonicalRoot: canonicalRoot,
  projectId: projectId,
  dirFor: dirFor,
  pathsFor: pathsFor,
  open: open,
  migrate: migrate,
  migrationLines: migrationLines,
};
