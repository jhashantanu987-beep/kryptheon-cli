// The dashboard page. Served from 127.0.0.1 by kryptheon-dashboard.js.
//
// Every value on this page can hold text from the app being checked - a line
// of its code, the heading of a page that broke. So nothing here is ever
// written as HTML: every node is made with createElement and filled with
// textContent. This file is read by kryptheon-code.js in its own check, and
// must come back with nothing to report.

(function () {
  'use strict';

  var tokenMeta = document.querySelector('meta[name="kryptheon-token"]');
  var TOKEN = tokenMeta ? tokenMeta.getAttribute('content') : '';

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function when(iso) {
    if (!iso) return 'unknown time';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
  }

  function stat(n, label) {
    var box = el('div', 'stat');
    box.appendChild(el('div', 'n', n));
    box.appendChild(el('div', 'l', label));
    return box;
  }

  function renderSummary(state) {
    var box = document.getElementById('summary');
    clear(box);
    var confirmed = state.findings.filter(function (f) { return f.status === 'confirmed'; }).length;
    var toCheck = state.findings.length - confirmed;
    var last = state.runs[0];
    box.appendChild(stat(confirmed, 'confirmed problems'));
    box.appendChild(stat(toCheck, 'to verify'));
    box.appendChild(stat(state.recordings, 'recordings'));
    box.appendChild(stat(last ? (last.failed ? last.failed + ' broken' : 'held') : 'never', 'last run'));
    document.getElementById('verification').textContent =
      'Verification: ' + state.verification.state + '. ' + state.verification.why;
  }

  function renderFindings(state) {
    var box = document.getElementById('findings');
    clear(box);
    if (!state.findings.length) {
      box.appendChild(el('p', 'empty', 'Nothing found by the checks that are switched on and have run. ' +
        'That is not the same as nothing wrong - see which checks are not available.'));
      return;
    }
    state.findings.forEach(function (f) {
      var item = el('div', 'finding');
      var tags = el('div', 'tags');
      tags.appendChild(el('span', 'tag sev-' + String(f.severity || '').replace(/\s+/g, ''), f.severity));
      tags.appendChild(el('span', 'tag', f.status));
      tags.appendChild(el('span', 'tag', f.evidence));
      tags.appendChild(el('span', 'tag', 'confidence: ' + f.confidence));
      tags.appendChild(el('span', 'tag', f.check));
      item.appendChild(tags);
      item.appendChild(el('div', 'headline', f.headline));
      item.appendChild(el('div', 'where', f.where + '  -  ' + when(f.when)));
      if (f.detail) item.appendChild(el('div', 'detail', f.detail));
      if (f.fixPrompt) {
        var more = el('details');
        more.appendChild(el('summary', null, 'Fix prompt'));
        more.appendChild(el('pre', null, f.fixPrompt));
        var copy = el('button', null, 'Copy prompt');
        copy.addEventListener('click', function () {
          navigator.clipboard.writeText(f.fixPrompt).then(function () {
            copy.textContent = 'Copied';
          }, function () {
            copy.textContent = 'Could not copy - select the text above';
          });
        });
        more.appendChild(copy);
        item.appendChild(more);
      } else if (f.fixWhere) {
        item.appendChild(el('div', 'detail', 'Fix prompt: ' + f.fixWhere + '.'));
      }
      box.appendChild(item);
    });
  }

  function renderRuns(state) {
    var box = document.getElementById('runs');
    clear(box);
    if (!state.runs.length) {
      box.appendChild(el('p', 'empty', 'No recorded flows have been run yet.'));
      return;
    }
    var table = el('table');
    var head = el('tr');
    ['When', 'Result', 'Held', 'Broke'].forEach(function (h) { head.appendChild(el('th', null, h)); });
    table.appendChild(head);
    state.runs.forEach(function (r) {
      var row = el('tr');
      row.appendChild(el('td', null, when(r.runAt)));
      row.appendChild(el('td', null, r.status));
      row.appendChild(el('td', null, r.passed));
      row.appendChild(el('td', null, r.failed));
      table.appendChild(row);
    });
    box.appendChild(table);
  }

  function renderChanges(state) {
    var box = document.getElementById('changes');
    clear(box);
    if (!state.changes) {
      box.appendChild(el('p', 'empty', 'This folder is not a git repository, so there is no change history to show.'));
      return;
    }
    var changes = state.changes;
    box.appendChild(el('p', 'notice', changes.uncommitted.length
      ? changes.uncommitted.length + ' file' + (changes.uncommitted.length === 1 ? '' : 's') + ' changed and not committed yet.'
      : 'No uncommitted changes.'));
    changes.uncommitted.slice(0, 12).forEach(function (c) {
      box.appendChild(el('div', 'where', c.state + '  ' + c.file));
    });
    if (changes.commits.length) {
      var table = el('table');
      changes.commits.forEach(function (c) {
        var row = el('tr');
        row.appendChild(el('td', 'where', c.hash));
        row.appendChild(el('td', null, c.subject));
        row.appendChild(el('td', 'where', when(c.when)));
        table.appendChild(row);
      });
      box.appendChild(table);
    }
  }

  function renderChecks(state) {
    var box = document.getElementById('checks');
    clear(box);
    state.checks.forEach(function (c) {
      var row = el('div', 'check' + (c.available ? '' : ' na'));
      var toggle = el('input', 'switch');
      toggle.type = 'checkbox';
      toggle.checked = !!c.enabled;
      toggle.disabled = !c.available;
      toggle.setAttribute('aria-label', c.label);
      toggle.addEventListener('change', function () { setCheck(c.id, toggle.checked, toggle); });
      var text = el('div');
      text.appendChild(el('div', 'name', c.label));
      text.appendChild(el('div', 'state', c.state));
      if (c.what) text.appendChild(el('div', 'state', c.what));
      if (c.runnable && c.enabled) {
        var run = el('button', null, 'Run now');
        run.addEventListener('click', function () { runCheck(c.id, run); });
        text.appendChild(run);
      }
      row.appendChild(toggle);
      row.appendChild(text);
      box.appendChild(row);
    });
  }

  function runCheck(id, button) {
    var error = document.getElementById('checkError');
    error.hidden = true;
    button.disabled = true;
    button.textContent = 'Running...';
    fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kryptheon-token': TOKEN },
      body: JSON.stringify({ id: id }),
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok || !body.ok) throw new Error(body.why || 'the run did not finish');
        return load();
      });
    }).catch(function (err) {
      error.textContent = 'Run failed: ' + err.message;
      error.hidden = false;
    }).then(function () {
      button.disabled = false;
      button.textContent = 'Run now';
    });
  }

  function setCheck(id, on, toggle) {
    var error = document.getElementById('checkError');
    error.hidden = true;
    fetch('/api/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kryptheon-token': TOKEN },
      body: JSON.stringify({ id: id, on: on }),
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok || !body.ok) throw new Error(body.why || 'could not save');
        return load();
      });
    }).catch(function (err) {
      toggle.checked = !on;
      error.textContent = 'Not saved: ' + err.message;
      error.hidden = false;
    });
  }

  function render(state) {
    document.getElementById('title').textContent = 'Kryptheon - ' + state.project.name;
    document.getElementById('where').textContent = state.project.root;
    document.getElementById('storeNote').textContent =
      'Everything shown here is read from ' + state.project.storeDir +
      ' on this machine. Nothing is sent anywhere, and nothing is written into your project.';
    renderSummary(state);
    renderFindings(state);
    renderRuns(state);
    renderChanges(state);
    renderChecks(state);
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
  setInterval(load, 15000);
})();
