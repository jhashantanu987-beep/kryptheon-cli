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
function classify(node, scope, code, depth, aliases) {
  if (!node || depth > 6) return 'unknown';
  const again = (n) => classify(n, scope, code, depth + 1, aliases);
  switch (node.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
      return 'safe';
    case 'TemplateLiteral':
      return worst(node.expressions.map((e) => again(e)));
    case 'BinaryExpression':
      if (node.operator !== '+') return 'safe'; // - * / % comparisons: never text
      return worst([again(node.left), again(node.right)]);
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
      if (NUMERIC_CALLS.test(name)) return 'safe';
      if (node.callee.type === 'MemberExpression' && node.callee.object && node.callee.object.name === 'Math') return 'safe';
      // items.map(i => `<li>${i.name}</li>`).join('') - judge what map builds.
      if (name === 'join' && node.callee.object && /CallExpression$/.test(node.callee.object.type) &&
          calleeName(node.callee.object.callee) === 'map') {
        const fn = node.callee.object.arguments[0];
        // The callback's item is whatever the array it walks holds.
        const listOrigin = again(node.callee.object.callee.object);
        const item = fn && fn.params && fn.params[0] && fn.params[0].type === 'Identifier' ? fn.params[0].name : null;
        const inner = Object.assign({}, aliases || {});
        if (item) inner[item] = listOrigin;
        return classify(returnedBy(fn), scope, code, depth + 1, inner);
      }
      // String methods pass through whatever they were called on.
      if (/^(trim|toUpperCase|toLowerCase|slice|substring|substr|replace|replaceAll|padStart|padEnd|concat|toString|join)$/.test(name) &&
          node.callee.type === 'MemberExpression') {
        return again(node.callee.object);
      }
      return 'unknown';
    }
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      const prop = node.property && !node.computed ? node.property.name : '';
      if (NUMERIC_PROPS.test(prop || '')) return 'safe';
      if (prop === 'message' && isCatchParam(node.object, scope)) return 'error';
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
  const init = binding.path && binding.path.node && binding.path.node.init;
  if (!init) return 'unknown';
  if (readsResponseBody(init)) return 'network';
  // Reassigned later: the first value says nothing reliable about the last.
  if (binding.constantViolations && binding.constantViolations.length) return 'unknown';
  // Destructured from a response body: const { name } = await res.json()
  return classify(init, binding.path.scope, code, depth + 1);
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
  const add = (node, scope, sink, value) => {
    const param = paramOf(value, scope);
    if (param) {
      viaHelper.push({ node: node, sink: sink, value: value, scope: scope, param: param });
      return;
    }
    const origin = classify(value, scope, code, 0);
    if (origin === 'safe') return;
    found.push({ line: lineOf(node), sink: sink, expression: textOf(value), origin: origin });
  };
  parser.traverse(ast, {
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
  let filesRead = 0;
  for (const full of listFiles(root)) {
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
  return { ran: true, filesRead: filesRead, findings: findings.map(describe), unreadable: unreadable };
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
  const fixPrompt = [
    'My app may have a security problem - please check it rather than assume it.',
    '',
    where,
    '',
    '    ' + f.expression,
    '',
    'The value is ' + ORIGIN_WORDS[f.origin] + '. If it can ever contain text a user or another ' +
      'account typed, a "<" in it becomes a real tag and can run script in this page with the ' +
      "signed-in person's session.",
    '',
  ].concat(fix, [
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
