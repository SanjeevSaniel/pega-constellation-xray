/* Pega Constellation X-Ray: DevTools panel.
 * All page data is rendered with textContent / DOM nodes, never innerHTML, so nothing a page returns can run here. */
(() => {
  'use strict';
  const tabId = chrome.devtools.inspectedWindow.tabId;
  const MAX_EVENTS = 5000;

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

  // ------------------------------------------------------------------ state
  const S = {
    events: [], byKey: new Map(), selected: null, tab: 'activity', sub: 'summary',
    kind: 'all', q: '', hideReads: true, pegaOnly: true, onlyProblems: false,
    mask: false, paused: false, origin: '', enabled: false, bridges: 0,
    statusByFrame: new Map(), frames: new Map(), expects: [], lastInspect: null, enabledAt: 0,
  };

  // ------------------------------------------------------------------ plain-English helpers
  const fmtTime = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`; };
  const KIND = { pcore: 'PCore', pconn: 'PConnect', net: 'Network', store: 'Store', pubsub: 'Event', nav: 'Page' };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function describeShape(s) {
    if (!s) return 'nothing recorded';
    switch (s.t) {
      case 'object': return `an object with ${plural(s.n ?? Object.keys(s.props || {}).length, 'key')}`;
      case 'array': return s.len === 0 ? 'an empty list' : `a list of ${plural(s.len, 'item')}`;
      case 'undefined': return 'nothing (undefined)';
      case 'null': return 'nothing (null)';
      case 'string': return 'a text value';
      case 'number': return 'a number';
      case 'boolean': return 'true or false';
      case 'function': return 'a function';
      case 'promise': return 'a promise';
      default: return `a ${s.t}`;
    }
  }

  const HTTP_HELP = {
    400: 'Pega rejected the request as malformed. Open the Output tab: the message usually names the field or value.',
    401: 'Not signed in, or the session expired. Sign in again, then retry.',
    403: 'Signed in, but this operator is not allowed to do this. Check the access group and the privileges.',
    404: 'Nothing was found at that address. Check the data page, case type or id in the URL.',
    409: 'The record changed under you (a conflict). Reload the case and try again.',
    412: 'The record is out of date (ETag mismatch). Reload it and retry.',
    422: 'Pega understood the request but a rule or validation refused it. See the Output tab for the reason.',
    500: 'Pega raised an error while handling this. Check the Pega logs for the same time.',
    502: 'A gateway between the browser and Pega failed.', 503: 'The server is unavailable or restarting.', 504: 'The server took too long to answer.',
  };

  function explain(ev) {
    const lines = [];
    let bad = false;
    const who = ev.comp ? `The ${ev.comp} component${ev.ctx ? ` (context ${ev.ctx})` : ''}` : 'Your code or the Pega runtime';
    if (ev.kind === 'nav') return { lines: [ev.name], bad };
    if (ev.kind === 'net') {
      const n = ev.net || {};
      lines.push(`${n.method} request to ${n.url ? new URL(n.url, 'http://x').pathname : ''} (${labelCategory(n.category)}).`);
      if (ev.status === 'pending') lines.push('Still waiting for the response.');
      else if (ev.status === 'error' && ev.http == null) { bad = true; lines.push('The request never got a response (network error, blocked or cancelled).'); }
      else {
        bad = ev.status === 'error';
        lines.push(`Answered HTTP ${ev.http} in ${ev.ms} ms with ${describeShape(ev.shape)}${ev.bytes ? ` (${(ev.bytes / 1024).toFixed(1)} KB)` : ''}.`);
        if (HTTP_HELP[ev.http]) lines.push(HTTP_HELP[ev.http]);
      }
      return { lines, bad };
    }
    if (ev.kind === 'store') {
      if (ev.name.startsWith('dispatch')) lines.push(`An action was dispatched to the store: ${ev.name.replace('dispatch ', '')}.`);
      else lines.push(`The store's state changed in ${plural((ev.changed || []).length, 'place')}: ${(ev.changed || []).slice(0, 6).join(', ')}${(ev.changed || []).length > 6 ? ', …' : ''}.`);
      return { lines, bad };
    }
    if (ev.kind === 'pubsub') {
      lines.push(`A subscribed callback was triggered (${ev.name.replace(' callback', '')}). The Input tab shows what it was given.`);
      return { lines, bad };
    }
    const argCount = ev.argsShape?.len ?? 0;
    lines.push(`${who} called ${ev.name} with ${plural(argCount, 'argument')}.`);
    if (ev.status === 'pending') lines.push('It has not finished yet.');
    else if (ev.status === 'error') { bad = true; lines.push(`It threw an error${ev.error?.message ? `: ${ev.error.message}` : ''}.`); }
    else {
      lines.push(`${ev.async ? `It resolved after ${ev.ms} ms with` : 'It returned'} ${describeShape(ev.shape)}.`);
      if (ev.access !== 'write' && ev.shape?.t === 'undefined') lines.push('A read that returns nothing usually means the property or view does not exist in this context.');
      if (ev.access === 'data' && ev.shape?.t === 'array' && ev.shape.len === 0) lines.push('No rows came back. Check the data page name, its parameters, and the context passed.');
    }
    return { lines, bad };
  }
  const labelCategory = (c) => ({ 'data-view': 'data view', case: 'case or assignment', attachment: 'attachment', 'dx-api': 'DX API', pega: 'Pega server', other: 'not recognised as Pega' }[c] || 'other');

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
  function leaf(v) {
    if (v && typeof v === 'object' && '$' in v && Object.keys(v).every((k) => ['$', 'name', 'tag', 'n', 'type', 'message', 'v'].includes(k))) return h('span', { class: 'v-meta' }, metaText(v));
    if (v === null) return h('span', { class: 'v-null' }, 'null');
    if (S.mask && typeof v !== 'object') return h('span', { class: 'v-mask' }, `‹${typeof v}›`);
    if (typeof v === 'string') return h('span', { class: 'v-str' }, JSON.stringify(v));
    if (typeof v === 'number') return h('span', { class: 'v-num' }, String(v));
    return h('span', { class: 'v-bool' }, String(v));
  }
  function node(key, v, depth) {
    const isMeta = v && typeof v === 'object' && '$' in v && Object.keys(v).every((k) => ['$', 'name', 'tag', 'n', 'type', 'message', 'v'].includes(k));
    const label = key === undefined ? [] : [h('span', { class: 'k' }, `${key}`), ': '];
    if (v && typeof v === 'object' && !isMeta) {
      const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
      const open = depth < 2;
      const d = h('details', { open }, h('summary', {}, ...label, h('span', { class: 'muted' }, Array.isArray(v) ? `[${entries.length}]` : `{${entries.length}}`)),
        h('ul', {}, ...entries.map(([k, x]) => node(k, x, depth + 1))));
      return h('li', {}, d);
    }
    return h('li', {}, ...label, leaf(v));
  }
  const tree = (v) => (v === undefined ? h('span', { class: 'muted' }, 'Nothing recorded.') : h('ul', { class: 'tree' }, node(undefined, view(v), 0)));

  function copyBtn(label, getText) {
    return h('button', { onclick: async (e) => {
      try { await navigator.clipboard.writeText(getText()); e.target.textContent = 'Copied'; setTimeout(() => { e.target.textContent = label; }, 1200); } catch { e.target.textContent = 'Copy failed'; }
    } }, label);
  }

  // ------------------------------------------------------------------ ingest
  function ingest(msg) {
    const fid = msg.frameId ?? 0;
    if (msg.type === 'events') {
      for (const it of msg.items) {
        if (it.upd) { const ev = S.byKey.get(`${fid}:${it.id}`); if (ev) Object.assign(ev, it.patch); continue; }
        const key = `${fid}:${it.id}`;
        const have = S.byKey.get(key);
        if (have) { Object.assign(have, it); continue; }
        it.key = key; it.frameId = fid; it.frameUrl = msg.frame;
        S.events.push(it); S.byKey.set(key, it);
      }
      if (S.events.length > MAX_EVENTS) for (const old of S.events.splice(0, S.events.length - MAX_EVENTS)) S.byKey.delete(old.key);
    } else if (msg.type === 'status') {
      S.statusByFrame.set(fid, msg.status); S.frames.set(fid, msg.frame);
    } else if (msg.type === 'bridge-up') {
      S.bridges++; S.frames.set(fid, msg.url); send({ cmd: 'replay' });
    } else if (msg.type === 'bridges') {
      S.bridges = msg.count; if (msg.count) send({ cmd: 'replay' });
    } else if (msg.type === 'note') {
      banner(msg.text, true);
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

  // ------------------------------------------------------------------ filtering, problems, findings
  const isProblem = (ev) => ev.status === 'error' || (ev.http != null && ev.http >= 400) || (ev.status === 'pending' && Date.now() - ev.t > 5000);
  function visible(ev, scope) {
    if (ev.kind === 'nav') return true;
    if (scope === 'network') { if (ev.kind !== 'net') return false; if (S.pegaOnly && !ev.net?.pega) return false; }
    else {
      if (S.kind !== 'all' && ev.kind !== S.kind) return false;
      if (S.hideReads && ev.access === 'read') return false;
      if (S.pegaOnly && ev.kind === 'net' && !ev.net?.pega) return false;
    }
    if (S.onlyProblems && !isProblem(ev)) return false;
    if (S.q) {
      const hay = `${ev.name} ${ev.comp || ''} ${ev.ctx || ''} ${ev.net?.url || ''}`.toLowerCase();
      if (!hay.includes(S.q.toLowerCase())) return false;
    }
    return true;
  }

  function findings() {
    const out = [];
    const dup = new Map();
    for (const ev of S.events) {
      if (ev.status === 'error' || (ev.http != null && ev.http >= 400)) out.push({ level: 'bad', ev, text: `${ev.name} failed${ev.http ? ` with HTTP ${ev.http}` : ''}${ev.error?.message ? `: ${ev.error.message}` : ''}` });
      else if (ev.status === 'pending' && Date.now() - ev.t > 5000) out.push({ level: 'warn', ev, text: `${ev.name} has been waiting for ${Math.round((Date.now() - ev.t) / 1000)} s with no answer` });
      else if (ev.ms > 3000) out.push({ level: 'warn', ev, text: `${ev.name} was slow: ${ev.ms} ms` });
      else if (ev.access === 'data' && ev.status === 'ok' && ((ev.shape?.t === 'array' && ev.shape.len === 0) || (ev.shape?.props?.data?.t === 'array' && ev.shape.props.data.len === 0))) out.push({ level: 'info', ev, text: `${ev.name} returned no rows` });
      if (ev.access !== 'read' && ev.kind !== 'store' && ev.kind !== 'nav' && ev.kind !== 'pubsub') {
        const k = `${ev.frameId}|${ev.name}|${JSON.stringify(ev.args)?.slice(0, 200)}`;
        const g = dup.get(k) || { ev, n: 0, first: ev.t, last: ev.t };
        g.n++; g.last = ev.t; dup.set(k, g);
      }
    }
    for (const g of dup.values()) if (g.n >= 5 && g.last - g.first < 4000) out.push({ level: 'warn', ev: g.ev, text: `${g.ev.name} ran ${g.n} times in ${((g.last - g.first) / 1000).toFixed(1)} s with identical input (a loop or a re-render storm?)` });
    return out.reverse().slice(0, 150);
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
      chip(S.enabled ? 'X-Ray on' : 'X-Ray off', S.enabled ? 'ok' : 'bad', S.enabled ? 'Recording this site' : 'Turn X-Ray on for this site to start recording'),
      chip(st.pcore ? `PCore found${st.version ? ` · ${st.version}` : ''}` : 'PCore not found yet', st.pcore ? 'ok' : 'wait', 'Pega Constellation core runtime'),
      chip(st.store ? 'Store watched' : 'Store waiting', st.store ? 'ok' : 'wait', 'State changes and dispatched actions'),
      chip(st.react ? `Components found${st.reactMode ? ` · ${st.reactMode}` : ''}` : 'No components yet', st.react ? 'ok' : 'wait', 'PConnect handles discovered in the page'),
    );
    $('#btn-enable').hidden = S.enabled || !/^https?:/.test(S.origin);
    $('#btn-reload').hidden = !S.enabled;
    if (!/^https?:/.test(S.origin) && S.origin) banner('X-Ray works on http and https pages. Open your Pega app and reopen DevTools.', true);
  }
  function banner(text, warn) {
    const b = $('#banner');
    if (!text) { b.hidden = true; return; }
    b.hidden = false; b.className = `banner${warn ? ' warn' : ''}`; b.textContent = text;
  }

  // ------------------------------------------------------------------ rendering: list + detail
  function renderList(scope) {
    const rowsEl = clear($('#rows'));
    const all = S.events.filter((e) => visible(e, scope));
    const shown = all.slice(-500);
    const wasBottom = rowsEl.scrollHeight - rowsEl.scrollTop - rowsEl.clientHeight < 40;
    for (const ev of shown) {
      const cls = ev.status === 'error' || (ev.http >= 400) ? 'err' : ev.status === 'pending' ? 'pending' : '';
      const nm = ev.kind === 'pconn' ? `${ev.name.replace(/^pConn\./, '')}${ev.comp ? `  ← ${ev.comp}` : ''}` : ev.name;
      const st = ev.kind === 'net' ? (ev.status === 'pending' ? '…' : ev.http != null ? `${ev.http} · ${ev.ms} ms` : '✕') : ev.status === 'pending' ? '…' : ev.status === 'error' ? '✕ error' : ev.ms != null ? `${ev.ms} ms` : '';
      rowsEl.append(h('div', { class: `row ${cls}`, role: 'option', tabindex: '0', 'aria-selected': String(S.selected === ev.key), onclick: () => select(ev.key),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(ev.key); } } },
      h('span', { class: 't' }, fmtTime(ev.t)), h('span', { class: `badge k-${ev.kind}` }, KIND[ev.kind] || ev.kind), h('span', { class: 'nm', title: nm }, nm), h('span', { class: 'st' }, st)));
    }
    if (wasBottom) rowsEl.scrollTop = rowsEl.scrollHeight;
    const empty = $('#rows-empty');
    empty.hidden = shown.length > 0;
    if (!shown.length) renderEmpty(empty, scope, all.length);
    $('#n-activity').textContent = S.events.filter((e) => e.kind !== 'net' && e.kind !== 'nav').length;
    $('#n-network').textContent = S.events.filter((e) => e.kind === 'net').length;
  }
  function renderEmpty(el, scope) {
    clear(el);
    if (!S.enabled) el.append(h('strong', {}, 'X-Ray is off for this site'), 'Click “Turn on for this site”, then reload the page to capture everything from the first call.');
    else if (!S.events.length) el.append(h('strong', {}, 'Nothing recorded yet'), 'Use the app: open a case, change a field, load a list. Each PCore call, PConnect call and API request shows up here as it happens.');
    else el.append(h('strong', {}, 'Nothing matches your filters'), scope === 'network' ? 'Try turning off “Pega calls only”.' : 'Try turning off “Hide quick reads” or clearing the search box.');
  }

  function select(key) { S.selected = key; renderList(S.tab === 'network' ? 'network' : 'activity'); renderDetail(); }

  function renderDetail() {
    const d = clear($('#detail'));
    const ev = S.byKey.get(S.selected);
    if (!ev) { d.append(h('div', { class: 'empty' }, h('strong', {}, 'Pick a row'), 'Select any call on the left to see exactly what went in, what came out, and its structure.')); return; }
    const ex = explain(ev);
    d.append(h('div', { class: 'detail-head' }, h('h3', {}, ev.name), h('div', { class: 'muted' }, `${KIND[ev.kind] || ev.kind} · ${fmtTime(ev.t)}${ev.ms != null ? ` · ${ev.ms} ms` : ''}${ev.status === 'pending' ? ' · pending' : ''}`)));
    const tabs = [['summary', 'Summary'], ['input', ev.kind === 'net' ? 'Request' : 'Input'], ['output', ev.kind === 'net' ? 'Response' : 'Output'], ['structure', 'Structure'], ['caller', 'Who called it'], ['raw', 'Raw']];
    d.append(h('div', { class: 'sub', role: 'tablist' }, ...tabs.map(([id, label]) => h('button', { role: 'tab', 'aria-selected': String(S.sub === id), onclick: () => { S.sub = id; renderDetail(); } }, label))));
    const body = h('div', { class: 'body' });
    d.append(body);
    if (S.sub === 'summary') {
      ex.lines.forEach((l, i) => body.append(h('p', { class: `say${ex.bad && i === 0 ? ' bad' : ''}` }, l)));
      const facts = [['Type', KIND[ev.kind] || ev.kind], ['Time', fmtTime(ev.t)], ['Duration', ev.ms != null ? `${ev.ms} ms` : 'not finished'], ['Result', ev.status]];
      if (ev.comp) facts.push(['Component', ev.comp]); if (ev.ctx) facts.push(['Context', ev.ctx]);
      if (ev.net) facts.push(['URL', ev.net.url], ['HTTP', ev.http != null ? `${ev.http} ${ev.statusText || ''}` : 'no response'], ['Sent with', ev.net.via]);
      if (ev.frameUrl) facts.push(['Frame', ev.frameUrl]);
      body.append(h('dl', { class: 'facts' }, ...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))])));
    } else if (S.sub === 'input') {
      if (ev.net) {
        body.append(h('p', { class: 'say' }, `${ev.net.method} ${ev.net.url}`), h('h4', {}, 'Headers (secrets hidden)'), tree(ev.net.reqHeaders), h('h4', {}, 'Body'), tree(ev.net.reqBody));
      } else {
        body.append(h('div', { class: 'tools' }, copyBtn('Copy input as JSON', () => JSON.stringify(view(ev.args), null, 2))), h('p', { class: 'muted' }, 'Arguments, in order:'), tree(ev.args));
      }
    } else if (S.sub === 'output') {
      if (ev.status === 'pending') body.append(h('div', { class: 'hint warn' }, 'Still waiting. If this never completes, the call was made but nothing came back.'));
      if (ev.error) body.append(h('div', { class: 'hint bad' }, 'It failed:'), tree(ev.error));
      if (ev.net && ev.resHeaders) body.append(h('h4', {}, 'Headers'), tree(ev.resHeaders), h('h4', {}, 'Body'));
      if (ev.status !== 'pending' || ev.result !== undefined) body.append(h('div', { class: 'tools' }, copyBtn('Copy output as JSON', () => JSON.stringify(view(ev.result), null, 2))), tree(ev.result));
      if (ev.changed) body.append(h('p', { class: 'muted' }, 'Changed paths:'), tree(ev.changed));
    } else if (S.sub === 'structure') {
      const blocks = [];
      if (ev.net) blocks.push(['Request body', ev.net.reqShape]);
      else if (ev.argsShape) blocks.push(['Input (arguments)', ev.argsShape]);
      if (ev.shape) blocks.push([ev.net ? 'Response body' : 'Output', ev.shape]);
      if (!blocks.length) body.append(h('p', { class: 'muted' }, 'No structure recorded for this entry.'));
      for (const [title, sh] of blocks) body.append(h('h4', {}, title), h('div', { class: 'tools' }, copyBtn('Copy as TypeScript', () => `type Shape = ${ts(sh)};`)), h('pre', { class: 'code' }, ts(sh)));
      body.append(h('p', { class: 'muted' }, 'A ? means the key was missing in some items. Arrays show the merged shape of up to 20 items.'));
    } else if (S.sub === 'caller') {
      const parent = ev.parent ? S.byKey.get(`${ev.frameId}:${ev.parent}`) : null;
      if (parent) body.append(h('p', { class: 'say' }, 'Started while this was running: ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); select(parent.key); } }, parent.name)));
      const kids = S.events.filter((e) => e.frameId === ev.frameId && e.parent === ev.id);
      if (kids.length) body.append(h('p', { class: 'say' }, `It triggered ${plural(kids.length, 'call')}:`), ...kids.map((k) => h('div', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); select(k.key); } }, k.name))));
      body.append(h('h4', {}, 'Call stack'), ev.stack?.length ? h('pre', { class: 'code' }, ev.stack.join('\n')) : h('p', { class: 'muted' }, 'No stack was captured.'));
    } else {
      const raw = JSON.stringify(view({ ...ev, stack: undefined }), null, 2);
      body.append(h('div', { class: 'tools' }, copyBtn('Copy event JSON', () => raw)), h('pre', { class: 'code' }, raw));
    }
  }

  // ------------------------------------------------------------------ "Was it called?"
  const parseExpect = (p) => { const m = /^\/(.+)\/([a-z]*)$/.exec(p); if (m) { try { const re = new RegExp(m[1], m[2]); return (s) => re.test(s); } catch { /* fall through */ } } const low = p.toLowerCase(); return (s) => s.toLowerCase().includes(low); };
  function expectStats() {
    return S.expects.map((ex) => {
      const test = parseExpect(ex.pattern);
      const hits = S.events.filter((ev) => ev.kind !== 'nav' && (ex.kind === 'any' || ev.kind === ex.kind) && test(`${ev.name} ${ev.net?.url || ''}`));
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
          h('td', {}, last ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); S.q = ex.pattern.replace(/^\/|\/[a-z]*$/g, ''); $('#q').value = S.q; switchTab(last.kind === 'net' ? 'network' : 'activity'); select(last.key); } }, `${last.status === 'error' ? 'failed' : last.status}${last.ms != null ? ` · ${last.ms} ms` : ''} at ${fmtTime(last.t)}`) : '—'),
          h('td', {}, h('button', { onclick: () => { S.expects = S.expects.filter((x) => x !== ex); saveExpects(); render(); } }, 'Remove')))))));
    }
    const called = stats.filter((s) => s.hits.length).length;
    $('#n-expect').textContent = stats.length ? `✓${called} ✗${stats.length - called}` : '';
  }
  const expectKey = () => `xray:expect:${new URL(S.origin || 'http://x').hostname}`;
  const saveExpects = () => { try { chrome.storage.local.set({ [expectKey()]: S.expects }); } catch { /* ignore */ } };
  async function loadExpects() { try { const r = await chrome.storage.local.get(expectKey()); S.expects = r[expectKey()] || []; } catch { S.expects = []; } }

  // ------------------------------------------------------------------ component x-ray
  const pageEval = (expr) => new Promise((res) => chrome.devtools.inspectedWindow.eval(expr, (r, e) => res({ r, e })));
  async function inspect() {
    const out = clear($('#component-out'));
    const { r, e } = await pageEval('window.__pegaXray ? window.__pegaXray.inspectElement($0) : { found: false, reason: "X-Ray is not attached to this page. Turn it on for this site and reload." }');
    if (e && (e.isError || e.isException)) { out.append(h('div', { class: 'card' }, h('div', { class: 'hint bad' }, 'Could not inspect: ', String(e.value || e.description || e.code)))); return; }
    if (!r || !r.found) { out.append(h('div', { class: 'card' }, h('div', { class: 'hint warn' }, r?.reason || 'Nothing found.'), h('p', { class: 'muted' }, 'Tip: select an element inside the component (not the page background), then try again.'))); return; }
    S.lastInspect = r;
    const d = r.data;
    const facts = [['Component', d.component], ['Context', d.contextName], ['Page reference', d.pageReference], ['Current view', typeof d.currentView === 'string' ? d.currentView : undefined], ['Children', d.childCount]].filter(([, v]) => v !== undefined && v !== null && v !== '');
    const calls = S.events.filter((ev) => ev.kind === 'pconn' && ev.comp === String(d.component) && ev.ctx === String(d.contextName) && ev.access !== 'read');
    out.append(
      h('div', { class: 'card' }, h('h2', {}, String(d.component ?? 'Component')), h('p', { class: 'muted' }, 'What this component is, and what it was given.'),
        h('dl', { class: 'facts' }, ...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))])),
        h('h3', {}, 'Config props (what Pega gave it to show)'), tree(d.configProps),
        h('h3', {}, 'State props'), tree(d.stateProps),
        h('h3', {}, 'Case info'), tree(d.caseInfo),
        h('h3', {}, 'Raw metadata'), tree(d.rawMetadata),
        h('h3', {}, 'Structure of its config props'), copyBtn('Copy as TypeScript', () => `type ConfigProps = ${ts(r.shape?.props?.configProps)};`), h('pre', { class: 'code' }, ts(r.shape?.props?.configProps))),
      h('div', { class: 'card' }, h('h2', {}, 'What it did'), calls.length ? h('div', {}, ...calls.slice(-30).reverse().map((ev) => h('div', { class: 'finding', onclick: () => { switchTab('activity'); S.hideReads = false; $('#hide-reads').checked = false; select(ev.key); } }, h('span', { class: `badge k-${ev.kind}` }, 'PConnect'), h('span', { class: 'mono' }, `${ev.name.replace(/^pConn\./, '')} · ${ev.status}`)))) : h('p', { class: 'muted' }, 'No writes, refreshes or data calls from this component yet. Interact with it, then inspect again.')),
    );
  }
  async function listComponents() {
    const out = clear($('#component-out'));
    const { r } = await pageEval('window.__pegaXray ? window.__pegaXray.listComponents() : null');
    if (!r) { out.append(h('div', { class: 'card' }, h('div', { class: 'hint warn' }, 'X-Ray is not attached to this page. Turn it on for this site and reload.'))); return; }
    out.append(h('div', { class: 'card' }, h('h2', {}, `${plural(r.length, 'component')} on the page`),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Component'), h('th', {}, 'Context'), h('th', {}, 'Element'))), h('tbody', {}, ...r.map((c) => h('tr', {}, h('td', {}, c.component), h('td', { class: 'mono' }, c.context), h('td', { class: 'mono' }, `<${c.tag}>${c.classes ? ` .${c.classes.split(' ')[0]}` : ''}`)))))));
  }

  // ------------------------------------------------------------------ health
  function renderHealth() {
    const out = clear($('#health-out'));
    const st = mergedStatus();
    const row = (label, ok, detail) => h('tr', {}, h('td', {}, label), h('td', { class: ok === true ? 'ok-t' : ok === false ? 'bad-t' : 'warn-t' }, ok === true ? '✓' : ok === false ? '✗' : '…'), h('td', {}, detail));
    const f = findings();
    out.append(
      h('div', { class: 'card' }, h('h2', {}, 'Is X-Ray seeing your app?'),
        h('p', { class: 'muted' }, 'Checks look for capabilities, not version numbers, so they apply to Pega 23, 24, 25, 26 and later. If a line is not green, that part of your runtime looks different and the line says what to try.'),
        h('table', {}, h('tbody', {},
          row('Switched on for this site', S.enabled, S.enabled ? S.origin : 'Click “Turn on for this site”.'),
          row('Hook attached to the page', S.bridges > 0 || S.statusByFrame.size > 0, S.statusByFrame.size ? `${plural(S.statusByFrame.size, 'frame')} reporting` : 'Reload the page after turning X-Ray on.'),
          row('PCore found', st.pcore ? true : S.enabled ? null : false, st.pcore ? `${st.pcoreMethods ?? '?'} methods` : 'Not on this page yet. Constellation apps load PCore a moment after the page; if the app is inside an iframe on another host, turn X-Ray on for that host too.'),
          row('Pega runtime version', st.version ? !/unknown/.test(st.version) : null, st.version || 'Waiting for PCore.'),
          row('Store watched (state changes)', st.store ? true : st.pcore ? null : false, st.store ? 'State changes and dispatched actions are recorded.' : 'Waiting for PCore.getStore(). If it never turns green, your build may not expose the store; PCore and network recording still work.'),
          row('Components discovered', st.react ? true : null, st.react ? `${st.reactMode || 'React'} · PConnect calls from components are recorded.` : 'No Constellation components rendered yet, or they are inside a closed shadow root.'),
          row('Events recorded', S.events.length > 0 ? true : null, `${S.events.length} in this panel`),
        ))),
      h('div', { class: 'card' }, h('h2', {}, `Things worth a look (${f.length})`),
        f.length ? h('div', {}, ...f.map((x) => h('div', { class: 'finding', onclick: () => { switchTab(x.ev.kind === 'net' ? 'network' : 'activity'); S.hideReads = false; $('#hide-reads').checked = false; select(x.ev.key); } },
          h('span', { class: `badge ${x.level === 'bad' ? 'bad-t' : x.level === 'warn' ? 'warn-t' : 'muted'}` }, x.level === 'bad' ? 'Error' : x.level === 'warn' ? 'Check' : 'Note'), h('span', {}, x.text)))) : h('p', { class: 'muted' }, 'Nothing suspicious so far: no failed calls, no stalled requests, no loops.')),
      h('div', { class: 'card' }, h('h2', {}, 'Share a diagnosis'), h('p', { class: 'muted' }, 'Copies the checks above (no event data) so you can report a compatibility problem.'),
        copyBtn('Copy diagnostics', () => JSON.stringify({ tool: 'Pega Constellation X-Ray 0.1.0', userAgent: navigator.userAgent, status: st, frames: S.statusByFrame.size, events: S.events.length }, null, 2))),
    );
    const bad = f.filter((x) => x.level === 'bad').length;
    const badge = $('#n-health'); badge.hidden = !bad; badge.textContent = bad;
  }

  // ------------------------------------------------------------------ tabs and render loop
  function switchTab(tab) {
    S.tab = tab;
    document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $('#view-list').hidden = !(tab === 'activity' || tab === 'network');
    $('#view-expect').hidden = tab !== 'expect';
    $('#view-component').hidden = tab !== 'component';
    $('#view-health').hidden = tab !== 'health';
    const kinds = $('#kinds'); kinds.hidden = tab === 'network';
    $('#hide-reads').closest('label').hidden = tab === 'network';
    render();
  }
  let raf = 0;
  const scheduleRender = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };
  function render() {
    renderChips();
    if (S.tab === 'activity' || S.tab === 'network') { renderList(S.tab === 'network' ? 'network' : 'activity'); renderDetail(); }
    else { renderList('activity'); }
    if (S.tab === 'expect') renderExpect(); else renderExpectCount();
    if (S.tab === 'health') renderHealth(); else healthBadge();
  }
  function renderExpectCount() { const stats = expectStats(); const c = stats.filter((s) => s.hits.length).length; $('#n-expect').textContent = stats.length ? `✓${c} ✗${stats.length - c}` : ''; }
  function healthBadge() { const bad = findings().filter((x) => x.level === 'bad').length; const b = $('#n-health'); b.hidden = !bad; b.textContent = bad; }

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
  $('#mask').addEventListener('change', (e) => { S.mask = e.target.checked; render(); });
  $('#kinds').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.kind = b.dataset.kind;
    document.querySelectorAll('#kinds button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    scheduleRender();
  });
  $('#btn-clear').addEventListener('click', () => { S.events = []; S.byKey.clear(); S.selected = null; send({ cmd: 'clear' }); render(); });
  $('#btn-pause').addEventListener('click', (e) => { S.paused = !S.paused; send({ cmd: S.paused ? 'pause' : 'resume' }); e.target.textContent = S.paused ? 'Resume' : 'Pause'; });
  $('#btn-reload').addEventListener('click', () => { banner(''); chrome.devtools.inspectedWindow.reload({}); });
  $('#btn-enable').addEventListener('click', async () => {
    const u = new URL(S.origin);
    const granted = await chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
    if (!granted) { banner('Permission was not granted, so X-Ray cannot run on this site.', true); return; }
    const res = await chrome.runtime.sendMessage({ type: 'enable', origin: S.origin, tabId });
    if (!res?.ok) { banner(`Could not turn X-Ray on: ${res?.error || 'unknown error'}`, true); return; }
    S.enabled = true; S.enabledAt = Date.now();
    banner('X-Ray is on. It sees new activity now; reload to capture everything from the very first call.');
    render();
    setTimeout(() => { if (!mergedStatus().pcore && S.enabled) banner('X-Ray is on, but no PCore was found yet. If this is a Constellation app, reload it. If the app runs inside an iframe on another host, turn X-Ray on for that host too.', true); }, 8000);
  });
  $('#btn-export').addEventListener('click', () => {
    const data = { tool: 'Pega Constellation X-Ray', version: '0.1.0', exportedAt: new Date().toISOString(), origin: S.origin, valuesHidden: S.mask, status: mergedStatus(), events: S.events.map((e) => view({ ...e })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = h('a', { href: url, download: `constellation-xray-${Date.now()}.json` }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('#expect-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const p = $('#expect-pattern').value.trim(); if (!p) return;
    S.expects.push({ pattern: p, kind: $('#expect-kind').value }); $('#expect-pattern').value = '';
    saveExpects(); render();
  });
  $('#btn-inspect').addEventListener('click', inspect);
  $('#btn-list').addEventListener('click', listComponents);
  chrome.devtools.panels.elements.onSelectionChanged.addListener(() => { if (S.tab === 'component' && $('#follow').checked) inspect(); });
  chrome.devtools.network.onNavigated.addListener((url) => {
    S.statusByFrame.clear(); S.bridges = 0;
    const ev = { key: `nav:${Date.now()}`, id: 0, frameId: -1, kind: 'nav', name: `Page loaded: ${url}`, t: Date.now(), status: 'ok', access: 'event' };
    S.events.push(ev); S.byKey.set(ev.key, ev); refreshSite();
  });
  document.documentElement.classList.toggle('dark', chrome.devtools.panels.themeName === 'dark');
  setInterval(() => { if (S.events.some((e) => e.status === 'pending')) scheduleRender(); }, 2000);

  connect();
  refreshSite();
  switchTab('activity');
})();
