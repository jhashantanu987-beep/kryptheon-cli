// The dashboard page. Served from 127.0.0.1 by kryptheon-dashboard.js.
//
// Every value on this page can hold text from the app being checked - a line
// of its code, the heading of a page that broke. So nothing here is ever
// written as HTML: every node is made with createElement (or createElementNS
// for the icons, from fixed path data) and filled with textContent. This file
// is read by kryptheon-code.js in its own check, and must come back with
// nothing to report.

(function () {
  'use strict';

  var tokenMeta = document.querySelector('meta[name="kryptheon-token"]');
  var TOKEN = tokenMeta ? tokenMeta.getAttribute('content') : '';
  var filter = 'all';
  var busy = false;
  var lastState = null;

  /* ------------------------------ building blocks ------------------------------ */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // Icons: fixed path data only, drawn with the SVG DOM - never from a string.
  var ICONS = {
    shield: 'M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5l8-3z',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    alert: 'M12 3l10 18H2L12 3zm0 7v5m0 3v.5',
    eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z',
    bolt: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z',
    film: 'M4 5h16v14H4zM4 9h16M4 15h16M8 5v14M16 5v14',
    clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zm0-13v5l3 2',
    wrench: 'M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.6 2.6-2.4-.6-.6-2.4 2.6-2.6z',
    copy: 'M9 9h10v12H9zM5 15V3h10',
    refresh: 'M20 12a8 8 0 10-2.3 5.7M20 12V6m0 6h-6',
  };
  function icon(name, size, color) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', String(size || 16));
    svg.setAttribute('height', String(size || 16));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    if (color) svg.style.color = color;
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', ICONS[name] || ICONS.shield);
    svg.appendChild(p);
    return svg;
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
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  function toast(text) {
    var t = document.getElementById('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.classList.remove('show'); }, 2600);
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
    Array.prototype.forEach.call(document.querySelectorAll('button[data-action]'), function (b) { b.disabled = on; });
  }

  /* --------------------------------- sections --------------------------------- */

  function renderTop(state) {
    var mark = document.getElementById('mark');
    clear(mark);
    mark.appendChild(icon('shield', 18, '#ffffff'));
    document.getElementById('title').textContent = 'Kryptheon  ·  ' + state.project.name;
    document.getElementById('where').textContent = state.project.root;
    var lastLook = state.looks && state.looks[0];
    document.getElementById('live').textContent = lastLook
      ? 'Watching  ·  last look ' + ago(lastLook.at)
      : 'Watching for changes';
  }

  function renderHero(state) {
    var confirmed = state.findings.filter(function (f) { return f.status === 'confirmed'; }).length;
    var toVerify = state.findings.length - confirmed;
    var hero = document.getElementById('hero');
    var iconBox = document.getElementById('heroIcon');
    clear(iconBox);
    hero.className = 'hero';
    var title;
    var sub;
    if (confirmed) {
      hero.classList.add('broken');
      iconBox.appendChild(icon('alert', 26, 'var(--crit)'));
      title = confirmed + ' confirmed problem' + (confirmed === 1 ? '' : 's');
      sub = 'Proven by a check that ran. Each has a fix prompt and a Re-check that says FIXED only when it is.' +
        (toVerify ? ' ' + toVerify + ' more need a look.' : '');
    } else if (toVerify) {
      hero.classList.add('look');
      iconBox.appendChild(icon('eye', 26, 'var(--med)'));
      title = toVerify + ' thing' + (toVerify === 1 ? '' : 's') + ' to verify';
      sub = 'Nothing confirmed broken. These were spotted without running anything - each needs a person to decide.';
    } else {
      iconBox.appendChild(icon('check', 26, 'var(--ok)'));
      title = 'Holding';
      sub = 'Nothing open from the checks that are on and have run. That is not the same as nothing wrong - ' +
        'see which checks are not available yet.';
    }
    document.getElementById('heroTitle').textContent = title;
    document.getElementById('heroSub').textContent = sub;
    var v = document.getElementById('verification');
    clear(v);
    v.appendChild(icon('shield', 14));
    v.appendChild(el('span', null, 'Verification: ' + state.verification.state + ' - ' + state.verification.why));
  }

  function kpi(label, value, iconName, color) {
    var box = el('div', 'kpi');
    var top = el('div', 'k-top');
    top.appendChild(el('span', null, label));
    top.appendChild(icon(iconName, 16, color));
    box.appendChild(top);
    box.appendChild(el('div', 'k-num', value));
    return box;
  }

  function renderKpis(state) {
    var box = document.getElementById('kpis');
    clear(box);
    var confirmed = state.findings.filter(function (f) { return f.status === 'confirmed'; }).length;
    var last = state.runs[0];
    box.appendChild(kpi('Confirmed', confirmed, 'alert', confirmed ? 'var(--crit)' : 'var(--faint)'));
    box.appendChild(kpi('To verify', state.findings.length - confirmed, 'eye', 'var(--med)'));
    box.appendChild(kpi('Proven fixes', (state.proven || []).length, 'wrench', 'var(--ok)'));
    box.appendChild(kpi('Recordings', state.recordings, 'film', 'var(--accent-2)'));
    box.appendChild(kpi('Last run', last ? (last.failed ? last.failed + ' broke' : 'held') : 'never', 'clock', 'var(--accent-1)'));
  }

  function renderFilters(state) {
    var box = document.getElementById('filters');
    clear(box);
    var confirmed = state.findings.filter(function (f) { return f.status === 'confirmed'; }).length;
    [['all', 'All ' + state.findings.length], ['confirmed', 'Confirmed ' + confirmed], ['verify', 'To verify ' + (state.findings.length - confirmed)]].forEach(function (pair) {
      var chip = el('button', 'chip' + (filter === pair[0] ? ' on' : ''), pair[1]);
      chip.type = 'button';
      chip.addEventListener('click', function () {
        filter = pair[0];
        render(lastState);
      });
      box.appendChild(chip);
    });
  }

  var VERDICT_CLASS = { fixed: 'ok', 'still open': 'bad', 'gone with its file': 'warn', 'could not confirm': 'warn' };

  function confidence(level) {
    var n = level === 'high' ? 3 : level === 'medium' ? 2 : 1;
    var box = el('span', 'conf');
    box.title = 'confidence: ' + level;
    for (var i = 0; i < 3; i++) box.appendChild(el('i', i < n ? 'on' : ''));
    return box;
  }

  function renderFinding(f) {
    var sev = String(f.severity || '').replace(/\s+/g, '');
    var item = el('article', 'finding s-' + sev);
    var tags = el('div', 'f-tags');
    tags.appendChild(el('span', 'pill sev-' + sev, f.severity));
    tags.appendChild(el('span', 'pill' + (f.status === 'confirmed' ? ' bad' : ' warn'), f.status));
    tags.appendChild(el('span', 'pill', f.evidence));
    tags.appendChild(el('span', 'pill', f.check));
    tags.appendChild(confidence(f.confidence));
    var id = el('button', 'idchip mono', '#' + f.id);
    id.type = 'button';
    id.title = 'Copy the re-check command';
    id.addEventListener('click', function () {
      copy('npx kryptheon recheck ' + f.id, 'Copied: npx kryptheon recheck ' + f.id);
    });
    tags.appendChild(id);
    item.appendChild(tags);
    item.appendChild(el('div', 'f-head', f.headline));
    item.appendChild(el('div', 'f-where mono', f.where + '   ·   ' + when(f.when)));
    if (f.detail) item.appendChild(el('div', 'f-detail mono', f.detail));

    if (f.fixPrompt) {
      var more = el('details', 'prompt');
      more.appendChild(el('summary', null, 'Fix prompt'));
      more.appendChild(el('pre', null, f.fixPrompt));
      item.appendChild(more);
    }

    var actions = el('div', 'f-actions');
    if (f.fixPrompt) {
      var cp = el('button', 'btn');
      cp.type = 'button';
      cp.appendChild(icon('copy', 14));
      cp.appendChild(el('span', null, 'Copy fix prompt'));
      cp.addEventListener('click', function () { copy(f.fixPrompt, 'Fix prompt copied - paste it into your AI tool'); });
      actions.appendChild(cp);
    }
    var re = el('button', 'btn primary');
    re.type = 'button';
    re.setAttribute('data-action', 'recheck');
    re.disabled = busy;
    re.appendChild(icon('refresh', 14, '#ffffff'));
    re.appendChild(el('span', null, 'Re-check'));
    re.addEventListener('click', function () { recheck(f, re); });
    actions.appendChild(re);
    item.appendChild(actions);

    if (f.attempts && f.attempts.length) {
      var list = el('div', 'attempts');
      f.attempts.slice(-4).reverse().forEach(function (a) {
        var row = el('div', 'attempt');
        row.appendChild(el('span', 'pill ' + (VERDICT_CLASS[a.verdict] || ''), a.verdict));
        row.appendChild(el('span', null, 'Re-checked ' + ago(a.at) + (a.why ? ' - ' + a.why : '') +
          (a.newProblems ? ' - ' + a.newProblems + ' new problem' + (a.newProblems === 1 ? '' : 's') : '')));
        list.appendChild(row);
      });
      item.appendChild(list);
    }
    return item;
  }

  function renderFindings(state) {
    var box = document.getElementById('findings');
    clear(box);
    renderFilters(state);
    var shown = state.findings.filter(function (f) {
      return filter === 'all' || (filter === 'confirmed' ? f.status === 'confirmed' : f.status !== 'confirmed');
    });
    document.getElementById('findingCount').textContent = shown.length + ' shown';
    if (!shown.length) {
      box.appendChild(el('p', 'empty', state.findings.length
        ? 'Nothing in this view.'
        : 'Nothing found by the checks that are on and have run. That is not the same as nothing wrong - see which checks are not available.'));
      return;
    }
    shown.forEach(function (f) { box.appendChild(renderFinding(f)); });
  }

  function renderProven(state) {
    var card = document.getElementById('provenCard');
    var box = document.getElementById('proven');
    clear(box);
    var list = state.proven || [];
    card.hidden = !list.length;
    document.getElementById('provenCount').textContent = list.length ? String(list.length) : '';
    list.forEach(function (p) {
      var row = el('div', 'attempt');
      row.appendChild(el('span', 'pill ok', 'FIXED'));
      row.appendChild(el('span', null, p.headline + '  ·  ' + p.where + '  ·  proven ' + ago(p.at) +
        (p.newProblems ? '  ·  ' + p.newProblems + ' new problem' + (p.newProblems === 1 ? '' : 's') + ' at the time' : '')));
      box.appendChild(row);
    });
  }

  function renderChanges(state) {
    var box = document.getElementById('changes');
    clear(box);
    var looks = state.looks || [];
    if (!looks.length) {
      box.appendChild(el('p', 'empty', 'Kryptheon has not looked at a change yet. It does by itself while this page is open, and whenever npx kryptheon verify runs.'));
    } else {
      var tl = el('div', 'timeline');
      looks.forEach(function (look) {
        var item = el('div', 'tl' + (look.newFindings ? ' bad' : look.fixed ? ' ok' : ''));
        item.appendChild(el('div', 'tl-head', look.first ? 'Starting point'
          : look.fileCount ? look.fileCount + ' file' + (look.fileCount === 1 ? '' : 's') + ' changed  ·  ' + look.parts.join(', ')
            : 'Nothing changed'));
        item.appendChild(el('div', 'tl-meta', (look.by === 'watch' ? 'Noticed by itself' : look.by === 'recheck' ? 'Re-check' : 'npx kryptheon verify') +
          '  ·  ' + when(look.at)));
        var tags = el('div', 'tl-checks');
        if (look.newFindings) tags.appendChild(el('span', 'pill bad', look.newFindings + ' new'));
        if (look.fixed) tags.appendChild(el('span', 'pill ok', look.fixed + ' fixed'));
        if (look.goneWithFile) tags.appendChild(el('span', 'pill warn', look.goneWithFile + ' gone with its file'));
        look.checks.forEach(function (c) {
          tags.appendChild(el('span', 'pill', c.id + ': ' + c.state));
        });
        item.appendChild(tags);
        var files = el('div', 'tl-files');
        look.files.slice(0, 6).forEach(function (f) {
          files.appendChild(el('div', 'tl-file mono', f.state + '  ' + f.path));
        });
        if (look.fileCount > 6) files.appendChild(el('div', 'tl-file', '... and ' + (look.fileCount - 6) + ' more'));
        look.dependencies.forEach(function (d) {
          files.appendChild(el('div', 'tl-file mono', 'package ' + d.name + ': ' + d.change + (d.to ? ' ' + d.to : '')));
        });
        item.appendChild(files);
        tl.appendChild(item);
      });
      box.appendChild(tl);
    }

    var git = state.changes;
    var gitHead = el('div', 'card-head');
    gitHead.style.marginTop = '18px';
    gitHead.appendChild(el('div', 'card-title', 'Git'));
    box.appendChild(gitHead);
    if (!git) {
      box.appendChild(el('p', 'empty', 'This folder is not a git repository.'));
      return;
    }
    box.appendChild(el('p', 'note', git.uncommitted.length
      ? git.uncommitted.length + ' file' + (git.uncommitted.length === 1 ? '' : 's') + ' changed and not committed yet.'
      : 'No uncommitted changes.'));
    if (git.commits.length) {
      var table = el('table');
      git.commits.forEach(function (c) {
        var row = el('tr');
        row.appendChild(el('td', 'mono', c.hash));
        row.appendChild(el('td', null, c.subject));
        row.appendChild(el('td', 'note', ago(c.when)));
        table.appendChild(row);
      });
      box.appendChild(table);
    }
  }

  var STATE_DOT = {
    'problems found': 'bad', 'things to check': 'warn', 'last run held': 'ok', 'nothing found': 'ok',
  };

  function renderChecks(state) {
    var box = document.getElementById('checks');
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
      var text = el('div');
      text.appendChild(el('div', 'c-name', c.label));
      var st = el('div', 'c-state');
      st.appendChild(el('span', 'sdot ' + (STATE_DOT[c.state] || '')));
      st.appendChild(el('span', null, c.state));
      text.appendChild(st);
      if (c.what) text.appendChild(el('div', 'c-what', c.what));
      if (c.runnable && c.enabled) {
        var run = el('button', 'btn');
        run.type = 'button';
        run.style.marginTop = '8px';
        run.setAttribute('data-action', 'run');
        run.disabled = busy;
        run.appendChild(icon('bolt', 14));
        var runText = el('span', null, 'Run now');
        run.appendChild(runText);
        run.addEventListener('click', function () { runCheck(c.id, run, runText); });
        text.appendChild(run);
      }
      row.appendChild(sw);
      row.appendChild(text);
      box.appendChild(row);
    });
  }

  function renderRuns(state) {
    var box = document.getElementById('runs');
    clear(box);
    if (!state.runs.length) {
      box.appendChild(el('p', 'empty', 'No recorded flows have been run yet.'));
      return;
    }
    var bars = el('div', 'bars');
    var recent = state.runs.slice(0, 20).reverse();
    var most = Math.max.apply(null, recent.map(function (r) { return (r.passed || 0) + (r.failed || 0); }).concat([1]));
    recent.forEach(function (r) {
      var total = (r.passed || 0) + (r.failed || 0);
      var b = el('div', 'bar' + (r.failed ? ' bad' : ''));
      b.style.height = Math.max(12, Math.round((Math.max(total, 1) / most) * 100)) + '%';
      b.title = when(r.runAt) + ': ' + (r.passed || 0) + ' held, ' + (r.failed || 0) + ' broke';
      bars.appendChild(b);
    });
    box.appendChild(bars);
    var table = el('table');
    var head = el('tr');
    ['When', 'Result', 'Held', 'Broke'].forEach(function (h) { head.appendChild(el('th', null, h)); });
    table.appendChild(head);
    state.runs.slice(0, 8).forEach(function (r) {
      var row = el('tr');
      row.appendChild(el('td', null, ago(r.runAt)));
      var res = el('td');
      res.appendChild(el('span', 'pill ' + (r.failed ? 'bad' : 'ok'), r.status));
      row.appendChild(res);
      row.appendChild(el('td', null, r.passed));
      row.appendChild(el('td', null, r.failed));
      table.appendChild(row);
    });
    box.appendChild(table);
  }

  /* ---------------------------------- actions ---------------------------------- */

  function copy(text, done) {
    navigator.clipboard.writeText(text).then(function () { toast(done); }, function () {
      toast('Could not copy - select the text instead');
    });
  }

  function recheck(f, button) {
    if (busy) return;
    setBusy(true);
    button.textContent = '';
    button.appendChild(el('span', 'spin'));
    button.appendChild(el('span', null, f.check === 'regression' ? 'Replaying...' : 'Re-checking...'));
    post('/api/recheck', { id: f.id }).then(function (r) {
      var words = { fixed: 'FIXED', 'still open': 'STILL OPEN', 'gone with its file': 'GONE WITH ITS FILE - not the same as fixed', 'could not confirm': 'COULD NOT CONFIRM' };
      toast((words[r.verdict] || r.verdict) + (r.why ? ' - ' + r.why : '') +
        (r.newProblems && r.newProblems.length ? '  ·  ' + r.newProblems.length + ' new problem(s)' : ''));
    }).catch(function (err) {
      toast('Re-check failed: ' + err.message);
    }).then(function () {
      setBusy(false);
      return load();
    });
  }

  function runCheck(id, button, label) {
    if (busy) return;
    setBusy(true);
    var error = document.getElementById('checkError');
    error.hidden = true;
    label.textContent = 'Running...';
    post('/api/run', { id: id }).then(function () {
      toast('Finished');
    }).catch(function (err) {
      error.textContent = 'Run failed: ' + err.message;
      error.hidden = false;
    }).then(function () {
      setBusy(false);
      return load();
    });
  }

  function setCheck(id, on, input) {
    var error = document.getElementById('checkError');
    error.hidden = true;
    post('/api/check', { id: id, on: on }).then(function () {
      toast((on ? 'Switched on: ' : 'Switched off: ') + id);
      return load();
    }).catch(function (err) {
      input.checked = !on;
      error.textContent = 'Not saved: ' + err.message;
      error.hidden = false;
    });
  }

  /* ----------------------------------- load ----------------------------------- */

  function render(state) {
    if (!state) return;
    lastState = state;
    renderTop(state);
    renderHero(state);
    renderKpis(state);
    renderFindings(state);
    renderProven(state);
    renderChanges(state);
    renderChecks(state);
    renderRuns(state);
    document.getElementById('storeNote').textContent =
      'Everything here is read from ' + state.project.storeDir +
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
        document.getElementById('where').textContent = 'Could not load: ' + err.message;
      });
  }

  load();
  // Not while something is running: a re-render would take the spinner away.
  setInterval(function () { if (!busy) load(); }, 5000);
})();
