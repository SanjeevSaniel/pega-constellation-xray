/* Constellation Lens: DevTools panel.
 * All page data is rendered with textContent / DOM nodes, never innerHTML, so nothing a page returns can run here.
 * The plain-English text, the data-call reader, the issue finder and the copy-ready reports live in src/report.js. */
(() => {
  'use strict';
  const R = globalThis.XrayReport;
  const { fmtTime, KIND, plural, explain } = R;
  const tabId = chrome.devtools.inspectedWindow.tabId;
  const VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch { return ''; } })();
  const MAX_EVENTS = 5000;
  const LIST_TABS = ['activity', 'data', 'network'];

  // ------------------------------------------------------------------ tiny DOM helper
  const $ = (s, r = document) => r.querySelector(s);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const clear = (el) => { el.textContent = ''; return el; };

  /** The mark as an SVG element (built with createElementNS, never innerHTML). Same geometry as panel.html and src/mark.js, flat colour. */
  function markIcon(size) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 32 32'); svg.setAttribute('width', size); svg.setAttribute('height', size); svg.setAttribute('class', 'mark'); svg.setAttribute('aria-hidden', 'true');
    const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); svg.append(e); };
    mk('rect', { width: 32, height: 32, rx: 7.5, fill: 'var(--accent)' });
    mk('circle', { cx: 14.5, cy: 14.5, r: 8.6, fill: 'none', stroke: '#fff', 'stroke-width': 2.8 });
    mk('path', { d: 'M21 21L26.5 26.5', stroke: '#fff', 'stroke-width': 2.8, 'stroke-linecap': 'round' });
    mk('path', { d: 'M10.3 17L14.2 11.6L19.2 15.4', fill: 'none', stroke: '#fff', 'stroke-opacity': 0.88, 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    mk('circle', { cx: 10.3, cy: 17, r: 1.7, fill: '#fff' });
    mk('circle', { cx: 19.2, cy: 15.4, r: 1.7, fill: '#fff' });
    mk('path', { class: 'star', d: 'M14.2 8.4L14.98 10.82L17.4 11.6L14.98 12.38L14.2 14.8L13.42 12.38L11 11.6L13.42 10.82Z' });
    return svg;
  }

  // ------------------------------------------------------------------ state
  const S = {
    events: [], byKey: new Map(), selected: null, tab: 'activity', sub: 'summary',
    kind: 'all', q: '', hideReads: true, pegaOnly: true, onlyProblems: false,
    mask: false, paused: false, origin: '', enabled: false, bridges: 0,
    statusByFrame: new Map(), frames: new Map(), expects: [], lastInspect: null, enabledAt: 0,
    listScope: '', lastShown: 0, issueLevel: 'all', issueQ: '', openIssues: new Set(),
    bodies: new Map(), bodyChars: 0, reveal: false, pretty: true, wrap: true, showAll: new Set(),
  };

  // ------------------------------------------------------------------ the mark plays one pulse when something is recorded
  const markEl = $('#mark');
  let pingTimer = 0;
  let lastPing = 0;
  function ping(bad) {
    if (!markEl || Date.now() - lastPing < 350) return;
    lastPing = Date.now();
    markEl.classList.remove('ping', 'bad');
    void markEl.getBoundingClientRect(); // restart the animation
    markEl.classList.add('ping');
    if (bad) markEl.classList.add('bad');
    clearTimeout(pingTimer);
    pingTimer = setTimeout(() => markEl.classList.remove('ping', 'bad'), 800);
  }

  // ------------------------------------------------------------------ masking and structure text
  function maskDeep(v) {
    if (Array.isArray(v)) return v.map(maskDeep);
    if (v && typeof v === 'object') {
      if ('$' in v) return v;
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)]));
    }
    if (v === null || v === undefined) return v;
    return `‹${typeof v}›`;
  }
  const view = (v) => (S.mask ? maskDeep(v) : v);

  function ts(s, ind = 0) {
    if (!s) return 'unknown';
    const pad = '  '.repeat(ind);
    const quote = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
    switch (s.t) {
      case 'object': {
        const keys = Object.keys(s.props || {});
        if (!keys.length) return s.n ? `{ /* ${s.n} keys, not shown */ }` : '{}';
        const body = keys.map((k) => `${pad}  ${quote(k)}${s.props[k].opt ? '?' : ''}: ${ts(s.props[k], ind + 1)};`).join('\n');
        return `{\n${body}\n${pad}}${s.n > keys.length ? ` /* +${s.n - keys.length} more */` : ''}`;
      }
      case 'array': {
        if (!s.item) return 'unknown[] /* empty */';
        const inner = ts(s.item, ind);
        return `${s.item.t === 'union' ? `(${inner})` : inner}[] /* ${plural(s.len, 'item')} */`;
      }
      case 'union': return s.of.map((x) => ts(x, ind)).join(' | ');
      default: return s.t;
    }
  }

  // ------------------------------------------------------------------ value tree
  function metaText(v) {
    switch (v.$) {
      case 'fn': return `ƒ ${v.name}()`;
      case 'undefined': return 'undefined';
      case 'node': return `<${String(v.tag).toLowerCase()}>`;
      case 'circular': return '↻ circular';
      case 'more': return `… ${v.n} more`;
      case 'truncated': return '… truncated';
      case 'deep': return `… (${v.type}, too deep)`;
      case 'error': return `Error: ${v.message}`;
      case 'date': return `Date ${v.v}`;
      default: return `[${v.$}${v.v ? ` ${v.v}` : ''}]`;
    }
  }
  const META_KEYS = ['$', 'name', 'tag', 'n', 'type', 'message', 'v'];
  const isMetaVal = (v) => v && typeof v === 'object' && '$' in v && Object.keys(v).every((k) => META_KEYS.includes(k));
  const LONG = 200;
  function leaf(v) {
    if (isMetaVal(v)) return h('span', { class: 'v-meta' }, metaText(v));
    if (v === null) return h('span', { class: 'v-null' }, 'null');
    if (S.mask && typeof v !== 'object') return h('span', { class: 'v-mask' }, `‹${typeof v}›`);
    if (typeof v === 'string') {
      if (v.length > LONG) {
        const short = () => `${JSON.stringify(v.slice(0, LONG))}… (+${v.length - LONG} more)`;
        const span = h('span', { class: 'v-str long', title: 'Click to show or hide the rest' }, short());
        let open = false;
        span.addEventListener('click', () => { open = !open; span.textContent = open ? JSON.stringify(v) : short(); });
        return span;
      }
      return h('span', { class: 'v-str' }, JSON.stringify(v));
    }
    if (typeof v === 'number') return h('span', { class: 'v-num' }, String(v));
    return h('span', { class: 'v-bool' }, String(v));
  }
  function node(key, v, depth, open0 = 2) {
    const label = key === undefined ? [] : [h('span', { class: Array.isArray(v) ? 'k' : 'k', title: typeof key === 'number' ? `item ${key}` : undefined }, `${key}`), ': '];
    if (v && typeof v === 'object' && !isMetaVal(v)) {
      const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
      const peek = Array.isArray(v) ? '' : entries.slice(0, 4).map(([k]) => k).join(', ') + (entries.length > 4 ? ', …' : '');
      const d = h('details', { open: depth < open0 }, h('summary', {}, ...label, h('span', { class: 'muted' }, Array.isArray(v) ? `[${entries.length}]` : `{${entries.length}}`), peek ? h('span', { class: 'pv' }, ` ${peek}`) : null),
        h('ul', {}, ...entries.map(([k, x]) => node(k, x, depth + 1, open0))));
      return h('li', {}, d);
    }
    return h('li', {}, ...label, leaf(v));
  }
  const tree = (v, open0 = 2) => {
    if (v === undefined) return h('span', { class: 'muted' }, 'Nothing recorded.');
    const root = h('ul', { class: 'tree' }, node(undefined, view(v), 0, open0));
    const big = v && typeof v === 'object' && !isMetaVal(v) && Object.keys(v).length > 1;
    return big ? h('div', { class: 'treebox' }, h('div', { class: 'tree-tools' }, ...expandTools(() => root)), root) : root;
  };

  // ------------------------------------------------------------------ copy
  /** Copies text. The clipboard API can be refused inside DevTools, so it falls back to a hidden textarea. */
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    try {
      const ta = h('textarea', { style: 'position:fixed;left:-9999px;top:0;opacity:0', 'aria-hidden': 'true' });
      ta.value = text; document.body.append(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
  function copyBtn(label, getText, cls) {
    const b = h('button', { type: 'button', class: cls || '' }, label);
    b.addEventListener('click', async () => {
      let text;
      try { text = getText(); } catch { text = undefined; }
      const ok = text !== undefined && (await copyText(text));
      b.textContent = ok ? 'Copied ✓' : 'Copy failed';
      b.classList.toggle('bad', !ok);
      setTimeout(() => { b.textContent = label; b.classList.remove('bad'); }, 1500);
    });
    return b;
  }
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ------------------------------------------------------------------ ingest
  function ingest(msg) {
    const fid = msg.frameId ?? 0;
    if (msg.type === 'events') {
      let real = false; let bad = false;
      for (const it of msg.items) {
        if (it.upd) {
          const ev = S.byKey.get(`${fid}:${it.id}`);
          if (ev) Object.assign(ev, it.patch);
          if (it.patch?.status === 'error' || it.patch?.http >= 400) bad = true;
          continue;
        }
        real = true;
        if (it.status === 'error' || (it.kind === 'issue' && it.level !== 'warn')) bad = true;
        const key = `${fid}:${it.id}`;
        const have = S.byKey.get(key);
        if (have) { Object.assign(have, it); continue; }
        it.key = key; it.frameId = fid; it.frameUrl = msg.frame;
        S.events.push(it); S.byKey.set(key, it);
      }
      if (S.events.length > MAX_EVENTS) for (const old of S.events.splice(0, S.events.length - MAX_EVENTS)) S.byKey.delete(old.key);
      if (real || bad) ping(bad);
    } else if (msg.type === 'status') {
      S.statusByFrame.set(fid, msg.status); S.frames.set(fid, msg.frame);
    } else if (msg.type === 'bridge-up') {
      S.bridges++; S.frames.set(fid, msg.url); send({ cmd: 'replay' });
    } else if (msg.type === 'bridges') {
      S.bridges = msg.count; if (msg.count) send({ cmd: 'replay' });
    } else if (msg.type === 'note') {
      banner(msg.text, true);
    } else if (msg.type === 'picked') {
      onPicked(msg);
    } else if (msg.type === 'body') {
      addBodyPart(msg);
    } else if (msg.type === 'body-dropped') {
      const i = String(msg.key).indexOf(':');
      const k = `${fid}:${String(msg.key).slice(0, i)}:${String(msg.key).slice(i + 1)}`;
      const b = S.bodies.get(k);
      if (b) { S.bodyChars -= b.text.length; S.bodies.delete(k); }
    }
    scheduleRender();
  }

  // ------------------------------------------------------------------ port to the background worker
  let port = null;
  function connect() {
    port = chrome.runtime.connect({ name: `panel:${tabId}` });
    port.onMessage.addListener(ingest);
    port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 500); });
    send({ cmd: 'replay' });
  }
  const send = (m) => { try { port?.postMessage(m); } catch { /* reconnecting */ } };

  // ------------------------------------------------------------------ filtering
  const isProblem = (ev) => ev.status === 'error' || (ev.http != null && ev.http >= 400) || (ev.status === 'pending' && Date.now() - ev.t > 5000);
  const scopeOf = (tab) => (tab === 'network' ? 'network' : tab === 'data' ? 'data' : 'activity');
  const parentOf = (ev) => (ev.parent ? S.byKey.get(`${ev.frameId}:${ev.parent}`) : null);

  function visible(ev, scope) {
    if (ev.kind === 'nav') return true;
    if (ev.kind === 'issue') return false; // issues live in the Issues tab
    if (scope === 'network') { if (ev.kind !== 'net') return false; if (S.pegaOnly && !ev.net?.pega) return false; }
    else if (scope === 'data') { if (!R.isDataCall(ev, parentOf(ev))) return false; }
    else {
      if (S.kind !== 'all' && ev.kind !== S.kind) return false;
      if (S.hideReads && ev.access === 'read') return false;
      if (S.pegaOnly && ev.kind === 'net' && !ev.net?.pega) return false;
    }
    if (S.onlyProblems && !isProblem(ev)) return false;
    if (S.q) {
      const hay = `${ev.name} ${ev.comp || ''} ${ev.ctx || ''} ${ev.net?.url || ''} ${scope === 'data' ? R.dataInfo(ev).name : ''}`.toLowerCase();
      if (!hay.includes(S.q.toLowerCase())) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ rendering: header
  function mergedStatus() {
    const all = [...S.statusByFrame.values()];
    return all.find((s) => s.pcore) || all[0] || {};
  }
  function renderChips() {
    const st = mergedStatus();
    const chip = (text, cls, title) => h('span', { class: `chip ${cls}`, title }, text);
    const box = clear($('#chips'));
    box.append(
      chip(S.enabled ? 'Lens on' : 'Lens off', S.enabled ? 'ok' : 'bad', S.enabled ? 'Recording this site' : 'Turn Lens on for this site to start recording'),
      chip(st.pcore ? `PCore found${st.version ? ` · ${st.version}` : ''}` : 'PCore not found yet', st.pcore ? 'ok' : 'wait', 'Pega Constellation core runtime'),
      chip(st.store ? 'Store watched' : 'Store waiting', st.store ? 'ok' : 'wait', 'State changes and dispatched actions'),
      chip(st.react ? `Components found${st.reactMode ? ` · ${st.reactMode}` : ''}` : 'No components yet', st.react ? 'ok' : 'wait', 'PConnect handles discovered in the page'),
    );
    $('#btn-enable').hidden = S.enabled || !/^https?:/.test(S.origin);
    $('#btn-reload').hidden = !S.enabled;
    if (!/^https?:/.test(S.origin) && S.origin) banner('Lens works on http and https pages. Open your Pega app and reopen DevTools.', true);
  }
  function banner(text, warn) {
    const b = $('#banner');
    if (!text) { b.hidden = true; return; }
    b.hidden = false; b.className = `banner${warn ? ' warn' : ''}`; b.textContent = text;
  }

  // ------------------------------------------------------------------ rendering: list
  function rowLabel(ev, scope) {
    if (scope === 'data') {
      const info = R.dataInfo(ev);
      const api = ev.kind === 'net' ? 'HTTP' : ev.name.replace(/^PCore\./, '').replace(/^pConn\./, '');
      return { nm: info.name ? `${info.name}   · ${api}` : api, title: ev.name };
    }
    const nm = ev.kind === 'pconn' ? `${ev.name.replace(/^pConn\./, '')}${ev.comp ? `  ← ${ev.comp}` : ''}` : ev.name;
    return { nm, title: nm };
  }
  function rowStatus(ev, scope) {
    if (ev.status === 'pending') return '…';
    if (ev.kind === 'net') return ev.http != null ? `${ev.http} · ${ev.ms} ms` : '✕';
    if (ev.status === 'error') return '✕ error';
    if (scope === 'data') { const n = R.rowCount(ev); return `${n !== undefined ? `${plural(n, 'row')} · ` : ''}${ev.ms != null ? `${ev.ms} ms` : ''}`; }
    return ev.ms != null ? `${ev.ms} ms` : '';
  }

  function renderList(scope) {
    const rowsEl = $('#rows');
    // Measure BEFORE clearing: afterwards the list is empty and every question about "was it at the bottom" answers yes,
    // which is what made the list jump to the bottom whenever anything was clicked.
    const prevTop = rowsEl.scrollTop;
    const wasBottom = rowsEl.scrollHeight - prevTop - rowsEl.clientHeight < 40;
    const scopeChanged = S.listScope !== scope;
    clear(rowsEl);
    const all = S.events.filter((e) => visible(e, scope));
    const shown = all.slice(-500);
    for (const ev of shown) {
      const cls = ev.kind === 'nav' ? 'nav' : ev.status === 'error' || (ev.http >= 400) ? 'err' : ev.status === 'pending' ? 'pending' : '';
      const { nm, title } = rowLabel(ev, scope);
      rowsEl.append(h('div', {
        class: `row ${cls}`, role: 'option', tabindex: '0', 'data-key': ev.key, 'aria-selected': String(S.selected === ev.key), onclick: () => select(ev.key),
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(ev.key); }
          else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const to = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
            if (to) { to.focus(); select(to.dataset.key); }
          }
        },
      }, h('span', { class: 't' }, fmtTime(ev.t)), h('span', { class: `badge k-${ev.kind}` }, KIND[ev.kind] || ev.kind), h('span', { class: 'nm', title }, nm), h('span', { class: 'st' }, rowStatus(ev, scope))));
    }
    // Stay where the reader is. Only follow the newest rows if they were already at the bottom (or just opened this tab).
    const stick = scopeChanged || wasBottom;
    rowsEl.scrollTop = stick ? rowsEl.scrollHeight : prevTop;
    const added = Math.max(0, shown.length - S.lastShown);
    const jump = $('#jump-latest');
    if (stick) { S.lastShown = shown.length; jump.hidden = true; }
    else if (added > 0) { jump.hidden = false; $('#jump-n').textContent = added; }
    S.listScope = scope;
    const empty = $('#rows-empty');
    empty.hidden = shown.length > 0;
    if (!shown.length) renderEmpty(empty, scope, all.length);
  }
  function renderCounts() {
    let act = 0; let dat = 0; let net = 0;
    for (const e of S.events) {
      if (e.kind === 'net') { net++; if (R.isDataCall(e, parentOf(e))) dat++; }
      else if (e.kind === 'pcore' || e.kind === 'pconn') { if (R.isDataCall(e)) dat++; if (e.kind !== 'nav') act++; }
      else if (e.kind !== 'nav' && e.kind !== 'issue') act++;
    }
    $('#n-activity').textContent = act;
    $('#n-data').textContent = dat;
    $('#n-network').textContent = net;
  }
  function renderEmpty(el, scope) {
    clear(el);
    const logo = markIcon(44);
    if (!S.enabled) el.append(logo, h('strong', {}, 'Lens is off for this site'), 'Click “Turn on for this site”, then reload the page to capture everything from the first call.');
    else if (!S.events.length) el.append(logo, h('strong', {}, 'Nothing recorded yet'), 'Use the app: open a case, change a field, load a list. Each PCore call, PConnect call and API request shows up here as it happens.');
    else if (scope === 'data' && !S.q && !S.onlyProblems) el.append(logo, h('strong', {}, 'No data page calls yet'), 'Open a screen that loads a list, a table or a dropdown. Every call that loads data appears here with its input, its rows and the HTTP request it made.');
    else el.append(logo, h('strong', {}, 'Nothing matches your filters'), scope === 'network' ? 'Try turning off “Pega calls only”.' : 'Try turning off “Hide quick reads” or clearing the search box.');
  }

  /** Selecting only marks the row and fills the detail. It never rebuilds or scrolls the list. */
  function select(key) {
    S.selected = key;
    document.querySelectorAll('#rows .row').forEach((r) => r.setAttribute('aria-selected', String(r.dataset.key === key)));
    detailSig = '';
    renderDetail();
  }
  /** Jump from another tab (an issue, "Was it called?") to a call, clearing any filter that would hide it. */
  function jumpTo(ev) {
    const tab = ev.kind === 'net' ? 'network' : 'activity';
    S.q = ''; $('#q').value = ''; S.kind = 'all'; S.onlyProblems = false; $('#only-problems').checked = false;
    S.hideReads = false; $('#hide-reads').checked = false; S.pegaOnly = false; $('#pega-only').checked = false;
    document.querySelectorAll('#kinds button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.kind === 'all')));
    switchTab(tab);
    select(ev.key);
    $('#rows .row[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------------ detail
  const cellText = (v) => {
    if (v === null || v === undefined) return '';
    if (isMetaVal(v)) return '…';
    if (typeof v === 'object') return Array.isArray(v) ? `[${v.length}]` : '{…}';
    if (S.mask) return `‹${typeof v}›`;
    return String(v).slice(0, 80);
  };
  function rowsTable(rows, cols) {
    const names = cols.map((c) => c.name).slice(0, 12);
    const shown = rows.slice(0, 20);
    const head = h('tr', {}, ...names.map((n) => h('th', {}, n)));
    const body = shown.map((r) => h('tr', {}, ...names.map((n) => h('td', {}, cellText(r && typeof r === 'object' ? r[n] : undefined)))));
    return h('div', {}, h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', {}, head), h('tbody', {}, ...body))),
      h('p', { class: 'note' }, `Showing ${shown.length} of ${rows.length} recorded row${rows.length === 1 ? '' : 's'}${names.length < cols.length ? ` and ${names.length} of ${cols.length} columns` : ''}.`));
  }
  function dataInput(body, ev) {
    const info = R.dataInfo(ev);
    body.append(h('div', { class: 'tools' }, copyBtn('Copy input as JSON', () => JSON.stringify(view(ev.kind === 'net' ? ev.net.reqBody : ev.args), null, 2))));
    body.append(h('dl', { class: 'facts' }, h('dt', {}, 'Data page / view'), h('dd', {}, info.name || 'not found in the arguments'), h('dt', {}, 'Context'), h('dd', {}, info.context || '—')));
    body.append(h('h4', {}, 'Parameters'), info.parameters === undefined ? h('p', { class: 'muted' }, 'No parameters found in the arguments.') : tree(info.parameters));
    if (info.other.length) body.append(h('h4', {}, 'Other arguments'), ...info.other.map((o) => h('div', {}, h('span', { class: 'muted' }, `Argument ${o.position}: `), tree(o.value, 1))));
    body.append(h('h4', {}, ev.kind === 'net' ? 'Request body (raw)' : 'All arguments (raw)'), tree(ev.kind === 'net' ? ev.net.reqBody : ev.args));
    if (info.guessed) body.append(h('p', { class: 'note' }, 'The names above are read from the argument values. Lens does not know Pega’s exact signatures, so check the raw arguments if something looks off.'));
  }
  function dataOutput(body, ev) {
    const n = R.rowCount(ev);
    const rows = R.rowsOf(ev.result);
    const cols = R.columnsOf(ev);
    if (n !== undefined) body.append(h('p', { class: 'say' }, n === 0 ? 'No rows came back.' : `${plural(n, 'row')} came back${rows && rows.length < n ? ` (Lens keeps the first ${rows.length})` : ''}.`));
    if (cols.length) {
      body.append(h('h4', {}, `Columns (${cols.length})`),
        h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, h('th', {}, 'Column'), h('th', {}, 'Type'), h('th', {}, 'In every row?'))),
          h('tbody', {}, ...cols.map((c) => h('tr', {}, h('td', {}, c.name), h('td', {}, c.type), h('td', { class: c.optional ? 'opt' : '' }, c.optional ? 'no, missing in some rows' : 'yes')))))));
    }
    if (rows && rows.length && cols.length) body.append(h('h4', {}, 'Rows'), rowsTable(rows, cols));
  }
  function networkSub(body, ev) {
    const nets = R.networkOf(ev, S.events);
    if (!nets.length) {
      body.append(h('p', { class: 'muted' }, ev.status === 'pending' ? 'No request seen yet.' : 'This call did not start any HTTP request that Lens recorded. Possible reasons: the data came from a cache, the request started before Lens attached, or it is made somewhere else.'));
      return;
    }
    body.append(h('p', { class: 'say' }, `It made ${plural(nets.length, 'HTTP request')}. Open one for its request and response, so you do not need the browser’s Network tab.`));
    nets.forEach((n, i) => {
      let path = n.net.url;
      try { path = new URL(n.net.url, 'http://x').pathname + new URL(n.net.url, 'http://x').search; } catch { /* keep the raw url */ }
      body.append(h('details', { class: 'issue ' + (n.status === 'error' ? 'bad' : 'info'), open: nets.length <= 2 || i === 0 },
        h('summary', {}, h('span', { class: 'badge k-net' }, n.net.method), h('span', { class: 'txt mono' }, path), h('span', { class: 'when' }, n.http != null ? `${n.http} · ${n.ms} ms` : n.status === 'pending' ? 'pending' : 'no response')),
        h('div', { class: 'inner' },
          h('dl', { class: 'facts' }, h('dt', {}, 'URL'), h('dd', {}, n.net.url), h('dt', {}, 'Category'), h('dd', {}, R.labelCategory(n.net.category)), h('dt', {}, 'Size'), h('dd', {}, n.bytes ? `${(n.bytes / 1024).toFixed(1)} KB` : '—')),
          h('div', { class: 'tools' }, copyBtn('Copy response', () => (bodyOf(n, 'res')?.done && !S.mask ? bodyOf(n, 'res').text : JSON.stringify(view(n.result), null, 2))), h('button', { type: 'button', onclick: () => jumpTo(n) }, 'Open in Network')),
          n.net.reqBody !== undefined ? [h('h4', {}, 'Request body'), tree(n.net.reqBody, 1)] : null,
          h('h4', {}, 'Response'), tree(n.result, 1)),
      ));
    });
  }

  // ------------------------------------------------------------------ full bodies, headers and timing (the Network-tab details)
  const BODY_BUDGET = 150000000; // characters of raw bodies kept in the panel, oldest dropped first
  const bodyOf = (ev, side) => S.bodies.get(`${ev.frameId}:${ev.id}:${side}`);
  const fmtBytes = (n) => (n == null || Number.isNaN(n) ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
  const jsonPretty = (text) => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return null; } };

  function addBodyPart(msg) {
    const key = `${msg.frameId ?? 0}:${msg.id}:${msg.side}`;
    let b = S.bodies.get(key);
    if (!b || b.of !== msg.of) {
      if (b) S.bodyChars -= b.text.length;
      b = { parts: new Array(msg.of), got: 0, of: msg.of, truncated: !!msg.truncated, total: msg.total, text: '', done: false };
      S.bodies.delete(key); S.bodies.set(key, b);
    }
    if (b.parts && b.parts[msg.part] === undefined) { b.parts[msg.part] = msg.data; b.got++; }
    if (b.got === b.of && !b.done) {
      b.text = b.parts.join(''); b.parts = null; b.done = true; S.bodyChars += b.text.length;
      while (S.bodyChars > BODY_BUDGET && S.bodies.size) { const [k, v] = S.bodies.entries().next().value; S.bodies.delete(k); S.bodyChars -= v.text.length; }
    }
  }

  /** A raw body, in full: copy, download, pretty or raw, wrapped or not. Long text is shown in a first slice, with a button for the rest. */
  function rawViewer(key, text, truncated, fileName) {
    const looksJson = /^\s*[[{]/.test(text);
    const pretty = S.pretty && looksJson && text.length <= 8000000 ? jsonPretty(text) : null;
    const shown = pretty ?? text;
    const LIMIT = 300000;
    const all = S.showAll.has(key);
    const slice = all || shown.length <= LIMIT ? shown : shown.slice(0, LIMIT);
    const toggle = (label, on, fn) => h('button', { type: 'button', 'aria-pressed': String(on), class: on ? 'on' : '', onclick: () => { fn(); detailSig = ''; renderDetail(); } }, label);
    const box = h('div', {});
    box.append(h('div', { class: 'tools' },
      copyBtn(`Copy full text (${fmtBytes(text.length)})`, () => text),
      h('button', { type: 'button', onclick: () => download(fileName, text, 'text/plain') }, 'Download'),
      looksJson ? toggle('Pretty', !!pretty, () => { S.pretty = !S.pretty; }) : null,
      toggle('Wrap', S.wrap, () => { S.wrap = !S.wrap; })));
    box.append(h('pre', { class: `code raw${S.wrap ? '' : ' nowrap'}` }, slice));
    if (slice.length < shown.length) box.append(h('p', { class: 'note' }, `Showing the first ${fmtBytes(slice.length)} of ${fmtBytes(shown.length)}. `), h('button', { type: 'button', onclick: () => { S.showAll.add(key); detailSig = ''; renderDetail(); } }, 'Show all'));
    if (truncated) box.append(h('p', { class: 'note' }, 'The recorded text was cut at 30 million characters.'));
    return box;
  }

  function kvTable(obj, redactedNote) {
    const rows = Object.entries(obj || {}).sort(([a], [b]) => a.localeCompare(b));
    if (!rows.length) return h('p', { class: 'muted' }, 'None recorded.');
    return h('div', { class: 'table-wrap' }, h('table', { class: 'data kv' }, h('tbody', {}, ...rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', { class: v === '[redacted]' ? 'redacted' : '', title: v === '[redacted]' ? redactedNote : undefined }, String(v)))))));
  }
  const revealBtn = () => h('button', { type: 'button', 'aria-pressed': String(S.reveal), class: S.reveal ? 'on' : '', title: 'Show cookies, tokens and other sensitive header and query values. They stay out of exports and copied reports.', onclick: () => { S.reveal = !S.reveal; detailSig = ''; renderDetail(); } }, S.reveal ? 'Sensitive values shown' : 'Show sensitive values');

  function netHeaders(body, ev) {
    const n = ev.net;
    const reqH = S.reveal ? (n.reqHeadersFull || n.reqHeaders) : n.reqHeaders;
    const resH = S.reveal ? (ev.resHeadersFull || ev.resHeaders) : ev.resHeaders;
    const url = S.reveal ? (n.urlFull || n.url) : n.url;
    body.append(h('div', { class: 'tools' }, revealBtn(), copyBtn('Copy URL', () => url)));
    const general = [['Request URL', url], ['Request method', n.method], ['Status', ev.status === 'pending' ? 'pending' : ev.http != null ? `${ev.http} ${ev.statusText || ''}`.trim() : 'no response'], ['Content type', ev.contentType || '—'], ['Sent with', n.via], ['Transferred', ev.timing ? fmtBytes(ev.timing.transferSize) : '—'], ['Protocol', ev.timing?.protocol || '—']];
    if (ev.redirected) general.push(['Redirected', 'yes']);
    if (ev.finalUrl && ev.finalUrl !== (n.urlFull || n.url)) general.push(['Final URL', S.reveal ? ev.finalUrl : redactForShow(ev.finalUrl)]);
    body.append(h('h4', {}, 'General'), h('div', { class: 'table-wrap' }, h('table', { class: 'data kv' }, h('tbody', {}, ...general.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, String(v))))))));
    body.append(h('h4', {}, `Response headers (${Object.keys(resH || {}).length})`), kvTable(resH, 'Hidden. Use “Show sensitive values”.'));
    body.append(h('h4', {}, `Request headers (${Object.keys(reqH || {}).length})`), kvTable(reqH, 'Hidden. Use “Show sensitive values”.'));
    if (!S.reveal) body.append(h('p', { class: 'note' }, 'Authorization, cookie, token and similar values are hidden by default.'));
  }
  const SECRET_PARAM = /authorization|cookie|token|csrf|api[-_]?key|secret|pzauth|password|session/i;
  function redactForShow(u) { try { const x = new URL(u); for (const k of Array.from(x.searchParams.keys())) if (SECRET_PARAM.test(k)) x.searchParams.set(k, '[redacted]'); return x.toString(); } catch { return u; } }

  function netPayload(body, ev) {
    const n = ev.net;
    let params = [];
    try { params = [...new URL(S.reveal ? (n.urlFull || n.url) : n.url).searchParams.entries()]; } catch { /* no query */ }
    body.append(h('div', { class: 'tools' }, revealBtn()));
    body.append(h('h4', {}, `Query string parameters (${params.length})`), params.length ? kvTable(Object.fromEntries(params), 'Hidden. Use “Show sensitive values”.') : h('p', { class: 'muted' }, 'None.'));
    const raw = bodyOf(ev, 'req');
    body.append(h('h4', {}, 'Request payload'));
    if (raw && raw.done) {
      if (S.mask) body.append(h('p', { class: 'muted' }, 'The raw text is hidden while Hide values is on. The structure is below.'), tree(n.reqBody));
      else body.append(rawViewer(`${ev.key}:req`, raw.text, raw.truncated, `request-${ev.id}.txt`), h('h4', {}, 'Parsed'), tree(n.reqBody, 2));
    } else if (n.reqBody !== undefined) body.append(tree(n.reqBody, 2));
    else body.append(h('p', { class: 'muted' }, 'This request has no body.'));
  }

  function netPreview(body, ev) {
    if (ev.status === 'pending') { body.append(h('div', { class: 'hint warn' }, 'Still waiting for the response.')); return; }
    if (ev.error) body.append(h('div', { class: 'hint bad' }, 'It failed:'), tree(ev.error));
    if (typeof ev.result === 'string' && ev.result.startsWith('[')) body.append(h('p', { class: 'muted' }, ev.result));
    else body.append(tree(ev.result, 2), h('p', { class: 'note' }, 'Long lists and long text are shortened here. The Response tab has everything.'));
  }

  function netResponse(body, ev) {
    if (ev.status === 'pending') { body.append(h('div', { class: 'hint warn' }, 'Still waiting for the response.')); return; }
    if (ev.error) body.append(h('div', { class: 'hint bad' }, 'It failed:'), tree(ev.error));
    const raw = bodyOf(ev, 'res');
    if (S.mask) { body.append(h('p', { class: 'muted' }, 'The raw text is hidden while Hide values is on. The structure is shown instead.'), tree(ev.result)); return; }
    if (raw && raw.done) body.append(rawViewer(`${ev.key}:res`, raw.text, raw.truncated, `response-${ev.id}.txt`));
    else if (raw) body.append(h('p', { class: 'muted' }, `Receiving the text… ${raw.got} of ${raw.of} parts.`));
    else if (typeof ev.result === 'string' && ev.result.startsWith('[')) body.append(h('p', { class: 'muted' }, ev.result));
    else body.append(h('p', { class: 'muted' }, 'The response text is not available: it was recorded before the panel opened, was dropped to save memory, or is not text. Reload with Lens open to capture it.'), tree(ev.result, 2));
  }

  function netInitiator(body, ev) {
    const parent = parentOf(ev);
    if (parent) body.append(h('p', { class: 'say' }, 'Started by: ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); select(parent.key); } }, parent.name)));
    else body.append(h('p', { class: 'muted' }, 'No recorded PCore or PConnect call started this request.'));
    body.append(h('h4', {}, 'Call stack'), ev.stack?.length ? h('pre', { class: 'code' }, ev.stack.join('\n')) : h('p', { class: 'muted' }, 'No stack was captured.'));
  }

  function netTiming(body, ev) {
    const t = ev.timing;
    const facts = [['Started', fmtTime(ev.t)], ['Duration seen by the page', ev.ms != null ? `${ev.ms} ms` : 'not finished']];
    if (t) facts.push(['Total (browser)', `${t.totalMs} ms`], ['Protocol', t.protocol || '—'], ['Transferred', fmtBytes(t.transferSize)], ['Body size (compressed)', fmtBytes(t.encodedBodySize)], ['Body size (decoded)', fmtBytes(t.decodedBodySize)]);
    body.append(h('dl', { class: 'facts' }, ...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))])));
    if (!t) { body.append(h('p', { class: 'muted' }, 'The browser’s timing breakdown arrives a moment after the response finishes, and is not available for every request.')); return; }
    if (!t.phases) { body.append(h('p', { class: 'muted' }, 'The browser did not share the phase breakdown (for example a cross-origin request without a Timing-Allow-Origin header).')); return; }
    const total = Math.max(t.totalMs, 0.1);
    const rows = [['Stalled', t.phases.stalled], ['DNS lookup', t.phases.dns], ['Initial connection', t.phases.connect], ['SSL', t.phases.tls], ['Waiting for the server', t.phases.waiting], ['Content download', t.phases.download]];
    body.append(h('h4', {}, 'Where the time went'), h('div', { class: 'phases' }, ...rows.map(([label, ms]) => {
      const fill = h('span', {}); fill.style.width = `${Math.min(100, (ms / total) * 100)}%`;
      return h('div', { class: 'phase' }, h('span', { class: 'pl' }, label), h('span', { class: 'bar' }, fill), h('span', { class: 'pv' }, `${ms} ms`));
    })));
  }

  const NET_TABS = ['headers', 'payload', 'preview', 'response', 'initiator', 'timing'];
  function netTab(body, ev) {
    if (S.sub === 'headers') netHeaders(body, ev);
    else if (S.sub === 'payload') netPayload(body, ev);
    else if (S.sub === 'preview') netPreview(body, ev);
    else if (S.sub === 'response') netResponse(body, ev);
    else if (S.sub === 'initiator') netInitiator(body, ev);
    else if (S.sub === 'timing') netTiming(body, ev);
  }

  // ------------------------------------------------------------------ the structure, as a readable schema
  const typeChip = (s) => {
    if (!s) return h('span', { class: 'ty ty-unknown' }, 'unknown');
    if (s.t === 'union') return h('span', {}, ...s.of.flatMap((x, i) => [i ? h('span', { class: 'muted' }, ' | ') : null, typeChip(x)]));
    return h('span', { class: `ty ty-${s.t}` }, s.t);
  };
  const isContainer = (s) => !!s && (s.t === 'object' || s.t === 'array');
  function schemaNode(key, s, optional, depth) {
    const keys = s && s.t === 'object' ? Object.keys(s.props || {}) : [];
    const meta = s?.t === 'array' ? ` · ${plural(s.len ?? 0, 'item')}` : s?.t === 'object' ? ` · ${plural(s.n ?? keys.length, 'key')}` : '';
    const head = [key !== undefined ? h('span', { class: 'sk' }, String(key)) : null, optional ? h('span', { class: 'sopt', title: 'missing in some items' }, '?') : null, key !== undefined ? ': ' : null, typeChip(s), meta ? h('span', { class: 'muted' }, meta) : null];
    let kids = [];
    if (s?.t === 'object') kids = keys.map((k) => schemaNode(k, s.props[k], !!s.props[k].opt, depth + 1));
    else if (s?.t === 'array' && s.item) kids = [schemaNode('each item', s.item, false, depth + 1)];
    else if (s?.t === 'union') kids = s.of.filter(isContainer).map((x, i) => schemaNode(`variant ${i + 1}`, x, false, depth + 1));
    if (!kids.length) return h('li', { class: 'srow' }, ...head);
    return h('li', {}, h('details', { open: depth < 2 }, h('summary', {}, ...head), h('ul', {}, ...kids)));
  }
  function expandTools(getRoot) {
    const set = (open) => { getRoot().querySelectorAll('details').forEach((d) => { d.open = open; }); };
    return [h('button', { type: 'button', onclick: () => set(true) }, 'Expand all'), h('button', { type: 'button', onclick: () => set(false) }, 'Collapse all')];
  }
  function schemaBlock(title, sh) {
    const root = h('ul', { class: 'tree schema' }, schemaNode(undefined, sh, false, 0));
    const wrap = h('div', {}, h('h4', {}, title), h('div', { class: 'tools' }, ...expandTools(() => root), copyBtn('Copy as TypeScript', () => `type Shape = ${ts(sh)};`)), root,
      h('details', { class: 'tsdoc' }, h('summary', {}, 'Show as TypeScript'), h('pre', { class: 'code' }, ts(sh))));
    return wrap;
  }

  let detailSig = '';
  function renderDetail() {
    const d = $('#detail');
    const ev = S.byKey.get(S.selected);
    const kids = ev ? S.events.filter((e) => e.frameId === ev.frameId && e.parent === ev.id).length : 0;
    // Rebuild only when something the detail shows has changed, so open branches and the scroll position survive new events.
    const bodySig = ev && ev.kind === 'net' ? `${S.reveal}|${S.pretty}|${S.wrap}|${S.showAll.size}|${bodyOf(ev, 'res')?.done ? 1 : bodyOf(ev, 'res') ? 'p' : 0}|${bodyOf(ev, 'req')?.done ? 1 : 0}|${ev.timing ? 1 : 0}` : '';
    const sig = ev ? `${ev.key}|${S.sub}|${S.mask}|${ev.status}|${ev.http}|${ev.ms}|${ev.result !== undefined}|${ev.error ? 1 : 0}|${kids}|${bodySig}` : 'none';
    if (sig === detailSig) return;
    const sameView = ev && detailSig.startsWith(`${ev.key}|${S.sub}|`);
    const prevScroll = d.scrollTop;
    detailSig = sig;
    clear(d);
    if (!ev) { d.append(h('div', { class: 'empty' }, markIcon(40), h('strong', {}, 'Pick a row'), 'Select any call on the left to see exactly what went in, what came out, and its structure.')); return; }
    const ex = explain(ev);
    const isData = R.isDataCall(ev, parentOf(ev));
    d.append(h('div', { class: 'detail-head' }, h('h3', {}, ev.name), h('div', { class: 'muted' }, `${KIND[ev.kind] || ev.kind} · ${fmtTime(ev.t)}${ev.ms != null ? ` · ${ev.ms} ms` : ''}${ev.status === 'pending' ? ' · pending' : ''}`)));
    let tabs;
    if (ev.kind === 'net') {
      const resBody = bodyOf(ev, 'res');
      tabs = [['summary', 'Summary'], ['headers', 'Headers'], ['payload', 'Payload'], ['preview', 'Preview'], ['response', `Response${resBody?.done ? ` (${fmtBytes(resBody.text.length)})` : ''}`], ['structure', 'Structure'], ['initiator', 'Initiator'], ['timing', 'Timing'], ['raw', 'Raw']];
    } else {
      tabs = [['summary', 'Summary'], ['input', 'Input'], ['output', 'Output'], ['structure', 'Structure']];
      if (ev.kind === 'pcore' || ev.kind === 'pconn') tabs.push(['network', `HTTP${kids ? ` (${R.networkOf(ev, S.events).length})` : ''}`]);
      tabs.push(['caller', 'Who called it'], ['raw', 'Raw']);
    }
    if (!tabs.some(([id]) => id === S.sub)) S.sub = 'summary';
    d.append(h('div', { class: 'sub', role: 'tablist' }, ...tabs.map(([id, label]) => h('button', { role: 'tab', 'aria-selected': String(S.sub === id), onclick: () => { S.sub = id; detailSig = ''; renderDetail(); d.scrollTop = 0; } }, label))));
    const body = h('div', { class: 'body' });
    d.append(body);
    if (ev.kind === 'net' && NET_TABS.includes(S.sub)) netTab(body, ev);
    else if (S.sub === 'summary') {
      ex.lines.forEach((l, i) => body.append(h('p', { class: `say${ex.bad && i === 0 ? ' bad' : ''}` }, l)));
      const facts = [['Type', KIND[ev.kind] || ev.kind], ['Time', fmtTime(ev.t)], ['Duration', ev.ms != null ? `${ev.ms} ms` : 'not finished'], ['Result', ev.status]];
      if (isData) { const info = R.dataInfo(ev); const n = R.rowCount(ev); if (info.name) facts.push(['Data page / view', info.name]); if (n !== undefined) facts.push(['Rows', n]); }
      if (ev.comp) facts.push(['Component', ev.comp]); if (ev.ctx) facts.push(['Context', ev.ctx]);
      if (ev.net) facts.push(['URL', ev.net.url], ['HTTP', ev.http != null ? `${ev.http} ${ev.statusText || ''}` : 'no response'], ['Sent with', ev.net.via]);
      if (ev.frameUrl) facts.push(['Frame', ev.frameUrl]);
      body.append(h('dl', { class: 'facts' }, ...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))])));
      if (ev.status === 'error' || ev.http >= 400) body.append(h('div', { class: 'tools' }, copyBtn('Copy as a bug report', () => R.issueMarkdown({ level: 'bad', text: ex.lines[0] || ev.name, ev }, { view, events: S.events }))));
    } else if (S.sub === 'input') {
      if (isData) dataInput(body, ev);
      else if (ev.net) body.append(h('p', { class: 'say' }, `${ev.net.method} ${ev.net.url}`), h('h4', {}, 'Headers (secrets hidden)'), tree(ev.net.reqHeaders), h('h4', {}, 'Body'), tree(ev.net.reqBody));
      else body.append(h('div', { class: 'tools' }, copyBtn('Copy input as JSON', () => JSON.stringify(view(ev.args), null, 2))), h('p', { class: 'muted' }, 'Arguments, in order:'), tree(ev.args));
    } else if (S.sub === 'output') {
      if (ev.status === 'pending') body.append(h('div', { class: 'hint warn' }, 'Still waiting. If this never completes, the call was made but nothing came back.'));
      if (ev.error) body.append(h('div', { class: 'hint bad' }, 'It failed:'), tree(ev.error));
      if (isData && ev.status === 'ok') dataOutput(body, ev);
      if (ev.net && ev.resHeaders) body.append(h('h4', {}, 'Headers'), tree(ev.resHeaders), h('h4', {}, 'Body'));
      else if (isData && ev.status === 'ok') body.append(h('h4', {}, 'Full output'));
      if (ev.status !== 'pending' || ev.result !== undefined) body.append(h('div', { class: 'tools' }, copyBtn('Copy output as JSON', () => JSON.stringify(view(ev.result), null, 2))), tree(ev.result));
      if (ev.changed) body.append(h('p', { class: 'muted' }, 'Changed paths:'), tree(ev.changed));
    } else if (S.sub === 'structure') {
      const blocks = [];
      if (ev.net) blocks.push(['Request body', ev.net.reqShape]);
      else if (ev.argsShape) blocks.push(['Input (arguments)', ev.argsShape]);
      if (ev.shape) blocks.push([ev.net ? 'Response body' : 'Output', ev.shape]);
      if (!blocks.length) body.append(h('p', { class: 'muted' }, 'No structure recorded for this entry.'));
      for (const [title, sh] of blocks) body.append(schemaBlock(title, sh));
      if (blocks.length) body.append(h('p', { class: 'note' }, 'A ? after a name means that key was missing in some items. For a list, “each item” is the merged shape of up to 20 items.'));
    } else if (S.sub === 'network') {
      networkSub(body, ev);
    } else if (S.sub === 'caller') {
      const parent = parentOf(ev);
      if (parent) body.append(h('p', { class: 'say' }, 'Started while this was running: ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); select(parent.key); } }, parent.name)));
      const children = S.events.filter((e) => e.frameId === ev.frameId && e.parent === ev.id);
      if (children.length) body.append(h('p', { class: 'say' }, `It triggered ${plural(children.length, 'call')}:`), ...children.map((k) => h('div', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); select(k.key); } }, k.name))));
      body.append(h('h4', {}, 'Call stack'), ev.stack?.length ? h('pre', { class: 'code' }, ev.stack.join('\n')) : h('p', { class: 'muted' }, 'No stack was captured.'));
    } else {
      const raw = JSON.stringify(view({ ...ev, stack: undefined }), null, 2);
      body.append(h('div', { class: 'tools' }, copyBtn('Copy event JSON', () => raw)), h('pre', { class: 'code' }, raw));
    }
    if (sameView) d.scrollTop = prevScroll;
  }

  // ------------------------------------------------------------------ issues
  const LEVEL_WORD = { bad: 'Error', warn: 'Check', info: 'Note' };
  const issueMeta = () => ({ tool: 'Constellation Lens', version: VERSION, origin: S.origin, runtime: mergedStatus().version, valuesHidden: S.mask });
  function issueCard(f) {
    const ev = f.ev;
    const inner = h('div', { class: 'inner' });
    const fill = () => {
      if (inner.dataset.filled) return;
      inner.dataset.filled = '1';
      const ex = explain(ev);
      ex.lines.forEach((l) => inner.append(h('p', { class: 'say' }, l)));
      const facts = [['Type', KIND[ev.kind] || ev.kind], ['Time', new Date(ev.t).toISOString()]];
      if (ev.ms != null) facts.push(['Duration', `${ev.ms} ms`]);
      if (ev.comp) facts.push(['Component', ev.comp]); if (ev.ctx) facts.push(['Context', ev.ctx]);
      if (ev.net) facts.push(['Request', `${ev.net.method} ${ev.net.url}`], ['HTTP', ev.http != null ? `${ev.http} ${ev.statusText || ''}` : 'no response']);
      if (ev.source) facts.push(['Where', ev.source]);
      inner.append(h('dl', { class: 'facts' }, ...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))])));
      inner.append(h('div', { class: 'tools' },
        copyBtn('Copy issue (Markdown)', () => R.issueMarkdown(f, { view, events: S.events })),
        copyBtn('Copy as JSON', () => JSON.stringify(R.issuesJson([f], issueMeta(), { view, events: S.events }), null, 2)),
        ev.kind !== 'issue' ? h('button', { type: 'button', onclick: () => jumpTo(ev) }, 'Show the call') : null));
      if (ev.kind === 'net') { if (ev.net?.reqBody !== undefined) inner.append(h('h4', {}, 'Request body'), tree(ev.net.reqBody, 1)); }
      else if (ev.kind !== 'issue' && ev.args !== undefined) inner.append(h('h4', {}, 'Input'), tree(ev.args, 1));
      if (ev.error) inner.append(h('h4', {}, 'Error'), tree(ev.error, 1));
      if (ev.status !== 'pending' && ev.result !== undefined) inner.append(h('h4', {}, ev.kind === 'net' ? 'Response' : 'Output'), tree(ev.result, 1));
      const nets = R.networkOf(ev, S.events);
      if (nets.length) inner.append(h('h4', {}, 'HTTP requests it made'), ...nets.map((n) => h('div', { class: 'mono' }, `${n.net.method} ${n.net.url} → ${n.http != null ? n.http : 'no response'} in ${n.ms ?? '?'} ms`)));
      if (ev.stack?.length) inner.append(h('h4', {}, 'Call stack'), h('pre', { class: 'code' }, ev.stack.join('\n')));
    };
    const open = S.openIssues.has(f.id);
    const card = h('details', { class: `issue ${f.level}`, open, ontoggle: (e) => { if (e.target.open) { S.openIssues.add(f.id); fill(); } else S.openIssues.delete(f.id); } },
      h('summary', {}, h('span', { class: 'lvl' }, LEVEL_WORD[f.level]), h('span', { class: 'txt' }, f.text), h('span', { class: 'when' }, fmtTime(ev.t))), inner);
    if (open) fill();
    return card;
  }

  let issuesSig = '';
  function renderIssues(force) {
    const all = R.findings(S.events);
    const counts = { all: all.length, bad: 0, warn: 0, info: 0 };
    for (const f of all) counts[f.level]++;
    for (const k of Object.keys(counts)) $(`#il-${k}`).textContent = counts[k];
    const badge = $('#n-issues');
    badge.hidden = counts.all === 0;
    badge.textContent = counts.bad || counts.all;
    badge.className = `count ${counts.bad ? 'err' : counts.warn ? 'warnc' : ''}`;
    if (S.tab !== 'issues') return;
    const q = S.issueQ.toLowerCase();
    const list = all.filter((f) => (S.issueLevel === 'all' || f.level === S.issueLevel) && (!q || `${f.text} ${f.ev.comp || ''} ${f.ev.net?.url || ''}`.toLowerCase().includes(q)));
    const sig = `${list.map((f) => f.id).join(',')}|${S.issueLevel}|${S.issueQ}|${S.mask}|${counts.all}`;
    if (!force && sig === issuesSig) return;
    issuesSig = sig;
    const main = $('main');
    const prevTop = main.scrollTop;
    const box = clear($('#issues-list'));
    if (!list.length) {
      box.append(h('div', { class: 'empty' }, markIcon(44), h('strong', {}, all.length ? 'No issues match' : 'No issues so far'), all.length ? 'Try another severity or clear the filter.' : 'Failed calls, page errors, console errors and warnings, stalled or slow requests, empty data and loops show up here, each with a copy button.'));
    } else {
      list.forEach((f) => box.append(issueCard(f)));
      box.append(h('p', { class: 'note' }, 'Hide values hides data. Error messages are kept, because they say what went wrong.'));
    }
    const bar = clear($('#issue-copy-all'));
    if (list.length) bar.append(
      copyBtn(`Copy ${plural(list.length, 'issue')} (Markdown)`, () => R.issuesMarkdown(list, issueMeta(), { view, events: S.events }), 'primary'),
      ' ',
      copyBtn('Copy as JSON', () => JSON.stringify(R.issuesJson(list, issueMeta(), { view, events: S.events }), null, 2)),
      ' ',
      h('button', { type: 'button', onclick: () => download(`lens-issues-${Date.now()}.md`, R.issuesMarkdown(list, issueMeta(), { view, events: S.events }), 'text/markdown') }, 'Download .md'));
    main.scrollTop = prevTop;
  }

  // ------------------------------------------------------------------ "Was it called?"
  const parseExpect = (p) => { const m = /^\/(.+)\/([a-z]*)$/.exec(p); if (m) { try { const re = new RegExp(m[1], m[2]); return (s) => re.test(s); } catch { /* fall through */ } } const low = p.toLowerCase(); return (s) => s.toLowerCase().includes(low); };
  function expectStats() {
    return S.expects.map((ex) => {
      const test = parseExpect(ex.pattern);
      const hits = S.events.filter((ev) => ev.kind !== 'nav' && ev.kind !== 'issue' && (ex.kind === 'any' || ev.kind === ex.kind) && test(`${ev.name} ${ev.net?.url || ''}`));
      return { ex, hits, last: hits[hits.length - 1] };
    });
  }
  function renderExpect() {
    const stats = expectStats();
    const box = clear($('#expect-list'));
    if (!stats.length) box.append(h('p', { class: 'empty' }, 'No expectations yet. Add the call or URL you are debugging, then use the app.'));
    else {
      box.append(h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Looking for'), h('th', {}, 'Where'), h('th', {}, 'Called?'), h('th', {}, 'Last result'), h('th', {}, ''))),
        h('tbody', {}, ...stats.map(({ ex, hits, last }) => h('tr', {},
          h('td', { class: 'mono' }, ex.pattern), h('td', {}, ex.kind === 'any' ? 'Anywhere' : KIND[ex.kind]),
          h('td', { class: hits.length ? 'ok-t' : 'bad-t' }, hits.length ? `✓ ${plural(hits.length, 'time')}` : '✗ not called'),
          h('td', {}, last ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); jumpTo(last); } }, `${last.status === 'error' ? 'failed' : last.status}${last.ms != null ? ` · ${last.ms} ms` : ''} at ${fmtTime(last.t)}`) : '—'),
          h('td', {}, h('button', { onclick: () => { S.expects = S.expects.filter((x) => x !== ex); saveExpects(); render(); } }, 'Remove')))))));
    }
    const called = stats.filter((s) => s.hits.length).length;
    $('#n-expect').textContent = stats.length ? `✓${called} ✗${stats.length - called}` : '';
  }
  const expectKey = () => `lens:expect:${new URL(S.origin || 'http://x').hostname}`;
  const saveExpects = () => { try { chrome.storage.local.set({ [expectKey()]: S.expects }); } catch { /* ignore */ } };
  async function loadExpects() { try { const r = await chrome.storage.local.get(expectKey()); S.expects = r[expectKey()] || []; } catch { S.expects = []; } }

  // ------------------------------------------------------------------ component
  const pageEval = (expr) => new Promise((res) => chrome.devtools.inspectedWindow.eval(expr, (r, e) => res({ r, e })));
  async function inspect() {
    const out = clear($('#component-out'));
    const { r, e } = await pageEval('window.__pegaXray ? window.__pegaXray.inspectElement($0) : { found: false, reason: "Lens is not attached to this page. Turn it on for this site and reload." }');
    if (e && (e.isError || e.isException)) { out.append(h('div', { class: 'card' }, h('div', { class: 'hint bad' }, 'Could not inspect: ', String(e.value || e.description || e.code)))); return; }
    if (!r || !r.found) { out.append(h('div', { class: 'card' }, h('div', { class: 'hint warn' }, r?.reason || 'Nothing found.'), h('p', { class: 'muted' }, 'Tip: select an element inside the component (not the page background), then try again.'))); return; }
    S.lastInspect = r;
    out.append(...componentCard(r));
  }
  async function listComponents() {
    const out = clear($('#component-out'));
    const { r } = await pageEval('window.__pegaXray ? window.__pegaXray.listComponents() : null');
    if (!r) { out.append(h('div', { class: 'card' }, h('div', { class: 'hint warn' }, 'Lens is not attached to this page. Turn it on for this site and reload.'))); return; }
    out.append(h('div', { class: 'card' }, h('h2', {}, `${plural(r.length, 'component')} on the page`),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Component'), h('th', {}, 'Context'), h('th', {}, 'Element'))), h('tbody', {}, ...r.map((c) => h('tr', {}, h('td', {}, c.component), h('td', { class: 'mono' }, c.context), h('td', { class: 'mono' }, `<${c.tag}>${c.classes ? ` .${c.classes.split(' ')[0]}` : ''}`)))))));
  }

  // ------------------------------------------------------------------ health
  function renderHealth() {
    const out = clear($('#health-out'));
    const st = mergedStatus();
    const row = (label, ok, detail) => h('tr', {}, h('td', {}, label), h('td', { class: ok === true ? 'ok-t' : ok === false ? 'bad-t' : 'warn-t' }, ok === true ? '✓' : ok === false ? '✗' : '…'), h('td', {}, detail));
    const f = R.findings(S.events);
    const bad = f.filter((x) => x.level === 'bad').length;
    out.append(
      h('div', { class: 'card' }, h('h2', {}, 'Is Lens seeing your app?'),
        h('p', { class: 'muted' }, 'Checks look for capabilities, not version numbers, so they apply to Pega 23, 24, 25, 26 and later. If a line is not green, that part of your runtime looks different and the line says what to try.'),
        h('table', {}, h('tbody', {},
          row('Switched on for this site', S.enabled, S.enabled ? S.origin : 'Click “Turn on for this site”.'),
          row('Hook attached to the page', S.bridges > 0 || S.statusByFrame.size > 0, S.statusByFrame.size ? `${plural(S.statusByFrame.size, 'frame')} reporting` : 'Reload the page after turning Lens on.'),
          row('PCore found', st.pcore ? true : S.enabled ? null : false, st.pcore ? `${st.pcoreMethods ?? '?'} methods` : 'Not on this page yet. Constellation apps load PCore a moment after the page; if the app is inside an iframe on another host, turn Lens on for that host too.'),
          row('Pega runtime version', st.version ? !/unknown/.test(st.version) : null, st.version || 'Waiting for PCore.'),
          row('Store watched (state changes)', st.store ? true : st.pcore ? null : false, st.store ? 'State changes and dispatched actions are recorded.' : 'Waiting for PCore.getStore(). If it never turns green, your build may not expose the store; PCore and network recording still work.'),
          row('Components discovered', st.react ? true : null, st.react ? `${st.reactMode || 'React'} · PConnect calls from components are recorded.` : 'No Constellation components rendered yet, or they are inside a closed shadow root.'),
          row('Events recorded', S.events.length > 0 ? true : null, `${S.events.length} in this panel`),
        ))),
      h('div', { class: 'card' }, h('h2', {}, f.length ? `${plural(f.length, 'issue')} found` : 'No issues so far'),
        h('p', { class: 'muted' }, f.length ? `${plural(bad, 'error')} among them. Each one can be copied as a bug report.` : 'No failed calls, page errors, stalled requests or loops.'),
        h('button', { class: 'primary', type: 'button', onclick: () => switchTab('issues') }, 'Open Issues')),
      h('div', { class: 'card' }, h('h2', {}, 'Share a diagnosis'), h('p', { class: 'muted' }, 'Copies the checks above (no event data) so you can report a compatibility problem.'),
        copyBtn('Copy diagnostics', () => JSON.stringify({ tool: `Constellation Lens ${VERSION}`, userAgent: navigator.userAgent, status: st, frames: S.statusByFrame.size, events: S.events.length }, null, 2))),
    );
  }

  /** The two cards a component gets: what it is and was given, and what it did. */
  function componentCard(r) {
    const d = r.data;
    const facts = [['Component', d.component], ['Context', d.contextName], ['Page reference', d.pageReference], ['Current view', typeof d.currentView === 'string' ? d.currentView : undefined], ['Children', d.childCount]].filter(([, v]) => v !== undefined && v !== null && v !== '');
    const calls = S.events.filter((ev) => ev.kind === 'pconn' && ev.comp === String(d.component) && ev.ctx === String(d.contextName) && ev.access !== 'read');
    const cfgShape = r.shape?.props?.configProps;
    return [
      h('div', { class: 'card' }, h('h2', {}, String(d.component ?? 'Component')), h('p', { class: 'muted' }, 'What this component is, and what it was given.'),
        h('dl', { class: 'facts' }, ...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))])),
        h('h3', {}, 'Config props (what Pega gave it to show)'), tree(d.configProps),
        h('h3', {}, 'State props'), tree(d.stateProps),
        h('h3', {}, 'Case info'), tree(d.caseInfo),
        h('h3', {}, 'Raw metadata'), tree(d.rawMetadata),
        h('h3', {}, 'Structure of its config props'), cfgShape ? schemaBlock('Config props', cfgShape) : h('p', { class: 'muted' }, 'No structure recorded.')),
      h('div', { class: 'card' }, h('h2', {}, 'What it did'), calls.length ? h('div', {}, ...calls.slice(-30).reverse().map((ev) => h('div', { class: 'finding', onclick: () => jumpTo(ev) }, h('span', { class: `badge k-${ev.kind}` }, 'PConnect'), h('span', { class: 'mono' }, `${ev.name.replace(/^pConn\./, '')} · ${ev.status}`)))) : h('p', { class: 'muted' }, 'No writes, refreshes or data calls from this component yet. Interact with it, then inspect again.')),
    ];
  }

  // ------------------------------------------------------------------ views: the component tree and the page picker
  S.views = { nodes: [], loaded: false, attached: true, containers: false, q: '', selected: null, detail: undefined, picking: false, loading: false };
  async function loadViews() {
    S.views.loading = true; renderViews();
    const { r } = await pageEval('window.__pegaXray ? window.__pegaXray.viewTree() : null');
    S.views.loading = false; S.views.loaded = true; S.views.attached = Array.isArray(r); S.views.nodes = Array.isArray(r) ? r : [];
    const badge = $('#n-views'); badge.hidden = !S.views.nodes.length; badge.textContent = S.views.nodes.length;
    renderViews();
  }
  async function selectView(node) {
    S.views.selected = node.id; S.views.detail = undefined; renderViews();
    await pageEval(`window.__pegaXray && window.__pegaXray.highlight(${Number(node.index)})`);
    const { r } = await pageEval(`window.__pegaXray ? window.__pegaXray.inspectIndex(${Number(node.index)}) : null`);
    if (S.views.selected === node.id) { S.views.detail = r; renderViewsDetail(); }
  }
  function viewRow(n, depth) {
    const selected = S.views.selected === n.id;
    const row = h('div', { class: `vrow${selected ? ' sel' : ''}${n.match === false ? ' dim' : ''}`, tabindex: '0', role: 'treeitem', 'aria-selected': String(selected), onclick: () => selectView(n), onkeydown: (e) => { if (e.key === 'Enter') selectView(n); } },
      h('span', { class: 'vname' }, n.component), n.type && n.type !== n.component ? h('span', { class: 'ty ty-object' }, n.type) : null,
      n.label ? h('span', { class: 'muted' }, `“${n.label}”`) : null,
      n.children.length ? h('span', { class: 'vin', title: 'Components inside this one' }, `${R.countViews(n.children)} inside`) : null,
      n.context ? h('span', { class: 'vctx' }, n.context) : null);
    if (!n.children.length) return h('li', {}, row);
    return h('li', {}, h('details', { open: depth < 3 || n.forceOpen }, h('summary', {}, row), h('ul', {}, ...n.children.map((k) => viewRow(k, depth + 1)))));
  }
  function renderViews() {
    const box = clear($('#views-tree'));
    const empty = clear($('#views-empty'));
    const roots = R.nestViews(S.views.nodes, S.views.q, { containersOnly: S.views.containers });
    empty.hidden = false;
    if (S.views.loading) empty.append(markIcon(40), h('strong', {}, 'Reading the page…'));
    else if (!S.views.attached) empty.append(markIcon(40), h('strong', {}, 'Lens is not attached to this page'), 'Turn it on for this site and reload, then press Refresh.');
    else if (!roots.length) empty.append(markIcon(40), h('strong', {}, S.views.nodes.length ? 'Nothing matches the filter' : 'No components found yet'), S.views.nodes.length ? 'Clear the filter to see them all.' : 'Open a case or a screen, then press Refresh. Components are found through React, so a page that has not rendered yet shows none.');
    else { empty.hidden = true; box.append(h('ul', { class: 'tree vtree' }, ...roots.map((r) => viewRow(r, 0)))); }
    $('#views-count').textContent = S.views.nodes.length ? `${plural(R.countViews(roots), 'component')}${S.views.q ? ` of ${S.views.nodes.length}` : ''}` : '';
    renderViewsDetail();
  }
  function renderViewsDetail() {
    const d = clear($('#views-detail'));
    if (!S.views.selected) { d.append(h('div', { class: 'empty' }, markIcon(40), h('strong', {}, 'Pick a component'), 'Select one in the tree, or press “Pick on page” and click it on the page.')); return; }
    const r = S.views.detail;
    if (r === undefined) { d.append(h('div', { class: 'empty' }, 'Reading the component…')); return; }
    if (!r || !r.found) { d.append(h('div', { class: 'card' }, h('div', { class: 'hint warn' }, r?.reason || 'Nothing found. Lens may not be attached to this page.'))); return; }
    const sel = S.views.nodes.find((n) => n.id === S.views.selected);
    if (sel) d.append(h('div', { class: 'crumbs', 'aria-label': 'Where this sits' }, ...R.viewPath(S.views.nodes, sel.id).flatMap((name, i, all) => [h('span', { class: i === all.length - 1 ? 'here' : '' }, name), i < all.length - 1 ? h('span', { class: 'sep' }, '›') : null])));
    d.append(...componentCard(r));
  }
  async function pickOnPage() {
    const { r } = await pageEval('window.__pegaXray ? window.__pegaXray.startPicker() : false');
    if (!r) { banner('Lens is not attached to this page. Turn it on for this site and reload.', true); return; }
    S.views.picking = true;
    banner('Click a component on the page to choose it. Press Escape to cancel. (Works in the top page; for an app inside an iframe, use that frame’s DevTools.)');
  }
  /** The page told us which component was clicked. */
  async function onPicked(msg) {
    banner('');
    S.views.picking = false;
    if (msg.cancelled) return;
    switchTab('views');
    const res = msg.result;
    await loadViews();
    const d = res && res.data;
    const node = d && S.views.nodes.find((n) => n.component === String(d.component) && n.context === String(d.contextName));
    S.views.selected = node ? node.id : 'picked';
    S.views.detail = res;
    renderViews();
  }

  // ------------------------------------------------------------------ tabs and render loop
  function switchTab(tab) {
    S.tab = tab;
    document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $('#view-list').hidden = !LIST_TABS.includes(tab);
    $('#view-views').hidden = tab !== 'views';
    $('#view-issues').hidden = tab !== 'issues';
    if (tab === 'views' && !S.views.loaded) loadViews();
    $('#view-expect').hidden = tab !== 'expect';
    $('#view-component').hidden = tab !== 'component';
    $('#view-health').hidden = tab !== 'health';
    const plain = tab === 'network' || tab === 'data';
    $('#kinds').hidden = plain;
    $('#lbl-hide-reads').hidden = plain;
    $('#lbl-pega-only').hidden = tab === 'data';
    issuesSig = '';
    render();
  }
  let raf = 0;
  const scheduleRender = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };
  function render() {
    renderChips();
    renderCounts();
    if (LIST_TABS.includes(S.tab)) { renderList(scopeOf(S.tab)); renderDetail(); }
    renderIssues();
    if (S.tab === 'expect') renderExpect(); else renderExpectCount();
    if (S.tab === 'health') renderHealth();
  }
  function renderExpectCount() { const stats = expectStats(); const c = stats.filter((s) => s.hits.length).length; $('#n-expect').textContent = stats.length ? `✓${c} ✗${stats.length - c}` : ''; }

  // ------------------------------------------------------------------ wiring
  async function refreshSite() {
    const { r } = await pageEval('location.origin');
    S.origin = typeof r === 'string' ? r : '';
    if (/^https?:/.test(S.origin)) {
      try { const res = await chrome.runtime.sendMessage({ type: 'status', origin: S.origin }); S.enabled = !!res?.enabled; } catch { S.enabled = false; }
    }
    await loadExpects();
    render();
  }

  document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#q').addEventListener('input', (e) => { S.q = e.target.value; scheduleRender(); });
  $('#hide-reads').addEventListener('change', (e) => { S.hideReads = e.target.checked; scheduleRender(); });
  $('#pega-only').addEventListener('change', (e) => { S.pegaOnly = e.target.checked; scheduleRender(); });
  $('#only-problems').addEventListener('change', (e) => { S.onlyProblems = e.target.checked; scheduleRender(); });
  $('#mask').addEventListener('change', (e) => { S.mask = e.target.checked; detailSig = ''; issuesSig = ''; render(); });
  $('#kinds').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.kind = b.dataset.kind;
    document.querySelectorAll('#kinds button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    scheduleRender();
  });
  $('#issue-levels').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.issueLevel = b.dataset.level;
    document.querySelectorAll('#issue-levels button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  });
  $('#issue-q').addEventListener('input', (e) => { S.issueQ = e.target.value; render(); });
  $('#jump-latest').addEventListener('click', () => { const r = $('#rows'); r.scrollTop = r.scrollHeight; $('#jump-latest').hidden = true; S.lastShown = r.children.length; });
  $('#rows').addEventListener('scroll', () => {
    const r = $('#rows');
    if (r.scrollHeight - r.scrollTop - r.clientHeight < 40) { $('#jump-latest').hidden = true; S.lastShown = r.children.length; }
  });
  $('#btn-clear').addEventListener('click', () => { S.events = []; S.byKey.clear(); S.selected = null; S.openIssues.clear(); S.bodies.clear(); S.bodyChars = 0; S.showAll.clear(); S.lastShown = 0; detailSig = ''; issuesSig = ''; send({ cmd: 'clear' }); render(); });
  $('#btn-pause').addEventListener('click', (e) => { S.paused = !S.paused; send({ cmd: S.paused ? 'pause' : 'resume' }); e.target.textContent = S.paused ? 'Resume' : 'Pause'; });
  $('#btn-reload').addEventListener('click', () => { banner(''); chrome.devtools.inspectedWindow.reload({}); });
  $('#btn-enable').addEventListener('click', async () => {
    const u = new URL(S.origin);
    const granted = await chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
    if (!granted) { banner('Permission was not granted, so Lens cannot run on this site.', true); return; }
    const res = await chrome.runtime.sendMessage({ type: 'enable', origin: S.origin, tabId });
    if (!res?.ok) { banner(`Could not turn Lens on: ${res?.error || 'unknown error'}`, true); return; }
    S.enabled = true; S.enabledAt = Date.now();
    banner('Lens is on. It sees new activity now; reload to capture everything from the very first call.');
    render();
    setTimeout(() => { if (!mergedStatus().pcore && S.enabled) banner('Lens is on, but no PCore was found yet. If this is a Constellation app, reload it. If the app runs inside an iframe on another host, turn Lens on for that host too.', true); }, 8000);
  });
  $('#btn-export').addEventListener('click', () => {
    const data = { tool: 'Constellation Lens', version: VERSION, exportedAt: new Date().toISOString(), origin: S.origin, valuesHidden: S.mask, status: mergedStatus(), events: S.events.map((e) => view({ ...e, resHeadersFull: undefined, net: e.net ? { ...e.net, reqHeadersFull: undefined, urlFull: undefined } : e.net })) };
    download(`lens-${Date.now()}.json`, JSON.stringify(data, null, 2), 'application/json');
  });
  $('#expect-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const p = $('#expect-pattern').value.trim(); if (!p) return;
    S.expects.push({ pattern: p, kind: $('#expect-kind').value }); $('#expect-pattern').value = '';
    saveExpects(); render();
  });
  $('#btn-inspect').addEventListener('click', inspect);
  $('#btn-pick').addEventListener('click', pickOnPage);
  $('#views-containers').addEventListener('change', (e) => { S.views.containers = e.target.checked; renderViews(); });
  $('#views-expand').addEventListener('click', () => document.querySelectorAll('#views-tree details').forEach((d) => { d.open = true; }));
  $('#views-collapse').addEventListener('click', () => document.querySelectorAll('#views-tree details').forEach((d) => { d.open = false; }));
  $('#btn-views-refresh').addEventListener('click', loadViews);
  $('#views-q').addEventListener('input', (e) => { S.views.q = e.target.value; renderViews(); });
  $('#btn-list').addEventListener('click', listComponents);
  chrome.devtools.panels.elements.onSelectionChanged.addListener(() => { if (S.tab === 'component' && $('#follow').checked) inspect(); });
  chrome.devtools.network.onNavigated.addListener((url) => {
    S.statusByFrame.clear(); S.bridges = 0; S.views.loaded = false; S.views.selected = null; S.views.detail = undefined;
    if (S.tab === 'views') setTimeout(loadViews, 1500);
    const ev = { key: `nav:${Date.now()}`, id: 0, frameId: -1, kind: 'nav', name: `Page loaded: ${url}`, t: Date.now(), status: 'ok', access: 'event' };
    S.events.push(ev); S.byKey.set(ev.key, ev); refreshSite();
  });
  document.documentElement.classList.toggle('dark', chrome.devtools.panels.themeName === 'dark');
  setInterval(() => { if (S.events.some((e) => e.status === 'pending')) scheduleRender(); }, 2000);

  connect();
  refreshSite();
  switchTab('activity');
})();
