// Working out whether this folder is a project at all.
//
// `kryptheon check` reads recordings out of ./tests and baselines out of the
// folder it was run in. Run it somewhere that is not a project - a home folder,
// the place a global install happened to leave you - and it will happily find
// whatever tests/ happens to be lying around and run those instead, reporting
// results for a project nobody asked about. That has already happened to
// somebody who installed into their home folder.
//
// Quietly testing the wrong project is the worst thing this tool can do. A
// green that belongs to something else is not a result, it is a lie with a tick
// next to it. So the answer to "is this a project?" has to be settled before
// anything runs, and the answer has to be a stop rather than a guess.
//
// Pure path work: nothing here runs a test or reads a recording.

const fs = require('fs');
const os = require('os');
const path = require('path');

// For someone who genuinely keeps recordings outside a package. Deliberately
// long-winded: it should be something you decide to type, not something you
// stumble into.
const ESCAPE_HATCH = 'KRYPTHEON_ALLOW_NO_PACKAGE_JSON';

// Where `record` keeps recordings for somebody who ran it in their home folder.
// A new terminal opens there, so for anyone who has only a web address - an
// app built in Lovable, no source folder anywhere - it is where the command
// gets typed.
const HOME_RECORDINGS = 'kryptheon-tests';

function hasPackageJson(dir) {
  try {
    return fs.statSync(path.join(dir, 'package.json')).isFile();
  } catch (e) {
    return false;
  }
}

/**
 * One comparable form of a path.
 *
 * The trailing separator has to go or C:\Users and C:\Users\ never match, but
 * it must not be taken off before the root test below. "C:" without a separator
 * is not the drive - Node resolves it to the current directory - so a root
 * compared in this form would quietly become "wherever I happen to be".
 */
function tidy(dir) {
  return path.resolve(String(dir || '')).replace(/[\\/]+$/, '').toLowerCase();
}

/** The folders that are somebody's whole account or the machine itself. */
function isHomeOrSystem(dir) {
  // A drive or filesystem root: C:\, D:\, /. Done on the resolved path, with
  // its separator still on, for the reason above.
  const resolved = path.resolve(String(dir || ''));
  if (resolved === path.parse(resolved).root) return true;

  const here = tidy(dir);
  if (here === tidy(os.homedir())) return true;

  for (const candidate of systemFolders()) {
    if (here === tidy(candidate)) return true;
  }
  return false;
}

/**
 * Every folder that belongs to the machine or to an account rather than to a
 * project, resolved.
 *
 * The first two entries are derived from the running system; the literals after
 * them are fallbacks for the usual layouts. They overlap - on Windows
 * USERPROFILE is the home folder and "/Users" resolves to C:\Users - and the
 * overlap is deliberate: a machine whose home is somewhere unusual is covered
 * by the derived pair, and a machine whose environment is missing entries is
 * covered by the literals.
 */
function systemFolders() {
  return [
    // The folder every account lives in - C:\Users, /home, /Users. On its own
    // it has no package.json so it would be refused anyway, but one stray npm
    // install there and it would look exactly like a project.
    path.dirname(os.homedir()),
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData,
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
    process.env.USERPROFILE,
    '/root',
    '/home',
    '/Users',
    '/usr',
    '/etc',
    '/bin',
    '/var',
    '/opt',
  ].filter(Boolean);
}

/**
 * Whether this folder can be checked, and if not, why not.
 *
 * `allowed` is the escape hatch having been set. It is reported rather than
 * hidden, so a run that only worked because of it says so.
 */
function inspectProject(dir, env) {
  const environment = env || process.env;
  const allowed = String(environment[ESCAPE_HATCH] || '') !== '';
  const packaged = hasPackageJson(dir);
  const personal = isHomeOrSystem(dir);
  const base = { dir: dir, packaged: packaged, personal: personal, allowed: allowed };

  // Somebody whose recordings `record` put in a folder of their own, standing
  // in their home folder again because that is where a new terminal opens.
  // Pointed at by name, rather than told to go and find a project they never
  // had.
  const kept = tidy(dir) === tidy(os.homedir()) ? path.join(path.resolve(dir), HOME_RECORDINGS) : null;
  if (kept && hasPackageJson(kept)) base.recordingsAt = kept;

  if (allowed) return Object.assign({ ok: true, reason: null }, base);

  // A home folder is refused even when it has a package.json, and this is not
  // belt and braces - it is the case that actually happened. Someone installed
  // the tool into their home folder, so npm left a package.json and a
  // node_modules there, and a tests folder alongside them. Every sign this
  // could look for says "project"; none of them is true. The measured state of
  // one real machine: C:\Users\<name> holding package.json, node_modules and
  // tests, none of which belong to anything.
  if (personal) return Object.assign({ ok: false, reason: 'personal' }, base);
  if (!packaged) return Object.assign({ ok: false, reason: 'no-package' }, base);
  return Object.assign({ ok: true, reason: null }, base);
}

/**
 * Why this folder is not a project, and what to do instead.
 *
 * The folder is printed back because the commonest version of this is not
 * knowing where you are - a new terminal, a global install, a shell that opened
 * somewhere else.
 */
function noProjectLines(inspection) {
  const lines = [''];

  if (inspection.recordingsAt) {
    lines.push('  This is your home folder, not a project.');
    lines.push('');
    lines.push('  Your recordings are in:  ' + inspection.recordingsAt);
    lines.push('');
    lines.push('  To check them:');
    lines.push('');
    lines.push('    cd "' + inspection.recordingsAt + '"');
    lines.push('    npx kryptheon check');
    lines.push('');
    return lines;
  }

  if (inspection.personal) {
    lines.push('  This is your home or a system folder, not a project.');
    lines.push('');
    lines.push('  You are in:  ' + inspection.dir);
    lines.push('');
    // Almost never deliberate, and the one place where running anyway does the
    // most damage. Said explicitly because a home folder that has had anything
    // installed into it looks exactly like a project from the outside.
    lines.push('  Recordings and results are kept beside the app they belong to,');
    lines.push('  so running here would check whichever tests folder happens to be');
    lines.push('  sitting in this one - almost certainly not the one you meant.');
    if (inspection.packaged) {
      lines.push('');
      // Said plainly, because otherwise the package.json sitting right there
      // makes this message look like the bug rather than the diagnosis.
      lines.push('  There is a package.json here, but that is not what makes a project.');
      lines.push('  It looks like npm install was run in this folder by mistake, which');
      lines.push('  leaves a package.json and a node_modules behind.');
    }
    lines.push('');
  } else {
    lines.push('  There is no project here - this folder has no package.json.');
    lines.push('');
    lines.push('  You are in:  ' + inspection.dir);
    lines.push('');
  }

  lines.push('  Change into your project folder and run this again:');
  lines.push('');
  lines.push('    cd path\\to\\your\\project');
  lines.push('    npx kryptheon check');
  lines.push('');
  // The person with a web address and no folder at all - an app built in
  // Lovable - has no project to change into, and would be stuck on the line
  // above. Not offered in a system folder: record refuses to set one up.
  if (!inspection.personal || tidy(inspection.dir) === tidy(os.homedir())) {
    lines.push('  No project folder, only a web address? Record from here and it');
    lines.push('  will be set up for you:');
    lines.push('');
    lines.push('    npx kryptheon record https://your-app.example.com');
    lines.push('');
  }
  lines.push('  If you really do keep recordings outside a package, set');
  lines.push('  ' + ESCAPE_HATCH + '=1 and this will run anyway.');
  lines.push('');
  return lines;
}

/** A real project, with nothing recorded in it yet. */
function noRecordingsLines() {
  return [
    '',
    '  No recordings were found in this project.',
    '',
    '  This is not a failure, and there is nothing in the code to fix.',
    '',
    '  Record a flow through your app first:',
    '',
    '    npx kryptheon record http://localhost:3000',
    '',
    '  That opens a browser window, so it has to be run by a person in a',
    '  normal terminal - it cannot be done from an AI assistant.',
    '',
  ];
}

// --- Setting a folder up, before recording into it ---------------------------
//
// Somebody who built their app in Lovable has an address and nothing else: no
// source folder, no package.json, nothing to change into. Their recordings
// still need somewhere to live, `check` refuses a folder with no package.json,
// and a recording cannot load the fixture unless kryptheon is installed where
// the recording is.
//
// `record` used to find all of that out afterwards. Measured in an empty
// folder: it started the browser, would have let the person spend five minutes
// using their app and saved the recording - and then `check`, in that same
// folder, said "There is no project here". So record now works out what is
// missing before the browser, which is a 200MB download on a new machine, and
// offers to add it.

/**
 * Whether kryptheon can be loaded by a recording saved in this folder.
 *
 * A filesystem walk, not require.resolve: this file lives inside the kryptheon
 * package, and a package with a name and an "exports" map can always resolve
 * itself by name, so require.resolve would answer "yes" even when the user's
 * recordings have no way to find it.
 */
function kryptheonReachableFrom(dir) {
  let current = path.resolve(String(dir || ''));
  if (insideKryptheonItself(current)) return true;
  for (;;) {
    if (fs.existsSync(path.join(current, 'node_modules', 'kryptheon', 'kryptheon-fixture.js'))) {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Inside the kryptheon package's own folder - this repository.
 *
 * Node lets a package load itself by its own name, so a recording made here
 * finds the fixture with no node_modules/kryptheon anywhere. Without this,
 * record in this repository offered to npm install kryptheon into kryptheon.
 * Only the nearest package.json counts: that is the package a file belongs to.
 */
function insideKryptheonItself(dir) {
  let current = dir;
  for (;;) {
    if (hasPackageJson(current)) {
      // The name alone is not enough: somebody's own app can be called that.
      // The fixture beside it is what makes it this package.
      try {
        return JSON.parse(fs.readFileSync(path.join(current, 'package.json'), 'utf8')).name === 'kryptheon' &&
          fs.existsSync(path.join(current, 'kryptheon-fixture.js'));
      } catch (err) {
        return false;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Installed in this folder itself, not borrowed from one above it.
 *
 * A folder record sets up gets its own copy even when one is reachable from
 * further up. The copy further up is, on the one machine where this was looked
 * at, a stray install in a home folder - and recordings that lean on that stop
 * working the day somebody tidies it away.
 */
function kryptheonInstalledIn(dir) {
  return fs.existsSync(path.join(path.resolve(String(dir || '')), 'node_modules', 'kryptheon', 'kryptheon-fixture.js'));
}

/**
 * The nearest folder above this one that is a project.
 *
 * Stops at a home or system folder rather than walking through it: the one
 * package.json most likely to be found up there is the stray one a mistaken
 * install left in a home folder, and that is nobody's project.
 */
function projectAbove(dir) {
  let current = path.resolve(String(dir || ''));
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    if (isHomeOrSystem(parent)) return null;
    if (hasPackageJson(parent)) return parent;
    current = parent;
  }
}

/** A folder record set up on an earlier run - its package.json asks for kryptheon. */
function setUpForKryptheon(dir) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return !!((json.devDependencies && json.devDependencies.kryptheon) ||
              (json.dependencies && json.dependencies.kryptheon));
  } catch (err) {
    return false;
  }
}

function isEmptyFolder(dir) {
  try {
    return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0;
  } catch (err) {
    return false;
  }
}

/**
 * What this folder needs before a recording made in it can be checked. Only
 * looks; never writes.
 *
 *   ready    nothing
 *   create   no package.json and no project above: make one, then install
 *   install  a project without kryptheon: install it
 *   above    no package.json, but a project sits above this folder
 *   home     a home folder: record in a kryptheon-tests folder inside it
 *   refuse   a system folder, or a home whose kryptheon-tests is taken
 */
function setupPlan(dir, env) {
  const environment = env || process.env;
  const here = path.resolve(String(dir || ''));

  // Somebody who has said they keep recordings outside a package is left
  // exactly as they were before any of this existed.
  if (String(environment[ESCAPE_HATCH] || '') !== '') return { action: 'ready', dir: here };

  if (tidy(here) === tidy(os.homedir())) {
    const into = path.join(here, HOME_RECORDINGS);
    // Used only if it is plainly ours or plainly nothing. A folder of that name
    // holding something else is somebody's, and recording into it would put a
    // package.json and node_modules in the middle of it.
    if (!fs.existsSync(into) || isEmptyFolder(into) || setUpForKryptheon(into)) {
      return { action: 'home', dir: here, into: into };
    }
    return { action: 'refuse', reason: 'taken', dir: here, into: into };
  }
  if (isHomeOrSystem(here)) return { action: 'refuse', reason: 'system', dir: here };

  if (!hasPackageJson(here)) {
    const above = projectAbove(here);
    if (above) return { action: 'above', dir: here, project: above };
    return { action: 'create', dir: here };
  }
  if (!kryptheonReachableFrom(here)) return { action: 'install', dir: here };
  return { action: 'ready', dir: here };
}

/** What is about to happen to this folder, said before it happens. */
function setupLines(plan, url) {
  const address = url || 'https://your-app.example.com';
  const lines = [''];

  if (plan.action === 'create') {
    lines.push('  This folder is not set up for recordings yet.');
    lines.push('');
    lines.push('  You are in:  ' + plan.dir);
    lines.push('');
    lines.push('  Your recordings are saved here, and kryptheon has to be installed');
    lines.push('  beside them or they cannot be checked later. So I will add:');
    lines.push('');
    lines.push('    package.json     a small file that marks this folder as a project');
    lines.push('    node_modules     kryptheon itself, about 20MB');
    lines.push('');
    lines.push('  Nothing already in this folder is touched.');
  } else if (plan.action === 'install') {
    lines.push('  kryptheon is not installed in this project yet.');
    lines.push('');
    lines.push('  You are in:  ' + plan.dir);
    lines.push('');
    lines.push('  Recordings load it by name, so without it here they cannot be');
    lines.push('  checked later. I will run:');
    lines.push('');
    lines.push('    npm install --save-dev kryptheon');
    lines.push('');
    lines.push('  which adds one line to package.json and about 20MB to node_modules.');
  } else if (plan.action === 'above') {
    lines.push('  This folder is inside a project:');
    lines.push('');
    lines.push('    ' + plan.project);
    lines.push('');
    lines.push('  Recordings belong beside the app they test, so the usual thing is');
    lines.push('  to run this from there:');
    lines.push('');
    lines.push('    cd "' + plan.project + '"');
    lines.push('    npx kryptheon record ' + address);
    lines.push('');
    lines.push('  If that is not your project - a package.json can be left behind by');
    lines.push('  an install run in the wrong place - I can set this folder up on its');
    lines.push('  own instead.');
  } else if (plan.action === 'home') {
    lines.push('  You are in your home folder.');
    lines.push('');
    lines.push('  Recordings are kept in a folder of their own rather than loose in');
    lines.push('  here, so I will ' + (fs.existsSync(plan.into) ? 'use this one' : 'make one') + ' and work in that:');
    lines.push('');
    lines.push('    ' + plan.into);
  } else if (plan.action === 'refuse' && plan.reason === 'taken') {
    lines.push('  You are in your home folder. Recordings are kept in a folder of');
    lines.push('  their own, and I would normally use:');
    lines.push('');
    lines.push('    ' + plan.into);
    lines.push('');
    lines.push('  but something else is already there, and it is not one I made.');
    lines.push('  Nothing was changed.');
    lines.push('');
    lines.push('  Make a new folder of your own, open a terminal in it, and run the');
    lines.push('  same command again.');
  } else if (plan.action === 'refuse') {
    lines.push('  This is a system folder, not somewhere to keep recordings.');
    lines.push('');
    lines.push('  You are in:  ' + plan.dir);
    lines.push('');
    lines.push('  Nothing was changed. Make a new folder of your own - on the Desktop');
    lines.push('  is fine - open a terminal in it, and run the same command again.');
    if (process.platform === 'win32') {
      lines.push('  (In File Explorer: right-click inside the folder, Open in Terminal.)');
    }
  }
  lines.push('');
  return lines;
}

/**
 * The question, and which way Enter answers it.
 *
 * Yes by default where saying yes is what the person came for. No by default
 * for a folder inside another project, where yes puts a second project inside
 * somebody's first.
 */
function setupQuestion(plan) {
  if (plan.action === 'above') return { text: '  Set this folder up on its own instead? [y/N] ', yesByDefault: false };
  if (plan.action === 'install') return { text: '  Install it? [Y/n] ', yesByDefault: true };
  if (plan.action === 'home') return { text: '  Go ahead? [Y/n] ', yesByDefault: true };
  return { text: '  Set this folder up? [Y/n] ', yesByDefault: true };
}

/** An answer typed at the question, read the way the question offered it. */
function answeredYes(answer, yesByDefault) {
  const typed = String(answer || '').trim();
  if (!typed) return !!yesByDefault;
  return /^y/i.test(typed);
}

/** After recording from a home folder: where the recordings went, and how to get back to them. */
function homeDoneLines(into) {
  return [
    '',
    '  Your recordings are in:  ' + into,
    '',
    '  To check them after a change, open a terminal and run:',
    '',
    '    cd "' + into + '"',
    '    npx kryptheon check',
    '',
  ];
}

/** The install did not finish. Nothing needs undoing: running again picks up where this stopped. */
function installFailedLines() {
  return [
    '',
    '  kryptheon could not be installed in this folder.',
    '',
    '  Installing needs an internet connection. Check it, then run the same',
    '  command again - nothing needs undoing first.',
    '',
    '  Or install it yourself, then record:',
    '',
    '    npm install --save-dev kryptheon',
    '',
  ];
}

module.exports = {
  ESCAPE_HATCH: ESCAPE_HATCH,
  HOME_RECORDINGS: HOME_RECORDINGS,
  kryptheonReachableFrom: kryptheonReachableFrom,
  kryptheonInstalledIn: kryptheonInstalledIn,
  projectAbove: projectAbove,
  setupPlan: setupPlan,
  setupLines: setupLines,
  setupQuestion: setupQuestion,
  answeredYes: answeredYes,
  homeDoneLines: homeDoneLines,
  installFailedLines: installFailedLines,
  hasPackageJson: hasPackageJson,
  systemFolders: systemFolders,
  tidy: tidy,
  isHomeOrSystem: isHomeOrSystem,
  inspectProject: inspectProject,
  noProjectLines: noProjectLines,
  noRecordingsLines: noRecordingsLines,
};
