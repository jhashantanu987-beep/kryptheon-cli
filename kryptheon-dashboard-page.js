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
  var activeNav = 'dashboard';

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
    plus: 'M12 5v14M5 12h14',
    alert: 'M12 3l10 18H2L12 3zm0 7v5m0 3v.5',
    eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    film: 'M4 5h16v14H4zM4 9h16M4 15h16M8 5v14M16 5v14',
    copy: 'M9 9h10v12H9zM5 15V3h10',
    refresh: 'M20 12a8 8 0 10-2.3 5.7M20 12V6m0 6h-6',
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
    toast.timer = setTimeout(function () { t.classList.remove('show'); }, 2800);
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

  var CHECK_NAME = { regression: 'Recorded flows', frontend: 'Frontend code', data: 'Database' };
  var CHECK_TONE = { regression: 'rust', frontend: 'brass', data: 'navy' };
  var CHECK_COLOR = { regression: '#c4643f', frontend: '#cf9b34', data: '#22304a' };

  /* ---------------------------------- sidebar ---------------------------------- */

  var NAV = {
    navOverview: [['dashboard', 'Dashboard', 'grid'], ['findings', 'Findings', 'list'], ['changes', 'What changed', 'change'], ['fixes', 'Proven fixes', 'wrench']],
    navWorkspace: [['checks', 'Checks', 'toggle'], ['runs', 'Runs', 'play'], ['verification', 'Verification', 'shield'], ['storage', 'Where this lives', 'box']],
  };

  function renderSide() {
    var logo = byId('logoTile');
    clear(logo);
    logo.appendChild(icon('shield', 22));
    var counts = {
      findings: state.findings.length,
      changes: (state.looks || []).length,
      fixes: (state.proven || []).length,
    };
    Object.keys(NAV).forEach(function (navId) {
      var box = byId(navId);
      clear(box);
      NAV[navId].forEach(function (item) {
        var b = el('button', activeNav === item[0] ? 'on' : '');
        b.type = 'button';
        b.appendChild(icon(item[2], 18));
        b.appendChild(el('span', null, item[1]));
        if (counts[item[0]]) b.appendChild(el('span', 'n-count', counts[item[0]]));
        b.addEventListener('click', function () {
          activeNav = item[0];
          var target = byId(item[0]);
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          renderSide();
        });
        box.appendChild(b);
      });
    });
    var built = state.checks.filter(function (c) { return c.available; }).length;
    byId('builtText').textContent = built + ' / ' + state.checks.length;
    byId('builtBar').style.width = Math.round((built / state.checks.length) * 100) + '%';
    byId('builtNote').textContent = (state.checks.length - built) + ' more are listed as not available - never as passed.';
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
    bell.title = fresh ? plural(fresh, 'new finding') + ' in the last look' : 'Nothing new in the last look';
    var run = byId('runAll');
    if (!busy) {
      clear(run);
      run.appendChild(icon('plus', 16));
      run.appendChild(el('span', null, 'Run checks'));
    }
  }

  /* --------------------------------- overview --------------------------------- */

  function renderBanner() {
    var confirmed = state.findings.filter(function (f) { return f.status === 'confirmed'; }).length;
    var toVerify = state.findings.length - confirmed;
    var ic = byId('bannerIcon');
    clear(ic);
    var title;
    var sub;
    if (confirmed) {
      ic.style.color = 'var(--rust)';
      ic.appendChild(icon('alert', 26));
      title = plural(confirmed, 'confirmed problem');
      sub = 'Proven by a check that ran. Each has a fix prompt, and a Re-check that says FIXED only when it is.' +
        (toVerify ? ' ' + toVerify + ' more need a look.' : '');
    } else if (toVerify) {
      ic.style.color = '#8e6718';
      ic.appendChild(icon('eye', 26));
      title = plural(toVerify, 'thing') + ' to verify';
      sub = 'Nothing confirmed broken. These were spotted without running anything - each needs a person to decide.';
    } else {
      ic.style.color = 'var(--teal)';
      ic.appendChild(icon('check', 26));
      title = 'Holding';
      sub = 'Nothing open from the checks that are on and have run. That is not the same as nothing wrong - see which checks are not available yet.';
    }
    byId('bannerTitle').textContent = title;
    byId('bannerSub').textContent = sub;
    byId('verifyPill').textContent = 'Verification: ' + state.verification.state;
  }

  function kpi(label, value, iconName, tone, foot) {
    var box = el('div', 'kpi raised');
    var top = el('div', 'kpi-top');
    var chip = el('div', 'ichip ' + tone);
    chip.appendChild(icon(iconName, 19));
    top.appendChild(chip);
    top.appendChild(el('div', 'kpi-label', label));
    box.appendChild(top);
    box.appendChild(el('div', 'kpi-num', value));
    var f = el('div', 'kpi-foot');
    foot.forEach(function (part) { f.appendChild(part); });
    box.appendChild(f);
    return box;
  }
  function delta(kind, text) {
    return el('span', 'delta ' + kind, (kind === 'up' ? '▲ ' : kind === 'down' ? '▼ ' : '') + text);
  }

  function renderKpis() {
    var box = byId('kpis');
    clear(box);
    var confirmed = state.findings.filter(function (f) { return f.status === 'confirmed'; }).length;
    var toVerify = state.findings.length - confirmed;
    var last = (state.looks || [])[0];
    var lastRun = state.runs[0];
    var newFound = last && !last.first ? last.newFindings : 0;
    var week = Date.now() - 7 * 86400000;
    var fixedWeek = (state.proven || []).filter(function (p) { return new Date(p.at).getTime() > week; }).length;
    box.appendChild(kpi('CONFIRMED', confirmed, 'alert', 'rust', newFound
      ? [delta('down', newFound + ' new'), el('span', null, 'in the last look')]
      : confirmed ? [el('span', null, 'open now - each has a fix prompt')] : [delta('up', 'none open')]));
    box.appendChild(kpi('TO VERIFY', toVerify, 'eye', 'brass', [el('span', null, 'spotted without running anything')]));
    box.appendChild(kpi('PROVEN FIXES', (state.proven || []).length, 'wrench', 'teal', fixedWeek ? [delta('up', fixedWeek + ' this week')] : [delta('flat', 'none this week')]));
    var held = lastRun ? lastRun.passed + ' / ' + (lastRun.passed + lastRun.failed) : '-';
    box.appendChild(kpi('RECORDINGS HELD', held, 'film', 'navy', lastRun
      ? [delta(lastRun.failed ? 'down' : 'up', lastRun.failed ? lastRun.failed + ' broke' : 'all held'), el('span', null, ago(lastRun.runAt))]
      : [el('span', null, plural(state.recordings, 'recording') + ', never run')]));
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
      ? plural(runs.length, 'run') + ' - ' + shortDate(runs[0].runAt) + ' to ' + shortDate(runs[runs.length - 1].runAt)
      : 'No runs in this range';
    if (!runs.length) {
      box.appendChild(el('p', 'empty', 'No recorded flows have been replayed in this range.'));
      return;
    }
    var W = 720;
    var H = 260;
    var L = 44;
    var R = 12;
    var T = 20;
    var B = 30;
    var top = Math.max(1, Math.max.apply(null, runs.map(function (r) { return (r.passed || 0) + (r.failed || 0); })));
    var x = function (i) { return runs.length === 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (runs.length - 1); };
    var y = function (v) { return T + (H - T - B) * (1 - v / top); };
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Recordings that held, per run' });
    var defs = svgEl('defs');
    var grad = svgEl('linearGradient', { id: 'kfill', x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#14776b', 'stop-opacity': 0.32 }));
    grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#14776b', 'stop-opacity': 0.02 }));
    defs.appendChild(grad);
    svg.appendChild(defs);
    var steps = top <= 4 ? top : 4;
    for (var g = 0; g <= steps; g++) {
      var v = Math.round((top * g) / steps);
      svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: 'rgba(38,48,31,0.10)', 'stroke-width': 1 }));
      var lab = svgEl('text', { x: L - 10, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#6b7663' });
      lab.textContent = String(v);
      svg.appendChild(lab);
    }
    var pts = runs.map(function (r, i) { return [x(i), y(r.passed || 0)]; });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var area = line + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + (H - B) + ' L' + pts[0][0].toFixed(1) + ' ' + (H - B) + ' Z';
    svg.appendChild(svgEl('path', { d: area, fill: 'url(#kfill)' }));
    svg.appendChild(svgEl('path', { d: line, fill: 'none', stroke: '#14776b', 'stroke-width': 3, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    runs.forEach(function (r, i) {
      if (r.failed) svg.appendChild(svgEl('circle', { cx: pts[i][0], cy: pts[i][1], r: 4.5, fill: '#c4643f', stroke: '#e2e8dc', 'stroke-width': 2 }));
    });
    var labels = Math.min(runs.length, 6);
    for (var k = 0; k < labels; k++) {
      var idx = labels === 1 ? 0 : Math.round((k * (runs.length - 1)) / (labels - 1));
      var t = svgEl('text', { x: x(idx), y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: '#6b7663' });
      // All on one day: the date says nothing, the time does.
      var sameDay = shortDate(runs[0].runAt) === shortDate(runs[runs.length - 1].runAt);
      t.textContent = sameDay
        ? new Date(runs[idx].runAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        : shortDate(runs[idx].runAt);
      svg.appendChild(t);
    }
    var ring = svgEl('circle', { r: 7, fill: '#e2e8dc', stroke: '#14776b', 'stroke-width': 3 });
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
      ring.setAttribute('stroke', r.failed ? '#c4643f' : '#14776b');
      var rect = svg.getBoundingClientRect();
      var px = (pts[i][0] / W) * rect.width;
      var py = (pts[i][1] / H) * rect.height;
      tDate.textContent = when(r.runAt);
      clear(tVal);
      var dot = el('i');
      dot.style.background = r.failed ? '#c4643f' : '#14776b';
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
    requestAnimationFrame(function () { point(runs.length - 1); });
  }

  /* ----------------------------------- donut ----------------------------------- */

  function renderDonut() {
    var box = byId('donut');
    clear(box);
    var counts = { regression: 0, frontend: 0, data: 0 };
    state.findings.forEach(function (f) { if (counts[f.check] !== undefined) counts[f.check]++; });
    var total = state.findings.length;
    var svg = svgEl('svg', { viewBox: '0 0 120 120', role: 'img', 'aria-label': 'Open findings by check' });
    var R = 44;
    var C = 2 * Math.PI * R;
    svg.appendChild(svgEl('circle', { cx: 60, cy: 60, r: R, fill: 'none', stroke: '#d3dbcc', 'stroke-width': 18 }));
    var offset = 0;
    Object.keys(counts).forEach(function (k) {
      if (!counts[k]) return;
      var len = (counts[k] / total) * C;
      svg.appendChild(svgEl('circle', {
        cx: 60, cy: 60, r: R, fill: 'none', stroke: CHECK_COLOR[k], 'stroke-width': 18,
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
    Object.keys(counts).forEach(function (k) {
      var row = el('div', 'row');
      var dot = el('i');
      dot.style.background = CHECK_COLOR[k];
      row.appendChild(dot);
      row.appendChild(el('span', null, CHECK_NAME[k]));
      row.appendChild(el('span', 'v', total ? Math.round((counts[k] / total) * 100) + '%' : '0'));
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
    var t = el('span', 'tag ' + (f.status === 'confirmed' ? 'rust' : 'brass'));
    t.appendChild(el('span', f.status === 'confirmed' ? 'g-dot' : 'g-half'));
    t.appendChild(el('span', null, f.status === 'confirmed' ? 'Confirmed' : 'To verify'));
    return t;
  }
  function sevTag(sev) {
    var tone = /CRITICAL/.test(sev) ? 'rust' : sev === 'HIGH' ? 'brass' : sev === 'MEDIUM' ? 'navy' : 'teal';
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

  var VERDICT_TONE = { fixed: 'teal', 'still open': 'rust', 'gone with its file': 'brass', 'could not confirm': 'brass' };

  function detailRow(f) {
    var tr = el('tr', 'detail');
    var td = el('td');
    td.colSpan = 6;
    var box = el('div', 'detail-box');
    if (f.detail) box.appendChild(el('div', 'd-text', f.detail));
    box.appendChild(el('div', 'd-text', 'Seen ' + when(f.when) + '  -  ' + f.evidence + '  -  id ' + f.id));
    if (f.fixPrompt) box.appendChild(el('pre', null, f.fixPrompt));
    var actions = el('div', 'd-actions');
    if (f.fixPrompt) {
      var cp = el('button', 'btn sm');
      cp.type = 'button';
      cp.appendChild(icon('copy', 15));
      cp.appendChild(el('span', null, 'Copy fix prompt'));
      cp.addEventListener('click', function (e) { e.stopPropagation(); copy(f.fixPrompt, 'Fix prompt copied - paste it into your AI tool'); });
      actions.appendChild(cp);
    }
    var re = el('button', 'btn teal sm');
    re.type = 'button';
    re.setAttribute('data-action', 'recheck');
    re.disabled = busy;
    re.appendChild(icon('refresh', 15));
    re.appendChild(el('span', null, 'Re-check'));
    re.addEventListener('click', function (e) { e.stopPropagation(); recheck(f, re); });
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
      var td = el('td', 'empty', state.findings.length ? 'Nothing matches.' : 'Nothing found by the checks that are on and have run. That is not the same as nothing wrong - see which checks are not available.');
      td.colSpan = 6;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    shown.forEach(function (f) {
      var tr = el('tr', 'row');
      var c1 = el('td');
      c1.appendChild(el('div', 'f-title', f.headline));
      c1.appendChild(el('div', 'f-id', '#' + f.id));
      tr.appendChild(c1);
      var c2 = el('td');
      c2.appendChild(el('span', 'tag ' + (CHECK_TONE[f.check] || 'teal'), CHECK_NAME[f.check] || f.check));
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

  /* ---------------------------------- the rest ---------------------------------- */

  function renderTimeline() {
    var box = byId('timeline');
    clear(box);
    var looks = state.looks || [];
    if (!looks.length) {
      box.appendChild(el('p', 'empty', 'Kryptheon has not looked at a change yet. It does by itself while this page is open, and whenever npx kryptheon verify runs.'));
      return;
    }
    looks.forEach(function (look) {
      var item = el('div', 'tl');
      item.appendChild(el('div', 'knob' + (look.newFindings ? ' bad' : look.fixed ? ' ok' : look.goneWithFile ? ' mid' : '')));
      var body = el('div');
      body.appendChild(el('div', 'tl-head', look.first ? 'Starting point'
        : look.fileCount ? plural(look.fileCount, 'file') + ' changed - ' + look.parts.join(', ') : 'Nothing changed'));
      body.appendChild(el('div', 'tl-meta', (look.by === 'watch' ? 'Noticed by itself' : look.by === 'recheck' ? 'Re-check' : 'npx kryptheon verify') + ' - ' + when(look.at)));
      var tags = el('div', 'tl-body');
      if (look.newFindings) tags.appendChild(el('span', 'tag rust', look.newFindings + ' new'));
      if (look.fixed) tags.appendChild(el('span', 'tag teal', look.fixed + ' fixed'));
      if (look.goneWithFile) tags.appendChild(el('span', 'tag brass', look.goneWithFile + ' gone with its file'));
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
      row.appendChild(el('span', 'tag teal', 'FIXED'));
      var text = el('div', 'fr-text');
      text.appendChild(el('div', null, p.headline));
      text.appendChild(el('div', 'fr-sub', p.where + ' - proven ' + ago(p.at) + (p.newProblems ? ' - ' + plural(p.newProblems, 'new problem') + ' at the time' : '')));
      row.appendChild(text);
      box.appendChild(row);
    });
  }

  var STATE_TONE = { 'problems found': 'rust', 'things to check': 'brass', 'last run held': 'teal', 'nothing found': 'teal' };

  function renderChecks() {
    var box = byId('checkList');
    clear(box);
    state.checks.forEach(function (c) {
      var row = el('div', 'check' + (c.available ? '' : ' na'));
      var sw = el('label', 'switch');
      var input = el('input');
      input.type = 'checkbox';
      input.checked = !!c.enabled;
      input.disabled = !c.available;
      input.setAttribute('aria-label', c.label);
      input.addEventListener('change', function () { setCheck(c.id, input.checked, input); });
      sw.appendChild(input);
      sw.appendChild(el('span', 'track'));
      row.appendChild(sw);
      var text = el('div');
      text.appendChild(el('div', 'c-name', c.label));
      var st = el('div', 'c-state');
      st.appendChild(el('span', 'tag ' + (STATE_TONE[c.state] || ''), c.state));
      text.appendChild(st);
      if (c.what) text.appendChild(el('div', 'c-what', c.what));
      if (c.runnable && c.enabled) {
        var run = el('button', 'btn sm');
        run.type = 'button';
        run.style.marginTop = '10px';
        run.setAttribute('data-action', 'run');
        run.disabled = busy;
        run.appendChild(icon('play', 14));
        run.appendChild(el('span', null, 'Run now'));
        run.addEventListener('click', function () { runChecks([c.id], run); });
        text.appendChild(run);
      }
      row.appendChild(text);
      box.appendChild(row);
    });
  }

  function renderRuns() {
    var box = byId('runList');
    clear(box);
    if (!state.runs.length) {
      box.appendChild(el('p', 'empty', 'No recorded flows have been replayed yet.'));
      return;
    }
    state.runs.slice(0, 6).forEach(function (r) {
      var row = el('div', 'fix-row');
      row.appendChild(el('span', 'tag ' + (r.failed ? 'rust' : 'teal'), r.failed ? r.failed + ' broke' : 'held'));
      var text = el('div', 'fr-text');
      text.appendChild(el('div', null, (r.passed || 0) + ' held, ' + (r.failed || 0) + ' broke'));
      text.appendChild(el('div', 'fr-sub', when(r.runAt)));
      row.appendChild(text);
      box.appendChild(row);
    });
  }

  /* ---------------------------------- actions ---------------------------------- */

  function recheck(f, button) {
    if (busy) return;
    setBusy(true);
    clear(button);
    button.appendChild(el('span', 'spin'));
    button.appendChild(el('span', null, f.check === 'regression' ? 'Replaying...' : 'Re-checking...'));
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

  function runChecks(ids, button) {
    if (busy || !ids.length) return;
    setBusy(true);
    var error = byId('checkError');
    error.hidden = true;
    clear(button);
    button.appendChild(el('span', 'spin'));
    button.appendChild(el('span', null, 'Running...'));
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
    renderFindings();
  });
  byId('bell').addEventListener('click', function () {
    activeNav = 'changes';
    byId('changes').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (state) renderSide();
  });
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
    renderBanner();
    renderKpis();
    renderRange();
    renderChart();
    renderDonut();
    renderStatusFilter();
    renderFindings();
    renderTimeline();
    renderFixes();
    renderChecks();
    renderRuns();
    byId('verifyText').textContent = 'Not verified. ' + state.verification.why +
      ' When it is built, a verification will stand for one version of this project, and a changed version will need it again.';
    byId('storeNote').textContent = 'Everything here is read from ' + state.project.storeDir +
      ' on this machine. Nothing is sent anywhere, and nothing is written into your project.';
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

  load();
  // Not while something runs, and not while a finding is open being read:
  // a re-render would take the spinner away or close what is being read.
  setInterval(function () { if (!busy && !openRow) load(); }, 5000);
})();
