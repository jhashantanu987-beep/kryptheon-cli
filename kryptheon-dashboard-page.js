// The dashboard page. Served from 127.0.0.1 by kryptheon-dashboard.js.
//
// Every value on this page can hold text from the app being checked - a line
// of its code, the heading of a page that broke. So nothing here is ever
// written as HTML: every node is made with createElement (or createElementNS
// for the icons, from fixed path data) and filled with textContent. This file
// is read by kryptheon-code.js in its own check, and must come back clean.

(function () {
  'use strict';

  var tokenMeta = document.querySelector('meta[name="kryptheon-token"]');
  var TOKEN = tokenMeta ? tokenMeta.getAttribute('content') : '';
  var NS = 'http://www.w3.org/2000/svg';
  var state = null;
  var busy = false;
  var openRow = null;
  var allLooks = false;

  /* ------------------------------ building blocks ------------------------------ */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function svgEl(tag, attrs) {
    var node = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, String(attrs[k])); });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function byId(id) { return document.getElementById(id); }

  // Line icons from fixed path data only.
  var ICONS = {
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
    change: 'M4 12h4l3-7 4 14 3-7h2',
    wrench: 'M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.6 2.6-2.4-.6-.6-2.4 2.6-2.6z',
    toggle: 'M8 7h8a5 5 0 010 10H8A5 5 0 018 7zm0 3a2 2 0 100 4 2 2 0 000-4z',
    play: 'M7 5l12 7-12 7V5z',
    box: 'M4 7l8-4 8 4v10l-8 4-8-4V7zm0 0l8 4 8-4M12 11v10',
    alert: 'M12 3l10 18H2L12 3zm0 7v5m0 3v.5',
    eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    film: 'M4 5h16v14H4zM4 9h16M4 15h16M8 5v14M16 5v14',
    copy: 'M9 9h10v12H9zM5 15V3h10',
    refresh: 'M20 12a8 8 0 10-2.3 5.7M20 12V6m0 6h-6',
    arrow: 'M5 12h14m-6-6l6 6-6 6',
    sun: 'M12 16a4 4 0 100-8 4 4 0 000 8zM12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M13 15h4',
    dot: 'M12 12h.01',
  };
  function icon(name, size) {
    var s = svgEl('svg', {
      width: size || 18, height: size || 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    });
    s.appendChild(svgEl('path', { d: ICONS[name] || ICONS.box }));
    return s;
  }

  function when(iso) {
    if (!iso) return 'unknown time';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
  }
  function ago(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many || one + 's'); }

  function toast(text) {
    var t = byId('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.classList.remove('show'); }, 3200);
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kryptheon-token': TOKEN },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || data.ok === false) throw new Error(data.why || 'the dashboard answered ' + res.status);
        return data;
      });
    });
  }

  function setBusy(on) {
    busy = on;
    Array.prototype.forEach.call(document.querySelectorAll('[data-action]'), function (b) { b.disabled = on; });
  }
  function copy(text, done) {
    navigator.clipboard.writeText(text).then(function () { toast(done); }, function () {
      toast('Could not copy - select the text instead');
    });
  }
  function button(cls, iconName, text, onClick) {
    var b = el('button', 'btn' + (cls ? ' ' + cls : ''));
    b.type = 'button';
    if (iconName) b.appendChild(icon(iconName, 15));
    b.appendChild(el('span', null, text));
    b.addEventListener('click', onClick);
    return b;
  }

  var CHECK_NAME = { regression: 'Recorded flows', frontend: 'Frontend code', data: 'Database' };
  var CHECK_TONE = { regression: 'sun', frontend: 'amber', data: 'dusk' };

  function counts() {
    var confirmed = state.findings.filter(function (f) { return f.status === 'confirmed'; }).length;
    return { confirmed: confirmed, toVerify: state.findings.length - confirmed, proven: (state.proven || []).length };
  }

  /* ----------------------------------- views ----------------------------------- */

  // One section on screen at a time; the address keeps it, so a reload lands
  // on the same one.
  var VIEWS = [
    { id: 'dashboard', title: 'Dashboard', icon: 'grid' },
    { id: 'findings', title: 'Findings', icon: 'list' },
    { id: 'changes', title: 'What changed', icon: 'change' },
    { id: 'fixes', title: 'Proven fixes', icon: 'wrench' },
    { id: 'checks', title: 'Checks', icon: 'toggle' },
    { id: 'runs', title: 'Runs', icon: 'play' },
    { id: 'storage', title: 'Where this lives', icon: 'box' },
  ];

  function currentView() {
    var id = (location.hash || '').replace(/^#/, '');
    return VIEWS.some(function (v) { return v.id === id; }) ? id : 'dashboard';
  }
  function go(id, filter) {
    if (filter) { statusFilter = filter; if (state) { renderStatusFilter(); renderFindings(); } }
    if (currentView() === id) return showView();
    location.hash = id;
  }
  function showView() {
    var id = currentView();
    VIEWS.forEach(function (v) { byId('view-' + v.id).hidden = v.id !== id; });
    var view = VIEWS.filter(function (v) { return v.id === id; })[0];
    byId('viewTitle').textContent = view.title;
    document.title = (id === 'dashboard' ? '' : view.title + ' - ') + 'Kryptheon';
    if (state) renderSide();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', showView);

  /* ---------------------------------- sidebar ---------------------------------- */

  function renderSide() {
    var c = counts();
    var active = currentView();
    var badge = {
      findings: [state.findings.length, c.confirmed > 0],
      changes: [(state.looks || []).length, false],
      fixes: [c.proven, false],
      runs: [state.runs.length, !!(state.runs[0] && state.runs[0].failed)],
    };
    var box = byId('nav');
    clear(box);
    VIEWS.forEach(function (v) {
      var b = el('button', active === v.id ? 'on' : '');
      b.type = 'button';
      b.appendChild(icon(v.icon, 18));
      b.appendChild(el('span', null, v.title));
      var n = badge[v.id];
      if (n && n[0]) b.appendChild(el('span', 'n-count' + (n[1] ? ' hot' : ''), n[0]));
      if (active === v.id) b.setAttribute('aria-current', 'page');
      b.addEventListener('click', function () { go(v.id); });
      box.appendChild(b);
    });
    var built = state.checks.filter(function (x) { return x.available; }).length;
    byId('builtText').textContent = built + ' / ' + state.checks.length;
    byId('builtBar').style.width = Math.round((built / state.checks.length) * 100) + '%';
    byId('builtNote').textContent = (state.checks.length - built) + ' more are listed as not available - never as passed.';
    var name = state.project.name || 'Project';
    var last = (state.looks || [])[0];
    byId('subline').textContent = name + '  -  ' + (last ? 'watching, last look ' + ago(last.at) : 'watching for changes');
  }

  /* ------------------------------ right now + steps ------------------------------ */

  function renderNow() {
    var sky = byId('sky');
    var ic = byId('skyIcon');
    var title = byId('skyTitle');
    var sub = byId('skySub');
    var actions = byId('skyActions');
    clear(ic); clear(title); clear(sub); clear(actions);
    var next = state.next || { kind: 'quiet', title: 'Nothing open' };
    byId('skyEyebrow').textContent = next.kind === 'quiet' ? 'ALL QUIET' : 'DO THIS NEXT';
    if (next.kind === 'fix') {
      sky.className = 'sky bad';
      ic.style.color = 'var(--ember)';
      ic.appendChild(icon('alert', 28));
      title.textContent = next.title;
      sub.textContent = 'Proven by a check that ran. Open it, copy the fix prompt into your AI tool, then press Re-check - it says FIXED only when it is.';
      actions.appendChild(button('sun', 'arrow', 'Open Findings', function () { go('findings', 'confirmed'); }));
    } else if (next.kind === 'step') {
      sky.className = 'sky';
      ic.style.color = 'var(--sun-deep)';
      ic.appendChild(icon('arrow', 28));
      title.textContent = next.title;
      sub.textContent = 'The next step in setting Kryptheon up. Do it below in Start here.';
      actions.appendChild(button('sun', 'arrow', 'Go to Start here', function () { go('dashboard'); scrollToId('steps'); }));
    } else if (next.kind === 'verify') {
      sky.className = 'sky';
      ic.style.color = 'var(--amber)';
      ic.appendChild(icon('eye', 28));
      title.textContent = next.title;
      sub.textContent = 'Spotted without running anything. Each needs a person to decide.';
      actions.appendChild(button('sun', 'arrow', 'Open Findings', function () { go('findings', 'verify'); }));
    } else {
      sky.className = 'sky ok';
      ic.style.color = 'var(--leaf)';
      ic.appendChild(icon('sun', 28));
      title.textContent = 'Nothing open';
      sub.textContent = 'Nothing open from the checks that are on and have run. That is not the same as nothing wrong - see Checks for what is not built yet.';
      actions.appendChild(button('', 'toggle', 'See the checks', function () { go('checks'); }));
    }
  }

  function scrollToId(id) {
    var t = byId(id);
    if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  var STEP_WORD = { done: 'Done', todo: 'To do', waiting: 'Waiting', off: 'Switched off' };
  var STEP_TONE = { done: 'leaf', todo: 'sun', waiting: 'amber', off: 'muted' };

  function renderSteps() {
    var box = byId('steps');
    clear(box);
    (state.steps || []).forEach(function (s, i) {
      var row = el('div', 'step ' + s.state);
      var num = el('div', 'step-num');
      if (s.state === 'done') num.appendChild(icon('check', 18));
      else num.textContent = String(i + 1).padStart(2, '0');
      row.appendChild(num);
      var body = el('div', 'step-body');
      var head = el('div', 'step-head');
      head.appendChild(el('div', 'step-title', s.title));
      head.appendChild(el('span', 'tag ' + STEP_TONE[s.state], STEP_WORD[s.state] || s.state));
      body.appendChild(head);
      body.appendChild(el('div', 'step-why', s.why + (s.at ? '  -  last ' + ago(s.at) : '') + (s.count ? '  -  ' + plural(s.count, 'recording') + ' held' : '')));
      if (s.action && s.action.kind === 'run') {
        var run = button('sun sm', 'play', s.action.label, function () { runChecks([s.action.check], run); });
        run.setAttribute('data-action', 'run');
        run.disabled = busy;
        body.appendChild(run);
      } else if (s.action && s.action.kind === 'command') {
        var cmd = el('div', 'cmd');
        cmd.appendChild(icon('terminal', 15));
        cmd.appendChild(el('code', null, s.action.command));
        var cp = el('button', 'cmd-copy');
        cp.type = 'button';
        cp.title = 'Copy';
        cp.appendChild(icon('copy', 14));
        cp.addEventListener('click', function () { copy(s.action.command, 'Command copied - run it in your terminal'); });
        cmd.appendChild(cp);
        body.appendChild(cmd);
      }
      row.appendChild(body);
      box.appendChild(row);
    });
  }

  /* ------------------------------ connect your AI tool ------------------------------ */

  // The same set-up kryptheon.tech shows, so the two never disagree. Every
  // step comes from that tool's own documentation, except where a tool is
  // marked tested - there it was run by hand. Static text: nothing here comes
  // from the project being checked.
  var SERVER = { command: 'npx', args: ['-y', 'kryptheon-mcp'] };
  var MCP_JSON = JSON.stringify({ mcpServers: { kryptheon: SERVER } }, null, 2);
  var VSCODE_JSON = JSON.stringify({ servers: { kryptheon: SERVER } }, null, 2);
  var AI_TOOLS = [
    { id: 'claude-code', name: 'Claude Code', tested: true,
      steps: ['Run this once, in any terminal. That is the whole set-up.'],
      code: 'claude mcp add kryptheon -- npx -y kryptheon-mcp', file: 'terminal' },
    { id: 'cursor', name: 'Cursor', tested: false,
      oneClick: { href: 'cursor://anysphere.cursor-deeplink/mcp/install?name=kryptheon&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImtyeXB0aGVvbi1tY3AiXX0=', label: 'Add to Cursor' },
      steps: ['Press Add to Cursor. Cursor asks you to confirm - say yes.', 'Or by hand: paste the config into mcp.json in the .cursor folder of your home folder.'],
      code: MCP_JSON, file: '~/.cursor/mcp.json' },
    { id: 'vscode', name: 'VS Code', tested: false,
      oneClick: { href: 'vscode:mcp/install?' + encodeURIComponent(JSON.stringify({ name: 'kryptheon', command: 'npx', args: ['-y', 'kryptheon-mcp'] })), label: 'Install in VS Code' },
      steps: ['Press Install in VS Code and confirm.', 'Or by hand: run MCP: Add Server from the Command Palette, or put the config in .vscode/mcp.json - VS Code calls the list "servers", not "mcpServers".'],
      code: VSCODE_JSON, file: '.vscode/mcp.json' },
    { id: 'antigravity', name: 'Antigravity', tested: false,
      steps: ['Open Settings, bottom left, then Customizations, then Add MCP. The MCP Store opens.', 'Click Manage MCP Servers, then View raw config.', 'Paste the config and save. Antigravity reloads it by itself.'],
      code: MCP_JSON, file: '~/.gemini/config/mcp_config.json' },
    { id: 'windsurf', name: 'Windsurf', tested: false,
      steps: ['In the Cascade panel, open the ... menu at the top right and click Open MCP config file.', 'Paste the config and save.'],
      note: 'Windsurf is Devin Desktop now. Use the menu rather than hunting for the file: newer versions keep it in %APPDATA%\\devin, older ones in .codeium\\windsurf.',
      code: MCP_JSON, file: 'mcp_config.json' },
    { id: 'claude-desktop', name: 'Claude Desktop', tested: false,
      steps: ['From the Claude menu choose Settings..., then Developer, then Edit Config.', 'Paste the config and save.', 'Quit Claude completely - not just the window - and open it again.'],
      code: MCP_JSON, file: 'claude_desktop_config.json' },
    { id: 'codex', name: 'Codex', tested: false,
      steps: ['Run this once, in any terminal.'],
      code: 'codex mcp add kryptheon -- npx -y kryptheon-mcp', file: 'terminal' },
  ];
  var aiTool = 'claude-code';

  function renderAI() {
    var tabs = byId('aiTabs');
    var panel = byId('aiPanel');
    if (!tabs || !panel) return;
    clear(tabs);
    clear(panel);
    AI_TOOLS.forEach(function (t, i) {
      var b = el('button', 'ai-tab' + (t.id === aiTool ? ' on' : ''));
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', t.id === aiTool ? 'true' : 'false');
      b.appendChild(el('span', 'ai-num', String(i + 1).padStart(2, '0')));
      b.appendChild(el('span', 'ai-name', t.name));
      if (t.oneClick) b.appendChild(el('span', 'ai-tag', '1-click'));
      b.addEventListener('click', function () { aiTool = t.id; renderAI(); });
      tabs.appendChild(b);
    });
    var tool = AI_TOOLS.filter(function (t) { return t.id === aiTool; })[0] || AI_TOOLS[0];
    panel.appendChild(el('span', 'ai-badge' + (tool.tested ? ' tested' : ''), tool.tested ? 'Tested by hand' : "From " + tool.name + "'s own docs - not tested by hand yet"));
    panel.appendChild(el('h4', null, tool.name));
    if (tool.oneClick) {
      var oc = el('div', 'ai-oneclick');
      var link = el('a', 'btn sun', tool.oneClick.label + ' →');
      link.href = tool.oneClick.href;
      oc.appendChild(link);
      oc.appendChild(el('small', null, 'or by hand, below'));
      panel.appendChild(oc);
    }
    var ol = el('ol', 'ai-steps');
    tool.steps.forEach(function (s, i) {
      var li = el('li');
      li.appendChild(el('span', null, String(i + 1)));
      li.appendChild(el('div', null, s));
      ol.appendChild(li);
    });
    panel.appendChild(ol);
    var plate = el('div', 'ai-plate');
    var bar = el('div', 'ai-plate-bar');
    bar.appendChild(el('span', null, tool.file));
    var cp = el('button', null, 'Copy');
    cp.type = 'button';
    cp.addEventListener('click', function () { copy(tool.code, tool.file === 'terminal' ? 'Command copied - run it in a terminal' : 'Config copied - paste it into ' + tool.file); });
    bar.appendChild(cp);
    plate.appendChild(bar);
    plate.appendChild(el('pre', null, tool.code));
    panel.appendChild(plate);
    if (tool.note) panel.appendChild(el('p', 'ai-note', tool.note));
    if (tool.file !== 'terminal') {
      panel.appendChild(el('p', 'ai-note', 'On Windows, if it says it cannot start npx: use "command": "cmd" and "args": ["/c", "npx", "-y", "kryptheon-mcp"] instead.'));
    }
    panel.appendChild(el('p', 'ai-note', 'To let it check your database too, add "env": { "KN_DATABASE_URL": "postgresql://..." } to the kryptheon entry. Never paste the connection string into the chat - that puts the password to your whole database in a transcript.'));
    var then = el('p', 'ai-then');
    then.appendChild(document.createTextNode('Then just ask your assistant: '));
    then.appendChild(el('b', null, '“Check my app.”'));
    panel.appendChild(then);
  }

  /* ---------------------------------- findings ---------------------------------- */

  var statusFilter = 'all';
  var query = '';

  function renderStatusFilter() {
    var box = byId('statusFilter');
    clear(box);
    [['all', 'All'], ['confirmed', 'Confirmed'], ['verify', 'To verify']].forEach(function (s) {
      var b = el('button', statusFilter === s[0] ? 'on' : '', s[1]);
      b.type = 'button';
      b.addEventListener('click', function () { statusFilter = s[0]; renderStatusFilter(); renderFindings(); });
      box.appendChild(b);
    });
  }
  function statusTag(f) {
    var t = el('span', 'tag ' + (f.status === 'confirmed' ? 'ember' : 'amber'));
    t.appendChild(el('span', f.status === 'confirmed' ? 'g-dot' : 'g-half'));
    t.appendChild(el('span', null, f.status === 'confirmed' ? 'Confirmed' : 'To verify'));
    return t;
  }
  function sevTag(sev) {
    var tone = /CRITICAL/.test(sev) ? 'ember' : sev === 'HIGH' ? 'sun' : sev === 'MEDIUM' ? 'amber' : 'leaf';
    return el('span', 'tag ' + tone, sev);
  }

  var VERDICT_TONE = { fixed: 'leaf', 'still open': 'ember', 'gone with its file': 'amber', 'could not confirm': 'amber' };

  function detailBox(f) {
    var box = el('div', 'detail-box');
    box.appendChild(el('div', 'd-step', 'WHAT IS WRONG'));
    box.appendChild(el('div', 'd-text', f.detail || f.headline));
    box.appendChild(el('div', 'd-text', 'Seen ' + when(f.when) + '  -  ' + f.evidence + '  -  id ' + f.id));
    if (f.fixPrompt) {
      box.appendChild(el('div', 'd-step', 'STEP 1 - PASTE THIS INTO YOUR AI TOOL'));
      box.appendChild(el('pre', null, f.fixPrompt));
    }
    box.appendChild(el('div', 'd-step', f.fixPrompt ? 'STEP 2 - AFTER IT CHANGES THE CODE, RE-CHECK' : 'RE-CHECK'));
    var actions = el('div', 'd-actions');
    if (f.fixPrompt) {
      actions.appendChild(button('', 'copy', 'Copy fix prompt', function (e) {
        e.stopPropagation();
        copy(f.fixPrompt, 'Fix prompt copied - paste it into your AI tool');
      }));
    }
    var re = button('sun sm', 'refresh', 'Re-check', function (e) { e.stopPropagation(); recheck(f, re); });
    re.setAttribute('data-action', 'recheck');
    re.disabled = busy;
    actions.appendChild(re);
    box.appendChild(actions);
    if (f.attempts && f.attempts.length) {
      var list = el('div', 'attempts');
      f.attempts.slice(-4).reverse().forEach(function (a) {
        var r = el('div');
        r.appendChild(el('span', 'tag ' + (VERDICT_TONE[a.verdict] || ''), a.verdict));
        r.appendChild(el('span', null, 'Re-checked ' + ago(a.at) + (a.why ? ' - ' + a.why : '') + (a.newProblems ? ' - ' + plural(a.newProblems, 'new problem') : '')));
        list.appendChild(r);
      });
      box.appendChild(list);
    }
    return box;
  }

  function renderFindings() {
    var body = byId('findingList');
    clear(body);
    var shown = state.findings.filter(function (f) {
      if (statusFilter === 'confirmed' && f.status !== 'confirmed') return false;
      if (statusFilter === 'verify' && f.status === 'confirmed') return false;
      return true;
    });
    byId('findingBadge').textContent = shown.length + (shown.length !== state.findings.length ? ' of ' + state.findings.length : '');
    if (!shown.length) {
      body.appendChild(el('p', 'empty', state.findings.length ? 'Nothing matches.' : 'Nothing found by the checks that are on and have run. That is not the same as nothing wrong - see which checks are not built yet.'));
      return;
    }
    shown.forEach(function (f) {
      var card = el('div', 'finding ' + (f.status === 'confirmed' ? 'bad' : 'warn'));
      var head = el('button', 'finding-head');
      head.type = 'button';
      var left = el('div', 'finding-left');
      left.appendChild(el('div', 'f-title', f.headline));
      var meta = el('div', 'f-meta');
      meta.appendChild(sevTag(f.severity));
      meta.appendChild(statusTag(f));
      meta.appendChild(el('span', 'tag ' + (CHECK_TONE[f.check] || ''), CHECK_NAME[f.check] || f.check));
      if (f.from === 'nightly' || f.from === 'both') meta.appendChild(el('span', 'tag', f.from === 'both' ? 'also nightly' : 'nightly'));
      meta.appendChild(el('span', 'f-where', f.where));
      left.appendChild(meta);
      head.appendChild(left);
      head.appendChild(icon(openRow === f.id ? 'change' : 'arrow', 18));
      head.addEventListener('click', function () { openRow = openRow === f.id ? null : f.id; renderFindings(); });
      card.appendChild(head);
      if (openRow === f.id) card.appendChild(detailBox(f));
      body.appendChild(card);
    });
  }

  /* -------------------------------- other views -------------------------------- */

  var LOOKS_SHOWN = 12;
  function renderTimeline() {
    var box = byId('timeline');
    clear(box);
    var looks = state.looks || [];
    byId('lookBadge').textContent = String(looks.length);
    if (!looks.length) {
      box.appendChild(el('p', 'empty', 'Kryptheon has not looked at a change yet. It does by itself while this page is open, and whenever npx kryptheon verify runs.'));
      return;
    }
    (allLooks ? looks : looks.slice(0, LOOKS_SHOWN)).forEach(function (look) {
      var item = el('div', 'tl');
      item.appendChild(el('div', 'knob' + (look.newFindings ? ' bad' : look.fixed ? ' ok' : look.goneWithFile ? ' mid' : '')));
      var body = el('div');
      body.appendChild(el('div', 'tl-head', look.first ? 'Starting point'
        : look.fileCount ? plural(look.fileCount, 'file') + ' changed - ' + look.parts.join(', ') : 'Nothing changed'));
      body.appendChild(el('div', 'tl-meta', (look.by === 'watch' ? 'Noticed by itself' : look.by === 'recheck' ? 'Re-check' : 'npx kryptheon verify') + ' - ' + when(look.at)));
      var tags = el('div', 'tl-body');
      if (look.newFindings) tags.appendChild(el('span', 'tag ember', look.newFindings + ' new'));
      if (look.fixed) tags.appendChild(el('span', 'tag leaf', look.fixed + ' fixed'));
      if (look.goneWithFile) tags.appendChild(el('span', 'tag amber', look.goneWithFile + ' gone with its file'));
      look.checks.forEach(function (c) { tags.appendChild(el('span', 'tag', c.id + ': ' + c.state)); });
      body.appendChild(tags);
      var files = el('div', 'tl-files');
      look.files.slice(0, 5).forEach(function (f) { files.appendChild(el('div', null, f.state + '  ' + f.path)); });
      if (look.fileCount > 5) files.appendChild(el('div', null, '... and ' + (look.fileCount - 5) + ' more'));
      look.dependencies.forEach(function (d) { files.appendChild(el('div', null, 'package ' + d.name + ': ' + d.change + (d.to ? ' ' + d.to : ''))); });
      body.appendChild(files);
      item.appendChild(body);
      box.appendChild(item);
    });
    if (looks.length > LOOKS_SHOWN) {
      box.appendChild(button('sm', null, allLooks ? 'Show the latest ' + LOOKS_SHOWN : 'Show all ' + looks.length, function () { allLooks = !allLooks; renderTimeline(); }));
    }
  }

  function renderFixes() {
    var box = byId('fixList');
    clear(box);
    var list = state.proven || [];
    byId('fixBadge').textContent = String(list.length);
    if (!list.length) { box.appendChild(el('p', 'empty', 'No fix has been proven yet. Open a finding, fix it, and press Re-check.')); return; }
    list.forEach(function (p) {
      var row = el('div', 'line-row');
      row.appendChild(el('span', 'tag leaf', 'FIXED'));
      var text = el('div', 'lr-text');
      text.appendChild(el('div', null, p.headline));
      text.appendChild(el('div', 'lr-sub', p.where + ' - proven ' + ago(p.at) + (p.newProblems ? ' - ' + plural(p.newProblems, 'new problem') + ' at the time' : '')));
      row.appendChild(text);
      box.appendChild(row);
    });
  }

  var STATE_TONE = { 'problems found': 'ember', 'things to check': 'amber', 'last run held': 'leaf', 'nothing found': 'leaf' };
  function checkSwitch(c) {
    var sw = el('label', 'switch');
    var input = el('input');
    input.type = 'checkbox';
    input.checked = !!c.enabled;
    input.disabled = !c.available;
    input.setAttribute('aria-label', c.label + (c.available ? '' : ' - not available'));
    input.addEventListener('change', function () { setCheck(c.id, input.checked, input); });
    sw.appendChild(input);
    sw.appendChild(el('span', 'track'));
    return sw;
  }
  function renderChecks() {
    var box = byId('checkList');
    clear(box);
    var na = byId('naList');
    clear(na);
    var missing = 0;
    state.checks.forEach(function (c) {
      if (!c.available) {
        missing++;
        var row = el('div', 'na');
        row.appendChild(checkSwitch(c));
        var nm = el('div', null, c.label);
        nm.appendChild(el('span', 'na-lock', 'NOT AVAILABLE'));
        row.appendChild(nm);
        na.appendChild(row);
        return;
      }
      var card = el('div', 'check');
      var top = el('div', 'c-top');
      top.appendChild(el('div', 'c-name', c.label));
      top.appendChild(checkSwitch(c));
      card.appendChild(top);
      var st = el('div');
      st.appendChild(el('span', 'tag ' + (STATE_TONE[c.state] || ''), c.state));
      card.appendChild(st);
      if (c.what) card.appendChild(el('div', 'c-what', c.what));
      // What the nightly run inside the database last said - its own answer,
      // not this terminal's, so it gets its own line.
      if (c.nightly) card.appendChild(el('div', 'c-what', c.nightly));
      if (c.runnable && c.enabled) {
        var run = button('sm', 'play', 'Run now', function () { runChecks([c.id], run); });
        run.setAttribute('data-action', 'run');
        run.disabled = busy;
        card.appendChild(run);
      } else if (!c.enabled) {
        card.appendChild(el('div', 'c-what', 'Switched off - it will not run.'));
      }
      box.appendChild(card);
    });
    byId('naBadge').textContent = String(missing);
  }

  function renderRuns() {
    var box = byId('runList');
    clear(box);
    byId('runBadge').textContent = String(state.runs.length);
    if (!state.runs.length) { box.appendChild(el('p', 'empty', 'No recorded flows have been replayed yet. Record one with npx kryptheon record, then press Run checks.')); return; }
    state.runs.slice(0, 30).forEach(function (r) {
      var row = el('div', 'line-row');
      row.appendChild(el('span', 'tag ' + (r.failed ? 'ember' : 'leaf'), r.failed ? r.failed + ' broke' : 'held'));
      var text = el('div', 'lr-text');
      text.appendChild(el('div', null, (r.passed || 0) + ' held, ' + (r.failed || 0) + ' broke'));
      text.appendChild(el('div', 'lr-sub', when(r.runAt)));
      row.appendChild(text);
      if (r.failed) row.appendChild(button('sm', 'arrow', 'See the finding', function () { go('findings', 'confirmed'); }));
      box.appendChild(row);
    });
  }

  var STORE_FILES = [
    ['baselines.json', 'what each page looked like the last time it worked'],
    ['history.jsonl', 'every run of your recorded flows'],
    ['test-results/', 'screenshots and traces from runs that broke'],
    ['code-findings.json', 'the last read of your frontend code'],
    ['night-last.json', 'the last database check'],
    ['night-nightly.json', 'what the nightly run inside your database last said'],
    ['snapshot.json', 'what your files looked like at the last look'],
    ['changes.jsonl', 'every look: what changed, what broke, what got fixed'],
    ['fixes.jsonl', 'every re-check and its verdict'],
    ['config.json', 'which checks are switched on'],
  ];
  function renderStorage() {
    byId('storeNote').textContent = 'Everything on this dashboard is read from this folder on your machine. Nothing is sent anywhere. Your project keeps only its recordings in tests/.';
    byId('storePath').textContent = state.project.storeDir;
    var box = byId('storeFiles');
    clear(box);
    STORE_FILES.forEach(function (f) {
      var row = el('div');
      row.appendChild(el('code', null, f[0]));
      row.appendChild(el('span', null, f[1]));
      box.appendChild(row);
    });
  }

  /* ---------------------------------- actions ---------------------------------- */

  function recheck(f, btn) {
    if (busy) return;
    setBusy(true);
    clear(btn);
    btn.appendChild(el('span', 'spin'));
    btn.appendChild(el('span', null, f.check === 'regression' ? 'Replaying...' : 'Re-checking...'));
    post('/api/recheck', { id: f.id }).then(function (r) {
      var words = { fixed: 'FIXED', 'still open': 'STILL OPEN', 'gone with its file': 'GONE WITH ITS FILE - not the same as fixed', 'could not confirm': 'COULD NOT CONFIRM' };
      toast((words[r.verdict] || r.verdict) + (r.why ? ' - ' + r.why : '') + (r.newProblems && r.newProblems.length ? ' - ' + plural(r.newProblems.length, 'new problem') : ''));
    }).catch(function (err) { toast('Re-check failed: ' + err.message); }).then(function () { setBusy(false); return load(); });
  }

  function runChecks(ids, btn) {
    if (busy || !ids.length) return;
    setBusy(true);
    clear(btn);
    btn.appendChild(el('span', 'spin'));
    btn.appendChild(el('span', null, 'Running...'));
    ids.reduce(function (chain, id) {
      return chain.then(function () { return post('/api/run', { id: id }); });
    }, Promise.resolve()).then(function () {
      toast('Finished: ' + ids.map(function (id) { return CHECK_NAME[id] || id; }).join(', '));
    }).catch(function (err) { toast('Run failed: ' + err.message); }).then(function () { setBusy(false); return load(); });
  }

  function setCheck(id, on, input) {
    post('/api/check', { id: id, on: on }).then(function () {
      toast((on ? 'Switched on: ' : 'Switched off: ') + (CHECK_NAME[id] || id));
      return load();
    }).catch(function (err) { input.checked = !on; toast('Not saved: ' + err.message); });
  }

  byId('runAll').addEventListener('click', function () {
    if (!state) return;
    var ids = state.checks.filter(function (c) { return c.runnable && c.enabled; }).map(function (c) { return c.id; });
    if (!ids.length) { toast('Nothing can run from here yet - switch a check on, or record a flow.'); return; }
    runChecks(ids, byId('runAll'));
  });

  /* ----------------------------------- load ----------------------------------- */

  function renderTop() {
    var run = byId('runAll');
    if (!busy) { clear(run); run.appendChild(icon('play', 15)); run.appendChild(el('span', null, 'Run checks')); }
  }

  function render(next) {
    if (!next) return;
    state = next;
    renderSide();
    renderTop();
    renderNow();
    renderSteps();
    renderStatusFilter();
    renderFindings();
    renderTimeline();
    renderFixes();
    renderChecks();
    renderRuns();
    renderStorage();
  }

  function load() {
    return fetch('/api/state', { cache: 'no-store' })
      .then(function (res) { if (!res.ok) throw new Error('the dashboard answered ' + res.status); return res.json(); })
      .then(render)
      .catch(function (err) { byId('subline').textContent = 'Could not load: ' + err.message; });
  }

  renderAI();
  showView();
  load();
  // Not while something runs, and not while a finding is open being read.
  setInterval(function () { if (!busy && !openRow) load(); }, 5000);
})();
