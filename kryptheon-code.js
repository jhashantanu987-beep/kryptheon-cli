// Reads a project's frontend code for one kind of mistake: text that may come
// from outside the page - a server response, an error message, a value a user
// typed - being handed to something that turns text into HTML.
//
//   element.innerHTML = `<p>${data.name}</p>`
//
// If data.name holds "<img src=x onerror=...>", the browser runs it in the
// page, with the page's session. Written as textContent, or escaped first, the
// same value is just text.
//
// This is code analysis, never execution: nothing is run, nothing is sent, and
// every finding is "verification required". A static read cannot see what a
// value holds at run time, so it says where the risk is and how sure it is,
// and leaves the verdict to a person or a later runtime check.
//
// Deliberately narrow, because a report that flags every innerHTML in an app
// is a report nobody reads twice:
//   - a sink fed only literal text is safe and never reported;
//   - a value wrapped in an escaping or sanitising call is safe;
//   - a value that can only be a number is safe;
//   - everything else is reported, and ranked by where it came from.
//
// The parser is the one Playwright already ships, so this adds no dependency.
// It is an internal file of Playwright's, not a public API; if a later
// Playwright moves it, this says it could not run - it never says "passed".

const fs = require('fs');
const path = require('path');
const keys = require('./kryptheon-keys.js');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  'coverage', 'vendor', '.vercel', '.netlify', '.turbo', '.cache', 'tests', 'test-results',
]);
const CODE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx)$/i;
const PAGE_EXT = /\.(html|htm|vue|svelte)$/i;
const MAX_BYTES = 800 * 1024;

// A call whose name says it makes text safe for HTML. Matched on the called
// name only - escapeHtml(x), DOMPurify.sanitize(x), he.encode(x).
const MAKES_SAFE = /^(escape\w*|\w*escape|sanitize\w*|sanitise\w*|\w*sanitize|purify|encode\w*|\w*encode|htmlEncode|safeHtml|clean(Html)?|textToHtml)$/i;

// Calls and properties whose result can only be a number, a boolean, or a
// formatted number/date - nothing that can carry a tag.
const NUMERIC_CALLS = /^(Number|parseInt|parseFloat|Boolean|isNaN|isFinite|toFixed|toPrecision|toLocaleString|toLocaleDateString|toLocaleTimeString|getTime|getFullYear|getMonth|getDate|getDay|getHours|getMinutes|getSeconds|round|floor|ceil|abs|min|max|indexOf|findIndex|size)$/;
const NUMERIC_PROPS = /^(length|size|count|total|id|index|width|height|top|left|x|y)$/;

/** Every file worth reading, relative paths, skipping what is not the app's source. */
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
      if (entry.name.startsWith('.') && entry.name !== '.') {
        if (entry.isDirectory()) continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if ((CODE_EXT.test(entry.name) || PAGE_EXT.test(entry.name)) && !/\.min\.js$/i.test(entry.name)) {
        out.push(full);
      }
    }
  })(root);
  return out.sort();
}

/** The parser, or null when this Playwright does not have it where expected. */
function loadParser(packageDir) {
  const candidates = [];
  try {
    candidates.push(path.join(path.dirname(require.resolve('playwright/package.json', { paths: [packageDir] })), 'lib', 'transform', 'babelBundle.js'));
  } catch (err) {
    /* not resolvable from here */
  }
  candidates.push(path.join(packageDir, 'node_modules', 'playwright', 'lib', 'transform', 'babelBundle.js'));
  for (const file of candidates) {
    try {
      const bundle = require(file);
      if (typeof bundle.babelParse === 'function' && typeof bundle.traverse === 'function') return bundle;
    } catch (err) {
      /* try the next */
    }
  }
  return null;
}

/** Inline <script> blocks of a page, with the line each one starts on. */
function scriptsIn(source) {
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(source))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (/type\s*=\s*["']?(application\/(ld\+)?json|text\/template|importmap)/i.test(attrs)) continue;
    const before = source.slice(0, m.index + m[0].indexOf('>') + 1);
    blocks.push({ code: m[2], line: before.split('\n').length });
  }
  return blocks;
}

/** v-html="..." in a template: always a sink, safe only when the value is quoted text. */
function vHtmlIn(source) {
  const found = [];
  const re = /\bv-html\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(source))) {
    const value = m[1].trim();
    if (/^'[^']*'$/.test(value)) continue;
    found.push({ line: source.slice(0, m.index).split('\n').length, expression: value });
  }
  return found;
}

function calleeName(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed && node.property) return node.property.name || '';
  return '';
}

/**
 * Where a value comes from, as far as the code shows.
 *   'safe'    - literal text, a number, or made safe by an escaping call
 *   'network' - read from a response body (.json()), so a server wrote it
 *   'error'   - an error's message, which often carries text a server sent
 *   'unknown' - anything else: it may be fine, the code alone cannot say
 */
// How far one value is followed back before giving up and calling it unknown.
// It only exists to stop a loop - a function that returns itself, a name that
// feeds another. It was 6, which a constant-only lookup (a template, a call,
// its return, a map of maps) used up before reaching the strings at the
// bottom, so a harmless label came back "unknown". Giving up always errs
// towards reporting, never towards silence.
const MAX_DEPTH = 12;

function classify(node, scope, code, depth, aliases) {
  if (!node || depth > MAX_DEPTH) return 'unknown';
  const again = (n) => classify(n, scope, code, depth + 1, aliases);
  switch (node.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
      return 'safe';
    case 'TemplateLiteral':
      return worst(judgedParts(node, scope, code).map((e) => again(e)));
    case 'BinaryExpression':
      if (node.operator !== '+') return 'safe'; // - * / % comparisons: never text
      return worst(judgedParts(node, scope, code).map((e) => again(e)));
    case 'UnaryExpression':
    case 'UpdateExpression':
      return 'safe';
    case 'ConditionalExpression':
      return worst([again(node.consequent), again(node.alternate)]);
    case 'LogicalExpression':
      return worst([again(node.left), again(node.right)]);
    case 'CallExpression':
    case 'OptionalCallExpression': {
      const name = calleeName(node.callee);
      if (MAKES_SAFE.test(name)) return 'safe';
      if (readsResponseBody(node)) return 'network';
      if (NUMERIC_CALLS.test(name)) return 'safe';
      if (node.callee.type === 'MemberExpression' && node.callee.object && node.callee.object.name === 'Math') return 'safe';
      // items.map(i => `<li>${i.name}</li>`).join('') - judge what map builds.
      const mapped = mapCallback(node, scope, code, depth, aliases);
      if (mapped) {
        return mapped.returns.length
          ? worst(mapped.returns.map((r) => classify(r.node, r.scope, code, depth + 1, mapped.inner)))
          : 'unknown';
      }
      // An escaping helper of this file's own, known by what it does. Inside a
      // template, one that leaves quotes alone does not protect a value that
      // lands in an attribute - the template judges that case itself.
      if (escaperOf(node, scope, code)) return 'safe';
      // A function of this file's own: as dangerous as what it returns. One
      // that only ever returns constants - a lookup of labels, icons and
      // colours - cannot carry anything in; one that returns a parameter
      // stays unknown, because its parameters are.
      const local = node.callee.type === 'Identifier' ? localFunction(node.callee.name, scope) : null;
      if (local) {
        const returns = returnsOf(local);
        if (returns.length) return worst(returns.map((r) => classify(r.node, r.scope, code, depth + 1, aliases)));
      }
      // String methods pass through whatever they were called on, and so do
      // the array methods that only pick or reorder items: notes.filter(...)
      // holds the same notes.
      if (/^(trim|toUpperCase|toLowerCase|slice|substring|substr|replace|replaceAll|padStart|padEnd|concat|toString|join|filter|sort|reverse|flat|toSorted|toReversed)$/.test(name) &&
          node.callee.type === 'MemberExpression') {
        return again(node.callee.object);
      }
      return 'unknown';
    }
    case 'ObjectExpression':
      // Only as dangerous as what is in it. A spread brings in whatever it spreads.
      return worst(node.properties.map((p) => (p.type === 'SpreadElement' ? again(p.argument) : p.value && again(p.value))));
    case 'ArrayExpression':
      return worst(node.elements.map((e) => (e ? again(e.type === 'SpreadElement' ? e.argument : e) : 'safe')));
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      const prop = node.property && !node.computed ? node.property.name : '';
      // The page's own markup, read back: button.innerHTML saved and put back
      // adds nothing that was not already there. textContent is not this - it
      // is text, and a "<" in it becomes a tag when written as HTML.
      if (prop === 'innerHTML' || prop === 'outerHTML') return 'safe';
      if (NUMERIC_PROPS.test(prop || '')) return 'safe';
      if (prop === 'message' && isCatchParam(node.object, scope)) return 'error';
      // labels().title - a property of what a call returns is judged by the
      // call; (await res.json()).name by the body it was read from.
      let base = node.object;
      while (base && /MemberExpression$/.test(base.type)) base = base.object;
      if (base && (/CallExpression$/.test(base.type) || base.type === 'AwaitExpression')) return again(base);
      return fromBinding(rootIdentifier(node), scope, code, depth, aliases);
    }
    case 'Identifier':
      return fromBinding(node, scope, code, depth, aliases);
    case 'AwaitExpression':
      return again(node.argument);
    default:
      return 'unknown';
  }
}

const RANK = { safe: 0, unknown: 1, error: 2, network: 3 };
function worst(list) {
  return (list || []).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'safe');
}

function returnedBy(fn) {
  if (!fn || !/Function/.test(fn.type)) return null;
  if (fn.body.type !== 'BlockStatement') return fn.body;
  const ret = fn.body.body.find((s) => s.type === 'ReturnStatement');
  return ret ? ret.argument : null;
}

/** The path of a function this file declares under `name`, or null. */
function localFunction(name, scope) {
  const binding = scope && scope.getBinding(name);
  if (!binding || !binding.path) return null;
  const p = binding.path;
  if (p.node.type === 'FunctionDeclaration') return p;
  if (p.node.type === 'VariableDeclarator' && p.node.init && /Function/.test(p.node.init.type) &&
      !(binding.constantViolations && binding.constantViolations.length)) {
    return p.get('init');
  }
  return null;
}

/** Every value a function returns, with the scope to judge it in; nested functions excluded. */
function returnsOf(fnPath) {
  if (fnPath.node.body.type !== 'BlockStatement') return [{ node: fnPath.node.body, scope: fnPath.scope }];
  const found = [];
  fnPath.traverse({
    Function(p) {
      p.skip();
    },
    ReturnStatement(p) {
      if (p.node.argument) found.push({ node: p.node.argument, scope: p.scope });
    },
  });
  return found;
}

// Every function in the piece being read, by node, so a callback handed to
// map() can be judged in its own scope - where its own `const color = ...`
// lives - instead of the caller's, where that name means nothing.
let FN_PATHS = new WeakMap();

/**
 * list.map(cb).join(''): the callback's returns, each with its own scope, and
 * what the callback's names stand for - the item is whatever the list holds,
 * the index is a number. Null when node is not that shape.
 */
function mapCallback(node, scope, code, depth, aliases) {
  if (calleeName(node.callee) !== 'join' || !node.callee.object || !/CallExpression$/.test(node.callee.object.type) ||
      calleeName(node.callee.object.callee) !== 'map') {
    return null;
  }
  const mapCall = node.callee.object;
  const fn = mapCall.arguments[0];
  const listOrigin = classify(mapCall.callee.object, scope, code, depth + 1, aliases);
  const inner = Object.assign({}, aliases || {});
  const params = (fn && fn.params) || [];
  if (params[0] && params[0].type === 'Identifier') inner[params[0].name] = listOrigin;
  if (params[1] && params[1].type === 'Identifier') inner[params[1].name] = 'safe';
  const fnPath = fn && FN_PATHS.get(fn);
  const returns = fnPath
    ? returnsOf(fnPath)
    : (returnedBy(fn) ? [{ node: returnedBy(fn), scope: scope }] : []);
  return { returns: returns, inner: inner };
}

/**
 * Whether a call escapes HTML - by name for the well-known ones, and for a
 * helper of this file's own, by what it does: every return is a replace()
 * chain, its patterns cover & < and >, and it writes &amp; &lt; &gt;. The
 * name decides nothing - `esc` and `clean3` count, and an "escape" that only
 * handles "<", or escapes and then returns the original, does not.
 * Returns { dq, sq }: whether " and ' are escaped too. Null when it does not escape.
 */
function escaperOf(call, scope, code) {
  if (!call || !/CallExpression$/.test(call.type)) return null;
  const name = calleeName(call.callee);
  if (MAKES_SAFE.test(name)) return { dq: true, sq: true };
  if (call.callee.type !== 'Identifier') return null;
  const fnPath = localFunction(call.callee.name, scope);
  if (!fnPath) return null;
  const returns = returnsOf(fnPath);
  if (!returns.length || !returns.every((r) => /CallExpression$/.test(r.node.type) &&
      /^(replace|replaceAll)$/.test(calleeName(r.node.callee)))) {
    return null;
  }
  let patterns = '';
  const written = [];
  fnPath.traverse({
    RegExpLiteral(p) {
      patterns += p.node.pattern;
    },
    StringLiteral(p) {
      written.push(p.node.value);
      const parent = p.parent;
      if (parent && /CallExpression$/.test(parent.type) && parent.arguments[0] === p.node &&
          /^(replace|replaceAll)$/.test(calleeName(parent.callee))) {
        patterns += p.node.value;
      }
    },
  });
  const writes = (entity) => written.some((s) => s.indexOf(entity) !== -1);
  if (!/&/.test(patterns) || !/</.test(patterns) || !/>/.test(patterns)) return null;
  if (!writes('&amp;') || !writes('&lt;') || !writes('&gt;')) return null;
  return {
    dq: /"/.test(patterns) && (writes('&quot;') || writes('&#34;') || writes('&#x22;')),
    sq: /'/.test(patterns) && (writes('&#39;') || writes('&#x27;') || writes('&apos;')),
  };
}

/**
 * The quote an HTML attribute value is open in at the end of this text: '"',
 * "'", 'bare' for an unquoted one, '' when the text is not inside a tag at all.
 * Only inside a tag - after a "<" that no ">" has closed - is an "=" an
 * attribute; the "=" of "/go?next=" in a URL string is not one.
 */
function openAttribute(text) {
  const lt = text.lastIndexOf('<');
  if (lt === -1 || text.lastIndexOf('>') > lt) return '';
  const tag = text.slice(lt);
  const quoted = /=\s*(["'])[^"']*$/.exec(tag);
  if (quoted) return quoted[1];
  return /\s[^\s"'<>\/=]+\s*=\s*$/.test(tag) ? 'bare' : '';
}

/**
 * The pieces of a template or a + concatenation to judge one by one. An
 * escaped value is judged as its escaped input when the escaping is not
 * enough for where it lands: inside a "..." attribute that needs " escaped,
 * inside '...' that needs ' escaped, and an unquoted attribute is broken by a
 * space no escaper touches.
 */
function judgedParts(node, scope, code) {
  const pairs = [];
  if (node.type === 'TemplateLiteral') {
    // Everything written before this value, so an attribute opened in an
    // earlier piece - `<a title="${a}" href="${b}"` - is still seen as open.
    let before = '';
    node.expressions.forEach((e, i) => {
      before += node.quasis[i].value.raw;
      pairs.push({ before: before, value: e });
      before += 'x';
    });
  } else {
    const text = (n) => (n.type === 'StringLiteral' ? n.value
      : n.type === 'TemplateLiteral' ? n.quasis[n.quasis.length - 1].value.raw : '');
    pairs.push({ before: '', value: node.left });
    pairs.push({ before: text(node.left), value: node.right });
  }
  return pairs.map(({ before, value }) => {
    const esc = escaperOf(value, scope, code);
    if (!esc) return value;
    const quote = openAttribute(before);
    const enough = quote === '' || (quote === '"' && esc.dq) || (quote === "'" && esc.sq);
    return enough ? { type: 'StringLiteral' } : (value.arguments[0] || value);
  });
}

/**
 * Which parts of a value make it unsafe, in the words of the code - so a fix
 * prompt can say "only ${log.caller_number}" instead of quoting sixty lines of
 * template and leaving the reader to find it. At most five, never repeated.
 */
function riskyParts(node, scope, code, aliases, out, depth) {
  if (!node || out.length >= 5 || depth > MAX_DEPTH) return;
  const origin = classify(node, scope, code, 0, aliases);
  if (origin === 'safe') return;
  const go = (n, s, a) => riskyParts(n, s || scope, code, a || aliases, out, depth + 1);
  if (node.type === 'TemplateLiteral' || (node.type === 'BinaryExpression' && node.operator === '+')) {
    judgedParts(node, scope, code).forEach((p) => go(p));
    return;
  }
  if (node.type === 'ConditionalExpression') { go(node.consequent); go(node.alternate); return; }
  if (node.type === 'LogicalExpression') { go(node.left); go(node.right); return; }
  if (/CallExpression$/.test(node.type)) {
    const mapped = mapCallback(node, scope, code, depth, aliases);
    if (mapped && mapped.returns.length) {
      mapped.returns.forEach((r) => go(r.node, r.scope, mapped.inner));
      return;
    }
  }
  const text = code.slice(node.start, node.end).replace(/\s+/g, ' ').slice(0, 80);
  if (!out.some((p) => p.text === text)) out.push({ text: text, origin: origin, line: node.loc ? node.loc.start.line : null });
}

function rootIdentifier(node) {
  let n = node;
  while (n && /MemberExpression$/.test(n.type)) n = n.object;
  return n && n.type === 'Identifier' ? n : null;
}

function isCatchParam(node, scope) {
  const id = rootIdentifier(node) || (node && node.type === 'Identifier' ? node : null);
  if (!id || !scope) return false;
  const binding = scope.getBinding(id.name);
  return !!(binding && binding.path && binding.path.type === 'CatchClause');
}

// Bindings whose values are being followed right now, so a variable assigned
// from itself (count = count + 1) is not followed round in a circle.
const RESOLVING = new Set();

// The project being read, for a value imported from another of its files:
// where each file's names lead, and which of them anything ever writes to.
// Set by scanProject for the length of one read, like FN_PATHS.
let IMPORTS = null;
// Which file each parsed program is, so an import is resolved from the file
// that wrote it - which, once a helper in another folder is being judged, is
// not the file the sink is in.
let PROGRAM_FILE = new WeakMap();

/**
 * Fixed data another file of the project exports - `export const demo = {...}`
 * of nothing but literals - is as safe as those literals, and only while no
 * file writes to it. Found on a blind test (LaunchRail): mock-data.js exported
 * the demo workspace, ui.js rendered it through a shell() helper, and the
 * import was read as unknown - so a safe page was reported.
 *
 * What is followed, and what is not:
 *   - a named import of a `const` declared at the top of a project file;
 *   - nothing at all if any file of the project could not be read, since a
 *     write could be in that file (IMPORTS.blind);
 *   - a write anywhere - through the import, any other file's import of it,
 *     a namespace import, a local name given to part of it, or the defining
 *     file itself - makes it unknown again (IMPORTS.written).
 * Handing it out - `return demo.flags` - is a read, and is not followed into
 * whoever receives it. That is the one place a write could still be missed: a
 * caller that pushes into the very list it was returned. Writing into shared
 * fixed data that way is rare enough to accept here, and is said so.
 */
function fromImport(binding, depth) {
  if (!IMPORTS || IMPORTS.blind) return 'unknown';
  const spec = binding.path && binding.path.node;
  if (!spec || spec.type !== 'ImportSpecifier') return 'unknown';
  const program = binding.scope && binding.scope.getProgramParent();
  const here = program && PROGRAM_FILE.get(program.block);
  if (!here) return 'unknown';
  const decl = binding.path.parentPath && binding.path.parentPath.node;
  const from = decl && decl.source && decl.source.value;
  const name = spec.imported && (spec.imported.name || spec.imported.value);
  const found = from && name ? IMPORTS.constOf(here, from, name) : null;
  if (!found) return 'unknown';
  if (IMPORTS.written.has(found.full + '::' + name) || IMPORTS.written.has(found.full + '::*')) return 'unknown';
  return classify(found.init, found.scope, found.code, depth + 1);
}

/** What a name was set to, followed one step back when that says anything. */
function fromBinding(id, scope, code, depth, aliases) {
  if (id && aliases && Object.prototype.hasOwnProperty.call(aliases, id.name)) return aliases[id.name];
  if (!id || !scope) return 'unknown';
  const binding = scope.getBinding(id.name);
  if (!binding) return 'unknown';
  if (binding.path && binding.path.type === 'CatchClause') return 'error';
  if (binding.kind === 'param') return fromCalls(binding, code, depth);
  if (binding.kind === 'module') return fromImport(binding, depth);
  const init = binding.path && binding.path.node && binding.path.node.init;
  const later = binding.constantViolations || [];
  if (!init && !later.length) return 'unknown';
  if (init && readsResponseBody(init)) return 'network';
  // Reassigned later: as dangerous as the worst value it is ever given. Found
  // on a blind test: `let notes = []`, then `notes = data` from the database,
  // then rendered - read as "unknown" because the first value was an empty
  // list. Only plain `=` and `+=` are followed; anything else - a destructure,
  // a for-of - stays unknown, because what it assigns is not in one place.
  if (later.length) {
    if (RESOLVING.has(binding)) return 'safe'; // x = x + 1: itself adds nothing new
    RESOLVING.add(binding);
    try {
      const origins = [];
      if (init) origins.push(classify(init, binding.path.scope, code, depth + 1, aliases));
      for (const v of later) {
        const node = v.node;
        if (node.type === 'UpdateExpression') continue; // x++ holds a number
        if (node.type !== 'AssignmentExpression' || node.left.type !== 'Identifier' ||
            (node.operator !== '=' && node.operator !== '+=')) return 'unknown';
        origins.push(classify(node.right, v.scope, code, depth + 1, aliases));
      }
      return worst(origins);
    } finally {
      RESOLVING.delete(binding);
    }
  }
  // Destructured from a response body: const { name } = await res.json()
  // Aliases carry through: inside a map() callback, `const t = r.title` is as
  // dangerous as the item r it was read from.
  return classify(init, binding.path.scope, code, depth + 1, aliases);
}

/**
 * A parameter is as dangerous as the worst thing any call passes it. Every
 * use of the function has to be a call this file makes: one handed on as a
 * value - a callback, an export, an event handler - is called from somewhere
 * the code does not show, so its parameter stays unknown.
 */
function fromCalls(binding, code, depth) {
  const fn = binding.path && binding.path.parentPath;
  if (!fn || !/Function/.test(fn.node.type)) return 'unknown';
  const index = fn.node.params.indexOf(binding.path.node);
  if (index === -1) return 'unknown';
  let name = fn.node.id && fn.node.id.name;
  if (!name && fn.parentPath && fn.parentPath.node.type === 'VariableDeclarator' && fn.parentPath.node.id.type === 'Identifier') {
    name = fn.parentPath.node.id.name;
  }
  const fnBinding = name && fn.parentPath && fn.parentPath.scope.getBinding(name);
  if (!fnBinding || (fnBinding.constantViolations && fnBinding.constantViolations.length)) return 'unknown';
  const refs = fnBinding.referencePaths || [];
  if (!refs.length) return 'unknown';
  const origins = [];
  for (const ref of refs) {
    const call = ref.parent;
    if (!call || !/CallExpression$/.test(call.type) || call.callee !== ref.node) return 'unknown';
    const arg = call.arguments[index];
    if (!arg) {
      origins.push('safe'); // not passed: undefined
      continue;
    }
    if (call.arguments.slice(0, index + 1).some((a) => a.type === 'SpreadElement')) return 'unknown';
    origins.push(classify(arg, ref.scope, code, depth + 1));
  }
  return worst(origins);
}

function readsResponseBody(node) {
  let n = node;
  if (n && n.type === 'AwaitExpression') n = n.argument;
  if (!n || !/CallExpression$/.test(n.type)) return false;
  const name = calleeName(n.callee);
  if (name === 'json' || name === 'text') return true;
  // res.json().catch(() => ({})) - the body read, with a fallback for when it
  // is not JSON. Still the server's words whenever it is.
  if ((name === 'catch' || name === 'finally') && n.callee.type === 'MemberExpression') {
    return readsResponseBody(n.callee.object);
  }
  // (await fetch(url)).json() and fetch(url).then(r => r.json())
  if (name === 'then') return (n.arguments || []).some((fn) => {
    const body = returnedBy(fn);
    return body && readsResponseBody(body);
  });
  // Found on a blind test: const { data } = await supabase.from('notes')
  // .select(...) is rows straight from the database, and was judged "unknown".
  if (queriesSupabase(n)) return true;
  // axios.get(url) - its .data is the server's body.
  const callee = n.callee;
  if (callee.type === 'Identifier' && callee.name === 'axios') return true;
  if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'axios' &&
      /^(get|post|put|patch|delete|head|request)$/.test(calleeName(callee))) return true;
  return false;
}

// What a Supabase query chain does after .from('table'). Required, so that
// Array.from(x) or somebody's own .from() is not read as the database.
const QUERY_STEPS = /^(select|insert|update|upsert|delete|eq|neq|gt|gte|lt|lte|like|ilike|is|in|contains|containedBy|match|filter|or|not|order|limit|range|single|maybeSingle|textSearch|csv|throwOnError|returns|abortSignal)$/;

/** supabase.from('notes').select(...)...  or  supabase.rpc('fn', ...). */
function queriesSupabase(node) {
  let c = node;
  while (c && /CallExpression$/.test(c.type) && c.callee && /MemberExpression$/.test(c.callee.type)) {
    const step = calleeName(c.callee);
    const inner = c.callee.object;
    if (step === 'rpc' && c.arguments[0] && /StringLiteral|TemplateLiteral/.test(c.arguments[0].type)) return true;
    if (QUERY_STEPS.test(step) && inner && /CallExpression$/.test(inner.type) && calleeName(inner.callee) === 'from' &&
        inner.callee.type === 'MemberExpression' && inner.arguments[0] &&
        /StringLiteral|TemplateLiteral/.test(inner.arguments[0].type)) return true;
    c = inner;
  }
  return false;
}

/**
 * When the value is a parameter of the function it sits in - a helper such as
 * setStatus(html) { box.innerHTML = html } - which function, and which place
 * in its argument list. Null for anything else.
 */
function paramOf(value, scope) {
  if (!value || value.type !== 'Identifier' || !scope) return null;
  const binding = scope.getBinding(value.name);
  if (!binding || binding.kind !== 'param' || !binding.path) return null;
  const fn = binding.path.parentPath;
  if (!fn || !/Function/.test(fn.node.type)) return null;
  const index = fn.node.params.indexOf(binding.path.node);
  if (index === -1) return null;
  let name = fn.node.id && fn.node.id.name;
  if (!name && fn.parentPath && fn.parentPath.node.type === 'VariableDeclarator' && fn.parentPath.node.id.type === 'Identifier') {
    name = fn.parentPath.node.id.name;
  }
  return name ? { fn: name, index: index } : null;
}

/** Everything in one piece of code that turns a non-literal value into HTML. */
/* -------------------------- open redirects -------------------------- */
//
// Found on a blind test: after signing in, the page sent the browser to
// new URLSearchParams(location.search).get('next') - wherever a link said.
// A phishing link then lands someone on the attacker's page straight from
// the real login, and a javascript: value runs in the page. Reported only
// when the address is taken from the page's own URL, and not when the code
// checks it first: a redirect to a fixed page is the feature.

/** location, window.location, document.location. */
function isLocation(node) {
  if (!node) return false;
  if (node.type === 'Identifier') return node.name === 'location';
  return node.type === 'MemberExpression' && !node.computed && node.property.name === 'location' &&
    node.object.type === 'Identifier' && /^(window|document|self|top)$/.test(node.object.name);
}

/** Is this address taken from the page's own URL, from its start? */
function readsUrl(node, scope, depth) {
  if (!node || depth > 8) return false;
  const again = (n) => readsUrl(n, scope, depth + 1);
  switch (node.type) {
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      const prop = !node.computed && node.property ? node.property.name : '';
      if ((prop === 'search' || prop === 'hash') && isLocation(node.object)) return true;
      if (prop === 'referrer' && node.object.type === 'Identifier' && node.object.name === 'document') return true;
      // Next's pages router: router.query.next
      let base = node.object;
      while (base && /MemberExpression$/.test(base.type)) {
        if (!base.computed && base.property.name === 'query' && base.object.type === 'Identifier' && base.object.name === 'router') return true;
        base = base.object;
      }
      return false;
    }
    case 'CallExpression':
    case 'OptionalCallExpression': {
      const name = calleeName(node.callee);
      if (name === 'get' && /MemberExpression$/.test(node.callee.type)) {
        const params = node.callee.object;
        if (params.type === 'NewExpression' && params.callee.name === 'URLSearchParams') return true;
        if (/MemberExpression$/.test(params.type) && !params.computed && params.property.name === 'searchParams') return true;
        if (params.type === 'Identifier' && scope) {
          const b = scope.getBinding(params.name);
          const init = b && b.path && b.path.node && b.path.node.init;
          if (init && init.type === 'NewExpression' && init.callee.name === 'URLSearchParams') return true;
          if (init && /MemberExpression$/.test(init.type) && !init.computed && init.property.name === 'searchParams') return true;
          // Next and React Router: const params = useSearchParams(), or
          // const [params] = useSearchParams().
          if (init && /CallExpression$/.test(init.type) && calleeName(init.callee) === 'useSearchParams') return true;
        }
        return false;
      }
      if (/^(decodeURIComponent|decodeURI|String)$/.test(name) && node.callee.type === 'Identifier') return again(node.arguments[0]);
      if (/^(trim|toString|slice|substring)$/.test(name) && /MemberExpression$/.test(node.callee.type)) return again(node.callee.object);
      return false; // anything else - isSafeUrl(x), sanitize(x) - is somebody's check
    }
    case 'LogicalExpression':
      return again(node.left) || again(node.right);
    case 'ConditionalExpression':
      return again(node.consequent) || again(node.alternate);
    case 'TemplateLiteral':
      // `login.html?next=${x}` starts somewhere fixed; `${x}` does not.
      return node.quasis[0].value.cooked === '' && node.expressions.length > 0 && again(node.expressions[0]);
    case 'BinaryExpression':
      return node.operator === '+' && again(node.left);
    case 'AwaitExpression':
      return again(node.argument);
    case 'Identifier': {
      const b = scope && scope.getBinding(node.name);
      if (!b || !b.path || b.kind === 'param') return false;
      const values = [];
      if (b.path.node && b.path.node.init) values.push(b.path.node.init);
      for (const v of b.constantViolations || []) if (v.node.type === 'AssignmentExpression') values.push(v.node.right);
      return values.some((v) => readsUrl(v, b.path.scope, depth + 1));
    }
    default:
      return false;
  }
}

/**
 * Does the code check this name before sending the browser there? Any `if`
 * or `? :` around the redirect, or an earlier `if` in the same block, whose
 * test mentions it - an allow-list, a startsWith('/'), an origin compare.
 */
function checkedFirst(p, value, code) {
  if (!value || value.type !== 'Identifier') return false;
  const word = new RegExp('\\b' + value.name.replace(/\$/g, '\\$') + '\\b');
  // A test that only asks whether there is a value - if (next) - checks
  // nothing about where it goes. It has to compare or match something.
  const VALIDATES = /startsWith|endsWith|\.test\(|includes|indexOf|match|origin|===|!==|allow|safe|valid|trusted/i;
  const mentions = (n) => {
    const text = n ? code.slice(n.start, n.end) : '';
    return word.test(text) && VALIDATES.test(text);
  };
  let child = p;
  for (let at = p.parentPath; at; child = at, at = at.parentPath) {
    const n = at.node;
    if ((n.type === 'IfStatement' || n.type === 'ConditionalExpression') && mentions(n.test)) return true;
    if (n.type === 'LogicalExpression' && n.operator === '&&' && child.node === n.right && mentions(n.left)) return true;
    if (n.type === 'BlockStatement' || n.type === 'Program') {
      const index = n.body.indexOf(child.node);
      if (n.body.slice(0, Math.max(0, index)).some((s) => s.type === 'IfStatement' && mentions(s.test))) return true;
    }
    if (/Function/.test(n.type)) break;
  }
  return false;
}

/**
 * The helper a value is the result of: a call to a function this file
 * declares, or one it imports from a file of the project. Its returns, each
 * with its scope and its file's code, and the line where the first of them
 * that is not plain text is built. Null for anything else - an import from a
 * package, a default export, a function that cannot be found.
 */
function helperOf(value, scope, code, file, lineOffset, resolver) {
  if (!value || !/CallExpression$/.test(value.type) || !value.callee || value.callee.type !== 'Identifier' || !scope) return null;
  const name = value.callee.name;
  let fnPath = localFunction(name, scope);
  let helper = { code: code, file: null, lineOffset: lineOffset };
  if (!fnPath) {
    const binding = scope.getBinding(name);
    const spec = binding && binding.kind === 'module' && binding.path && binding.path.node;
    if (!spec || spec.type !== 'ImportSpecifier' || !resolver) return null;
    const from = binding.path.parentPath && binding.path.parentPath.node.source && binding.path.parentPath.node.source.value;
    const imported = spec.imported && (spec.imported.name || spec.imported.value);
    const found = from && imported ? resolver(file, from, imported) : null;
    if (!found) return null;
    fnPath = found.fnPath;
    helper = { code: found.code, file: found.file, lineOffset: 1 };
  }
  const returns = returnsOf(fnPath);
  if (!returns.length) return null;
  const risky = returns.find((r) => classify(r.node, r.scope, helper.code, 0) !== 'safe') || returns[0];
  return {
    fn: name,
    file: helper.file,
    line: (risky.node.loc ? risky.node.loc.start.line : 1) + helper.lineOffset - 1,
    code: helper.code,
    lineOffset: helper.lineOffset,
    returns: returns,
  };
}

/**
 * Finds a function another file of the project exports, for helperOf. Parsed
 * once a file; its functions are handed to the map() reader each time, since
 * that table is rebuilt for every file read.
 */
/** The project file a relative import names, or null for a package or nothing. */
function resolveModule(fromFile, source) {
  if (!/^\.\.?\//.test(source)) return null;
  const EXTS = ['', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '/index.js', '/index.ts'];
  const base = path.resolve(path.dirname(fromFile), source);
  return EXTS.map((ext) => base + ext).find((candidate) => {
    try {
      return fs.statSync(candidate).isFile() && CODE_EXT.test(candidate);
    } catch (err) {
      return false;
    }
  }) || null;
}

function importResolver(parser, root) {
  const parsed = new Map();
  const entryOf = (fromFile, source) => {
    const full = resolveModule(fromFile, source);
    if (!full) return null;
    if (!parsed.has(full)) {
      let entry = null;
      try {
        if (fs.statSync(full).size <= MAX_BYTES) {
          const code = fs.readFileSync(full, 'utf8');
          const ast = parser.babelParse(code, full, true);
          const fns = [];
          let program = null;
          parser.traverse(ast, {
            Program(p) { program = p.scope; },
            Function(p) { fns.push(p); },
          });
          if (program) PROGRAM_FILE.set(program.block, full);
          entry = { code: code, program: program, fns: fns, file: path.relative(root, full).split(path.sep).join('/') };
        }
      } catch (err) {
        entry = null;
      }
      parsed.set(full, entry);
    }
    const entry = parsed.get(full);
    if (!entry || !entry.program) return null;
    for (const p of entry.fns) FN_PATHS.set(p.node, p);
    return Object.assign({ full: full }, entry);
  };
  const resolve = (fromFile, source, name) => {
    const entry = entryOf(fromFile, source);
    if (!entry) return null;
    const fnPath = localFunction(name, entry.program);
    return fnPath ? { fnPath: fnPath, code: entry.code, file: entry.file } : null;
  };
  // A `const` the file declares at its top, with the value it is given there.
  resolve.constOf = (fromFile, source, name) => {
    const entry = entryOf(fromFile, source);
    if (!entry) return null;
    const binding = entry.program.getBinding(name);
    const node = binding && binding.path && binding.path.node;
    if (!binding || binding.kind !== 'const' || !node || node.type !== 'VariableDeclarator' || !node.init) return null;
    if (binding.constantViolations && binding.constantViolations.length) return null;
    return { full: entry.full, init: node.init, scope: binding.path.scope, code: entry.code };
  };
  return resolve;
}

// Methods that change the array, map or set they are called on.
const MUTATORS = /^(push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|set|add|delete|clear)$/;
// Calls that only read what they are given.
const READS_ONLY = /^(String|Number|Boolean|JSON\.stringify|console\.\w+|Array\.isArray|Object\.(keys|values|entries|freeze|isFrozen))$/;
// Methods that only read their argument: list.concat(demo.changes) builds a
// new list and leaves demo alone. push() and the like are not here - they put
// the value somewhere it can be written through.
const READS_ARGUMENT = /^(concat|includes|indexOf|lastIndexOf|startsWith|endsWith|localeCompare|has|at)$/;

/**
 * Whether this use of a name can change what the name holds: an assignment or
 * delete through it, a mutating method on it, or handing it to a call that
 * could change it. A local name given to part of it - `const list = demo.flags`
 * - is followed, since writing to the list writes to demo.
 */
function writtenThrough(ref, depth) {
  if ((depth || 0) > 4) return true;
  let p = ref;
  while (p.parentPath && /MemberExpression$/.test(p.parentPath.node.type) && p.parentPath.node.object === p.node) p = p.parentPath;
  const parentPath = p.parentPath;
  const parent = parentPath && parentPath.node;
  if (!parent) return false;
  if (parent.type === 'UpdateExpression') return true;
  if (parent.type === 'UnaryExpression' && parent.operator === 'delete') return true;
  // The target of an assignment, plain or inside a destructuring pattern.
  let up = p;
  while (up.parentPath && /^(ObjectProperty|ObjectPattern|ArrayPattern|AssignmentPattern|RestElement)$/.test(up.parentPath.node.type)) up = up.parentPath;
  const holder = up.parentPath && up.parentPath.node;
  if (holder && holder.type === 'AssignmentExpression' && holder.left === up.node) return true;
  if (holder && /^For(Of|In)Statement$/.test(holder.type) && holder.left === up.node) return true;
  if (/CallExpression$/.test(parent.type)) {
    if (parent.callee === p.node) {
      return /MemberExpression$/.test(p.node.type) && MUTATORS.test(calleeName(p.node));
    }
    if (parent.arguments.indexOf(p.node) !== -1) {
      const callee = parent.callee;
      const full = callee.type === 'MemberExpression' && callee.object.type === 'Identifier'
        ? callee.object.name + '.' + calleeName(callee) : calleeName(callee);
      if (/MemberExpression$/.test(callee.type) && READS_ARGUMENT.test(calleeName(callee))) return false;
      return !(MAKES_SAFE.test(calleeName(callee)) || READS_ONLY.test(full));
    }
  }
  if (parent.type === 'VariableDeclarator' && parent.init === p.node && parent.id.type === 'Identifier') {
    const alias = parentPath.scope.getBinding(parent.id.name);
    if (!alias) return true;
    if (alias.constantViolations && alias.constantViolations.length) return true;
    return (alias.referencePaths || []).some((r) => writtenThrough(r, (depth || 0) + 1));
  }
  return false;
}

/**
 * Every project name something writes to, as "<file>::<name>", read once over
 * the whole project before any file is judged. `blind` when a file could not
 * be read: a write could be in it, so no import is trusted at all.
 */
function projectWrites(parser, files) {
  const written = new Set();
  let blind = false;
  for (const full of files) {
    let pieces;
    try {
      if (fs.statSync(full).size > MAX_BYTES) continue;
      const source = fs.readFileSync(full, 'utf8');
      pieces = PAGE_EXT.test(full) ? scriptsIn(source) : [{ code: source }];
    } catch (err) {
      blind = true;
      continue;
    }
    for (const piece of pieces) {
      let ast;
      try {
        ast = parser.babelParse(piece.code, full, true);
      } catch (err) {
        blind = true;
        continue;
      }
      parser.traverse(ast, {
        Program(p) {
          // This file's own top-level names, written to here.
          for (const name of Object.keys(p.scope.bindings)) {
            const b = p.scope.bindings[name];
            if (b.kind === 'module') continue;
            if ((b.constantViolations && b.constantViolations.length) ||
                (b.referencePaths || []).some((r) => writtenThrough(r))) {
              written.add(full + '::' + name);
            }
          }
        },
        ImportDeclaration(p) {
          const from = resolveModule(full, p.node.source.value);
          if (!from) return;
          for (const spec of p.node.specifiers) {
            const b = p.scope.getBinding(spec.local.name);
            if (!b) continue;
            if (spec.type === 'ImportNamespaceSpecifier') {
              for (const r of b.referencePaths || []) {
                const m = r.parentPath && r.parentPath.node;
                if (m && /MemberExpression$/.test(m.type) && m.object === r.node && !m.computed && m.property.type === 'Identifier') {
                  if (writtenThrough(r.parentPath)) written.add(from + '::' + m.property.name);
                } else {
                  written.add(from + '::*');
                }
              }
              continue;
            }
            const name = spec.type === 'ImportDefaultSpecifier' ? 'default' : (spec.imported.name || spec.imported.value);
            if ((b.referencePaths || []).some((r) => writtenThrough(r))) written.add(from + '::' + name);
          }
        },
      });
    }
  }
  return { written: written, blind: blind };
}

function sinksIn(parser, code, file, lineOffset, resolver) {
  const found = [];
  const ast = parser.babelParse(code, file, true);
  PROGRAM_FILE.set(ast.program, file);
  const lineOf = (node) => (node.loc ? node.loc.start.line : 1) + lineOffset - 1;
  const textOf = (node) => code.slice(node.start, node.end).replace(/\s+/g, ' ').slice(0, 160);
  // Calls to plain named functions, so a helper's sink can be judged by what
  // each call actually hands it.
  const calls = new Map();
  const viaHelper = [];
  const partsOf = (value, scope) => {
    const out = [];
    riskyParts(value, scope, code, undefined, out, 0);
    return out;
  };
  const add = (node, scope, sink, value) => {
    const param = paramOf(value, scope);
    if (param) {
      viaHelper.push({ node: node, sink: sink, value: value, scope: scope, param: param });
      return;
    }
    // The HTML built by a helper - root.innerHTML = renderBoard(rows) - is
    // judged by what the helper returns, in its own file, and the place it
    // puts a value in is named. Found on a blind test (HelixOps): appShell(),
    // a fixed string in ui.js, was reported as unknown, and renderBoard() was
    // reported at its call with no word of ui.js:13, where the title goes in.
    const built = helperOf(value, scope, code, file, lineOffset, resolver);
    if (built) {
      const origin = worst(built.returns.map((r) => classify(r.node, r.scope, built.code, 0)));
      if (origin === 'safe') return;
      const parts = [];
      for (const r of built.returns) riskyParts(r.node, r.scope, built.code, undefined, parts, 0);
      // The line of the first value that goes in, not of the return around it.
      const first = parts.find((p) => p.line);
      found.push({
        line: lineOf(node), sink: sink, expression: textOf(value), origin: origin, parts: parts,
        helper: { fn: built.fn, file: built.file, line: first ? first.line + built.lineOffset - 1 : built.line },
      });
      return;
    }
    const origin = classify(value, scope, code, 0);
    if (origin === 'safe') return;
    found.push({ line: lineOf(node), sink: sink, expression: textOf(value), origin: origin, parts: partsOf(value, scope) });
  };
  FN_PATHS = new WeakMap();
  parser.traverse(ast, {
    Function(p) {
      FN_PATHS.set(p.node, p);
    },
    CallExpression: {
      exit(p) {
        if (p.node.callee.type !== 'Identifier') return;
        const list = calls.get(p.node.callee.name) || [];
        list.push({ node: p.node, scope: p.scope });
        calls.set(p.node.callee.name, list);
      },
    },
  });
  const redirect = (p, sink, value) => {
    if (!value || !readsUrl(value, p.scope, 0) || checkedFirst(p, value, code)) return;
    found.push({ kind: 'redirect', line: lineOf(p.node), sink: sink, expression: textOf(value), origin: 'url', parts: [] });
  };
  parser.traverse(ast, {
    AssignmentExpression(p) {
      const left = p.node.left;
      if (isLocation(left)) return redirect(p, 'location', p.node.right);
      if (left.type !== 'MemberExpression' || left.computed) return;
      const prop = left.property && left.property.name;
      if (prop === 'innerHTML' || prop === 'outerHTML') add(p.node, p.scope, prop, p.node.right);
      else if (prop === 'href' && isLocation(left.object)) redirect(p, 'location.href', p.node.right);
    },
    CallExpression(p) {
      const callee = p.node.callee;
      const name = calleeName(callee);
      const args = p.node.arguments;
      if ((name === 'assign' || name === 'replace') && callee.type === 'MemberExpression' && isLocation(callee.object)) {
        return redirect(p, 'location.' + name + '()', args[0]);
      }
      if (name === 'open' && callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'window') {
        return redirect(p, 'window.open()', args[0]);
      }
      // Next's router follows a full URL off the site. React Router's
      // navigate() does not, so it is not a sink here.
      if ((name === 'push' || name === 'replace') && callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' && callee.object.name === 'router') {
        return redirect(p, 'router.' + name + '()', args[0]);
      }
      if (name === 'insertAdjacentHTML' && args[1]) add(p.node, p.scope, 'insertAdjacentHTML', args[1]);
      else if ((name === 'write' || name === 'writeln') && callee.type === 'MemberExpression' &&
               callee.object && callee.object.name === 'document' && args[0]) {
        add(p.node, p.scope, 'document.' + name, args[0]);
      } else if (name === 'html' && callee.type === 'MemberExpression' && args.length === 1) {
        add(p.node, p.scope, '.html()', args[0]);
      }
    },
    JSXAttribute(p) {
      if (!p.node.name || p.node.name.name !== 'dangerouslySetInnerHTML') return;
      const expr = p.node.value && p.node.value.expression;
      if (!expr || expr.type !== 'ObjectExpression') return;
      const html = expr.properties.find((prop) => prop.key && (prop.key.name === '__html' || prop.key.value === '__html'));
      if (html) add(p.node, p.scope, 'dangerouslySetInnerHTML', html.value);
    },
  });

  // A helper's sink is judged at its calls. Most calls of a helper like this
  // pass HTML on purpose, so the risk is the one call that passes something
  // from outside - and that is where it has to be fixed. A helper with no call
  // this file can see cannot be judged that way, so its sink is reported where
  // it is, as unknown, rather than dropped.
  for (const h of viaHelper) {
    const seen = calls.get(h.param.fn) || [];
    if (!seen.length) {
      found.push({ line: lineOf(h.node), sink: h.sink, expression: textOf(h.value), origin: 'unknown' });
      continue;
    }
    for (const call of seen) {
      const arg = call.node.arguments[h.param.index];
      if (!arg) continue;
      const origin = classify(arg, call.scope, code, 0);
      if (origin === 'safe') continue;
      found.push({
        line: lineOf(call.node),
        sink: h.sink,
        expression: textOf(arg),
        origin: origin,
        parts: partsOf(arg, call.scope),
        via: { fn: h.param.fn, line: lineOf(h.node) },
      });
    }
  }
  return found;
}

/**
 * Reads the project at `root`. Returns
 *   { ran, why?, filesRead, findings: [...], unreadable: [{ file, why }] }
 * `ran: false` means the check did not happen - never that it passed.
 */
function scanProject(root, options) {
  const packageDir = (options && options.packageDir) || __dirname;
  const parser = (options && options.parser) || loadParser(packageDir);
  if (!parser) {
    return {
      ran: false,
      why: 'the JavaScript parser this check uses was not found in this install of Playwright',
      filesRead: 0,
      findings: [],
      unreadable: [],
    };
  }
  const findings = [];
  const unreadable = [];
  // Secret keys, read from the same files. Kept apart from the HTML findings:
  // they are already in their final shape, and they go first.
  const secrets = [];
  let filesRead = 0;
  const files = listFiles(root);
  const relOf = (full) => path.relative(root, full).split(path.sep).join('/');
  // Which pages load which scripts, so a key in config.js can be said to
  // reach the browser because index.html loads it - not guessed at.
  const pages = [];
  for (const full of files) {
    if (!/\.html?$/i.test(full)) continue;
    try {
      if (fs.statSync(full).size <= MAX_BYTES) pages.push({ rel: relOf(full), source: fs.readFileSync(full, 'utf8') });
    } catch (err) {
      /* unreadable pages are reported below */
    }
  }
  const loadedBy = keys.scriptsLoadedBy(pages);
  const resolver = importResolver(parser, root);
  // Before any file is judged: which of the project's own names anything
  // writes to, so fixed data is only trusted while it really is fixed.
  PROGRAM_FILE = new WeakMap();
  IMPORTS = Object.assign({ constOf: resolver.constOf }, projectWrites(parser, files));
  try {
    readAll();
  } finally {
    IMPORTS = null;
  }
  return { ran: true, filesRead: filesRead, findings: secrets.concat(findings.map(describe)), unreadable: unreadable };

  function readAll() {
    for (const full of files) {
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch (err) {
        continue;
      }
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (size > MAX_BYTES) {
        unreadable.push({ file: rel, why: 'larger than ' + Math.round(MAX_BYTES / 1024) + ' KB, probably generated' });
        continue;
      }
      const source = fs.readFileSync(full, 'utf8');
      filesRead++;
      for (const k of keys.secretsIn(rel, source, loadedBy)) secrets.push(k);
      const pieces = PAGE_EXT.test(full) ? scriptsIn(source) : [{ code: source, line: 1 }];
      for (const piece of pieces) {
        try {
          for (const f of sinksIn(parser, piece.code, full, piece.line, resolver)) findings.push(Object.assign({ file: rel }, f));
        } catch (err) {
          unreadable.push({ file: rel + (piece.line > 1 ? ':' + piece.line : ''), why: 'could not be parsed: ' + String(err.message).split('\n')[0].slice(0, 120) });
        }
      }
      if (/\.(vue|html)$/i.test(full)) {
        for (const v of vHtmlIn(source)) {
          findings.push({ file: rel, line: v.line, sink: 'v-html', expression: v.expression, origin: 'unknown' });
        }
      }
    }
  }
}

const ORIGIN_WORDS = {
  network: 'read from a server response',
  error: "an error's message, which often carries text a server sent",
  unknown: 'from somewhere the code alone cannot pin down',
};

// Wrapped here rather than by whoever prints it: this is pasted into a chat
// box as often as it is read in a terminal, and a long line is a wall in both.
// A quoted piece of code is never wrapped - breaking it would change it.
function wrap(text, width) {
  const out = [];
  let current = '';
  for (const word of String(text).split(/\s+/)) {
    if (current && (current + ' ' + word).length > width) {
      out.push(current);
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) out.push(current);
  return out.join('\n');
}

/** An open redirect, in the same shape as every other finding. */
function describeRedirect(f) {
  const fixPrompt = [
    'My app may have an open redirect - please check it rather than assume it.',
    '',
    'In ' + f.file + ' at line ' + f.line + ', the page sends the browser to an address taken from its own URL:',
    '',
    '    ' + f.expression,
    '',
    'Anyone can send a link to this page with that part of the URL set to their own site - for example ' +
      '?next=https://attacker.example. The person uses your real page, then lands on the attacker\'s, which ' +
      'can ask for their password again. A value starting with javascript: can run script in your page.',
    '',
    'Fix it so only your own pages are allowed: accept the value only if it starts with a single "/" (not ' +
      '"//" and not "/\\"), or check that new URL(value, location.origin).origin equals location.origin, and ' +
      'go to your home page otherwise. Then check every other place that reads a next, redirect or returnTo ' +
      'value the same way.',
  ].map((p) => (p.startsWith('    ') ? p : wrap(p, 72))).join('\n');
  return {
    kind: 'open-redirect',
    status: 'verification required',
    evidence: 'code analysis',
    severity: 'HIGH',
    confidence: 'medium',
    file: f.file,
    line: f.line,
    sink: f.sink,
    expression: f.expression,
    origin: 'url',
    parts: [],
    via: null,
    headline: 'A redirect in ' + f.file + ':' + f.line + ' goes wherever the page\'s URL says.',
    fixPrompt: fixPrompt,
  };
}

/** One finding, in the shape every Kryptheon report uses. */
function describe(f) {
  if (f.kind === 'redirect') return describeRedirect(f);
  const severity = f.origin === 'unknown' ? 'MEDIUM' : 'HIGH';
  const how = f.sink === 'v-html' ? 'v-html' : f.sink;
  // Where the helper builds it: its own file when it is another one.
  const builtAt = f.helper ? (f.helper.file ? f.helper.file + ':' : 'line ') + f.helper.line : '';
  const where = f.via
    ? 'In ' + f.file + ' at line ' + f.line + ', this value is passed to ' + f.via.fn + '(), which puts ' +
      'what it is given into the page as HTML with ' + how + ' at line ' + f.via.line + ':'
    : f.helper
    ? 'In ' + f.file + ' at line ' + f.line + ', the HTML that ' + f.helper.fn + '() builds - at ' + builtAt +
      ' - is put into the page with ' + how + ':'
    : 'In ' + f.file + ' at line ' + f.line + ', this value is put into the page as HTML with ' + how + ':';
  // The fix for a helper is different, and getting it wrong breaks the page:
  // switching the helper to textContent makes every other call - the ones
  // that pass HTML on purpose - show their tags as text. Found by applying the
  // plain version of this prompt to a real helper like this.
  const fix = f.via
    ? [
      'Do not change ' + f.via.fn + '() to use textContent: other calls pass HTML to it on purpose, ' +
        'and they would show their tags as text. Fix it here instead - escape the dynamic part of ' +
        'this value before it is joined into the HTML (replace & < > " \' with their HTML entities), ' +
        'or pass it through a sanitizer such as DOMPurify if it must keep some formatting.',
    ]
    : f.helper
    ? [
      'Fix it inside ' + f.helper.fn + '() at ' + builtAt + ', where the values are joined into the HTML: ' +
        'escape each dynamic value there (replace & < > " \' with their HTML entities), or pass the ' +
        'result through a sanitizer such as DOMPurify if it must keep some formatting.',
    ]
    : [
      'Fix it so the value is always shown as text: set textContent instead of innerHTML for the ' +
        'dynamic part, or escape it before it is joined into HTML (replace & < > " \' with their ' +
        'HTML entities). If the HTML is meant to allow some formatting, pass it through a sanitizer ' +
        'such as DOMPurify first.',
    ];
  // A long template is mostly harmless markup. Naming the part that decides it
  // keeps the fix - and the AI tool doing it - to that part alone.
  const parts = (f.parts || []).filter((p) => p.text && p.text !== f.expression);
  const only = parts.length
    ? [''].concat(
      [(parts.length === 1 ? 'Only this part' : 'Only these parts') + ' of it can carry text from outside the page, ' +
        'so only ' + (parts.length === 1 ? 'it needs' : 'they need') + ' changing:'],
      parts.map((p) => '    ${' + p.text + '}'),
    )
    : [];
  const fixPrompt = [
    'My app may have a security problem - please check it rather than assume it.',
    '',
    where,
    '',
    '    ' + f.expression,
  ].concat(only, [
    '',
    'The value is ' + ORIGIN_WORDS[f.origin] + '. If it can ever contain text a user or another ' +
      'account typed, a "<" in it becomes a real tag and can run script in this page with the ' +
      "signed-in person's session.",
    '',
  ]).concat(fix, [
    '',
    'Keep the page looking the same, change only how this value is inserted, and look for the ' +
      'same pattern elsewhere in this file. Afterwards, open this page and check that ordinary ' +
      'text, and text containing < and &, both display correctly.',
  ]).map((p) => (p.startsWith('    ') ? p : wrap(p, 72))).join('\n');
  return {
    kind: 'unsafe-html',
    status: 'verification required',
    evidence: 'code analysis',
    severity: severity,
    confidence: f.origin === 'unknown' ? 'low' : 'medium',
    file: f.file,
    line: f.line,
    sink: f.sink,
    expression: f.expression,
    origin: f.origin,
    parts: (f.parts || []).map((p) => ({ text: p.text, origin: p.origin })),
    via: f.via || null,
    helper: f.helper || null,
    headline: 'Text ' + (f.origin === 'unknown' ? 'of unknown origin' : ORIGIN_WORDS[f.origin].split(',')[0]) +
      ' is inserted as HTML in ' + f.file + ':' + f.line +
      (f.via ? ' (through ' + f.via.fn + '() at line ' + f.via.line + ')' : '') +
      (f.helper ? ', built by ' + f.helper.fn + '() at ' + builtAt : '') + '.',
    fixPrompt: fixPrompt,
  };
}

module.exports = {
  scanProject: scanProject,
  listFiles: listFiles,
  loadParser: loadParser,
  scriptsIn: scriptsIn,
  classify: classify,
  describe: describe,
};
