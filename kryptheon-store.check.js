// Checks kryptheon-store.js: every record lands outside the project, in the
// right project's folder, and what an older version left behind is moved once
// without losing a line of it.
//
// Every case runs against real folders on disk, with KRYPTHEON_HOME pointed at
// a scratch folder so this never touches the real ~/.kryptheon.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE = path.join(__dirname, 'kryptheon-store.js');

// A fresh copy each time, so no case can lean on module state left by another.
function fresh() {
  delete require.cache[require.resolve(MODULE)];
  return require(MODULE);
}

let failures = 0;
function expect(what, ok, detail) {
  if (ok) {
    console.log('  ok    ' + what);
  } else {
    failures++;
    console.log('  FAIL  ' + what + (detail ? '\n        ' + detail : ''));
  }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kryptheon-store-check-'));
const HOME = path.join(scratch, 'home');
const env = { KRYPTHEON_HOME: HOME };

function project(name, files) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'flow.spec.js'), '// a recording\n', 'utf8');
  for (const rel of Object.keys(files || {})) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, files[rel], 'utf8');
  }
  return dir;
}

const read = (file) => fs.readFileSync(file, 'utf8');
const has = (file) => fs.existsSync(file);

try {
  console.log('');
  console.log('Project ids');
  {
    const store = fresh();
    // Fixed answers. kryptheon-night's store.check.js holds the same four, so
    // the two packages put the same project in the same folder.
    const win = store.projectId('C:\\Users\\asha\\OneDrive\\Desktop\\kt-test', 'win32');
    const posix = store.projectId('/home/asha/code/My Shop', 'linux');
    expect('a Windows project gets its fixed id', win === 'kt-test-825e82abd404', win);
    expect('a Linux project gets its fixed id', posix === 'my-shop-bcc5d191f563', posix);
    expect(
      'on Windows, a different case of the same path is the same project',
      store.projectId('c:\\users\\ASHA\\onedrive\\desktop\\KT-TEST', 'win32') === win,
    );
    expect(
      'a trailing separator does not make a second project',
      store.projectId('C:\\Users\\asha\\OneDrive\\Desktop\\kt-test\\', 'win32') === win,
    );
    expect(
      'on Linux, case is part of the path',
      store.projectId('/home/asha/code/my shop', 'linux') !== posix,
    );
    expect(
      'two folders with the same name in different places are two projects',
      store.projectId('C:\\work\\kt-test', 'win32') !== win,
    );
  }

  console.log('');
  console.log('Where the store is');
  {
    const store = fresh();
    expect('KRYPTHEON_HOME is used when set', store.home(env) === path.resolve(HOME));
    expect(
      'otherwise it is .kryptheon in the home folder',
      store.home({}) === path.join(os.homedir(), '.kryptheon'),
    );
    expect(
      'the store is under projects/, never inside the project',
      store.dirFor(scratch, env).startsWith(path.join(path.resolve(HOME), 'projects') + path.sep),
    );
    // The fixture and the reporter ask for paths just by being loaded, and the
    // checks load them from inside a project. Asking must never move anything.
    const untouched = project('only-asking', { 'kryptheon-baselines.json': '{}' });
    const p = store.pathsFor(untouched, env);
    expect('asking for the paths creates no store', !has(p.dir));
    expect('and moves nothing out of the project', has(path.join(untouched, 'kryptheon-baselines.json')));
    expect('pathsFor names the same files open() uses', p.baselines === path.join(store.dirFor(untouched, env), 'baselines.json'));
  }

  console.log('');
  console.log('An older project moves out once');
  const legacy = {
    'kryptheon-baselines.json': '{"tests/flow.spec.js :: Flow":{"url":"/done"}}\n',
    'kryptheon-history.jsonl': '{"runAt":"2026-09-01T10:00:00.000Z","passed":1}\n{"runAt":"2026-09-02T10:00:00.000Z","passed":1}\n',
    '.kryptheon-last.json': '{"findings":[]}',
    'test-results/.last-run.json': '{"status":"failed"}',
    'test-results/flow-Flow/test-failed-1.png': 'PNG',
  };
  const old = project('landing-page', legacy);
  {
    const store = fresh();
    const s = store.open(old, { env: env });
    expect('the store folder is created', has(s.dir));
    expect('it is not inside the project', path.relative(old, s.dir).startsWith('..'), path.relative(old, s.dir));
    expect('baselines moved, word for word', has(s.baselines) && read(s.baselines) === legacy['kryptheon-baselines.json']);
    expect('history moved, word for word', has(s.history) && read(s.history) === legacy['kryptheon-history.jsonl']);
    expect('the database check\'s last run moved', has(s.nightLast) && read(s.nightLast) === legacy['.kryptheon-last.json']);
    expect(
      'test-results moved with what was inside',
      has(path.join(s.testResults, 'flow-Flow', 'test-failed-1.png')) && has(path.join(s.testResults, '.last-run.json')),
    );
    const left = fs.readdirSync(old).sort();
    expect('only tests/ is left in the project', left.length === 1 && left[0] === 'tests', left.join(', '));
    expect('the recording itself was not touched', read(path.join(old, 'tests', 'flow.spec.js')) === '// a recording\n');
    const owner = JSON.parse(read(s.project));
    expect('project.json names the folder it belongs to', owner.root === store.canonicalRoot(old), owner.root);
    expect('four records reported as moved', s.migration.moved.length === 4, JSON.stringify(s.migration));
    const lines = store.migrationLines(s).join('\n');
    expect('the person is told what moved and where', lines.indexOf('kryptheon-baselines.json') !== -1 && lines.indexOf(s.dir) !== -1, lines);

    const again = fresh().open(old, { env: env });
    expect('the second time, nothing is moved', !again.migration.moved.length && !again.migration.parked.length && !again.migration.appended.length);
    expect('and nothing is said', fresh().migrationLines(again).length === 0);
    expect('the same project opens the same store', again.dir === s.dir);
  }

  console.log('');
  console.log('When the project and the store both have a record');
  {
    const store = fresh();
    const s = store.open(old, { env: env });
    // An older copy of kryptheon ran in this folder after the move.
    fs.writeFileSync(path.join(old, 'kryptheon-baselines.json'), '{"older":"copy"}\n', 'utf8');
    fs.writeFileSync(
      path.join(old, 'kryptheon-history.jsonl'),
      '{"runAt":"2026-09-02T10:00:00.000Z","passed":1}\n{"runAt":"2026-09-03T10:00:00.000Z","passed":0}\n',
      'utf8',
    );
    const before = read(s.baselines);
    const t = fresh().open(old, { env: env });
    expect('the store\'s baselines are not overwritten', read(t.baselines) === before);
    const parked = t.migration.parked.find((p) => p.name === 'kryptheon-baselines.json');
    expect('the project\'s copy is kept, in parked/', parked && read(parked.to) === '{"older":"copy"}\n', JSON.stringify(t.migration));
    const history = read(t.history).split('\n').filter(Boolean);
    expect('history gains only the run it did not have', history.length === 3, history.join(' | '));
    expect('no run is written down twice', new Set(history).size === history.length);
    expect('both are gone from the project', !has(path.join(old, 'kryptheon-baselines.json')) && !has(path.join(old, 'kryptheon-history.jsonl')));
  }

  console.log('');
  console.log('A project with its own Playwright');
  {
    const own = project('own-playwright', {
      'playwright.config.ts': 'export default {}\n',
      'test-results/theirs.png': 'PNG',
      'kryptheon-history.jsonl': '{"runAt":"x"}\n',
    });
    const s = fresh().open(own, { env: env });
    expect('its test-results/ stays where it is', has(path.join(own, 'test-results', 'theirs.png')));
    expect('and is not copied into the store either', !has(path.join(s.testResults, 'theirs.png')));
    expect('the person is told why', fresh().migrationLines(s).join(' ').indexOf('own Playwright config') !== -1);
    expect('its history still moves', has(s.history) && !has(path.join(own, 'kryptheon-history.jsonl')));
  }

  console.log('');
  console.log('Projects are never mixed');
  {
    const a = project(path.join('one', 'shop'), { 'kryptheon-baselines.json': '{"a":1}' });
    const b = project(path.join('two', 'shop'), { 'kryptheon-baselines.json': '{"b":2}' });
    const sa = fresh().open(a, { env: env });
    const sb = fresh().open(b, { env: env });
    expect('two folders called shop get two stores', sa.dir !== sb.dir);
    expect('each keeps its own baselines', read(sa.baselines) === '{"a":1}' && read(sb.baselines) === '{"b":2}');

    // Two paths whose short hashes collide cannot be found on purpose, so the
    // store is made to look taken: its project.json names another folder.
    const c = project(path.join('three', 'shop'), { 'kryptheon-baselines.json': '{"c":3}' });
    const taken = fresh().dirFor(c, env);
    fs.mkdirSync(taken, { recursive: true });
    fs.writeFileSync(path.join(taken, 'project.json'), JSON.stringify({ root: path.join(scratch, 'someone-else') }), 'utf8');
    const sc = fresh().open(c, { env: env });
    expect('a store that belongs to another folder is never used', sc.dir !== taken && !has(path.join(taken, 'baselines.json')), sc.dir);
    expect('the project gets a store of its own instead', read(sc.baselines) === '{"c":3}' && JSON.parse(read(sc.project)).root === fresh().canonicalRoot(c));
  }

  console.log('');
  console.log('A store that cannot be made');
  {
    const blocker = path.join(scratch, 'not-a-folder');
    fs.writeFileSync(blocker, 'a file where the store would go', 'utf8');
    let threw = null;
    try {
      fresh().open(project('blocked', {}), { env: { KRYPTHEON_HOME: path.join(blocker, 'inside') } });
    } catch (err) {
      threw = err;
    }
    expect('open() fails loudly rather than quietly keeping nothing', !!threw);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.log(failures + ' failed.');
  process.exit(1);
}
console.log('All store checks passed.');
