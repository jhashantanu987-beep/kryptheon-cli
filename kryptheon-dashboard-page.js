// The dashboard page. Served from 127.0.0.1 by kryptheon-dashboard.js.
//
// Every value on this page can hold text from the app being checked - a line
// of its code, the heading of a page that broke. So nothing here is ever
// written as HTML: every node is made with createElement (or createElementNS
// for the charts and icons, from numbers and fixed path data) and filled with
// textContent. This file is read by kryptheon-code.js in its own check, and
// must come back with nothing to report.

(function () {
  'use strict';

  var tokenMeta = document.querySelector('meta[name="kryptheon-token"]');
  var TOKEN = tokenMeta ? tokenMeta.getAttribute('content') : '';
  var NS = 'http://www.w3.org/2000/svg';
  var state = null;
  var busy = false;
  var statusFilter = 'all';
  var range = 'all';
  var query = '';
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
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }
  function byId(id) {
    return document.getElementById(id);
  }
  // A sentence with its important words marked: parts are plain strings, or
  // { hl: text } for the words someone skimming must not miss.
  function rich(node, parts) {
    parts.forEach(function (p) {
      node.appendChild(typeof p === 'string' ? document.createTextNode(p) : el('span', 'hl', p.hl));
    });
    return node;
  }

  // Line icons from fixed path data only.
  var ICONS = {
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
    change: 'M4 12h4l3-7 4 14 3-7h2',
    wrench: 'M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.6 2.6-2.4-.6-.6-2.4 2.6-2.6z',
    toggle: 'M8 7h8a5 5 0 010 10H8A5 5 0 018 7zm0 3a2 2 0 100 4 2 2 0 000-4z',
    play: 'M7 5l12 7-12 7V5z',
    shield: 'M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5l8-3z',
    box: 'M4 7l8-4 8 4v10l-8 4-8-4V7zm0 0l8 4 8-4M12 11v10',
    search: 'M11 18a7 7 0 100-14 7 7 0 000 14zm9 3l-4.3-4.3',
    bell: 'M6 16V11a6 6 0 1112 0v5l2 2H4l2-2zm4 4h4',
    alert: 'M12 3l10 18H2L12 3zm0 7v5m0 3v.5',
    eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    film: 'M4 5h16v14H4zM4 9h16M4 15h16M8 5v14M16 5v14',
    copy: 'M9 9h10v12H9zM5 15V3h10',
    refresh: 'M20 12a8 8 0 10-2.3 5.7M20 12V6m0 6h-6',
    arrow: 'M5 12h14m-6-6l6 6-6 6',
    sun: 'M12 16a4 4 0 100-8 4 4 0 000 8zM12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    lock: 'M6 11h12v10H6zM8 11V7a4 4 0 018 0v4',
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
  function shortDate(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many || one + 's');
  }

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
  var CHECK_COLOR = { regression: '#ec7433', frontend: '#d49b33', data: '#6d4a7c' };

  function counts() {
    var confirmed = state.findings.filter(function (f) { return f.status === 'confirmed'; }).length;
    return {
      confirmed: confirmed,
      toVerify: state.findings.length - confirmed,
      lastRun: state.runs[0],
      lastLook: (state.looks || [])[0],
      proven: (state.proven || []).length,
      built: state.checks.filter(function (c) { return c.available; }).length,
    };
  }

  /* ----------------------------------- views ----------------------------------- */

  // One section on screen at a time; the address keeps it, so a reload or the
  // back button lands on the same one.
  var VIEWS = [
    { id: 'dashboard', title: 'Dashboard', icon: 'grid', group: 'navOverview' },
    { id: 'findings', title: 'Findings', icon: 'list', group: 'navOverview' },
    { id: 'changes', title: 'What changed', icon: 'change', group: 'navOverview' },
    { id: 'fixes', title: 'Proven fixes', icon: 'wrench', group: 'navOverview' },
    { id: 'checks', title: 'Checks', icon: 'toggle', group: 'navWorkspace' },
    { id: 'runs', title: 'Runs', icon: 'play', group: 'navWorkspace' },
    { id: 'verification', title: 'Verification', icon: 'shield', group: 'navWorkspace' },
    { id: 'storage', title: 'Where this lives', icon: 'box', group: 'navWorkspace' },
  ];

  // What each section is for, with the words that decide it marked.
  var WHEN = {
    findings: ['Open this when something ', { hl: 'broke or looks risky' }, '. Click a row, ', { hl: 'copy the fix prompt' },
      ' into your AI tool, then press ', { hl: 'Re-check' }, ' - it says FIXED only when it is.'],
    changes: ['Open this to see ', { hl: 'what your AI changed' }, ' - every file, and what broke or got fixed with it. ',
      'Kryptheon looks by itself while this page is open.'],
    fixes: ['Open this for ', { hl: 'proof' }, '. A fix is listed only after a ', { hl: 're-check passed' },
      ' - never just because the code changed.'],
    checks: ['Open this to ', { hl: 'switch checks on or off' }, ', or run one now. Checks that are not built yet are listed, and ',
      { hl: 'never counted as passed' }, '.'],
    runs: ['Open this when a ', { hl: 'recorded flow' }, ' - sign-up, login, checkout - ', { hl: 'stopped working' },
      '. Each run replays your recordings against your app.'],
    verification: ['Open this for the ', { hl: 'Kryptheon Verified' }, ' badge. It is ', { hl: 'not built yet' },
      ', so nothing here is verified.'],
    storage: ['Open this to see ', { hl: 'where your records are kept' }, '. Nothing is sent anywhere, and ',
      { hl: 'nothing is written into your project' }, '.'],
  };

  function currentView() {
    var id = (location.hash || '').replace(/^#/, '');
    return VIEWS.some(function (v) { return v.id === id; }) ? id : 'dashboard';
  }

  function go(id, filter) {
    if (filter) {
      statusFilter = filter;
      if (state) { renderStatusFilter(); renderFindings(); }
    }
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
    // The chart measures itself, so it is drawn again once it is on screen.
    if (state && id === 'dashboard') renderChart();
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
      runs: [state.runs.length, !!(c.lastRun && c.lastRun.failed)],
    };
    ['navOverview', 'navWorkspace'].forEach(function (group) {
      var box = byId(group);
      clear(box);
      VIEWS.filter(function (v) { return v.group === group; }).forEach(function (v) {
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
    });
    byId('builtText').textContent = c.built + ' / ' + state.checks.length;
    byId('builtBar').style.width = Math.round((c.built / state.checks.length) * 100) + '%';
    byId('builtNote').textContent = (state.checks.length - c.built) + ' more are listed as not available - never as passed.';
    var name = state.project.name || 'Project';
    byId('avatar').textContent = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'K';
    byId('projName').textContent = name;
    byId('projPath').textContent = state.project.root;
    byId('projPath').title = state.project.root;
  }

  /* ---------------------------------- topbar ---------------------------------- */

  function renderTop() {
    var last = (state.looks || [])[0];
    byId('subline').textContent = last ? 'Watching - last look ' + ago(last.at) : 'Watching for changes';
    var si = byId('searchIcon');
    clear(si);
    si.appendChild(icon('search', 16));
    var bell = byId('bell');
    clear(bell);
    bell.appendChild(icon('bell', 20));
    var fresh = last && !last.first ? last.newFindings : 0;
    if (fresh) bell.appendChild(el('span', 'bdot'));
    bell.title = fresh ? plural(fresh, 'new finding') + ' in the last look - open What changed' : 'Nothing new in the last look';
    var run = byId('runAll');
    if (!busy) {
      clear(run);
      run.appendChild(icon('play', 15));
      run.appendChild(el('span', null, 'Run checks'));
    }
  }

  /* --------------------------------- dashboard --------------------------------- */

  function renderSky() {
    var c = counts();
    var sky = byId('sky');
    var ic = byId('skyIcon');
    var title = byId('skyTitle');
    var sub = byId('skySub');
    var actions = byId('skyActions');
    clear(ic);
    clear(title);
    clear(sub);
    clear(actions);
    if (c.confirmed) {
      sky.className = 'sky bad';
      ic.style.color = 'var(--ember)';
      ic.appendChild(icon('alert', 28));
      byId('skyEyebrow').textContent = 'NEEDS YOU NOW';
      rich(title, [{ hl: plural(c.confirmed, 'confirmed problem') }]);
      rich(sub, ['Proven by a check that ran. Open ', { hl: 'Findings' }, ', copy the fix prompt into your AI tool, then press ',
        { hl: 'Re-check' }, '.' + (c.toVerify ? ' ' + c.toVerify + (c.toVerify === 1 ? ' more needs' : ' more need') + ' a look.' : '')]);
      actions.appendChild(button('sun', 'arrow', 'Open Findings', function () { go('findings', 'confirmed'); }));
    } else if (c.toVerify) {
      sky.className = 'sky';
      ic.style.color = 'var(--amber)';
      ic.appendChild(icon('eye', 28));
      byId('skyEyebrow').textContent = 'WORTH A LOOK';
      rich(title, [{ hl: plural(c.toVerify, 'thing') + ' to verify' }]);
      rich(sub, ['Nothing confirmed broken. These were spotted ', { hl: 'without running anything' },
        ' - each needs a person to decide.']);
      actions.appendChild(button('sun', 'arrow', 'Open Findings', function () { go('findings', 'verify'); }));
    } else {
      sky.className = 'sky ok';
      ic.style.color = 'var(--leaf)';
      ic.appendChild(icon('sun', 28));
      byId('skyEyebrow').textContent = 'ALL QUIET';
      rich(title, ['Holding']);
      rich(sub, ['Nothing open from the checks that are on and have run. That is ', { hl: 'not the same as nothing wrong' },
        ' - ' + (state.checks.length - c.built) + ' checks are not built yet.']);
      actions.appendChild(button('sun', 'arrow', 'See the checks', function () { go('checks'); }));
    }
    if (c.lastLook && !c.lastLook.first && c.lastLook.fileCount) {
      actions.appendChild(button('', 'change', 'What changed', function () { go('changes'); }));
    }
  }

  function kpi(label, value, iconName, tone, foot, goText, onOpen) {
    var box = el('button', 'kpi raised');
    box.type = 'button';
    var top = el('div', 'kpi-top');
    var chip = el('div', 'ichip ' + tone);
    chip.appendChild(icon(iconName, 18));
    top.appendChild(chip);
    top.appendChild(el('div', 'kpi-label', label));
    box.appendChild(top);
    box.appendChild(el('div', 'kpi-num', value));
    var f = el('div', 'kpi-foot');
    foot.forEach(function (part) { f.appendChild(part); });
    box.appendChild(f);
    box.appendChild(el('div', 'kpi-go', goText + ' →'));
    box.addEventListener('click', onOpen);
    return box;
  }
  function delta(kind, text) {
    return el('span', 'delta ' + kind, (kind === 'up' ? '▲ ' : kind === 'down' ? '▼ ' : '') + text);
  }

  function renderKpis() {
    var box = byId('kpis');
    clear(box);
    var c = counts();
    var newFound = c.lastLook && !c.lastLook.first ? c.lastLook.newFindings : 0;
    var week = Date.now() - 7 * 86400000;
    var fixedWeek = (state.proven || []).filter(function (p) { return new Date(p.at).getTime() > week; }).length;
    box.appendChild(kpi('CONFIRMED', c.confirmed, 'alert', 'ember', newFound
      ? [delta('down', newFound + ' new'), el('span', null, 'in the last look')]
      : c.confirmed ? [el('span', null, 'open now, each with a fix prompt')] : [delta('up', 'none open')],
    'Open Findings', function () { go('findings', 'confirmed'); }));
    box.appendChild(kpi('TO VERIFY', c.toVerify, 'eye', 'amber', [el('span', null, 'spotted without running anything')],
      'Open Findings', function () { go('findings', 'verify'); }));
    box.appendChild(kpi('PROVEN FIXES', c.proven, 'wrench', 'leaf', fixedWeek ? [delta('up', fixedWeek + ' this week')] : [delta('flat', 'none this week')],
      'Open Proven fixes', function () { go('fixes'); }));
    var r = c.lastRun;
    box.appendChild(kpi('FLOWS HELD', r ? r.passed + ' / ' + (r.passed + r.failed) : '-', 'film', 'sun', r
      ? [delta(r.failed ? 'down' : 'up', r.failed ? r.failed + ' broke' : 'all held'), el('span', null, ago(r.runAt))]
      : [el('span', null, plural(state.recordings, 'recording') + ', never run')],
    'Open Runs', function () { go('runs'); }));
  }

  function renderGuide() {
    var box = byId('guide');
    clear(box);
    var c = counts();
    var looks = state.looks || [];
    var items = [
      { view: 'findings', parts: ['Something ', { hl: 'broke or looks risky' }, ' after your AI changed code'],
        state: state.findings.length ? c.confirmed + ' confirmed, ' + c.toVerify + ' to verify' : 'nothing open',
        tone: c.confirmed ? 'hot' : c.toVerify ? 'warm' : 'cool' },
      { view: 'runs', parts: ['A ', { hl: 'recorded flow' }, ' (sign-up, login, checkout) stopped working'],
        state: c.lastRun ? (c.lastRun.failed ? plural(c.lastRun.failed, 'flow') + ' broke in the last run' : 'last run held') : 'never replayed',
        tone: c.lastRun ? (c.lastRun.failed ? 'hot' : 'cool') : '' },
      { view: 'changes', parts: ['You want to see ', { hl: 'what your AI touched' }],
        state: looks.length ? plural(looks.length, 'look') + ', last ' + ago(looks[0].at) : 'no look yet',
        tone: c.lastLook && !c.lastLook.first && c.lastLook.newFindings ? 'hot' : looks.length ? 'cool' : '' },
      { view: 'fixes', parts: ['You fixed something and want ', { hl: 'proof it is fixed' }],
        state: c.proven ? plural(c.proven, 'fix', 'fixes') + ' proven' : 'none proven yet', tone: c.proven ? 'cool' : '' },
      { view: 'checks', parts: ['You want to ', { hl: 'switch a check' }, ' on or off, or run one'],
        state: c.built + ' of ' + state.checks.length + ' built', tone: '' },
      { view: 'verification', parts: ['You want the ', { hl: 'Kryptheon Verified' }, ' badge'],
        state: state.verification.state, tone: 'warm' },
      { view: 'storage', parts: ['You want to know ', { hl: 'where your records are kept' }],
        state: 'on this machine only', tone: 'cool' },
    ];
    items.forEach(function (it) {
      var v = VIEWS.filter(function (x) { return x.id === it.view; })[0];
      var row = el('button', 'g-row');
      row.type = 'button';
      row.appendChild(el('span', 'g-dot' + (it.tone ? ' ' + it.tone : '')));
      var text = el('span');
      rich(text, it.parts);
      text.appendChild(el('span', 'g-state', it.state));
      row.appendChild(text);
      var to = el('span', 'g-to');
      to.appendChild(el('span', 'ul', v.title));
      to.appendChild(icon('arrow', 15));
      row.appendChild(to);
      row.addEventListener('click', function () { go(it.view); });
      box.appendChild(row);
    });
  }

  /* ----------------------------------- chart ----------------------------------- */

  function renderRange() {
    var box = byId('range');
    clear(box);
    [['all', 'All'], ['30', '30D'], ['7', '7D']].forEach(function (r) {
      var b = el('button', range === r[0] ? 'on' : '', r[1]);
      b.type = 'button';
      b.addEventListener('click', function () { range = r[0]; renderRange(); renderChart(); });
      box.appendChild(b);
    });
  }

  function renderChart() {
    var box = byId('chart');
    clear(box);
    var runs = state.runs.slice().reverse();
    if (range !== 'all') {
      var since = Date.now() - Number(range) * 86400000;
      runs = runs.filter(function (r) { return new Date(r.runAt).getTime() >= since; });
    }
    byId('chartSub').textContent = runs.length
      ? plural(runs.length, 'run') + ' - ' + shortDate(runs[0].runAt) + ' to ' + shortDate(runs[runs.length - 1].runAt) + ' - red dots broke'
      : 'No runs in this range';
    if (!runs.length) {
      box.appendChild(el('p', 'empty', 'No recorded flows have been replayed in this range.'));
      return;
    }
    var W = 720;
    var H = 210;
    var L = 40;
    var R = 12;
    var T = 18;
    var B = 28;
    var top = Math.max(1, Math.max.apply(null, runs.map(function (r) { return (r.passed || 0) + (r.failed || 0); })));
    var x = function (i) { return runs.length === 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (runs.length - 1); };
    var y = function (v) { return T + (H - T - B) * (1 - v / top); };
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Recorded flows that held, per run' });
    var defs = svgEl('defs');
    var grad = svgEl('linearGradient', { id: 'kfill', x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#f39a5c', 'stop-opacity': 0.42 }));
    grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#fbd3b5', 'stop-opacity': 0.04 }));
    defs.appendChild(grad);
    var stroke = svgEl('linearGradient', { id: 'kline', x1: 0, y1: 0, x2: 1, y2: 0 });
    stroke.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#d49b33' }));
    stroke.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#e5652b' }));
    defs.appendChild(stroke);
    svg.appendChild(defs);
    var steps = top <= 4 ? top : 4;
    for (var g = 0; g <= steps; g++) {
      var v = Math.round((top * g) / steps);
      svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: 'rgba(138,109,94,0.14)', 'stroke-width': 1 }));
      var lab = svgEl('text', { x: L - 10, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#8a6d5e' });
      lab.textContent = String(v);
      svg.appendChild(lab);
    }
    var pts = runs.map(function (r, i) { return [x(i), y(r.passed || 0)]; });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var area = line + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + (H - B) + ' L' + pts[0][0].toFixed(1) + ' ' + (H - B) + ' Z';
    svg.appendChild(svgEl('path', { d: area, fill: 'url(#kfill)' }));
    svg.appendChild(svgEl('path', { d: line, fill: 'none', stroke: 'url(#kline)', 'stroke-width': 3, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    runs.forEach(function (r, i) {
      if (r.failed) svg.appendChild(svgEl('circle', { cx: pts[i][0], cy: pts[i][1], r: 5, fill: '#c2412d', stroke: '#fffaf5', 'stroke-width': 2 }));
    });
    // All on one day: the date says nothing, the time does.
    var sameDay = shortDate(runs[0].runAt) === shortDate(runs[runs.length - 1].runAt);
    var labels = Math.min(runs.length, 6);
    var lastLabel = '';
    for (var k = 0; k < labels; k++) {
      var idx = labels === 1 ? 0 : Math.round((k * (runs.length - 1)) / (labels - 1));
      var text = sameDay
        ? new Date(runs[idx].runAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        : shortDate(runs[idx].runAt);
      // Two runs in the same minute (or day) would print the same label twice.
      if (text === lastLabel) continue;
      lastLabel = text;
      var t = svgEl('text', { x: x(idx), y: H - 6, 'text-anchor': 'middle', 'font-size': 11, fill: '#8a6d5e' });
      t.textContent = text;
      svg.appendChild(t);
    }
    var ring = svgEl('circle', { r: 7, fill: '#fffaf5', stroke: '#e5652b', 'stroke-width': 3 });
    svg.appendChild(ring);
    box.appendChild(svg);
    var stem = el('div', 'stem');
    var tip = el('div', 'tip');
    var tDate = el('div', 't-date');
    var tVal = el('div', 't-val');
    tip.appendChild(tDate);
    tip.appendChild(tVal);
    box.appendChild(stem);
    box.appendChild(tip);

    function point(i) {
      var r = runs[i];
      ring.setAttribute('cx', pts[i][0]);
      ring.setAttribute('cy', pts[i][1]);
      ring.setAttribute('stroke', r.failed ? '#c2412d' : '#e5652b');
      var rect = svg.getBoundingClientRect();
      var px = (pts[i][0] / W) * rect.width;
      var py = (pts[i][1] / H) * rect.height;
      tDate.textContent = when(r.runAt);
      clear(tVal);
      var dot = el('i');
      dot.style.background = r.failed ? '#c2412d' : '#3b8657';
      tVal.appendChild(dot);
      tVal.appendChild(el('span', null, (r.passed || 0) + ' held' + (r.failed ? ', ' + r.failed + ' broke' : '')));
      tip.style.left = px + 'px';
      tip.style.top = Math.max(0, py - 22) + 'px';
      stem.style.left = px + 'px';
      stem.style.top = Math.max(0, py - 22) + 'px';
      stem.style.height = '14px';
    }
    svg.addEventListener('mousemove', function (e) {
      var rect = svg.getBoundingClientRect();
      var mx = ((e.clientX - rect.left) / rect.width) * W;
      var best = 0;
      pts.forEach(function (p, i) { if (Math.abs(p[0] - mx) < Math.abs(pts[best][0] - mx)) best = i; });
      point(best);
    });
    requestAnimationFrame(function () { if (!byId('view-dashboard').hidden) point(runs.length - 1); });
  }

  /* ----------------------------------- donut ----------------------------------- */

  function renderDonut() {
    var box = byId('donut');
    clear(box);
    var by = { regression: 0, frontend: 0, data: 0 };
    state.findings.forEach(function (f) { if (by[f.check] !== undefined) by[f.check]++; });
    var total = state.findings.length;
    var svg = svgEl('svg', { viewBox: '0 0 120 120', role: 'img', 'aria-label': 'Open findings by check' });
    var R = 44;
    var C = 2 * Math.PI * R;
    svg.appendChild(svgEl('circle', { cx: 60, cy: 60, r: R, fill: 'none', stroke: '#f7e4d4', 'stroke-width': 16 }));
    var offset = 0;
    Object.keys(by).forEach(function (k) {
      if (!by[k]) return;
      var len = (by[k] / total) * C;
      svg.appendChild(svgEl('circle', {
        cx: 60, cy: 60, r: R, fill: 'none', stroke: CHECK_COLOR[k], 'stroke-width': 16,
        'stroke-dasharray': Math.max(0, len - 2).toFixed(2) + ' ' + (C - Math.max(0, len - 2)).toFixed(2),
        'stroke-dashoffset': (-offset).toFixed(2), transform: 'rotate(-90 60 60)', 'stroke-linecap': 'butt',
      }));
      offset += len;
    });
    box.appendChild(svg);
    var center = el('div', 'center');
    center.appendChild(el('b', null, total));
    center.appendChild(el('span', null, 'open'));
    box.appendChild(center);
    var legend = byId('legend');
    clear(legend);
    Object.keys(by).forEach(function (k) {
      var row = el('div', 'row');
      var dot = el('i');
      dot.style.background = CHECK_COLOR[k];
      row.appendChild(dot);
      row.appendChild(el('span', null, CHECK_NAME[k]));
      row.appendChild(el('span', 'v', by[k]));
      legend.appendChild(row);
    });
  }

  /* ---------------------------------- findings ---------------------------------- */

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
  function confidence(level) {
    var box = el('div', 'conf');
    var m = el('div', 'meter sunken');
    var bar = el('i');
    bar.style.width = (level === 'high' ? 100 : level === 'medium' ? 66 : 33) + '%';
    m.appendChild(bar);
    box.appendChild(m);
    box.appendChild(el('span', null, level));
    return box;
  }

  var VERDICT_TONE = { fixed: 'leaf', 'still open': 'ember', 'gone with its file': 'amber', 'could not confirm': 'amber' };

  function detailRow(f) {
    var tr = el('tr', 'detail');
    var td = el('td');
    td.colSpan = 6;
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
        var row = el('div');
        row.appendChild(el('span', 'tag ' + (VERDICT_TONE[a.verdict] || ''), a.verdict));
        row.appendChild(el('span', null, 'Re-checked ' + ago(a.at) + (a.why ? ' - ' + a.why : '') +
          (a.newProblems ? ' - ' + plural(a.newProblems, 'new problem') : '')));
        list.appendChild(row);
      });
      box.appendChild(list);
    }
    td.appendChild(box);
    tr.appendChild(td);
    return tr;
  }

  function renderFindings() {
    var body = byId('findingRows');
    clear(body);
    var q = query.trim().toLowerCase();
    var shown = state.findings.filter(function (f) {
      if (statusFilter === 'confirmed' && f.status !== 'confirmed') return false;
      if (statusFilter === 'verify' && f.status === 'confirmed') return false;
      if (!q) return true;
      return [f.headline, f.where, f.detail, f.check, f.id].join(' ').toLowerCase().indexOf(q) !== -1;
    });
    byId('findingBadge').textContent = shown.length + (shown.length !== state.findings.length ? ' of ' + state.findings.length : '');
    if (!shown.length) {
      var tr = el('tr');
      var td = el('td', 'empty', state.findings.length ? 'Nothing matches.' : 'Nothing found by the checks that are on and have run. That is not the same as nothing wrong - see which checks are not built yet.');
      td.colSpan = 6;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    shown.forEach(function (f) {
      var tr = el('tr', 'row ' + (f.status === 'confirmed' ? 'bad' : 'warn'));
      var c1 = el('td');
      c1.appendChild(el('div', 'f-title', f.headline));
      c1.appendChild(el('div', 'f-id', '#' + f.id + (openRow === f.id ? '' : '  -  click for the fix prompt')));
      tr.appendChild(c1);
      var c2 = el('td');
      c2.appendChild(el('span', 'tag ' + (CHECK_TONE[f.check] || ''), CHECK_NAME[f.check] || f.check));
      tr.appendChild(c2);
      var c3 = el('td');
      c3.appendChild(statusTag(f));
      tr.appendChild(c3);
      var c4 = el('td');
      c4.appendChild(sevTag(f.severity));
      tr.appendChild(c4);
      tr.appendChild(el('td', 'where', f.where));
      var c6 = el('td');
      c6.appendChild(confidence(f.confidence));
      tr.appendChild(c6);
      tr.addEventListener('click', function () {
        openRow = openRow === f.id ? null : f.id;
        renderFindings();
      });
      body.appendChild(tr);
      if (openRow === f.id) body.appendChild(detailRow(f));
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
      var more = button('sm more', null, allLooks ? 'Show the latest ' + LOOKS_SHOWN : 'Show all ' + looks.length, function () {
        allLooks = !allLooks;
        renderTimeline();
      });
      box.appendChild(more);
    }
  }

  function renderFixes() {
    var box = byId('fixList');
    clear(box);
    var list = state.proven || [];
    byId('fixBadge').textContent = String(list.length);
    if (!list.length) {
      box.appendChild(el('p', 'empty', 'No fix has been proven yet. Open a finding, fix it, and press Re-check.'));
      return;
    }
    list.forEach(function (p) {
      var row = el('div', 'fix-row');
      row.appendChild(el('span', 'tag leaf', 'FIXED'));
      var text = el('div', 'fr-text');
      text.appendChild(el('div', null, p.headline));
      text.appendChild(el('div', 'fr-sub', p.where + ' - proven ' + ago(p.at) + (p.newProblems ? ' - ' + plural(p.newProblems, 'new problem') + ' at the time' : '')));
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
        var row = el('div', 'na sunken');
        row.appendChild(checkSwitch(c));
        var name = el('div', null, c.label);
        name.appendChild(el('span', 'na-lock', 'NOT AVAILABLE'));
        row.appendChild(name);
        na.appendChild(row);
        return;
      }
      var card = el('div', 'check raised');
      var top = el('div', 'c-top');
      top.appendChild(el('div', 'c-name', c.label));
      top.appendChild(checkSwitch(c));
      card.appendChild(top);
      card.appendChild(el('div', null)).appendChild(el('span', 'tag ' + (STATE_TONE[c.state] || ''), c.state));
      if (c.what) card.appendChild(el('div', 'c-what', c.what));
      var foot = el('div', 'c-foot');
      if (c.runnable && c.enabled) {
        var run = button('sm', 'play', 'Run now', function () { runChecks([c.id], run); });
        run.setAttribute('data-action', 'run');
        run.disabled = busy;
        foot.appendChild(run);
      } else if (!c.enabled) {
        foot.appendChild(el('span', 'note', 'Switched off - it will not run.'));
      }
      card.appendChild(foot);
      box.appendChild(card);
    });
    byId('naBadge').textContent = String(missing);
  }

  function renderRuns() {
    var box = byId('runList');
    clear(box);
    byId('runBadge').textContent = String(state.runs.length);
    if (!state.runs.length) {
      box.appendChild(el('p', 'empty', 'No recorded flows have been replayed yet. Record one with npx kryptheon record, then press Run checks.'));
      return;
    }
    state.runs.slice(0, 30).forEach(function (r) {
      var row = el('div', 'fix-row');
      row.appendChild(el('span', 'tag ' + (r.failed ? 'ember' : 'leaf'), r.failed ? r.failed + ' broke' : 'held'));
      var text = el('div', 'fr-text');
      text.appendChild(el('div', null, (r.passed || 0) + ' held, ' + (r.failed || 0) + ' broke'));
      text.appendChild(el('div', 'fr-sub', when(r.runAt)));
      row.appendChild(text);
      if (r.failed) row.appendChild(button('sm', 'arrow', 'See the finding', function () { go('findings', 'confirmed'); }));
      box.appendChild(row);
    });
  }

  var BADGE_STATES = [
    ['Active', 'This exact version was checked and held.'],
    ['Outdated', 'The project changed after it was verified.'],
    ['Revalidation required', 'A check found something new - verify again.'],
    ['Revoked', 'Withdrawn. The badge says so publicly.'],
  ];

  function renderVerification() {
    byId('verifyBadge').textContent = state.verification.state;
    byId('verifyText').textContent = 'Not verified. ' + state.verification.why +
      ' When it is built, a verification will stand for one version of this project, and a changed version will need it again. These are the states it will have:';
    var box = byId('verifyStates');
    clear(box);
    BADGE_STATES.forEach(function (s) {
      var card = el('div', 'state-card sunken');
      card.appendChild(el('b', null, s[0]));
      card.appendChild(el('span', null, s[1]));
      box.appendChild(card);
    });
  }

  var STORE_FILES = [
    ['baselines.json', 'what each page looked like the last time it worked'],
    ['history.jsonl', 'every run of your recorded flows'],
    ['test-results/', 'screenshots and traces from runs that broke'],
    ['code-findings.json', 'the last read of your frontend code'],
    ['night-last.json', 'the last database check'],
    ['snapshot.json', 'what your files looked like at the last look'],
    ['changes.jsonl', 'every look: what changed, what broke, what got fixed'],
    ['fixes.jsonl', 'every re-check and its verdict'],
    ['config.json', 'which checks are switched on'],
  ];

  function renderStorage() {
    byId('storeNote').textContent = 'Everything on this dashboard is read from this folder on your machine. Nothing is sent anywhere. ' +
      'Your project keeps only its recordings in tests/.';
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

  function renderWhen() {
    Object.keys(WHEN).forEach(function (id) {
      var box = byId('when-' + id);
      clear(box);
      box.appendChild(el('b', 'lbl', 'THIS SECTION'));
      box.appendChild(rich(el('span'), WHEN[id]));
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
      toast((words[r.verdict] || r.verdict) + (r.why ? ' - ' + r.why : '') +
        (r.newProblems && r.newProblems.length ? ' - ' + plural(r.newProblems.length, 'new problem') : ''));
    }).catch(function (err) {
      toast('Re-check failed: ' + err.message);
    }).then(function () {
      setBusy(false);
      return load();
    });
  }

  function runChecks(ids, btn) {
    if (busy || !ids.length) return;
    setBusy(true);
    var error = byId('checkError');
    error.hidden = true;
    clear(btn);
    btn.appendChild(el('span', 'spin'));
    btn.appendChild(el('span', null, 'Running...'));
    ids.reduce(function (chain, id) {
      return chain.then(function () { return post('/api/run', { id: id }); });
    }, Promise.resolve()).then(function () {
      toast('Finished: ' + ids.map(function (id) { return CHECK_NAME[id] || id; }).join(', '));
    }).catch(function (err) {
      error.textContent = 'Run failed: ' + err.message;
      error.hidden = false;
      toast('Run failed: ' + err.message);
    }).then(function () {
      setBusy(false);
      return load();
    });
  }

  function setCheck(id, on, input) {
    var error = byId('checkError');
    error.hidden = true;
    post('/api/check', { id: id, on: on }).then(function () {
      toast((on ? 'Switched on: ' : 'Switched off: ') + (CHECK_NAME[id] || id));
      return load();
    }).catch(function (err) {
      input.checked = !on;
      error.textContent = 'Not saved: ' + err.message;
      error.hidden = false;
    });
  }

  byId('search').addEventListener('input', function (e) {
    query = e.target.value;
    if (query.trim() && currentView() !== 'findings') go('findings');
    if (state) renderFindings();
  });
  byId('bell').addEventListener('click', function () { go('changes'); });
  byId('runAll').addEventListener('click', function () {
    if (!state) return;
    var ids = state.checks.filter(function (c) { return c.runnable && c.enabled; }).map(function (c) { return c.id; });
    if (!ids.length) {
      toast('Nothing can run from here yet - switch a check on, or record a flow.');
      return;
    }
    runChecks(ids, byId('runAll'));
  });

  /* ----------------------------------- load ----------------------------------- */

  function render(next) {
    if (!next) return;
    state = next;
    renderSide();
    renderTop();
    renderSky();
    renderKpis();
    renderGuide();
    renderRange();
    renderChart();
    renderDonut();
    renderStatusFilter();
    renderFindings();
    renderTimeline();
    renderFixes();
    renderChecks();
    renderRuns();
    renderVerification();
    renderStorage();
  }

  function load() {
    return fetch('/api/state', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('the dashboard answered ' + res.status);
        return res.json();
      })
      .then(render)
      .catch(function (err) {
        byId('subline').textContent = 'Could not load: ' + err.message;
      });
  }

  renderWhen();
  showView();
  load();
  // Not while something runs, and not while a finding is open being read:
  // a re-render would take the spinner away or close what is being read.
  setInterval(function () { if (!busy && !openRow) load(); }, 5000);
})();
