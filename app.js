(function () {
  'use strict';

  const STORAGE_KEY = 'joke-planner:v1';
  const WORDS_PER_MINUTE = 150; // typical stand-up delivery pace, used for estimates

  /* ---------- helpers ---------- */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c.nodeType ? c : String(c));
    }
    return node;
  }

  const uid = () => (window.crypto && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

  function fmt(sec) {
    if (sec == null || Number.isNaN(sec)) return '—';
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  function fmtClock(ms) {
    const t = Math.max(0, ms) / 1000;
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  }

  /** Accepts "1:30", "1:02:30", "90", "90s", "2m", "2m 30s", "1.5m". Returns seconds, null if blank, NaN if invalid. */
  function parseDuration(input) {
    const str = String(input == null ? '' : input).trim().toLowerCase();
    if (!str) return null;
    let m = str.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
    if (m) return m[3] != null ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
    m = str.match(/^(?:(\d+(?:\.\d+)?)\s*m(?:in(?:s|utes?)?)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:s|onds?)?)?)?$/);
    if (m && (m[1] || m[2])) return Math.round((+(m[1] || 0)) * 60 + (+(m[2] || 0)));
    if (/^\d+(?:\.\d+)?$/.test(str)) return Math.round(+str);
    return NaN;
  }

  const wordCount = (text) => (String(text || '').trim().match(/\S+/g) || []).length;

  function estimateSeconds(script) {
    const words = wordCount(script);
    if (!words) return null;
    return Math.max(5, Math.round((words / WORDS_PER_MINUTE) * 60 / 5) * 5);
  }

  /** Length used for planning: the real timing if set, otherwise an estimate from the script. */
  function jokeLength(joke) {
    if (joke.duration != null) return { sec: joke.duration, estimated: false };
    const est = estimateSeconds(joke.script);
    return { sec: est || 0, estimated: est != null, missing: est == null };
  }

  function download(filename, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const today = () => new Date().toISOString().slice(0, 10);
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'set';

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  /* ---------- state & persistence ---------- */

  function defaultSettings() {
    return { voiceTrigger: true, autoStop: false, silenceSec: 4, transcribe: true, sensitivity: 5, sort: 'newest' };
  }

  function newSet(name) {
    const now = Date.now();
    return { id: uid(), name, targetSeconds: 300, jokeIds: [], createdAt: now, updatedAt: now };
  }

  function defaultState() {
    const set = newSet('My set');
    return { version: 1, jokes: [], sets: [set], activeSetId: set.id, settings: defaultSettings(), lastBackupAt: null };
  }

  function normJoke(j) {
    if (!j || typeof j !== 'object') return null;
    const dur = typeof j.duration === 'number' && Number.isFinite(j.duration) && j.duration >= 0 ? Math.round(j.duration) : null;
    return {
      id: String(j.id || uid()),
      title: String(j.title || 'Untitled joke').slice(0, 200),
      script: String(j.script || ''),
      duration: dur,
      createdAt: Number(j.createdAt) || Date.now(),
      updatedAt: Number(j.updatedAt) || Date.now(),
    };
  }

  function normSet(s, jokeIds) {
    if (!s || typeof s !== 'object') return null;
    const ids = Array.isArray(s.jokeIds) ? s.jokeIds.map(String) : [];
    return {
      id: String(s.id || uid()),
      name: String(s.name || 'Untitled set').slice(0, 200),
      targetSeconds: Number(s.targetSeconds) > 0 ? Math.round(Number(s.targetSeconds)) : 300,
      jokeIds: Array.from(new Set(ids)).filter((id) => jokeIds.has(id)),
      createdAt: Number(s.createdAt) || Date.now(),
      updatedAt: Number(s.updatedAt) || Date.now(),
    };
  }

  function normalize(data) {
    const base = defaultState();
    if (!data || typeof data !== 'object') return base;
    const jokes = (Array.isArray(data.jokes) ? data.jokes : []).map(normJoke).filter(Boolean);
    const seen = new Set();
    const uniqueJokes = jokes.filter((j) => (seen.has(j.id) ? false : seen.add(j.id)));
    let sets = (Array.isArray(data.sets) ? data.sets : []).map((s) => normSet(s, seen)).filter(Boolean);
    if (!sets.length) sets = base.sets;
    const activeSetId = sets.some((s) => s.id === data.activeSetId) ? data.activeSetId : sets[0].id;
    return {
      version: 1,
      jokes: uniqueJokes,
      sets,
      activeSetId,
      settings: Object.assign(defaultSettings(), data.settings || {}),
      lastBackupAt: data.lastBackupAt || null,
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return normalize(JSON.parse(raw));
    } catch (err) {
      console.warn('Could not load saved data', err);
    }
    return defaultState();
  }

  let state = load();
  let saveTimer = null;
  let askedPersist = false;

  function save() {
    clearTimeout(saveTimer);
    setSaveStatus('Saving…');
    saveTimer = setTimeout(saveNow, 150);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      setSaveStatus('Saved in this browser', false);
    } catch (err) {
      console.error(err);
      setSaveStatus('Couldn’t save! Download a backup now.', true);
    }
    if (!askedPersist && navigator.storage && navigator.storage.persist) {
      askedPersist = true;
      navigator.storage.persist().catch(() => {});
    }
  }

  function setSaveStatus(text, isError) {
    const s = $('#saveStatus');
    s.textContent = text;
    s.classList.toggle('error', !!isError);
  }

  window.addEventListener('beforeunload', () => { if (saveTimer) saveNow(); });

  // Keep several open tabs in sync.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    try { state = normalize(JSON.parse(e.newValue)); render(); } catch (err) { /* ignore */ }
  });

  function commit(mutator) {
    mutator();
    save();
    render();
  }

  const getJoke = (id) => state.jokes.find((j) => j.id === id);
  const activeSet = () => state.sets.find((s) => s.id === state.activeSetId) || state.sets[0];
  const touch = (obj) => { obj.updatedAt = Date.now(); };

  function addToSet(jokeId, index) {
    const set = activeSet();
    set.jokeIds = set.jokeIds.filter((id) => id !== jokeId);
    if (index == null || index > set.jokeIds.length) set.jokeIds.push(jokeId);
    else set.jokeIds.splice(index, 0, jokeId);
    touch(set);
  }

  function removeFromSet(jokeId) {
    const set = activeSet();
    set.jokeIds = set.jokeIds.filter((id) => id !== jokeId);
    touch(set);
  }

  /* ---------- rendering ---------- */

  let renderPending = false;

  function render() {
    if (drag && drag.started) { renderPending = true; return; }
    renderPending = false;
    renderLibrary();
    renderSet();
    renderBackupStatus();
  }

  function durationBadge(joke) {
    const len = jokeLength(joke);
    if (len.missing) return el('span', { class: 'dur dur-missing', title: 'No length yet: time it or add a script' }, '—');
    if (len.estimated) {
      return el('span', { class: 'dur dur-est', title: `Estimated from ${wordCount(joke.script)} words. Time it for a real length.` }, '~' + fmt(len.sec));
    }
    return el('span', { class: 'dur', title: 'Timed length' }, fmt(len.sec));
  }

  function snippet(script) {
    const s = String(script || '').replace(/\s+/g, ' ').trim();
    return s.length > 110 ? s.slice(0, 110) + '…' : s;
  }

  function jokeCard(joke, source, extra) {
    const inSet = activeSet().jokeIds.includes(joke.id);
    const body = el('div', { class: 'card-body', 'data-action': 'edit' },
      el('div', { class: 'card-title' }, joke.title),
      joke.script ? el('div', { class: 'card-snippet' }, snippet(joke.script)) : el('div', { class: 'card-snippet muted' }, 'No script yet'),
    );
    const actions = el('div', { class: 'card-actions' });
    if (source === 'library') {
      actions.append(
        el('button', { type: 'button', class: 'icon-btn', 'data-action': 'time', title: 'Time this joke', 'aria-label': `Time ${joke.title}` }, '⏱'),
        inSet
          ? el('button', { type: 'button', class: 'icon-btn in-set', 'data-action': 'unset', title: 'In set (click to remove)', 'aria-label': `Remove ${joke.title} from set` }, '✓')
          : el('button', { type: 'button', class: 'icon-btn add', 'data-action': 'add', title: 'Add to set', 'aria-label': `Add ${joke.title} to set` }, '＋'),
      );
    } else {
      actions.append(
        el('button', { type: 'button', class: 'icon-btn', 'data-action': 'time', title: 'Time this joke', 'aria-label': `Time ${joke.title}` }, '⏱'),
        el('button', { type: 'button', class: 'icon-btn', 'data-action': 'unset', title: 'Remove from set', 'aria-label': `Remove ${joke.title} from set` }, '✕'),
      );
    }
    return el('li', {
      class: 'card' + (source === 'library' && inSet ? ' is-in-set' : ''),
      tabindex: '0',
      dataset: { jokeId: joke.id, source },
      'aria-label': `${joke.title}, ${fmt(jokeLength(joke).sec)}`,
    },
    el('span', { class: 'grip', title: 'Drag', 'aria-hidden': 'true' }, '⠿'),
    extra || null,
    body,
    durationBadge(joke),
    actions);
  }

  function sortedJokes() {
    const q = $('#search').value.trim().toLowerCase();
    let list = state.jokes;
    if (q) list = list.filter((j) => j.title.toLowerCase().includes(q) || j.script.toLowerCase().includes(q));
    const sort = state.settings.sort;
    const by = {
      newest: (a, b) => b.createdAt - a.createdAt,
      oldest: (a, b) => a.createdAt - b.createdAt,
      title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
      short: (a, b) => jokeLength(a).sec - jokeLength(b).sec,
      long: (a, b) => jokeLength(b).sec - jokeLength(a).sec,
    }[sort] || ((a, b) => b.createdAt - a.createdAt);
    return list.slice().sort(by);
  }

  function renderLibrary() {
    const list = $('#library');
    const jokes = sortedJokes();
    list.replaceChildren(...jokes.map((j) => jokeCard(j, 'library')));
    $('#jokeCount').textContent = state.jokes.length ? String(state.jokes.length) : '';
    $('#sort').value = state.settings.sort;

    const empty = $('#libraryEmpty');
    if (!state.jokes.length) {
      empty.hidden = false;
      empty.replaceChildren(
        el('strong', {}, 'No jokes yet.'), el('br'),
        'Add one with ', el('b', {}, '＋ New joke'), ', or press ', el('b', {}, '● Record joke'),
        ' and perform it out loud: it gets timed and transcribed for you.',
      );
    } else if (!jokes.length) {
      empty.hidden = false;
      empty.replaceChildren('No jokes match your search.');
    } else {
      empty.hidden = true;
    }
  }

  function renderSet() {
    const set = activeSet();
    const select = $('#setSelect');
    select.replaceChildren(...state.sets.map((s) => el('option', { value: s.id, selected: s.id === set.id }, s.name)));

    const target = $('#targetMinutes');
    if (document.activeElement !== target) target.value = +(set.targetSeconds / 60).toFixed(2);

    const list = $('#setList');
    let clock = 0;
    let estimated = 0;
    let missing = 0;
    const cards = set.jokeIds.map((id, i) => {
      const joke = getJoke(id);
      if (!joke) return null;
      const len = jokeLength(joke);
      const startsAt = clock;
      clock += len.sec;
      if (len.estimated) estimated++;
      if (len.missing) missing++;
      const marker = el('span', { class: 'set-pos', title: `Starts at ${fmt(startsAt)}` },
        el('span', { class: 'set-num' }, String(i + 1)),
        el('span', { class: 'set-at' }, '@' + fmt(startsAt)));
      return jokeCard(joke, 'set', marker);
    }).filter(Boolean);
    list.replaceChildren(...cards);
    $('#setEmpty').hidden = cards.length > 0;

    const total = clock;
    const diff = set.targetSeconds - total;
    $('#setTotal').textContent = `${fmt(total)} / ${fmt(set.targetSeconds)}`;
    const diffEl = $('#setDiff');
    diffEl.className = 'diff ' + (diff < 0 ? 'over' : diff <= 15 ? 'spot-on' : 'under');
    diffEl.textContent = diff < 0 ? `${fmt(-diff)} over` : diff <= 15 ? (diff === 0 ? 'Right on time' : `${fmt(diff)} left · on target`) : `${fmt(diff)} left`;

    const pct = set.targetSeconds ? Math.min(100, (total / set.targetSeconds) * 100) : 0;
    const bar = $('#setProgress');
    bar.style.width = pct + '%';
    bar.className = 'progress-fill ' + (diff < 0 ? 'over' : diff <= 15 ? 'spot-on' : '');

    const bits = [`${cards.length} joke${cards.length === 1 ? '' : 's'}`];
    if (estimated) bits.push(`${estimated} estimated (~)`);
    if (missing) bits.push(`${missing} with no length`);
    $('#setMeta').textContent = bits.join(' · ');
  }

  function renderBackupStatus() {
    const s = $('#backupStatus');
    const last = state.lastBackupAt;
    const stale = state.jokes.length > 0 && (!last || Date.now() - last > 7 * 24 * 3600 * 1000);
    s.textContent = last ? `Last backup ${new Date(last).toLocaleDateString()}` : (state.jokes.length ? 'Never backed up' : '');
    $('#backupBtn').classList.toggle('nudge', stale);
  }

  /* ---------- drag & drop (mouse, pen and touch) ---------- */

  let drag = null;
  let suppressClickUntil = 0;

  function onPointerDown(e) {
    if (e.button !== 0 || drag) return;
    const card = e.target.closest('.card[data-joke-id]');
    if (!card) return;
    if (e.target.closest('button, input, textarea, select, a')) return;
    // On touch screens only the grip starts a drag, so the list still scrolls normally.
    if (e.pointerType !== 'mouse' && !e.target.closest('.grip')) return;
    drag = {
      card, id: card.dataset.jokeId, source: card.dataset.source, pointerId: e.pointerId,
      x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, started: false, target: null,
    };
    if (e.pointerType !== 'mouse') e.preventDefault();
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.started) {
      if (Math.hypot(drag.x - drag.x0, drag.y - drag.y0) < 6) return;
      beginDrag();
    }
    e.preventDefault();
    moveGhost();
    updateDropTarget();
  }

  function beginDrag() {
    const r = drag.card.getBoundingClientRect();
    drag.offX = drag.x0 - r.left;
    drag.offY = drag.y0 - r.top;
    const ghost = drag.card.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = r.width + 'px';
    ghost.removeAttribute('tabindex');
    document.body.append(ghost);
    drag.ghost = ghost;
    drag.placeholder = el('li', { class: 'drop-placeholder', 'aria-hidden': 'true' });
    drag.placeholder.style.height = r.height + 'px';
    if (drag.source === 'set') {
      drag.card.after(drag.placeholder);
      drag.card.classList.add('drag-hidden');
    } else {
      drag.card.classList.add('drag-origin');
    }
    drag.started = true;
    document.body.classList.add('is-dragging', 'drag-from-' + drag.source);
    const sel = window.getSelection && window.getSelection();
    if (sel) sel.removeAllRanges();
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function moveGhost() {
    drag.ghost.style.transform = `translate(${drag.x - drag.offX}px, ${drag.y - drag.offY}px) rotate(-1.5deg)`;
  }

  function updateDropTarget() {
    const under = document.elementFromPoint(drag.x, drag.y);
    const list = $('#setList');
    const overSet = !!(under && under.closest('#setPane'));
    const overLibrary = !!(under && under.closest('#libraryPane'));

    if (overSet) {
      const cards = $$(':scope > .card:not(.drag-hidden)', list);
      let before = null;
      for (const c of cards) {
        const r = c.getBoundingClientRect();
        if (drag.y < r.top + r.height / 2) { before = c; break; }
      }
      if (before) {
        if (drag.placeholder.nextElementSibling !== before) list.insertBefore(drag.placeholder, before);
      } else if (list.lastElementChild !== drag.placeholder) {
        list.append(drag.placeholder);
      }
      drag.target = 'set';
    } else {
      drag.placeholder.remove();
      drag.target = overLibrary && drag.source === 'set' ? 'remove' : null;
    }
    drag.ghost.classList.toggle('will-remove', drag.target === 'remove');
    $('#setPane').classList.toggle('drop-hover', drag.target === 'set');
    $('#libraryPane').classList.toggle('drop-hover-remove', drag.target === 'remove');
    $('#setEmpty').classList.toggle('is-hidden', drag.target === 'set');
  }

  function autoScroll() {
    if (!drag || !drag.started) return;
    const edge = 56;
    let scrolled = false;
    for (const sc of [$('#setList'), $('#library')]) {
      if (sc.scrollHeight <= sc.clientHeight) continue;
      const r = sc.getBoundingClientRect();
      if (drag.x < r.left || drag.x > r.right) continue;
      if (drag.y > r.top - 10 && drag.y < r.top + edge) { sc.scrollTop -= Math.ceil((r.top + edge - drag.y) / 4); scrolled = true; }
      else if (drag.y < r.bottom + 10 && drag.y > r.bottom - edge) { sc.scrollTop += Math.ceil((drag.y - (r.bottom - edge)) / 4); scrolled = true; }
    }
    if (drag.y < edge) { window.scrollBy(0, -Math.ceil((edge - drag.y) / 3)); scrolled = true; }
    else if (drag.y > window.innerHeight - edge) { window.scrollBy(0, Math.ceil((drag.y - (window.innerHeight - edge)) / 3)); scrolled = true; }
    if (scrolled) updateDropTarget();
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function removeDragListeners() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
  }

  function endDrag() {
    cancelAnimationFrame(drag.raf);
    if (drag.ghost) drag.ghost.remove();
    if (drag.placeholder) drag.placeholder.remove();
    drag.card.classList.remove('drag-hidden', 'drag-origin');
    document.body.classList.remove('is-dragging', 'drag-from-set', 'drag-from-library');
    $('#setPane').classList.remove('drop-hover');
    $('#libraryPane').classList.remove('drop-hover-remove');
    $('#setEmpty').classList.remove('is-hidden');
    drag = null;
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    removeDragListeners();
    if (!drag.started) { drag = null; return; }
    updateDropTarget();
    const { id, target, placeholder } = drag;
    let order = null;
    if (target === 'set') {
      order = [];
      for (const c of $('#setList').children) {
        if (c === placeholder) order.push(id);
        else if (c.dataset.jokeId && c.dataset.jokeId !== id) order.push(c.dataset.jokeId);
      }
    }
    endDrag();
    suppressClickUntil = performance.now() + 250;
    if (target === 'set') {
      commit(() => { const set = activeSet(); set.jokeIds = order; touch(set); });
    } else if (target === 'remove') {
      commit(() => removeFromSet(id));
    } else if (renderPending) {
      render();
    }
  }

  function onPointerCancel(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    removeDragListeners();
    if (drag.started) endDrag(); else drag = null;
    if (renderPending) render();
  }

  /* ---------- list interactions ---------- */

  function onListClick(e) {
    if (performance.now() < suppressClickUntil) return;
    const card = e.target.closest('.card[data-joke-id]');
    if (!card) return;
    const id = card.dataset.jokeId;
    const actionEl = e.target.closest('[data-action]');
    const action = actionEl ? actionEl.dataset.action : null;
    if (action === 'add') commit(() => addToSet(id));
    else if (action === 'unset') commit(() => removeFromSet(id));
    else if (action === 'time') timeJoke(id);
    else if (action === 'edit') openEditor(id);
  }

  function onListKey(e) {
    const card = e.target.closest('.card[data-joke-id]');
    if (!card || e.target !== card) return;
    const id = card.dataset.jokeId;
    const source = card.dataset.source;
    if (e.key === 'Enter') { e.preventDefault(); openEditor(id); return; }
    if (source === 'library' && (e.key === '+' || e.key === 'a')) { e.preventDefault(); commit(() => addToSet(id)); refocus(id, 'library'); return; }
    if (source !== 'set') return;
    const set = activeSet();
    const i = set.jokeIds.indexOf(id);
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
      if (j < 0 || j >= set.jokeIds.length) return;
      commit(() => { set.jokeIds.splice(i, 1); set.jokeIds.splice(j, 0, id); touch(set); });
      refocus(id, 'set');
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const next = set.jokeIds[i + 1] || set.jokeIds[i - 1];
      commit(() => removeFromSet(id));
      if (next) refocus(next, 'set');
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const sib = e.key === 'ArrowUp' ? card.previousElementSibling : card.nextElementSibling;
      if (sib) sib.focus();
    }
  }

  function refocus(id, source) {
    const c = $(`.card[data-source="${source}"][data-joke-id="${CSS.escape(id)}"]`);
    if (c) c.focus();
  }

  /* ---------- generic ask dialog ---------- */

  /**
   * ask({title, message, input?: defaultValue, buttons: [{label, value, kind}]}) → Promise<{value, text}|null>
   */
  function ask(opts) {
    const dlg = $('#askDialog');
    $('#askTitle').textContent = opts.title || '';
    $('#askMessage').textContent = opts.message || '';
    $('#askMessage').hidden = !opts.message;
    const input = $('#askInput');
    input.hidden = opts.input == null;
    input.value = opts.input == null ? '' : opts.input;
    const actions = $('#askActions');
    const buttons = opts.buttons || [{ label: 'Cancel', value: null }, { label: 'OK', value: 'ok', kind: 'primary' }];
    actions.replaceChildren(...buttons.map((b, i) => el('button', {
      type: b.kind === 'primary' ? 'submit' : 'button',
      class: 'btn' + (b.kind === 'primary' ? ' btn-primary' : b.kind === 'danger' ? ' btn-danger' : ''),
      dataset: { index: String(i) },
    }, b.label)));
    return new Promise((resolve) => {
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        dlg.removeEventListener('close', onClose);
        $('#askForm').onsubmit = null;
        actions.onclick = null;
        if (dlg.open) dlg.close();
        resolve(val);
      };
      const onClose = () => finish(null);
      dlg.addEventListener('close', onClose);
      const choose = (i) => {
        const b = buttons[i];
        finish(b.value == null ? null : { value: b.value, text: input.value.trim() });
      };
      actions.onclick = (e) => {
        const btn = e.target.closest('button[data-index]');
        if (btn && btn.type !== 'submit') choose(+btn.dataset.index);
      };
      $('#askForm').onsubmit = (e) => {
        e.preventDefault();
        choose(buttons.findIndex((b) => b.kind === 'primary'));
      };
      dlg.showModal();
      if (!input.hidden) { input.focus(); input.select(); }
    });
  }

  /* ---------- joke editor ---------- */

  const editor = { id: null };

  function openEditor(id) {
    const joke = id ? getJoke(id) : null;
    const form = $('#jokeForm');
    editor.id = joke ? joke.id : null;
    $('#jokeDialogTitle').textContent = joke ? 'Edit joke' : 'New joke';
    form.title.value = joke ? joke.title : '';
    form.script.value = joke ? joke.script : '';
    form.duration.value = joke && joke.duration != null ? fmt(joke.duration) : '';
    form.duration.setCustomValidity('');
    $('#deleteJokeBtn').hidden = !joke;
    updateEstimateHint();
    $('#jokeDialog').showModal();
    form.title.focus();
  }

  function updateEstimateHint() {
    const form = $('#jokeForm');
    const words = wordCount(form.script.value);
    const est = estimateSeconds(form.script.value);
    const hint = $('#estimateHint');
    if (!est) hint.textContent = 'Type m:ss (e.g. 1:30), or press Time it and perform it.';
    else if (form.duration.value.trim()) hint.textContent = `${words} words (about ${fmt(est)} at a typical pace)`;
    else hint.textContent = `${words} words: about ${fmt(est)} if left blank. Time it for a real length.`;
  }

  function saveEditor(e) {
    e.preventDefault();
    const form = $('#jokeForm');
    const dur = parseDuration(form.duration.value);
    if (Number.isNaN(dur)) {
      form.duration.setCustomValidity('Use minutes:seconds, like 1:30');
      form.duration.reportValidity();
      return;
    }
    const title = form.title.value.trim() || autoTitle(form.script.value);
    const script = form.script.value.replace(/\s+$/, '');
    commit(() => {
      if (editor.id) {
        const j = getJoke(editor.id);
        Object.assign(j, { title, script, duration: dur });
        touch(j);
      } else {
        const now = Date.now();
        state.jokes.push({ id: uid(), title, script, duration: dur, createdAt: now, updatedAt: now });
      }
    });
    $('#jokeDialog').close();
    toast(editor.id ? 'Joke updated' : 'Joke added');
  }

  async function deleteJoke() {
    const j = getJoke(editor.id);
    if (!j) return;
    const sets = state.sets.filter((s) => s.jokeIds.includes(j.id)).length;
    const res = await ask({
      title: `Delete “${j.title}”?`,
      message: sets ? `It will also be removed from ${sets} set${sets === 1 ? '' : 's'}. This can’t be undone.` : 'This can’t be undone.',
      buttons: [{ label: 'Cancel', value: null }, { label: 'Delete', value: 'delete', kind: 'danger' }],
    });
    if (!res) return;
    commit(() => {
      state.jokes = state.jokes.filter((x) => x.id !== j.id);
      state.sets.forEach((s) => { if (s.jokeIds.includes(j.id)) { s.jokeIds = s.jokeIds.filter((id) => id !== j.id); touch(s); } });
    });
    $('#jokeDialog').close();
    toast('Joke deleted');
  }

  function autoTitle(script) {
    const words = String(script || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return 'Untitled joke';
    const t = words.slice(0, 6).join(' ').replace(/[.,!?;:]+$/, '');
    return words.length > 6 ? t + '…' : t;
  }

  /* ---------- recorder / timer ---------- */

  const rec = { timer: null, ctx: null, phase: 'idle', userEdited: false, baseScript: '' };

  function timeJoke(id) {
    const j = getJoke(id);
    if (!j) return;
    openRecorder({
      mode: 'time',
      title: j.title,
      script: j.script,
      onSave(sec) {
        commit(() => { const joke = getJoke(id); if (joke) { joke.duration = sec; touch(joke); } });
        toast(`“${j.title}” timed at ${fmt(sec)}`);
      },
    });
  }

  function openRecorder(ctx) {
    rec.ctx = ctx;
    rec.userEdited = false;
    const isNew = ctx.mode === 'new';
    $('#recHeading').textContent = isNew ? 'Record a new joke' : `Time “${ctx.title}”`;
    const ref = $('#recScriptRef');
    ref.hidden = isNew || !ctx.script;
    ref.textContent = ctx.script || '';
    ref.scrollTop = 0;
    $('#recNewFields').hidden = !isNew;
    $('#recTitle').value = '';
    $('#recScript').value = '';
    $('#recAddToSet').checked = false;
    $('#recSetName').textContent = `“${activeSet().name}”`;
    $('#recOptions').open = false;

    const s = state.settings;
    $('#optVoiceTrigger').checked = !!s.voiceTrigger;
    $('#optAutoStop').checked = !!s.autoStop;
    $('#optSilence').value = s.silenceSec;
    $('#optSensitivity').value = s.sensitivity;
    $('#optTranscribe').checked = !!s.transcribe && VoiceTimer.speechSupported;
    $('#optTranscribe').disabled = !VoiceTimer.speechSupported;
    $('#optTranscribeRow').hidden = !isNew;
    $('#speechSupportHint').hidden = !isNew;
    $('#speechSupportHint').textContent = VoiceTimer.speechSupported
      ? 'Speech-to-text uses your browser’s speech service, which may send audio to Google or Apple. Turn it off to keep audio on your device.'
      : 'Speech-to-text isn’t available in this browser (try Chrome, Edge or Safari). Timing still works.';

    $('#recClock').textContent = '0:00.0';
    $('#recMeter').style.width = '0%';
    $('#recThresh').hidden = true;
    hideRecNote();
    setRecPhase('idle');
    $('#recDialog').showModal();
    $('#recStart').focus();
  }

  function setRecPhase(phase) {
    rec.phase = phase;
    $('#recStart').hidden = phase !== 'idle';
    $('#recStop').hidden = phase !== 'recording';
    $('#recRedo').hidden = phase !== 'done';
    $('#recSave').hidden = phase !== 'done';
    $('#recResult').hidden = phase !== 'done';
    $('#recScript').readOnly = phase === 'recording';
    $('#recOptionsFields').disabled = phase === 'recording';
    $('#recDialog').classList.toggle('is-recording', phase === 'recording');
    if (phase === 'idle') {
      $('#recStatus').textContent = state.settings.voiceTrigger
        ? 'Press Start, then start performing. The clock starts when you start talking.'
        : 'Press Start and begin performing.';
      $('#recDialog').classList.remove('is-waiting', 'is-speaking');
    }
  }

  function showRecNote(msg) { const n = $('#recNote'); n.textContent = msg; n.hidden = false; }
  function hideRecNote() { $('#recNote').hidden = true; }

  const levelPct = (v) => (v > 0 ? Math.max(0, Math.min(100, ((20 * Math.log10(v) + 60) / 60) * 100)) : 0);

  async function recStart() {
    const s = state.settings;
    hideRecNote();
    rec.baseScript = $('#recScript').value.trim();
    rec.userEdited = false;
    setRecPhase('recording');
    $('#recStop').focus();
    $('#recStatus').textContent = 'Asking for the microphone…';
    const timer = new VoiceTimer({
      voiceTrigger: s.voiceTrigger,
      autoStop: s.autoStop,
      silenceSec: Number(s.silenceSec) || 4,
      sensitivity: s.sensitivity,
      transcribe: rec.ctx.mode === 'new' && s.transcribe && VoiceTimer.speechSupported,
      onTick: onRecTick,
      onTranscript(finalText, interim) {
        if (rec.userEdited) return;
        const box = $('#recScript');
        box.value = [rec.baseScript, finalText, interim].filter(Boolean).join(' ');
        box.scrollTop = box.scrollHeight;
      },
      onAutoStop(result) { recFinish(result); },
      onError: showRecNote,
    });
    rec.timer = timer;
    await timer.start();
  }

  function onRecTick(t) {
    $('#recClock').textContent = fmtClock(t.elapsed);
    $('#recMeter').style.width = levelPct(t.level) + '%';
    const th = $('#recThresh');
    th.hidden = t.threshold == null;
    if (t.threshold != null) th.style.left = levelPct(t.threshold) + '%';
    const dlg = $('#recDialog');
    dlg.classList.toggle('is-waiting', t.waiting);
    dlg.classList.toggle('is-speaking', t.speaking);
    let status;
    if (!t.usesVoice) status = 'Stopwatch running. Press Stop when you finish.';
    else if (t.calibrating) status = 'Checking room noise. Stay quiet for a moment…';
    else if (t.waiting) status = 'Listening… the clock starts when you start talking.';
    else if (t.speaking) status = 'Hearing you 🎙';
    else if (state.settings.autoStop && t.silentFor != null && t.silentFor > 1000) {
      status = `Quiet… stopping in ${Math.max(0, Math.ceil(state.settings.silenceSec - t.silentFor / 1000))}s`;
    } else status = 'Recording. Press Stop when you finish.';
    $('#recStatus').textContent = status;
  }

  function recStop() {
    if (!rec.timer) return;
    recFinish(rec.timer.stop('manual'));
  }

  function recFinish(result) {
    if (rec.phase !== 'recording') return;
    setRecPhase('done');
    $('#recDialog').classList.remove('is-waiting', 'is-speaking');
    $('#recMeter').style.width = '0%';
    const sec = Math.round(result.durationMs / 1000);
    $('#recClock').textContent = fmtClock(result.durationMs);
    $('#recDuration').value = fmt(sec);
    $('#recDuration').setCustomValidity('');
    let note = '';
    if (result.usedVoice && !result.heardSpeech) {
      note = 'Didn’t hear any speech. Try again, or turn up mic sensitivity in Timing options.';
    } else if (result.usedVoice && result.rawMs - result.durationMs >= 1000) {
      note = `Trimmed ${fmt((result.rawMs - result.durationMs) / 1000)} of silence at the end. Adjust if needed.`;
    } else {
      note = 'Adjust the length if needed, then save.';
    }
    $('#recResultNote').textContent = note;
    $('#recStatus').textContent = result.reason === 'silence' ? 'Stopped after silence.' : 'Done.';
    $('#recSave').focus();
  }

  function recSave() {
    const sec = parseDuration($('#recDuration').value);
    if (sec == null || Number.isNaN(sec)) {
      const input = $('#recDuration');
      input.setCustomValidity('Use minutes:seconds, like 1:30');
      input.reportValidity();
      return;
    }
    const ctx = rec.ctx;
    if (ctx.mode === 'new') {
      const script = $('#recScript').value.trim();
      const title = $('#recTitle').value.trim() || autoTitle(script);
      const addIt = $('#recAddToSet').checked;
      const now = Date.now();
      const joke = { id: uid(), title, script, duration: sec, createdAt: now, updatedAt: now };
      commit(() => { state.jokes.push(joke); if (addIt) addToSet(joke.id); });
      toast(`Saved “${title}” (${fmt(sec)})`);
    } else {
      ctx.onSave(sec);
    }
    closeRecorder();
  }

  function closeRecorder() {
    if (rec.timer) { rec.timer.cancel(); rec.timer = null; }
    if ($('#recDialog').open) $('#recDialog').close();
  }

  function recRedo() {
    if (rec.timer) { rec.timer.cancel(); rec.timer = null; }
    if (rec.ctx.mode === 'new' && !rec.userEdited) $('#recScript').value = rec.baseScript;
    $('#recClock').textContent = '0:00.0';
    hideRecNote();
    setRecPhase('idle');
  }

  function bindRecorderOptions() {
    const s = () => state.settings;
    $('#optVoiceTrigger').addEventListener('change', (e) => { s().voiceTrigger = e.target.checked; save(); setRecPhase(rec.phase); });
    $('#optAutoStop').addEventListener('change', (e) => { s().autoStop = e.target.checked; save(); });
    $('#optSilence').addEventListener('change', (e) => {
      const v = Math.min(30, Math.max(1, Number(e.target.value) || 4));
      e.target.value = v;
      s().silenceSec = v;
      save();
    });
    $('#optSensitivity').addEventListener('input', (e) => {
      s().sensitivity = Number(e.target.value);
      if (rec.timer) rec.timer.opts.sensitivity = s().sensitivity;
      save();
    });
    $('#optTranscribe').addEventListener('change', (e) => { s().transcribe = e.target.checked; save(); });
  }

  /* ---------- sets ---------- */

  async function onSetAction(action) {
    const set = activeSet();
    if (action === 'new') {
      const res = await ask({ title: 'New set', input: `Set ${state.sets.length + 1}`, buttons: [{ label: 'Cancel' }, { label: 'Create', value: 'ok', kind: 'primary' }] });
      if (!res) return;
      const s = newSet(res.text || `Set ${state.sets.length + 1}`);
      s.targetSeconds = set.targetSeconds;
      commit(() => { state.sets.push(s); state.activeSetId = s.id; });
    } else if (action === 'rename') {
      const res = await ask({ title: 'Rename set', input: set.name, buttons: [{ label: 'Cancel' }, { label: 'Rename', value: 'ok', kind: 'primary' }] });
      if (!res || !res.text) return;
      commit(() => { set.name = res.text; touch(set); });
    } else if (action === 'duplicate') {
      const copy = Object.assign(newSet(`${set.name} (copy)`), { targetSeconds: set.targetSeconds, jokeIds: set.jokeIds.slice() });
      commit(() => { state.sets.push(copy); state.activeSetId = copy.id; });
      toast('Set duplicated');
    } else if (action === 'clear') {
      if (!set.jokeIds.length) return;
      const res = await ask({ title: `Empty “${set.name}”?`, message: 'The jokes stay in your library.', buttons: [{ label: 'Cancel' }, { label: 'Remove all', value: 'ok', kind: 'danger' }] });
      if (!res) return;
      commit(() => { set.jokeIds = []; touch(set); });
    } else if (action === 'delete') {
      const res = await ask({ title: `Delete set “${set.name}”?`, message: 'The jokes stay in your library.', buttons: [{ label: 'Cancel' }, { label: 'Delete set', value: 'ok', kind: 'danger' }] });
      if (!res) return;
      commit(() => {
        state.sets = state.sets.filter((s) => s.id !== set.id);
        if (!state.sets.length) state.sets.push(newSet('My set'));
        state.activeSetId = state.sets[0].id;
      });
    }
  }

  /* ---------- export / backup ---------- */

  function setRows(set) {
    let clock = 0;
    return set.jokeIds.map(getJoke).filter(Boolean).map((joke, i) => {
      const len = jokeLength(joke);
      const row = { n: i + 1, joke, len, startsAt: clock };
      clock += len.sec;
      return row;
    });
  }

  function setTotal(set) { return setRows(set).reduce((t, r) => t + r.len.sec, 0); }

  function lenLabel(len) { return len.missing ? '?' : (len.estimated ? '~' : '') + fmt(len.sec); }

  function setAsText(set, withScripts) {
    const rows = setRows(set);
    const lines = [
      set.name,
      `Target ${fmt(set.targetSeconds)} · Total ${fmt(setTotal(set))} · ${rows.length} joke${rows.length === 1 ? '' : 's'}`,
      '',
    ];
    const width = String(rows.length).length;
    for (const r of rows) {
      lines.push(`${String(r.n).padStart(width)}. [${fmt(r.startsAt)}] ${r.joke.title} (${lenLabel(r.len)})`);
      if (withScripts && r.joke.script.trim()) {
        lines.push('', ...r.joke.script.trim().split('\n').map((l) => '    ' + l), '');
      }
    }
    if (rows.some((r) => r.len.estimated)) lines.push('', '~ = estimated from word count');
    return lines.join('\n') + '\n';
  }

  function printSet(set, withScripts) {
    const rows = setRows(set);
    const area = $('#printArea');
    area.replaceChildren(
      el('h1', {}, set.name),
      el('p', { class: 'print-meta' }, `Target ${fmt(set.targetSeconds)} · Total ${fmt(setTotal(set))} · ${rows.length} jokes`),
      el('ol', { class: withScripts ? 'print-list with-scripts' : 'print-list' }, rows.map((r) => el('li', {},
        el('div', { class: 'print-row' },
          el('span', { class: 'print-title' }, r.joke.title),
          el('span', { class: 'print-time' }, `${lenLabel(r.len)}  @${fmt(r.startsAt)}`)),
        withScripts && r.joke.script.trim() ? el('div', { class: 'print-script' }, r.joke.script.trim()) : null,
      ))),
    );
    window.print();
  }

  async function onExport(kind) {
    const set = activeSet();
    if (kind === 'txt' || kind === 'txt-scripts') {
      download(`${slug(set.name)}${kind === 'txt-scripts' ? '-scripts' : ''}-${today()}.txt`, setAsText(set, kind === 'txt-scripts'));
    } else if (kind === 'copy') {
      try {
        await navigator.clipboard.writeText(setAsText(set, false));
        toast('Set list copied');
      } catch (err) {
        toast('Couldn’t copy. Try the .txt export instead.');
      }
    } else if (kind === 'print' || kind === 'print-scripts') {
      printSet(set, kind === 'print-scripts');
    }
  }

  function backup() {
    const data = {
      app: 'joke-planner',
      version: 1,
      exportedAt: new Date().toISOString(),
      jokes: state.jokes,
      sets: state.sets,
      activeSetId: state.activeSetId,
      settings: state.settings,
    };
    download(`joke-planner-backup-${today()}.json`, JSON.stringify(data, null, 2), 'application/json');
    commit(() => { state.lastBackupAt = Date.now(); });
    toast('Backup downloaded. Keep it somewhere safe.');
  }

  async function restore(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (err) {
      toast('That file isn’t a valid backup.');
      return;
    }
    if (!data || !Array.isArray(data.jokes) || !Array.isArray(data.sets)) {
      toast('That file isn’t a Joke Planner backup.');
      return;
    }
    const incoming = normalize(data);
    const res = await ask({
      title: 'Restore backup',
      message: `The backup has ${incoming.jokes.length} jokes and ${incoming.sets.length} sets. Merge keeps everything you have now and adds or updates from the backup. Replace swaps everything for the backup.`,
      buttons: [
        { label: 'Cancel' },
        { label: 'Replace all', value: 'replace', kind: 'danger' },
        { label: 'Merge', value: 'merge', kind: 'primary' },
      ],
    });
    if (!res) return;
    commit(() => {
      if (res.value === 'replace') {
        state = Object.assign(incoming, { settings: state.settings, lastBackupAt: state.lastBackupAt });
      } else {
        const mergeById = (mine, theirs) => {
          const map = new Map(mine.map((x) => [x.id, x]));
          for (const t of theirs) {
            const m = map.get(t.id);
            if (!m || (t.updatedAt || 0) > (m.updatedAt || 0)) map.set(t.id, t);
          }
          return Array.from(map.values());
        };
        state = normalize(Object.assign({}, state, {
          jokes: mergeById(state.jokes, incoming.jokes),
          sets: mergeById(state.sets, incoming.sets),
        }));
      }
    });
    toast(res.value === 'replace' ? 'Backup restored' : 'Backup merged');
  }

  /* ---------- wiring ---------- */

  function init() {
    document.addEventListener('pointerdown', onPointerDown);
    for (const list of [$('#library'), $('#setList')]) {
      list.addEventListener('click', onListClick);
      list.addEventListener('keydown', onListKey);
    }

    $('#newJokeBtn').addEventListener('click', () => openEditor(null));
    $('#recordJokeBtn').addEventListener('click', () => openRecorder({ mode: 'new' }));
    $('#search').addEventListener('input', renderLibrary);
    $('#sort').addEventListener('change', (e) => { state.settings.sort = e.target.value; save(); renderLibrary(); });

    // editor
    const form = $('#jokeForm');
    form.addEventListener('submit', saveEditor);
    form.script.addEventListener('input', updateEstimateHint);
    form.duration.addEventListener('input', () => { form.duration.setCustomValidity(''); updateEstimateHint(); });
    $('#jokeDialog [data-close]').addEventListener('click', () => $('#jokeDialog').close());
    $('#deleteJokeBtn').addEventListener('click', deleteJoke);
    $('#timeFromEditor').addEventListener('click', () => {
      openRecorder({
        mode: 'time',
        title: form.title.value.trim() || 'this joke',
        script: form.script.value,
        onSave(sec) { form.duration.value = fmt(sec); updateEstimateHint(); },
      });
    });

    // recorder
    $('#recStart').addEventListener('click', recStart);
    $('#recStop').addEventListener('click', recStop);
    $('#recSave').addEventListener('click', recSave);
    $('#recRedo').addEventListener('click', recRedo);
    $('#recCancel').addEventListener('click', closeRecorder);
    $('#recDialog').addEventListener('close', () => { if (rec.timer) { rec.timer.cancel(); rec.timer = null; } });
    $('#recScript').addEventListener('input', () => { rec.userEdited = true; });
    $('#recDuration').addEventListener('input', (e) => e.target.setCustomValidity(''));
    $('#recDuration').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); recSave(); } });
    bindRecorderOptions();

    // sets
    $('#setSelect').addEventListener('change', (e) => commit(() => { state.activeSetId = e.target.value; }));
    $('#newSetBtn').addEventListener('click', () => onSetAction('new'));
    $('#targetMinutes').addEventListener('change', (e) => {
      const min = Number(e.target.value);
      if (!(min > 0)) { renderSet(); return; }
      commit(() => { const s = activeSet(); s.targetSeconds = Math.round(min * 60); touch(s); });
    });
    document.addEventListener('click', (e) => {
      const setBtn = e.target.closest('[data-set-action]');
      const expBtn = e.target.closest('[data-export]');
      if (setBtn || expBtn) {
        const menu = e.target.closest('details.menu');
        if (menu) menu.open = false;
        if (setBtn) onSetAction(setBtn.dataset.setAction);
        if (expBtn) onExport(expBtn.dataset.export);
        return;
      }
      // close open menus when clicking elsewhere
      $$('details.menu[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') $$('details.menu[open]').forEach((d) => { d.open = false; });
    });

    // backup
    $('#backupBtn').addEventListener('click', backup);
    $('#restoreBtn').addEventListener('click', () => $('#restoreInput').click());
    $('#restoreInput').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) restore(file);
    });

    // The small confirm dialog closes when you click outside it.
    const askDlg = $('#askDialog');
    let downOutside = false;
    const outside = (e) => {
      const r = askDlg.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    askDlg.addEventListener('pointerdown', (e) => { downOutside = e.target === askDlg && outside(e); });
    askDlg.addEventListener('click', (e) => { if (downOutside && e.target === askDlg && outside(e)) askDlg.close(); downOutside = false; });

    render();
  }

  // Exposed for tests / debugging in the console.
  window.JokePlanner = { parseDuration, fmt, estimateSeconds, setAsText, getState: () => state };

  init();
})();
