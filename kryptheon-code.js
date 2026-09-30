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
      // String methods pass through whatever they were called on.
      if (/^(trim|toUpperCase|toLowerCase|slice|substring|substr|replace|replaceAll|padStart|padEnd|concat|toString|join)$/.test(name) &&
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
  if (!out.some((p) => p.text === text)) out.push({ text: text, origin: origin });
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

/** What a name was set to, followed one step back when that says anything. */
function fromBinding(id, scope, code, depth, aliases) {
  if (id && aliases && Object.prototype.hasOwnProperty.call(aliases, id.name)) return aliases[id.name];
  if (!id || !scope) return 'unknown';
  const binding = scope.getBinding(id.name);
  if (!binding) return 'unknown';
  if (binding.path && binding.path.type === 'CatchClause') return 'error';
  if (binding.kind === 'param') return fromCalls(binding, code, depth);
  const init = binding.path && binding.path.node && binding.path.node.init;
  if (!init) return 'unknown';
  if (readsResponseBody(init)) return 'network';
  // Reassigned later: the first value says nothing reliable about the last.
  if (binding.constantViolations && binding.constantViolations.length) return 'unknown';
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
function sinksIn(parser, code, file, lineOffset) {
  const found = [];
  const ast = parser.babelParse(code, file, true);
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
  parser.traverse(ast, {
    AssignmentExpression(p) {
      const left = p.node.left;
      if (left.type !== 'MemberExpression' || left.computed) return;
      const prop = left.property && left.property.name;
      if (prop === 'innerHTML' || prop === 'outerHTML') add(p.node, p.scope, prop, p.node.right);
    },
    CallExpression(p) {
      const callee = p.node.callee;
      const name = calleeName(callee);
      const args = p.node.arguments;
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
        for (const f of sinksIn(parser, piece.code, full, piece.line)) findings.push(Object.assign({ file: rel }, f));
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
  return { ran: true, filesRead: filesRead, findings: secrets.concat(findings.map(describe)), unreadable: unreadable };
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

/** One finding, in the shape every Kryptheon report uses. */
function describe(f) {
  const severity = f.origin === 'unknown' ? 'MEDIUM' : 'HIGH';
  const how = f.sink === 'v-html' ? 'v-html' : f.sink;
  const where = f.via
    ? 'In ' + f.file + ' at line ' + f.line + ', this value is passed to ' + f.via.fn + '(), which puts ' +
      'what it is given into the page as HTML with ' + how + ' at line ' + f.via.line + ':'
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
    headline: 'Text ' + (f.origin === 'unknown' ? 'of unknown origin' : ORIGIN_WORDS[f.origin].split(',')[0]) +
      ' is inserted as HTML in ' + f.file + ':' + f.line +
      (f.via ? ' (through ' + f.via.fn + '() at line ' + f.via.line + ')' : '') + '.',
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
