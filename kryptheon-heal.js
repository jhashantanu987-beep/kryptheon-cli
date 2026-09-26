// A button that was renamed has not broken the flow.
//
// Found on a real Lovable app: "Reserve a table" became "Reserve here", the
// replay stopped at the first step that clicked it, and the report said the
// flow was broken. It was not - the same button was in the same place, and
// everything after it (the form, the email check, the date check, the
// confirmation) was never looked at. One rename hid the whole flow, and the
// person had to go and prove that themselves.
//
// So when a step cannot find its element by the recorded name, this asks what
// changed on the page since the flow last passed. The rule is deliberately
// narrow: exactly one name of that kind is gone, it is the one the step
// wanted, and exactly one new name of the same role has appeared in its
// place. Then the step uses the new one and the report says so. Anything
// looser - two new buttons, the old name still somewhere, a page that has
// not finished drawing - is not a rename this can prove, and the step fails
// exactly as it did before, with the same message.
//
// What the page looked like before comes from two places. Every step that
// finds its element by name notes the names of its role on the page at that
// moment, and the baseline keeps them from the last passing run. A project
// recorded before this existed has none of those yet, and falls back to the
// buttons, links and fields the baseline saw on the flow's last page - which
// only proves a rename when the step's page and the last page are the same.
//
// Only page.getByRole with a plain string name is watched: that is what
// codegen writes for nearly every click and fill. Assertions are never
// redirected. A check someone added on purpose says what they expect to see,
// and quietly checking something else instead would make it a lie.

// How long a step waits for its element by the recorded name before asking
// whether it was renamed. A step whose element is merely slow is not
// affected: when the page does not prove a rename, the step carries on
// waiting exactly as it always did.
const PROBE_MS = 5000;

const ACTIONS = [
  'click', 'dblclick', 'tap', 'hover', 'focus',
  'fill', 'clear', 'press', 'pressSequentially', 'type',
  'check', 'uncheck', 'setChecked', 'selectOption', 'setInputFiles',
];

// The same groups the baseline signature uses: its "actions" are buttons and
// links, its "fields" are form controls.
const ACTION_ROLES = new Set(['button', 'link']);
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'checkbox', 'radio', 'slider', 'switch']);

function norm(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Names on the page by role, read from Playwright's accessibility snapshot -
 * the same names getByRole matches against, so nothing is guessed.
 *
 *   - button "Reserve here"
 *   - link "Story":
 *   - textbox "Email" [disabled]
 */
function namesByRole(snapshot) {
  const out = new Map();
  for (const line of String(snapshot || '').split('\n')) {
    const m = line.match(/^\s*- ([a-z]+) "((?:[^"\\]|\\.)*)"/);
    if (!m) continue;
    let name;
    try {
      name = JSON.parse('"' + m[2] + '"');
    } catch (e) {
      continue;
    }
    if (!name) continue;
    if (!out.has(m[1])) out.set(m[1], []);
    out.get(m[1]).push(name);
  }
  return out;
}

/**
 * The whole decision, with nothing but names in and out.
 *
 * `wanted` is the name the step was recorded with, `before` and `now` the
 * names of that kind on the page then and now, and `candidates` the names
 * now on the page with the step's own role. Returns the new name, or null
 * when the page does not prove a rename.
 */
function decideRename(wanted, before, now, candidates) {
  const target = norm(wanted);
  if (!target || !Array.isArray(before) || !before.length) return null;
  const nowSet = new Set((now || []).map(norm));
  const beforeSet = new Set(before.map(norm));

  const gone = [...beforeSet].filter((n) => !nowSet.has(n));
  const added = [...nowSet].filter((n) => !beforeSet.has(n));
  if (gone.length !== 1 || added.length !== 1) return null;
  // getByRole matches a name that contains the recorded one, so the name
  // that went is the step's own only if it contains what was recorded.
  if (!gone[0].includes(target)) return null;

  // Of the step's own role. A button renamed while the recorded link went
  // missing is two changes, not one rename.
  return (candidates || []).find((c) => norm(c) === added[0]) || null;
}

/**
 * Watches one test's page. `memory` is what the last passing run noted per
 * step, `fallback` the last page's signature; either may be missing.
 */
function watch(page, options) {
  const opts = options || {};
  const memory = opts.memory && typeof opts.memory === 'object' ? opts.memory : null;
  const fallback = opts.fallback && typeof opts.fallback === 'object' ? opts.fallback : null;
  const probeMs = opts.probeMs || PROBE_MS;

  const learned = {};
  const renamed = [];
  let counter = 0;

  const byRole = page.getByRole.bind(page);

  async function readRoles() {
    try {
      return namesByRole(await page.locator('body').ariaSnapshot({ timeout: 3000 }));
    } catch (e) {
      return null; // a page that cannot be read proves nothing
    }
  }

  async function findRename(key, role, name) {
    const roles = await readRoles();
    if (!roles) return null;
    const ofRole = roles.get(role) || [];
    if (memory && Array.isArray(memory[key])) {
      return decideRename(name, memory[key], ofRole, ofRole);
    }
    if (!fallback) return null;
    const kind = ACTION_ROLES.has(role) ? 'actions' : FIELD_ROLES.has(role) ? 'fields' : null;
    if (!kind || !Array.isArray(fallback[kind])) return null;
    const group = kind === 'actions' ? ACTION_ROLES : FIELD_ROLES;
    const now = [];
    for (const [r, names] of roles) if (group.has(r)) now.push(...names);
    return decideRename(name, fallback[kind], now, ofRole);
  }

  async function act(locator, real, method, args, role, name) {
    const key = counter++ + ' ' + role + ' ' + name;
    const there = await locator
      .first()
      .waitFor({ state: 'attached', timeout: probeMs })
      .then(() => true, () => false);
    if (there) {
      const roles = await readRoles();
      if (roles) learned[key] = roles.get(role) || [];
      return real.apply(locator, args);
    }

    const newName = await findRename(key, role, name);
    if (newName) {
      const replacement = byRole(role, { name: newName, exact: true });
      const count = await replacement.count().catch(() => 0);
      if (count === 1) {
        renamed.push({ role: role, was: name, now: newName });
        return replacement[method].apply(replacement, args);
      }
    }
    // Not a rename this can prove: the step fails the way it always did.
    return real.apply(locator, args);
  }

  page.getByRole = function (role, roleOptions) {
    const locator = byRole(role, roleOptions);
    const name = roleOptions && typeof roleOptions.name === 'string' ? roleOptions.name : null;
    if (!name) return locator;
    for (const method of ACTIONS) {
      const real = locator[method];
      if (typeof real !== 'function') continue;
      locator[method] = function () {
        return act(locator, real, method, Array.prototype.slice.call(arguments), role, name);
      };
    }
    return locator;
  };

  return {
    learned: learned,
    renamed: renamed,
  };
}

/**
 * What to keep for next time: the steps this run found by their recorded
 * name, over whatever was kept before. A step that had to follow a rename
 * keeps its old note - that note is what lets the next run prove the same
 * rename again.
 */
function mergeMemory(previous, learned) {
  const out = {};
  if (previous && typeof previous === 'object') Object.assign(out, previous);
  if (learned && typeof learned === 'object') Object.assign(out, learned);
  return out;
}

/** The report line, shared by the terminal and the history. */
function describeRename(entry) {
  const what = entry.role === 'link' ? 'link' : entry.role === 'button' ? 'button' : entry.role;
  return 'The ' + what + ' "' + entry.was + '" is now called "' + entry.now + '" - I used "' + entry.now + '" and carried on.';
}

module.exports = {
  PROBE_MS: PROBE_MS,
  namesByRole: namesByRole,
  decideRename: decideRename,
  watch: watch,
  mergeMemory: mergeMemory,
  describeRename: describeRename,
};
