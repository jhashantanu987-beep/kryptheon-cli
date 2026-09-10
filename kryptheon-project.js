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
  lines.push('    kryptheon check');
  lines.push('');
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
    '    kryptheon record http://localhost:3000',
    '',
    '  That opens a browser window, so it has to be run by a person in a',
    '  normal terminal - it cannot be done from an AI assistant.',
    '',
  ];
}

module.exports = {
  ESCAPE_HATCH: ESCAPE_HATCH,
  hasPackageJson: hasPackageJson,
  systemFolders: systemFolders,
  tidy: tidy,
  isHomeOrSystem: isHomeOrSystem,
  inspectProject: inspectProject,
  noProjectLines: noProjectLines,
  noRecordingsLines: noRecordingsLines,
};
