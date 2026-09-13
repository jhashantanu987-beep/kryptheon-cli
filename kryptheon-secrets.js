// Which environment variables a recording needs, and whether they are there.
//
// Why this exists. When a password is typed during recording it is taken out
// of the spec and replaced with `process.env.KRYPTHEON_PASSWORD || ''`. If
// nobody ever creates the .env file, that expression quietly evaluates to an
// empty string: the run submits a blank password, the login fails for the most
// boring reason imaginable, and the report blames the app. Two hours can go
// into that before anyone thinks to check the environment.
//
// So the names are read out of the spec before anything runs, and a recording
// whose secret is missing is not run at all - a blank password is never sent.

const fs = require('fs');
const path = require('path');

// The exact shape the scrubber writes. Anything else in the file that happens
// to mention process.env is the author's own business and left alone.
const SECRET_USE = /process\.env\.([A-Z][A-Z0-9_]*)\s*\|\|\s*(['"])\2/g;

/** Every environment variable this recording falls back to an empty string for. */
function requiredSecrets(source) {
  const out = [];
  const seen = Object.create(null);
  let match;
  SECRET_USE.lastIndex = 0;
  while ((match = SECRET_USE.exec(String(source || '')))) {
    const name = match[1];
    if (seen[name]) continue;
    seen[name] = true;
    out.push(name);
  }
  return out;
}

/**
 * Reads a .env file into a plain object. Never throws: a missing file simply
 * means nothing was defined there.
 *
 * Values are not expanded or unescaped beyond stripping one layer of quotes -
 * this only has to answer "is it set", and guessing at more would be a second
 * dialect of .env for people to trip over.
 */
function readEnvFile(file) {
  const out = Object.create(null);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return out;
  }
  // A byte order mark would otherwise become part of the first name.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    out[match[1]] = match[2].replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return out;
}

/** A value that is present and not blank. An empty variable is not set. */
function isSet(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Which of the names a recording needs are missing, looking at both the real
 * environment and the project's .env - the same two places the test itself
 * will look when it runs.
 */
function missingSecrets(names, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const fromFile = opts.envFile ? readEnvFile(opts.envFile) : {};
  return (names || []).filter((name) => !isSet(env[name]) && !isSet(fromFile[name]));
}

/**
 * How to create the file without a byte order mark.
 *
 * PowerShell's own `Out-File -Encoding utf8` writes one, and so does Notepad,
 * which is why this spells out a command that does not rather than leaving it
 * to whatever the person reaches for first.
 */
function howToWriteEnv(names, platform) {
  const line = names.map((name) => name + '=yourpassword').join('\\n');
  if ((platform || process.platform) === 'win32') {
    return [
      '  In PowerShell, this writes it without a byte order mark:',
      '    [IO.File]::WriteAllText("$PWD\\.env", "' + line + '`n")',
      '',
      '  Avoid Out-File and Notepad here: both add a mark that makes the first',
      '  line unreadable, and the password would silently come out blank.',
    ];
  }
  return ['  For example:', "    printf '" + line.replace(/\\n/g, "\\n") + "\\n' > .env"];
}

/** What to tell somebody who has not created the file yet. */
function missingSecretLines(specName, names, options) {
  const opts = options || {};
  const many = names.length > 1;
  const lines = [
    '  Skipped ' + specName,
    '  This recording needs a password' + (many ? ' and other secrets' : '') + ', and there is none set.',
    '',
  ];
  if (opts.examplePath) {
    lines.push('  There is a ' + opts.examplePath + ' here already. Put the real value in it');
    lines.push('  and save it as .env, in the same folder.');
  } else {
    lines.push('  Create a .env file in this folder containing:');
    for (const name of names) lines.push('    ' + name + '=yourpassword');
  }
  lines.push('');
  for (const line of howToWriteEnv(names, opts.platform)) lines.push(line);
  lines.push('');
  lines.push('  Without it the recording would sign in with a blank password and');
  lines.push('  fail for a reason that has nothing to do with your app, so it was');
  lines.push('  not run. Keep .env out of version control.');
  return lines;
}

/**
 * Writes .env.example so nobody has to get the encoding right by hand.
 *
 * Plain UTF-8, no byte order mark. Never overwrites: the file may already hold
 * names from an earlier recording, and clobbering it would lose them.
 */
function writeEnvExample(dir, names) {
  const file = path.join(dir, '.env.example');
  if (fs.existsSync(file)) return null;
  const body = (names || []).map((name) => name + '=yourpassword').join('\n') + '\n';
  try {
    fs.writeFileSync(file, body, { encoding: 'utf8' });
    return file;
  } catch (e) {
    return null; // a convenience, never a reason to fail a recording
  }
}

// Everything kryptheon leaves in a project that should not be committed: the
// real password, and three files that are machine state rather than source.
const GITIGNORE_ENTRIES = ['.env', 'kryptheon-baselines.json', 'kryptheon-history.jsonl', 'test-results/'];

/**
 * Adds the missing entries to an existing .gitignore. Returns what it added.
 *
 * Only touches a file that is already there - creating one in a project that
 * has deliberately gone without is not this tool's decision to make.
 */
function updateGitignore(dir, entries) {
  const file = path.join(dir, '.gitignore');
  let raw;
  try {
    raw = fs.readFileSync(file, { encoding: 'utf8' });
  } catch (e) {
    return [];
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const present = new Set(
    raw
      .split('\n')
      .map((line) => line.trim().replace(/^\/+/, '').replace(/\/+$/, ''))
      .filter(Boolean),
  );
  const wanted = entries || GITIGNORE_ENTRIES;
  const missing = wanted.filter((entry) => !present.has(entry.replace(/\/+$/, '')));
  if (!missing.length) return [];
  const needsNewline = raw.length && !raw.endsWith('\n');
  const block = (needsNewline ? '\n' : '') + '\n# kryptheon\n' + missing.join('\n') + '\n';
  try {
    fs.appendFileSync(file, block, { encoding: 'utf8' });
    return missing;
  } catch (e) {
    return [];
  }
}

module.exports = {
  requiredSecrets: requiredSecrets,
  readEnvFile: readEnvFile,
  missingSecrets: missingSecrets,
  missingSecretLines: missingSecretLines,
  howToWriteEnv: howToWriteEnv,
  writeEnvExample: writeEnvExample,
  updateGitignore: updateGitignore,
  GITIGNORE_ENTRIES: GITIGNORE_ENTRIES,
  isSet: isSet,
  envFileFor: (dir) => path.join(dir, '.env'),
};
