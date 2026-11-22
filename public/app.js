/* ToDoApp – Phase 1
 * ES5, kein Build-Schritt. Daten liegen in Cloudflare D1 (über /api),
 * eine Kopie im localStorage sorgt für schnellen Start und Lesezugriff offline.
 */
(function () {
  'use strict';

  var LEVEL = { 1: 'Niedrig', 2: 'Mittel', 3: 'Hoch' };
  var SHORT = { 1: 'N', 2: 'M', 3: 'H' };
  var DAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  var CACHE_KEY = 'todoapp.data.v1';
  var UI_KEY = 'todoapp.ui.v1';
  var SMART = [
    { id: 'all', name: 'Alle' },
    { id: 'today', name: 'Heute' },
    { id: 'week', name: 'Nächste 7 Tage' },
    { id: 'unrated', name: 'Unbewertet' },
    { id: 'done', name: 'Erledigt' }
  ];
  var KIND = {
    lists: { one: 'Liste', neu: 'Neue Liste', field: 'list_id' },
    areas: { one: 'Bereich', neu: 'Neuer Bereich', field: 'area_id' },
    categories: { one: 'Kategorie', neu: 'Neue Kategorie', field: 'category_id' }
  };

  var S = {
    user: '', lists: [], areas: [], categories: [], tasks: [],
    view: 'list', smart: 'all', listId: null, areaId: '', categoryId: '', search: '',
    editId: null, showDone: false, drawer: false, loaded: false
  };

  var chains = {};
  var pending = 0;
  var lastLoad = 0;
  var toastTimer = null;
  var toastAction = null;

  /* ---------- Hilfsfunktionen ---------- */

  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function extend(a, b) { for (var k in b) { if (Object.prototype.hasOwnProperty.call(b, k)) a[k] = b[k]; } return a; }
  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }
  function nowIso() { return new Date().toISOString(); }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function dstr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseD(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function todayStr() { return dstr(new Date()); }
  function addDays(s, n) { var d = parseD(s); d.setDate(d.getDate() + n); return dstr(d); }
  function find(arr, id) { for (var i = 0; i < arr.length; i++) { if (arr[i].id === id) return arr[i]; } return null; }
  function defOf(arr) { for (var i = 0; i < arr.length; i++) { if (arr[i].is_default) return arr[i]; } return arr[0] || null; }
  function idOf(o) { return o ? o.id : null; }
  function score(t) { return t.urgency + t.importance; }
  function childrenOf(id) { return S.tasks.filter(function (t) { return t.parent_id === id; }); }
  function sortMeta(arr) {
    return arr.slice().sort(function (a, b) {
      if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
      return a.name.localeCompare(b.name, 'de');
    });
  }

  function fmtDue(t) {
    if (!t.due_date) return '';
    var t0 = todayStr(), label;
    if (t.due_date === t0) label = 'Heute';
    else if (t.due_date === addDays(t0, 1)) label = 'Morgen';
    else if (t.due_date === addDays(t0, -1)) label = 'Gestern';
    else {
      var d = parseD(t.due_date);
      label = DAYS[d.getDay()] + ' ' + pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.';
      if (d.getFullYear() !== new Date().getFullYear()) label += d.getFullYear();
    }
    return t.due_time ? label + ' ' + t.due_time : label;
  }
  function dueClass(t) {
    if (!t.due_date || t.done) return '';
    var t0 = todayStr();
    return t.due_date < t0 ? 'overdue' : (t.due_date === t0 ? 'today' : '');
  }
  function fmtDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function byPriority(a, b) {
    var d = score(b) - score(a);
    if (d) return d;
    d = b.importance - a.importance;
    if (d) return d;
    if (a.due_date !== b.due_date) {
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return a.due_date < b.due_date ? -1 : 1;
    }
    return (a.sort || 0) - (b.sort || 0);
  }
  function byDoneAt(a, b) { return (b.done_at || '') < (a.done_at || '') ? -1 : 1; }
  function bySort(a, b) { return (a.sort || 0) - (b.sort || 0); }

  /* ---------- Speicher ---------- */

  function persist() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        user: S.user, lists: S.lists, areas: S.areas, categories: S.categories, tasks: S.tasks
      }));
    } catch (e) { /* Speicher voll oder gesperrt – egal, Server ist führend */ }
  }
  function loadCache() {
    try {
      var d = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (d && d.tasks) { S.user = d.user || ''; S.lists = d.lists; S.areas = d.areas; S.categories = d.categories; S.tasks = d.tasks; }
    } catch (e) { /* ignorieren */ }
  }
  function saveUi() {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({
        view: S.view, smart: S.smart, listId: S.listId, areaId: S.areaId, categoryId: S.categoryId
      }));
    } catch (e) { /* ignorieren */ }
  }
  function loadUi() {
    try { extend(S, JSON.parse(localStorage.getItem(UI_KEY) || '{}')); } catch (e) { /* ignorieren */ }
  }

  /* ---------- Server ---------- */

  function api(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', redirect: 'manual', headers: {} };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch('/api/' + path, opts).then(function (r) {
      if (r.type === 'opaqueredirect' || r.status === 401) {
        var ae = new Error('Anmeldung abgelaufen'); ae.auth = true; throw ae;
      }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  // Serialisiert Anfragen pro Datensatz, damit z. B. PATCH nie vor dem POST ankommt.
  function enqueue(key, fn) {
    pending++;
    var prev = chains[key] || Promise.resolve();
    var p = prev.then(fn).catch(fail).then(function () { pending--; });
    chains[key] = p;
    return p;
  }

  function fail(e) {
    if (e && e.auth) {
      toast('Anmeldung abgelaufen.', 'Neu anmelden', function () { location.reload(); }, 0);
    } else if (e && e.name === 'TypeError') {
      toast('Offline – Änderung wurde nicht gespeichert.', null, null, 5000);
    } else {
      toast('Nicht gespeichert: ' + (e && e.message ? e.message : 'Fehler') + '. Daten werden neu geladen.', null, null, 5000);
      load(true);
    }
  }

  function load(force) {
    if (!force && (pending > 0 || S.editId)) return;
    lastLoad = Date.now();
    api('GET', 'bootstrap').then(function (d) {
      S.user = d.user; S.lists = d.lists; S.areas = d.areas; S.categories = d.categories; S.tasks = d.tasks;
      S.loaded = true;
      persist();
      render();
      if (S.editId) renderSheet();
    }).catch(function (e) {
      S.loaded = true;
      if (e && e.auth) { fail(e); return; }
      if (e && e.name === 'TypeError') toast('Offline – zeige gespeicherten Stand.', null, null, 4000);
      else toast('Laden fehlgeschlagen: ' + (e && e.message), null, null, 6000);
      render();
    });
  }

  /* ---------- Aufgaben ändern ---------- */

  function newTaskDefaults() {
    return {
      list_id: S.smart === 'list' && S.listId ? S.listId : idOf(defOf(S.lists)),
      area_id: S.areaId || idOf(defOf(S.areas)),
      category_id: S.categoryId || idOf(defOf(S.categories)),
      due_date: S.smart === 'today' ? todayStr() : (S.smart === 'week' ? todayStr() : null)
    };
  }

  function createTask(fields) {
    var now = nowIso();
    var t = {
      id: uuid(), parent_id: null, list_id: null, area_id: null, category_id: null,
      title: '', notes: '', urgency: 1, importance: 1, rated: 0,
      due_date: null, due_time: null, recurrence: null, done: 0, done_at: null,
      sort: Date.now(), created_at: now, updated_at: now
    };
    extend(t, newTaskDefaults());
    extend(t, fields);
    S.tasks.push(t);
    persist();
    var post = function () {
      return api('POST', 'tasks', t).then(function (srv) {
        var cur = find(S.tasks, srv.id);
        if (!cur) return;
        ['list_id', 'area_id', 'category_id'].forEach(function (f) { if (!cur[f]) cur[f] = srv[f]; });
        persist();
      });
    };
    // Unteraufgaben erst nach der Hauptaufgabe anlegen
    if (t.parent_id) chains[t.id] = enqueue(t.parent_id, post);
    else enqueue(t.id, post);
    return t;
  }

  function updateTask(id, patch) {
    var t = find(S.tasks, id);
    if (!t) return;
    var changed = false;
    for (var k in patch) { if (t[k] !== patch[k]) changed = true; }
    if (!changed) return;
    extend(t, patch);
    t.updated_at = nowIso();
    if (Object.prototype.hasOwnProperty.call(patch, 'done')) t.done_at = patch.done ? nowIso() : null;
    persist();
    enqueue(id, function () { return api('PATCH', 'tasks/' + encodeURIComponent(id), patch); });
  }

  function deleteTask(id, ask) {
    var t = find(S.tasks, id);
    if (!t) return;
    var subs = childrenOf(id).length;
    if (ask && !window.confirm('„' + t.title + '“ löschen?' + (subs ? ' Auch ' + subs + ' Unteraufgabe(n) werden gelöscht.' : ''))) return;
    S.tasks = S.tasks.filter(function (x) { return x.id !== id && x.parent_id !== id; });
    persist();
    if (S.editId === id) {
      if (t.parent_id) { S.editId = t.parent_id; renderSheet(); } else closeEditor(true);
    } else if (S.editId) renderSheet();
    render();
    enqueue(id, function () { return api('DELETE', 'tasks/' + encodeURIComponent(id)); });
  }

  function toggleDone(id) {
    var t = find(S.tasks, id);
    if (!t) return;
    var nd = t.done ? 0 : 1;
    updateTask(id, { done: nd });
    render();
    if (S.editId) renderSheet();
    if (nd && !t.parent_id) {
      toast('„' + t.title + '“ erledigt', 'Rückgängig', function () {
        updateTask(id, { done: 0 });
        render();
        if (S.editId) renderSheet();
      }, 4000);
    }
  }

  function setRating(field, value) {
    var p = { rated: 1 };
    p[field] = value;
    updateTask(S.editId, p);
    render();
    renderSheet();
  }

  /* ---------- Listen, Bereiche, Kategorien ---------- */

  function addMeta(kind) {
    var name = window.prompt(KIND[kind].neu + ' – Name:');
    if (!name || !name.replace(/\s/g, '')) return;
    var row = { id: uuid(), name: name.trim().slice(0, 500), color: null, sort: 0, is_default: 0 };
    S[kind].push(row);
    persist();
    render();
    enqueue(row.id, function () { return api('POST', kind, row); });
  }

  function renameMeta(kind, id) {
    var r = find(S[kind], id);
    if (!r) return;
    var name = window.prompt(KIND[kind].one + ' umbenennen:', r.name);
    if (!name || !name.replace(/\s/g, '') || name.trim() === r.name) return;
    r.name = name.trim().slice(0, 500);
    persist();
    render();
    enqueue(id, function () { return api('PATCH', kind + '/' + encodeURIComponent(id), { name: r.name }); });
  }

  function removeMeta(kind, id) {
    var r = find(S[kind], id), def = defOf(S[kind]);
    if (!r || r.is_default) return;
    var field = KIND[kind].field;
    var n = S.tasks.filter(function (t) { return t[field] === id; }).length;
    if (!window.confirm(KIND[kind].one + ' „' + r.name + '“ löschen?' +
      (n ? ' ' + n + ' Aufgabe(n) wandern nach „' + def.name + '“.' : ''))) return;
    S.tasks.forEach(function (t) { if (t[field] === id) t[field] = def.id; });
    S[kind] = S[kind].filter(function (x) { return x.id !== id; });
    if (kind === 'lists' && S.listId === id) { S.smart = 'all'; S.listId = null; }
    if (kind === 'areas' && S.areaId === id) S.areaId = '';
    if (kind === 'categories' && S.categoryId === id) S.categoryId = '';
    saveUi();
    persist();
    render();
    enqueue(id, function () { return api('DELETE', kind + '/' + encodeURIComponent(id)); });
  }

  /* ---------- Filter ---------- */

  function visibleTasks() {
    var q = S.search.trim().toLowerCase();
    var t0 = todayStr(), t7 = addDays(t0, 7);
    return S.tasks.filter(function (t) {
      if (t.parent_id) return false;
      if (S.areaId && t.area_id !== S.areaId) return false;
      if (S.categoryId && t.category_id !== S.categoryId) return false;
      if (q && (t.title + ' ' + (t.notes || '')).toLowerCase().indexOf(q) < 0) return false;
      switch (S.smart) {
        case 'list': return t.list_id === S.listId;
        case 'today': return !!t.due_date && t.due_date <= t0;
        case 'week': return !!t.due_date && t.due_date <= t7;
        case 'unrated': return !t.rated && !t.done;
        case 'done': return !!t.done;
        default: return true;
      }
    });
  }

  function openCount(pred) {
    var n = 0;
    S.tasks.forEach(function (t) { if (!t.parent_id && !t.done && pred(t)) n++; });
    return n;
  }
  function smartCount(id) {
    var t0 = todayStr(), t7 = addDays(t0, 7);
    switch (id) {
      case 'today': return openCount(function (t) { return t.due_date && t.due_date <= t0; });
      case 'week': return openCount(function (t) { return t.due_date && t.due_date <= t7; });
      case 'unrated': return openCount(function (t) { return !t.rated; });
      case 'done': return '';
      default: return openCount(function () { return true; });
    }
  }

  function currentTitle() {
    if (S.smart === 'list') { var l = find(S.lists, S.listId); return l ? l.name : 'Liste'; }
    for (var i = 0; i < SMART.length; i++) { if (SMART[i].id === S.smart) return SMART[i].name; }
    return 'Alle';
  }

  /* ---------- Darstellung ---------- */

  function render() {
    if (S.smart === 'list' && !find(S.lists, S.listId) && S.lists.length) { S.smart = 'all'; S.listId = null; }
    if (S.areaId && S.areas.length && !find(S.areas, S.areaId)) S.areaId = '';
    if (S.categoryId && S.categories.length && !find(S.categories, S.categoryId)) S.categoryId = '';
    $('#title').textContent = currentTitle();
    var vb = document.querySelectorAll('.viewtoggle button');
    for (var i = 0; i < vb.length; i++) vb[i].className = vb[i].getAttribute('data-v') === S.view ? 'on' : '';
    renderFilters();
    renderMain();
    if (S.drawer) renderDrawer();
  }

  function optionsHtml(arr, allLabel, selected) {
    var html = allLabel !== null ? '<option value="">' + esc(allLabel) + '</option>' : '';
    sortMeta(arr).forEach(function (x) {
      html += '<option value="' + esc(x.id) + '"' + (x.id === selected ? ' selected' : '') + '>' + esc(x.name) + '</option>';
    });
    return html;
  }

  function renderFilters() {
    var fa = $('#f-area'), fc = $('#f-cat');
    fa.innerHTML = optionsHtml(S.areas, 'Alle Bereiche', S.areaId);
    fc.innerHTML = optionsHtml(S.categories, 'Alle Kategorien', S.categoryId);
    fa.value = S.areaId; fc.value = S.categoryId;
    fa.className = S.areaId ? 'active' : '';
    fc.className = S.categoryId ? 'active' : '';
  }

  function renderMain() {
    var main = $('#main');
    if (!S.loaded && !S.tasks.length) { main.innerHTML = '<p class="empty">Lade …</p>'; return; }
    main.innerHTML = S.view === 'matrix' ? matrixHtml() : listHtml();
  }

  function unratedHint() {
    var n = smartCount('unrated');
    if (!n || S.smart === 'unrated' || S.smart === 'done') return '';
    return '<button class="hint" data-act="smart" data-v="unrated">' + n + ' unbewertete Aufgabe' +
      (n === 1 ? '' : 'n') + ' – jetzt einordnen ›</button>';
  }

  function rowHtml(t) {
    var meta = [];
    var subs = childrenOf(t.id);
    if (t.due_date) meta.push('<span class="chip ' + dueClass(t) + '">' + esc(fmtDue(t)) + '</span>');
    var l = find(S.lists, t.list_id);
    if (l && !l.is_default && S.smart !== 'list') meta.push('<span class="chip">≡ ' + esc(l.name) + '</span>');
    var a = find(S.areas, t.area_id);
    if (a && !a.is_default) meta.push('<span class="chip">◆ ' + esc(a.name) + '</span>');
    var c = find(S.categories, t.category_id);
    if (c && !c.is_default) meta.push('<span class="chip"># ' + esc(c.name) + '</span>');
    if (subs.length) {
      var sd = subs.filter(function (s) { return s.done; }).length;
      meta.push('<span class="chip">☑ ' + sd + '/' + subs.length + '</span>');
    }
    if (t.notes) meta.push('<span class="chip">✎</span>');
    if (!t.rated && !t.done) meta.push('<span class="chip new">unbewertet</span>');
    var id = esc(t.id);
    return '<div class="task s' + score(t) + (t.rated ? '' : ' unrated') + (t.done ? ' is-done' : '') + '">' +
      '<button class="chk" data-act="toggle" data-id="' + id + '" aria-label="' + (t.done ? 'Wieder öffnen' : 'Erledigen') + '">' + (t.done ? '✓' : '') + '</button>' +
      '<div class="tmain" data-act="open" data-id="' + id + '"><div class="ttitle">' + esc(t.title) + '</div>' +
      (meta.length ? '<div class="tmeta">' + meta.join('') + '</div>' : '') + '</div>' +
      '<span class="rate" data-act="open" data-id="' + id + '" title="Dringlichkeit ' + LEVEL[t.urgency] +
      ', Wichtigkeit ' + LEVEL[t.importance] + '">D' + SHORT[t.urgency] + ' · W' + SHORT[t.importance] + '</span>' +
      '</div>';
  }

  function section(title, items, cls) {
    if (!items.length) return '';
    return '<div class="group-title ' + (cls || '') + '">' + esc(title) + ' · ' + items.length + '</div>' +
      '<div class="group">' + items.map(rowHtml).join('') + '</div>';
  }

  function listHtml() {
    var items = visibleTasks();
    var html = unratedHint();
    if (S.smart === 'done') {
      items.sort(byDoneAt);
      return html + (items.length ? section('Erledigt (letzte 90 Tage)', items) : '<p class="empty">Noch nichts erledigt.</p>');
    }
    var open = [], done = [];
    items.forEach(function (t) { (t.done ? done : open).push(t); });
    open.sort(byPriority);
    var t0 = todayStr(), t1 = addDays(t0, 1), t7 = addDays(t0, 7);
    var g = { over: [], today: [], tomorrow: [], week: [], later: [], none: [] };
    open.forEach(function (t) {
      var d = t.due_date;
      if (!d) g.none.push(t);
      else if (d < t0) g.over.push(t);
      else if (d === t0) g.today.push(t);
      else if (d === t1) g.tomorrow.push(t);
      else if (d <= t7) g.week.push(t);
      else g.later.push(t);
    });
    html += section('Überfällig', g.over, 'overdue') + section('Heute', g.today) + section('Morgen', g.tomorrow) +
      section('Nächste 7 Tage', g.week) + section('Später', g.later) + section('Ohne Datum', g.none);
    if (!open.length) html += '<p class="empty">Keine offenen Aufgaben.</p>';
    if (done.length) {
      done.sort(byDoneAt);
      html += '<button class="done-toggle" data-act="showdone">' + (S.showDone ? '▾' : '▸') + ' Erledigt (' + done.length + ')</button>';
      if (S.showDone) html += '<div class="group">' + done.map(rowHtml).join('') + '</div>';
    }
    return html;
  }

  function matrixHtml() {
    if (S.smart === 'done') return '<p class="empty">Die Matrix zeigt nur offene Aufgaben.</p>';
    var cells = {};
    visibleTasks().forEach(function (t) {
      if (t.done) return;
      var k = t.importance + '-' + t.urgency;
      (cells[k] = cells[k] || []).push(t);
    });
    var html = unratedHint() + '<div class="matrix"><div class="mx-corner"></div>';
    [3, 2, 1].forEach(function (u) {
      html += '<div class="mx-head"><small>Dringlichkeit</small>' + LEVEL[u] + '</div>';
    });
    [3, 2, 1].forEach(function (i) {
      html += '<div class="mx-side"><span>Wichtigkeit ' + LEVEL[i] + '</span></div>';
      [3, 2, 1].forEach(function (u) {
        var list = (cells[i + '-' + u] || []).sort(function (a, b) {
          if (a.due_date !== b.due_date) {
            if (!a.due_date) return 1;
            if (!b.due_date) return -1;
            return a.due_date < b.due_date ? -1 : 1;
          }
          return (a.sort || 0) - (b.sort || 0);
        });
        html += '<div class="mx-cell s' + (i + u) + '"><div class="mx-count">' + (list.length || '') + '</div>';
        list.forEach(function (t) {
          html += '<button class="mx-task' + (t.rated ? '' : ' unrated') + '" data-act="open" data-id="' + esc(t.id) + '">' +
            '<span class="mx-t">' + esc(t.title) + '</span>' +
            (t.due_date ? '<span class="due ' + dueClass(t) + '">' + esc(fmtDue(t)) + '</span>' : '') + '</button>';
        });
        html += '<button class="mx-add" data-act="mxadd" data-u="' + u + '" data-i="' + i + '" aria-label="Aufgabe mit Dringlichkeit ' +
          LEVEL[u] + ' und Wichtigkeit ' + LEVEL[i] + ' anlegen">＋</button></div>';
      });
    });
    html += '</div><p class="mx-legend">Oben links: sofort erledigen · unten rechts: später oder streichen. ' +
      'Neue Aufgaben starten unten rechts (gestrichelt = noch unbewertet).</p>';
    return html;
  }

  function renderDrawer() {
    var html = '<div class="dr-sec"><h3>Ansichten</h3>';
    SMART.forEach(function (s) {
      html += '<div class="dr-row"><button class="dr-item' + (S.smart === s.id ? ' on' : '') + '" data-act="smart" data-v="' + s.id + '">' +
        '<span>' + s.name + '</span><span class="cnt">' + smartCount(s.id) + '</span></button></div>';
    });
    html += '</div>';
    html += metaSection('lists', 'Listen', function (x) {
      return { act: 'list', on: S.smart === 'list' && S.listId === x.id,
        cnt: openCount(function (t) { return t.list_id === x.id; }) };
    });
    html += metaSection('areas', 'Bereiche (Filter)', function (x) {
      return { act: 'farea', on: S.areaId === x.id, cnt: openCount(function (t) { return t.area_id === x.id; }) };
    });
    html += metaSection('categories', 'Kategorien (Filter)', function (x) {
      return { act: 'fcat', on: S.categoryId === x.id, cnt: openCount(function (t) { return t.category_id === x.id; }) };
    });
    html += '<div class="dr-foot">' + (S.user ? 'Angemeldet: ' + esc(S.user) + '<br>' : '') +
      '<button class="link" data-act="reload">Neu laden</button></div>';
    $('#drawer').innerHTML = html;
  }

  function metaSection(kind, title, info) {
    var html = '<div class="dr-sec"><h3>' + title + '</h3>';
    sortMeta(S[kind]).forEach(function (x) {
      var inf = info(x), id = esc(x.id);
      html += '<div class="dr-row"><button class="dr-item' + (inf.on ? ' on' : '') + '" data-act="' + inf.act + '" data-id="' + id + '">' +
        '<span>' + esc(x.name) + '</span><span class="cnt">' + inf.cnt + '</span></button>' +
        (x.is_default ? '' :
          '<button class="icon-btn sm" data-act="rename" data-kind="' + kind + '" data-id="' + id + '" aria-label="Umbenennen">✎</button>' +
          '<button class="icon-btn sm" data-act="remove" data-kind="' + kind + '" data-id="' + id + '" aria-label="Löschen">🗑</button>') +
        '</div>';
    });
    html += '<button class="dr-add" data-act="add" data-kind="' + kind + '">＋ ' + KIND[kind].one + '</button></div>';
    return html;
  }

  function toggleDrawer(open) {
    S.drawer = open;
    $('#drawer').hidden = !open;
    $('#drawer-bg').hidden = !open;
    if (open) renderDrawer();
  }

  /* ---------- Editor ---------- */

  function segHtml(field, label, t) {
    var html = '<span class="lbl">' + label + '</span><div class="seg">';
    [1, 2, 3].forEach(function (v) {
      html += '<button class="v' + v + (t[field] === v && t.rated ? ' on' : '') + '" data-act="seg" data-field="' + field + '" data-v="' + v + '">' + LEVEL[v] + '</button>';
    });
    return html + '</div>';
  }
  function field(label, inner, full) {
    return '<label class="' + (full ? 'full' : '') + '"><span class="lbl">' + label + '</span>' + inner + '</label>';
  }

  function openEditor(id) {
    if (S.editId && S.editId !== id) blurActive();
    S.editId = id;
    renderSheet();
    $('#sheet').hidden = false;
    $('#sheet-bg').hidden = false;
    $('#sheet').scrollTop = 0;
    document.body.className = 'noscroll';
  }

  function blurActive() {
    var a = document.activeElement;
    if (a && a.blur && a !== document.body) a.blur();
  }

  function closeEditor(skipBlur) {
    if (!skipBlur) blurActive();
    S.editId = null;
    $('#sheet').hidden = true;
    $('#sheet-bg').hidden = true;
    document.body.className = '';
    render();
  }

  function renderSheet() {
    var t = find(S.tasks, S.editId);
    if (!t) { closeEditor(true); return; }
    var parent = t.parent_id ? find(S.tasks, t.parent_id) : null;
    var id = esc(t.id);
    var html = '<div class="sh-head"><button class="icon-btn" data-act="close" aria-label="Schließen">✕</button>' +
      '<span class="sh-title">' + (parent ? 'Unteraufgabe' : 'Aufgabe') + '</span>' +
      '<button class="btn' + (t.done ? '' : ' primary') + '" data-act="toggle" data-id="' + id + '">' + (t.done ? 'Wieder öffnen' : '✓ Erledigt') + '</button></div>';
    if (parent) html += '<button class="link" data-act="open" data-id="' + esc(parent.id) + '">‹ ' + esc(parent.title) + '</button>';
    html += '<input id="e-title" class="e-title" value="' + esc(t.title) + '" maxlength="500" aria-label="Titel">';
    html += '<textarea id="e-notes" rows="3" placeholder="Notizen …" aria-label="Notizen">' + esc(t.notes) + '</textarea>';
    if (!parent) {
      html += segHtml('urgency', 'Dringlichkeit', t) + segHtml('importance', 'Wichtigkeit', t);
      if (!t.rated) html += '<p class="note">Noch unbewertet (zählt als Niedrig/Niedrig). <button class="link" data-act="markrated">So bestätigen</button></p>';
    }
    html += '<div class="grid2">' +
      field('Fällig am', '<input id="e-date" type="date" value="' + esc(t.due_date || '') + '">') +
      field('Uhrzeit', '<input id="e-time" type="time" value="' + esc(t.due_time || '') + '"' + (t.due_date ? '' : ' disabled') + '>');
    if (!parent) {
      html += field('Liste', '<select id="e-list">' + optionsHtml(S.lists, null, t.list_id) + '</select>', true) +
        field('Bereich', '<select id="e-area">' + optionsHtml(S.areas, null, t.area_id) + '</select>') +
        field('Kategorie', '<select id="e-cat">' + optionsHtml(S.categories, null, t.category_id) + '</select>');
    }
    html += '</div>';
    if (!parent) {
      var subs = childrenOf(t.id).sort(bySort);
      html += '<h4>Unteraufgaben' + (subs.length ? ' · ' + subs.filter(function (s) { return s.done; }).length + '/' + subs.length : '') + '</h4>';
      subs.forEach(function (s) {
        var sid = esc(s.id);
        html += '<div class="sub' + (s.done ? ' is-done' : '') + '">' +
          '<button class="chk sm" data-act="toggle" data-id="' + sid + '" aria-label="Erledigen">' + (s.done ? '✓' : '') + '</button>' +
          '<span class="sub-title" data-act="open" data-id="' + sid + '">' + esc(s.title) + (s.due_date ? ' <span class="chip ' + dueClass(s) + '">' + esc(fmtDue(s)) + '</span>' : '') + '</span>' +
          '<button class="icon-btn sm" data-act="del" data-id="' + sid + '" aria-label="Unteraufgabe löschen">✕</button></div>';
      });
      html += '<form id="sub-form" class="sub-add" autocomplete="off"><input id="sub-input" placeholder="Unteraufgabe hinzufügen …" enterkeyhint="done" maxlength="500">' +
        '<button type="submit" aria-label="Unteraufgabe hinzufügen">＋</button></form>';
    }
    html += '<div class="sh-foot"><button class="btn danger" data-act="delask" data-id="' + id + '">Löschen</button>' +
      '<span class="muted">Erstellt ' + fmtDateTime(t.created_at) + '</span></div>';
    $('#sheet').innerHTML = html;
  }

  /* ---------- Schnelleingabe ---------- */

  function parseQuick(text) {
    var due = null;
    var m = text.match(/\s+(heute|morgen|übermorgen)\s*$/i);
    if (m) {
      var w = m[1].toLowerCase();
      due = addDays(todayStr(), w === 'heute' ? 0 : (w === 'morgen' ? 1 : 2));
      text = text.slice(0, m.index);
    }
    return { title: text.trim(), due: due };
  }

  function isVisible(t) {
    var v = visibleTasks();
    for (var i = 0; i < v.length; i++) { if (v[i] === t) return true; }
    return false;
  }

  function matrixAdd(u, i) {
    var title = window.prompt('Neue Aufgabe (Dringlichkeit ' + LEVEL[u] + ', Wichtigkeit ' + LEVEL[i] + '):');
    if (!title || !title.replace(/\s/g, '')) return;
    var q = parseQuick(title);
    var f = { title: q.title.slice(0, 500), urgency: u, importance: i, rated: 1 };
    if (q.due) f.due_date = q.due;
    createTask(f);
    render();
  }

  /* ---------- Toast ---------- */

  function toast(msg, actionLabel, action, ms) {
    var el = $('#toast');
    toastAction = action || null;
    el.innerHTML = '<span>' + esc(msg) + '</span>' + (actionLabel ? '<button data-act="toast">' + esc(actionLabel) + '</button>' : '');
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = ms === 0 ? null : setTimeout(function () { el.hidden = true; toastAction = null; }, ms || 3000);
  }

  /* ---------- Ereignisse ---------- */

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    var act = el.getAttribute('data-act');
    var id = el.getAttribute('data-id');
    var v = el.getAttribute('data-v');
    var kind = el.getAttribute('data-kind');
    switch (act) {
      case 'drawer': toggleDrawer(true); break;
      case 'drawer-close': toggleDrawer(false); break;
      case 'view': S.view = v; saveUi(); render(); break;
      case 'smart': S.smart = v; S.listId = null; saveUi(); toggleDrawer(false); render(); window.scrollTo(0, 0); break;
      case 'list': S.smart = 'list'; S.listId = id; saveUi(); toggleDrawer(false); render(); window.scrollTo(0, 0); break;
      case 'farea': S.areaId = S.areaId === id ? '' : id; saveUi(); toggleDrawer(false); render(); break;
      case 'fcat': S.categoryId = S.categoryId === id ? '' : id; saveUi(); toggleDrawer(false); render(); break;
      case 'add': addMeta(kind); break;
      case 'rename': renameMeta(kind, id); break;
      case 'remove': removeMeta(kind, id); break;
      case 'open': openEditor(id); break;
      case 'close': closeEditor(); break;
      case 'toggle': toggleDone(id); break;
      case 'del': deleteTask(id, false); break;
      case 'delask': deleteTask(id, true); break;
      case 'seg': setRating(el.getAttribute('data-field'), parseInt(v, 10)); break;
      case 'markrated': updateTask(S.editId, { rated: 1 }); render(); renderSheet(); break;
      case 'mxadd': matrixAdd(parseInt(el.getAttribute('data-u'), 10), parseInt(el.getAttribute('data-i'), 10)); break;
      case 'showdone': S.showDone = !S.showDone; renderMain(); break;
      case 'reload': location.reload(); break;
      case 'toast':
        $('#toast').hidden = true;
        if (toastAction) { var fn = toastAction; toastAction = null; fn(); }
        break;
    }
  });

  document.addEventListener('change', function (e) {
    var id = e.target.id;
    if (id === 'f-area') { S.areaId = e.target.value; saveUi(); render(); return; }
    if (id === 'f-cat') { S.categoryId = e.target.value; saveUi(); render(); return; }
    var t = S.editId ? find(S.tasks, S.editId) : null;
    if (!t) return;
    switch (id) {
      case 'e-title':
        var v = e.target.value.trim();
        if (!v) { e.target.value = t.title; toast('Der Titel darf nicht leer sein.'); return; }
        updateTask(t.id, { title: v.slice(0, 500) });
        break;
      case 'e-notes': updateTask(t.id, { notes: e.target.value }); break;
      case 'e-date':
        var d = e.target.value || null;
        var p = { due_date: d };
        if (!d) p.due_time = null;
        updateTask(t.id, p);
        renderSheet();
        break;
      case 'e-time': updateTask(t.id, { due_time: e.target.value || null }); break;
      case 'e-list': updateTask(t.id, { list_id: e.target.value }); break;
      case 'e-area': updateTask(t.id, { area_id: e.target.value }); break;
      case 'e-cat': updateTask(t.id, { category_id: e.target.value }); break;
      default: return;
    }
    render();
  });

  document.addEventListener('input', function (e) {
    if (e.target.id === 'f-search') { S.search = e.target.value; renderMain(); }
  });

  document.addEventListener('submit', function (e) {
    e.preventDefault();
    if (e.target.id === 'quick') {
      var inp = $('#quick-input');
      var q = parseQuick(inp.value);
      if (!q.title) return;
      var f = { title: q.title.slice(0, 500) };
      if (q.due) f.due_date = q.due;
      var t = createTask(f);
      inp.value = '';
      render();
      if (!isVisible(t)) toast('Angelegt – in dieser Ansicht ausgeblendet.', 'Öffnen', function () { openEditor(t.id); }, 4000);
    } else if (e.target.id === 'sub-form') {
      var si = $('#sub-input');
      var title = si.value.trim();
      var parent = find(S.tasks, S.editId);
      if (!title || !parent) return;
      createTask({ parent_id: parent.id, title: title.slice(0, 500), due_date: null,
        list_id: parent.list_id, area_id: parent.area_id, category_id: parent.category_id });
      render();
      renderSheet();
      var n = $('#sub-input');
      if (n) n.focus();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (S.editId) closeEditor();
    else if (S.drawer) toggleDrawer(false);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && Date.now() - lastLoad > 60000) load(false);
  });

  /* ---------- Start ---------- */

  loadUi();
  loadCache();
  S.editId = null;
  render();
  load(true);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () { /* optional */ });
  }
})();
