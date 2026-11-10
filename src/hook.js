/* Lens: page-world hook.
 *
 * Records what a Pega Constellation page does through PCore, PConnect, the Redux-style store and the network:
 * the call, its arguments, what came back (data and exact shape), how long it took, and who called it.
 *
 * Request and response bodies are kept in full as raw text and sent to the panel in pieces.
 * Nothing leaves the browser. Events go to the DevTools panel for this tab and nowhere else.
 * Only API names documented in the Constellation guide are relied on; everything else is duck-typed and guarded,
 * so an unknown runtime shape degrades to "not recorded" instead of breaking the page.
 */
(() => {
  'use strict';
  const G = globalThis;
  if (G.__pegaXray) return;

  const MAX_EVENTS = 3000;
  const FLUSH_MS = 120;
  const LIMITS = { depth: 8, keys: 80, items: 30, str: 500, nodes: 4000 };

  const st = { seq: 0, buf: [], q: [], timer: 0, paused: false, internal: 0, stack: [], status: { pcore: false, store: false, react: false } };

  // ---------------------------------------------------------------- helpers
  const now = () => Date.now();
  const perf = () => (typeof performance !== 'undefined' ? performance.now() : now());
  const isNode = (v) => typeof Node !== 'undefined' && v instanceof Node;
  const isPromise = (v) => typeof Promise !== 'undefined' && v instanceof Promise;
  const internal = (fn, fallback) => { st.internal++; try { return fn(); } catch { return fallback; } finally { st.internal--; } };

  const READ_RE = /^(get|is|has|resolve|find|read|to)[A-Z_]|^(getState|subscribe)$/;
  const WRITE_RE = /^(set|update|trigger|open|save|create|refresh|close|dispatch|invoke|run|show|navigate|publish|notify|clear|accept|ignore|delete|submit|validate|add|remove|reset|switch)/i;
  const DATA_RE = /(getData|getPageData|getDataAsync|invokeRestApi|saveData|getCaseAttachments|getDataViewMetadata|getDataPageMetadata)/;

  function classify(method) {
    if (DATA_RE.test(method)) return 'data';
    if (WRITE_RE.test(method) && !/^(is|has)/.test(method)) return 'write';
    if (READ_RE.test(method)) return 'read';
    return 'other';
  }

  /** JSON-safe copy with limits. Functions, DOM nodes, cycles and huge values become small markers. */
  function snap(v, budget = { n: LIMITS.nodes }, depth = 0, seen = new WeakSet()) {
    if (budget.n-- <= 0) return { $: 'truncated' };
    const t = typeof v;
    if (v === null || t === 'boolean') return v;
    if (t === 'number') return Number.isFinite(v) ? v : { $: 'number', v: String(v) };
    if (t === 'undefined') return { $: 'undefined' };
    if (t === 'string') return v.length > LIMITS.str ? `${v.slice(0, LIMITS.str)}…(+${v.length - LIMITS.str})` : v;
    if (t === 'bigint') return { $: 'bigint', v: String(v) };
    if (t === 'symbol') return { $: 'symbol', v: String(v) };
    if (t === 'function') return { $: 'fn', name: v.name || 'anonymous' };
    if (isNode(v)) return { $: 'node', tag: v.nodeName };
    if (isPromise(v)) return { $: 'promise' };
    if (seen.has(v)) return { $: 'circular' };
    if (depth >= LIMITS.depth) return { $: 'deep', type: Array.isArray(v) ? 'array' : 'object' };
    seen.add(v);
    try {
      if (v instanceof Date) return { $: 'date', v: isNaN(v) ? 'invalid' : v.toISOString() };
      if (v instanceof Error) return { $: 'error', message: String(v.message), name: v.name };
      if (Array.isArray(v)) {
        const out = v.slice(0, LIMITS.items).map((x) => snap(x, budget, depth + 1, seen));
        if (v.length > LIMITS.items) out.push({ $: 'more', n: v.length - LIMITS.items });
        return out;
      }
      if (v instanceof Map) return { $: 'map', entries: snap(Array.from(v.entries()), budget, depth + 1, seen) };
      if (v instanceof Set) return { $: 'set', values: snap(Array.from(v.values()), budget, depth + 1, seen) };
      const out = {};
      const keys = Object.keys(v);
      for (const k of keys.slice(0, LIMITS.keys)) {
        try { out[k] = snap(v[k], budget, depth + 1, seen); } catch { out[k] = { $: 'unreadable' }; }
      }
      if (keys.length > LIMITS.keys) out.$more = keys.length - LIMITS.keys;
      return out;
    } finally {
      seen.delete(v);
    }
  }

  /** The exact structure of a value: types per key, array item shape merged across items, optional keys marked. */
  function shape(v, budget = { n: LIMITS.nodes }, depth = 0, seen = new WeakSet()) {
    if (budget.n-- <= 0) return { t: 'truncated' };
    if (v === null) return { t: 'null' };
    const t = typeof v;
    if (t !== 'object') return { t };
    if (isNode(v)) return { t: 'node' };
    if (isPromise(v)) return { t: 'promise' };
    if (seen.has(v)) return { t: 'circular' };
    if (depth >= LIMITS.depth) return { t: Array.isArray(v) ? 'array' : 'object', deep: true };
    seen.add(v);
    try {
      if (v instanceof Date) return { t: 'date' };
      if (Array.isArray(v)) {
        let item = null;
        for (const x of v.slice(0, 20)) {
          const s = shape(x, budget, depth + 1, seen);
          item = item ? merge(item, s) : s;
        }
        return { t: 'array', len: v.length, item };
      }
      const props = {};
      const keys = Object.keys(v);
      for (const k of keys.slice(0, 150)) {
        try { props[k] = shape(v[k], budget, depth + 1, seen); } catch { props[k] = { t: 'unreadable' }; }
      }
      return { t: 'object', props, n: keys.length };
    } finally {
      seen.delete(v);
    }
  }

  function merge(a, b) {
    if (a.t === 'object' && b.t === 'object') {
      const props = {};
      const keys = new Set([...Object.keys(a.props || {}), ...Object.keys(b.props || {})]);
      for (const k of keys) {
        const x = a.props?.[k];
        const y = b.props?.[k];
        props[k] = x && y ? merge(x, y) : { ...(x || y), opt: true };
        if (x?.opt || y?.opt) props[k].opt = true;
      }
      return { t: 'object', props };
    }
    if (a.t === 'array' && b.t === 'array') return { t: 'array', len: a.len, item: a.item && b.item ? merge(a.item, b.item) : a.item || b.item };
    if (a.t === b.t) return a;
    const parts = [...(a.t === 'union' ? a.of : [a]), ...(b.t === 'union' ? b.of : [b])];
    const of = [];
    for (const p of parts) if (!of.some((q) => q.t === p.t && (p.t !== 'object' || of.length >= 4))) of.push(p);
    return { t: 'union', of: of.slice(0, 6) };
  }

  const SECRET_KEY = /authorization|cookie|token|csrf|api[-_]?key|secret|pzauth|password|session/i;
  const redactObj = (o) => {
    const out = {};
    for (const k of Object.keys(o || {})) out[k] = SECRET_KEY.test(k) ? '[redacted]' : o[k];
    return out;
  };
  const redactUrl = (u) => {
    try {
      const url = new URL(u, G.location?.href);
      for (const k of Array.from(url.searchParams.keys())) if (SECRET_KEY.test(k)) url.searchParams.set(k, '[redacted]');
      return url.toString();
    } catch { return String(u); }
  };

  function callerStack() {
    const lines = (new Error().stack || '').split('\n').slice(1);
    return lines.map((l) => l.trim()).filter((l) => l && !l.includes('/src/hook.js')).slice(0, 8);
  }

  // ---------------------------------------------------------------- event bus
  function post(msg) {
    try { G.postMessage({ __pxr: 1, frame: G.location?.href, ...msg }, '*'); } catch { /* page closing */ }
  }
  function schedule() {
    if (st.timer) return;
    st.timer = setTimeout(() => {
      st.timer = 0;
      if (st.q.length) post({ type: 'events', items: st.q.splice(0) });
    }, FLUSH_MS);
  }
  function emit(ev) {
    if (st.paused) return ev;
    ev.id = ++st.seq;
    ev.t = now();
    st.buf.push(ev);
    if (st.buf.length > MAX_EVENTS) st.buf.splice(0, st.buf.length - MAX_EVENTS);
    st.q.push(ev);
    schedule();
    return ev;
  }
  function patch(ev, p) {
    if (!ev || !ev.id) return;
    Object.assign(ev, p);
    st.q.push({ upd: true, id: ev.id, patch: p });
    schedule();
  }
  function status(p) {
    Object.assign(st.status, p);
    post({ type: 'status', status: st.status });
  }

  // ---------------------------------------------------------------- PConnect / PCore wrapping
  const proxyOf = new WeakMap(); // target -> proxy
  const targetOf = new WeakMap(); // proxy -> target
  const fnCache = new WeakMap(); // original fn -> wrapper
  const labels = new WeakMap(); // pConn -> { ctx, comp }
  const cbMap = new WeakMap(); // original callback -> logging wrapper

  const isPConn = (o) => !!o && typeof o === 'object' && typeof o.getActionsApi === 'function' && typeof o.getValue === 'function';
  function isApiLike(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o) || isNode(o) || isPromise(o)) return false;
    if (o instanceof Date || o instanceof Map || o instanceof Set || o instanceof Error) return false;
    if (isPConn(o)) return true;
    let count = 0;
    for (const k of Object.keys(o)) {
      try { if (typeof o[k] === 'function' && ++count >= 1) return true; } catch { /* getter threw */ }
    }
    const proto = Object.getPrototypeOf(o);
    return !!proto && proto !== Object.prototype && Object.getOwnPropertyNames(proto).some((k) => k !== 'constructor' && typeof proto[k] === 'function');
  }

  function labelOf(pConn) {
    if (!pConn) return null;
    let l = labels.get(pConn);
    if (l) return l;
    l = { ctx: '', comp: '' };
    internal(() => {
      l.ctx = String(pConn.getContextName?.() ?? '');
      const meta = pConn.getRawMetadata?.();
      l.comp = String(meta?.name ?? meta?.type ?? '');
    });
    labels.set(pConn, l);
    return l;
  }

  function wrapCallbacks(method, args) {
    if (/unsubscribe|remove|off$/i.test(method)) return args.map((a) => (typeof a === 'function' && cbMap.get(a)) || a);
    if (!/subscribe|^on[A-Z]|addListener|register/i.test(method)) return args;
    return args.map((a) => {
      if (typeof a !== 'function') return a;
      let w = cbMap.get(a);
      if (!w) {
        w = function (...cbArgs) {
          if (!st.internal) emit({ kind: 'pubsub', name: `${method} callback`, access: 'event', args: snap(cbArgs), argsShape: shape(cbArgs), status: 'ok' });
          return a.apply(this, cbArgs);
        };
        cbMap.set(a, w);
      }
      return w;
    });
  }

  function wrapResult(res, path, owner, depth) {
    if (isPConn(res)) return wrapObject(res, 'pConn', res, depth + 1);
    if (isApiLike(res)) return wrapObject(res, `${path}()`, owner, depth + 1);
    return res;
  }

  function wrapFn(fn, path, owner, depth) {
    let w = fnCache.get(fn);
    if (w) return w;
    const method = path.slice(path.lastIndexOf('.') + 1);
    w = new Proxy(fn, {
      apply(target, thisArg, rawArgs) {
        if (st.internal || st.paused) return Reflect.apply(target, targetOf.get(thisArg) || thisArg, rawArgs);
        const self = targetOf.get(thisArg) || thisArg;
        const args = wrapCallbacks(method, rawArgs);
        const label = owner ? labelOf(owner) : null;
        const parent = st.stack[st.stack.length - 1] || 0;
        const ev = emit({
          kind: owner ? 'pconn' : 'pcore',
          name: path,
          access: classify(method),
          ctx: label?.ctx || '',
          comp: label?.comp || '',
          parent,
          args: snap(rawArgs),
          argsShape: shape(rawArgs),
          status: 'pending',
          stack: callerStack(),
        });
        const t0 = perf();
        st.stack.push(ev.id);
        let res;
        try {
          res = Reflect.apply(target, self, args);
        } catch (err) {
          patch(ev, { status: 'error', error: snap(err), ms: Math.round(perf() - t0) });
          throw err;
        } finally {
          st.stack.pop();
        }
        if (isPromise(res)) {
          res.then(
            (v) => patch(ev, { status: 'ok', result: snap(v), shape: shape(v), ms: Math.round(perf() - t0), async: true }),
            (e) => patch(ev, { status: 'error', error: snap(e), ms: Math.round(perf() - t0), async: true }),
          );
          return res;
        }
        patch(ev, { status: 'ok', result: snap(res), shape: shape(res), ms: Math.round(perf() - t0) });
        return wrapResult(res, path, owner, depth);
      },
    });
    fnCache.set(fn, w);
    return w;
  }

  function wrapObject(target, path, owner, depth = 0) {
    if (depth > 4 || !isApiLike(target)) return target;
    if (targetOf.has(target)) return target; // already a proxy
    const hit = proxyOf.get(target);
    if (hit) return hit;
    const p = new Proxy(target, {
      get(t, prop) {
        const v = Reflect.get(t, prop, t);
        if (typeof prop === 'symbol') return v;
        if (typeof v === 'function') return wrapFn(v, `${path}.${prop}`, owner, depth);
        if (v && typeof v === 'object' && isApiLike(v)) return wrapObject(v, `${path}.${prop}`, owner, depth + 1);
        return v;
      },
    });
    proxyOf.set(target, p);
    targetOf.set(p, target);
    return p;
  }

  /** Patch a PConnect instance in place, so components that already hold it are recorded too. */
  const patched = new WeakSet();
  function patchInstance(pConn) {
    if (!isPConn(pConn) || patched.has(pConn)) return;
    patched.add(pConn);
    const names = new Set();
    for (let o = pConn; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const k of Object.getOwnPropertyNames(o)) if (k !== 'constructor') names.add(k);
    }
    for (const k of names) {
      let v;
      try { v = pConn[k]; } catch { continue; }
      if (typeof v !== 'function') continue;
      try {
        Object.defineProperty(pConn, k, {
          value: wrapFn(v, `pConn.${k}`, pConn, 0),
          configurable: true,
          writable: true,
          enumerable: false,
        });
      } catch { /* frozen: skip */ }
    }
  }

  // PCore: capture the global the moment the runtime assigns it.
  function installPCore() {
    let real = G.PCore;
    let proxy = real ? wrapObject(real, 'PCore', null) : undefined;
    try {
      Object.defineProperty(G, 'PCore', {
        configurable: true,
        enumerable: true,
        get: () => proxy,
        set: (v) => { real = v; proxy = v ? wrapObject(v, 'PCore', null) : v; status({ pcore: !!v }); setTimeout(() => { detectVersion(); status({}); }, 0); watchStore(); },
      });
      if (real) { status({ pcore: true }); setTimeout(() => { detectVersion(); status({}); }, 0); }
    } catch {
      post({ type: 'note', level: 'warn', text: 'window.PCore is locked, so PCore calls cannot be recorded. Network and component views still work.' });
    }
    return () => real;
  }
  const getRealPCore = installPCore();

  /** Which Pega runtime is this? Read defensively: the call is optional and its absence is reported, not an error. */
  function detectVersion() {
    const real = getRealPCore();
    if (!real) return;
    const v = internal(() => (typeof real.getPCoreVersion === 'function' ? real.getPCoreVersion() : undefined));
    st.status.version = v ? String(v) : 'unknown (getPCoreVersion not available)';
    st.status.pcoreMethods = internal(() => Object.keys(real).filter((k) => typeof real[k] === 'function').length, 0);
  }

  // ---------------------------------------------------------------- store: state changes and dispatched actions
  function diff(prev, next, path, out, depth) {
    if (prev === next || out.length >= 25) return;
    if (depth >= 3 || !next || typeof next !== 'object' || !prev || typeof prev !== 'object' || Array.isArray(next)) {
      out.push(path);
      return;
    }
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    for (const k of keys) diff(prev[k], next[k], path ? `${path}.${k}` : k, out, depth + 1);
  }
  const getAt = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

  let storeWatched = false;
  function watchStore() {
    if (storeWatched) return;
    const real = getRealPCore();
    let tries = 0;
    const tick = () => {
      const store = internal(() => real?.getStore?.());
      if (store && typeof store.subscribe === 'function' && typeof store.getState === 'function') {
        storeWatched = true;
        status({ store: true });
        let prev = internal(() => store.getState());
        store.subscribe(() => {
          if (st.paused) return;
          const next = internal(() => store.getState());
          const changed = [];
          diff(prev, next, '', changed, 0);
          prev = next;
          if (!changed.length) return;
          emit({
            kind: 'store', name: `state changed (${changed.length})`, access: 'event', status: 'ok',
            changed,
            result: snap(Object.fromEntries(changed.map((p) => [p, getAt(next, p)])), { n: 1500 }),
            shape: shape(Object.fromEntries(changed.map((p) => [p, getAt(next, p)])), { n: 1500 }),
          });
        });
        if (typeof store.dispatch === 'function') {
          const original = store.dispatch;
          try {
            store.dispatch = function (action) {
              if (!st.paused && !st.internal) {
                emit({ kind: 'store', name: `dispatch ${action?.type ?? '(function)'}`, access: 'write', status: 'ok', args: snap([action]), argsShape: shape([action]), stack: callerStack() });
              }
              return original.apply(this, arguments);
            };
          } catch { /* frozen store */ }
        }
        return;
      }
      if (++tries < 120) setTimeout(tick, 500); // up to a minute while the runtime boots
    };
    tick();
  }
  if (G.PCore) watchStore();

  // ---------------------------------------------------------------- network
  const PEGA_URL = /\/prweb\/|\/PRRestService\/|\/api\/(application\/)?v\d+\/|\/data_views\/|\/assignments\b|\/cases\b|\/attachments\b/;
  function categorize(url) {
    const u = String(url);
    if (/\/data_views\//.test(u)) return 'data-view';
    if (/\/attachments\b/.test(u)) return 'attachment';
    if (/\/assignments\b|\/cases\b|\/actions\b/.test(u)) return 'case';
    if (/\/api\/(application\/)?v\d+\//.test(u)) return 'dx-api';
    if (/\/prweb\/|\/PRRestService\//.test(u)) return 'pega';
    return 'other';
  }
  const textual = (ct) => !ct || /json|text|xml|javascript|x-www-form-urlencoded|graphql/i.test(ct);
  // Pega 26 can stream a data page (Accept: text/event-stream). A stream may never end, so it is read in pieces and capped,
  // instead of waiting for a whole body that might not come.
  const streaming = (ct) => /event-stream|x-ndjson|stream\+json/i.test(ct || '');
  const STREAM_CAP = 1000000; // characters kept of one stream
  const STREAM_MS = 60000; // the longest one stream is followed
  const STREAM_FLUSH_MS = 400; // how often the panel is given what has arrived so far
  // Bodies are kept in full as raw text and sent to the panel in pieces, so a big response is never dropped.
  const PARSE_LIMIT = 8000000; // the largest body parsed into a tree; a bigger one still keeps its full raw text
  const RAW_LIMIT = 30000000; // the longest raw body kept (characters)
  const RAW_BUDGET = 80000000; // all raw bodies kept in the page, oldest dropped first (the panel has its own budget)
  const CHUNK = 2000000; // characters per message
  const rawStore = new Map(); // `${eventId}:${side}` -> { text, truncated }
  let rawTotal = 0;

  function postBody(id, side, text, truncated) {
    const of = Math.max(1, Math.ceil(text.length / CHUNK));
    for (let i = 0; i < of; i++) post({ type: 'body', id, side, part: i, of, truncated, total: text.length, data: text.slice(i * CHUNK, (i + 1) * CHUNK) });
  }
  /** Keeps and sends a request or response body. side is 'req' or 'res'. */
  function sendBody(id, side, text) {
    if (typeof text !== 'string' || st.paused) return;
    const truncated = text.length > RAW_LIMIT;
    const t = truncated ? text.slice(0, RAW_LIMIT) : text;
    rawStore.set(`${id}:${side}`, { text: t, truncated });
    rawTotal += t.length;
    for (const [k, v] of rawStore) {
      if (rawTotal <= RAW_BUDGET) break;
      rawStore.delete(k);
      rawTotal -= v.text.length;
      post({ type: 'body-dropped', key: k });
    }
    postBody(id, side, t, truncated);
  }

  function parseBody(text) {
    if (text == null) return undefined;
    if (typeof text !== 'string') return text;
    if (text.length > PARSE_LIMIT) return `[large body, ${text.length} characters: the Response tab has the full text]`;
    try { return JSON.parse(text); } catch { return text; }
  }

  /** Follows a streamed response through a clone, so the page's own reader is never touched. */
  function followStream(res, ev, base, t0, url) {
    let reader;
    try { reader = res.clone().body.getReader(); } catch { patch(ev, { ...base, result: '[stream not recorded]' }); timingFor(ev, t0, url); return; }
    const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
    let text = '';
    let ended = false;
    let lastFlush = 0;
    let timer = 0;
    const finish = (note) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      try { reader.cancel(); } catch { /* already closed */ }
      patch(ev, { ...base, streaming: false, result: snap(text), shape: shape(text), bytes: text.length, ...(note ? { streamNote: note } : {}) });
      sendBody(ev.id, 'res', text);
      timingFor(ev, t0, url);
    };
    timer = setTimeout(() => finish(`The stream was still open after ${STREAM_MS / 1000} s, so only what arrived by then was recorded.`), STREAM_MS);
    const pump = () => reader.read().then(({ done, value }) => {
      if (ended) return;
      if (done) { finish(); return; }
      text += typeof value === 'string' ? value : decoder ? decoder.decode(value, { stream: true }) : '';
      if (text.length >= STREAM_CAP) { text = text.slice(0, STREAM_CAP); finish(`Only the first ${STREAM_CAP} characters of the stream were recorded.`); return; }
      const now = perf();
      if (now - lastFlush > STREAM_FLUSH_MS) { lastFlush = now; patch(ev, { ...base, streaming: true, result: snap(text), bytes: text.length }); }
      pump();
    }, () => finish());
    patch(ev, { ...base, streaming: true, result: '', bytes: 0 });
    pump();
  }

  const absUrl = (u) => { try { return new URL(u, G.location?.href).href; } catch { return String(u); } };

  /** The browser's own timing for a finished request (the same numbers the Network tab draws), when it exposes them. */
  function timingFor(ev, perf0, url, attempt = 0) {
    setTimeout(() => {
      try {
        if (typeof performance === 'undefined' || typeof performance.getEntriesByName !== 'function') return;
        const entries = performance.getEntriesByName(absUrl(url)).filter((e) => e.startTime >= perf0 - 30).sort((a, b) => a.startTime - b.startTime);
        const e = entries[0];
        if (!e) { if (attempt < 3) timingFor(ev, perf0, url, attempt + 1); return; }
        const r1 = (n) => Math.round(n * 10) / 10;
        const visible = e.responseStart > 0; // zeros mean a cross-origin request without Timing-Allow-Origin
        patch(ev, {
          timing: {
            startMs: r1(e.startTime), totalMs: r1(e.duration), protocol: e.nextHopProtocol || '',
            transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize,
            phases: visible ? {
              stalled: r1(Math.max(0, (e.domainLookupStart || e.fetchStart) - e.startTime)),
              dns: r1(e.domainLookupEnd - e.domainLookupStart),
              connect: r1(e.secureConnectionStart ? e.secureConnectionStart - e.connectStart : e.connectEnd - e.connectStart),
              tls: e.secureConnectionStart ? r1(e.connectEnd - e.secureConnectionStart) : 0,
              waiting: r1(e.responseStart - e.requestStart),
              download: r1(e.responseEnd - e.responseStart),
            } : null,
          },
        });
      } catch { /* timing is best effort */ }
    }, attempt ? 300 : 80);
  }
  function describeBody(b) {
    if (b == null) return undefined;
    if (typeof b === 'string') return parseBody(b);
    if (typeof FormData !== 'undefined' && b instanceof FormData) return Object.fromEntries(Array.from(b.entries()).map(([k, v]) => [k, typeof v === 'string' ? v : `[file ${v.name}, ${v.size} bytes]`]));
    if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return Object.fromEntries(b.entries());
    if (typeof Blob !== 'undefined' && b instanceof Blob) return `[blob ${b.size} bytes]`;
    return `[${Object.prototype.toString.call(b)}]`;
  }
  const headersToObj = (h, keep) => {
    const o = {};
    try {
      if (!h) return o;
      if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => { o[k] = v; });
      else if (Array.isArray(h)) h.forEach(([k, v]) => { o[k] = v; });
      else Object.assign(o, h);
    } catch { /* ignore */ }
    return keep ? o : redactObj(o);
  };
  const parseRawHeaders = (text) => {
    const o = {};
    String(text || '').trim().split(/[\r\n]+/).forEach((line) => { const i = line.indexOf(':'); if (i > 0) o[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); });
    return o;
  };

  function netEvent(method, url, reqHeaders, reqBody, via, reqHeadersFull) {
    const cat = categorize(url);
    const parent = st.stack[st.stack.length - 1] || 0;
    return emit({
      kind: 'net', name: `${method} ${redactUrl(url).replace(/^https?:\/\/[^/]+/, '')}`, access: 'net', status: 'pending', parent,
      net: { via, method, url: redactUrl(url), urlFull: absUrl(url), reqHeadersFull, category: cat, pega: cat !== 'other' || PEGA_URL.test(String(url)), reqHeaders, reqBody: snap(reqBody), reqShape: reqBody === undefined ? undefined : shape(reqBody) },
      stack: callerStack(),
    });
  }

  const origFetch = G.fetch;
  if (typeof origFetch === 'function') {
    G.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      if (st.paused || st.internal) return p;
      try {
        const req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
        const method = String(init?.method || req?.method || 'GET').toUpperCase();
        const url = req ? req.url : String(input?.url ?? input);
        const hdrs = init?.headers || req?.headers;
        const ev = netEvent(method, url, headersToObj(hdrs), describeBody(init?.body), 'fetch', headersToObj(hdrs, true));
        const reqBody = init?.body;
        const reqText = typeof reqBody === 'string' ? reqBody : (typeof URLSearchParams !== 'undefined' && reqBody instanceof URLSearchParams ? String(reqBody) : undefined);
        if (reqText !== undefined) sendBody(ev.id, 'req', reqText);
        const t0 = perf();
        p.then(
          (res) => {
            const ct = res.headers?.get?.('content-type') || '';
            const base = { ms: Math.round(perf() - t0), http: res.status, statusText: res.statusText, status: res.ok ? 'ok' : 'error', resHeaders: headersToObj(res.headers), resHeadersFull: headersToObj(res.headers, true), finalUrl: res.url || undefined, redirected: !!res.redirected, contentType: ct };
            if (!textual(ct)) { patch(ev, { ...base, result: `[${ct || 'binary'} not recorded]` }); timingFor(ev, t0, url); return; }
            if (streaming(ct)) { followStream(res, ev, base, t0, url); return; }
            res.clone().text().then(
              (txt) => { const body = parseBody(txt); patch(ev, { ...base, result: snap(body), shape: shape(body), bytes: txt.length }); sendBody(ev.id, 'res', txt); timingFor(ev, t0, url); },
              () => patch(ev, base),
            );
          },
          (err) => patch(ev, { status: 'error', error: snap(err), ms: Math.round(perf() - t0) }),
        );
      } catch { /* never break the page's request */ }
      return p;
    };
  }

  const XHR = G.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    const setHeader = XHR.prototype.setRequestHeader;
    XHR.prototype.open = function (method, url) {
      this.__pxr = { method: String(method).toUpperCase(), url: String(url), headers: {} };
      return open.apply(this, arguments);
    };
    XHR.prototype.setRequestHeader = function (k, v) {
      if (this.__pxr) this.__pxr.headers[k] = v;
      return setHeader.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      const m = this.__pxr;
      if (m && !st.paused && !st.internal) {
        try {
          const ev = netEvent(m.method, m.url, redactObj(m.headers), describeBody(body), 'xhr', { ...m.headers });
          if (typeof body === 'string') sendBody(ev.id, 'req', body);
          const t0 = perf();
          this.addEventListener('loadend', () => {
            try {
              const ct = this.getResponseHeader('content-type') || '';
              const all = parseRawHeaders(this.getAllResponseHeaders());
              const base = { ms: Math.round(perf() - t0), http: this.status, statusText: this.statusText, status: this.status >= 200 && this.status < 400 ? 'ok' : 'error', contentType: ct, resHeaders: redactObj(all), resHeadersFull: all, finalUrl: this.responseURL || undefined };
              if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json') { patch(ev, { ...base, result: `[${this.responseType} not recorded]` }); timingFor(ev, t0, m.url); return; }
              const raw = this.responseType === 'json' ? this.response : this.responseText;
              const body2 = typeof raw === 'string' ? parseBody(raw) : raw;
              patch(ev, { ...base, result: snap(body2), shape: shape(body2), bytes: typeof raw === 'string' ? raw.length : undefined });
              if (typeof raw === 'string') sendBody(ev.id, 'res', raw);
              else if (raw != null) { try { sendBody(ev.id, 'res', JSON.stringify(raw)); } catch { /* not serialisable */ } }
              timingFor(ev, t0, m.url);
            } catch { /* ignore */ }
          });
        } catch { /* ignore */ }
      }
      return send.apply(this, arguments);
    };
  }

  // ---------------------------------------------------------------- page errors and console warnings
  // Recorded as `issue` events for the Issues view. The page's own handlers and console methods always run unchanged.
  const MAX_ISSUES = 300;
  let issueCount = 0;
  let inConsole = false;
  function issue(level, name, message, extra) {
    if (st.paused || st.internal || issueCount >= MAX_ISSUES) return;
    issueCount++;
    emit({ kind: 'issue', name, level, access: 'event', status: level === 'warn' ? 'ok' : 'error', message: String(message ?? '').slice(0, 800), ...extra });
  }
  const stackLines = (e) => (e && e.stack ? String(e.stack).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 10) : undefined);
  const fmtArg = (a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try { return JSON.stringify(snap(a)); } catch { return String(a); }
  };

  try {
    G.addEventListener('error', (e) => {
      try {
        if (e && e.target && e.target !== G && e.target.tagName) {
          issue('warn', 'Resource failed to load', `${String(e.target.tagName).toLowerCase()} ${e.target.src || e.target.href || ''}`.trim());
          return;
        }
        issue('error', 'Uncaught error', e?.message || 'Script error', { source: e?.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined, stack: stackLines(e?.error), error: e?.error ? snap(e.error) : undefined });
      } catch { /* never break the page */ }
    }, true);
    G.addEventListener('unhandledrejection', (e) => {
      try {
        const r = e?.reason;
        issue('error', 'Unhandled promise rejection', r instanceof Error ? `${r.name}: ${r.message}` : fmtArg(r), { stack: stackLines(r), error: snap(r) });
      } catch { /* never break the page */ }
    });
  } catch { /* no event support here */ }

  for (const level of ['error', 'warn']) {
    const orig = G.console && G.console[level];
    if (typeof orig !== 'function') continue;
    try {
      G.console[level] = function () {
        if (!inConsole) {
          inConsole = true;
          try { issue(level === 'error' ? 'error' : 'warn', `console.${level}`, Array.from(arguments).map(fmtArg).join(' '), { args: snap(Array.from(arguments)), stack: callerStack() }); } catch { /* ignore */ } finally { inConsole = false; }
        }
        return orig.apply(this, arguments);
      };
    } catch { /* console is locked */ }
  }

  // ---------------------------------------------------------------- finding components (React fibers)
  const seenGetters = new WeakSet();
  // React 17+ stores the fiber under __reactFiber$…; React 16 under __reactInternalInstance$…. Both are handled,
  // so the same hook works across the React versions Constellation has shipped with.
  let fiberKey = null;
  let fiberProbes = 0;
  function fiberOf(el) {
    if (!el) return null;
    if (!fiberKey && fiberProbes++ < 800) {
      fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) || null;
      if (fiberKey) st.status.reactMode = fiberKey.startsWith('__reactFiber$') ? 'React 17+' : 'React 16';
    }
    return fiberKey ? el[fiberKey] || null : null;
  }
  function pConnFromFiber(fiber) {
    for (let f = fiber, i = 0; f && i < 60; f = f.return, i++) {
      const g = f.memoizedProps?.getPConnect;
      if (typeof g === 'function') return { getter: g, fiber: f };
    }
    return null;
  }
  function scan(root) {
    let count = 0;
    const visit = (el) => {
      if (count++ > 4000) return;
      const hit = pConnFromFiber(fiberOf(el));
      if (hit && !seenGetters.has(hit.getter)) {
        seenGetters.add(hit.getter);
        const pConn = internal(() => hit.getter());
        if (pConn) { st.status.react = true; patchInstance(pConn); }
      }
    };
    const walk = (r) => {
      if (r.nodeType === 1) visit(r);
      const all = r.querySelectorAll ? r.querySelectorAll('*') : [];
      for (let i = 0; i < all.length && count < 4000; i++) {
        visit(all[i]);
        if (all[i].shadowRoot) walk(all[i].shadowRoot); // web-component hosts used by some Constellation builds
      }
    };
    walk(root);
  }

  function startScanning() {
    if (typeof MutationObserver === 'undefined' || !G.document) return;
    const run = (roots) => { try { roots.forEach(scan); status({ react: st.status.react }); } catch { /* ignore */ } };
    let pending = new Set();
    let timer = 0;
    const mo = new MutationObserver((records) => {
      for (const r of records) r.addedNodes.forEach((n) => { if (n.nodeType === 1) pending.add(n); });
      if (timer) return;
      timer = setTimeout(() => { timer = 0; const roots = Array.from(pending); pending = new Set(); run(roots); }, 300);
    });
    const begin = () => { run([document.documentElement]); mo.observe(document.documentElement, { childList: true, subtree: true }); };
    if (document.documentElement) begin();
    else document.addEventListener('DOMContentLoaded', begin, { once: true });
  }
  startScanning();

  /** Everything a component knows right now, for the Component tab. Reads only; nothing is recorded or changed. */
  function inspectElement(el) {
    const hit = pConnFromFiber(fiberOf(el));
    if (!hit) return { found: false, reason: 'No Constellation component found at or above this element.' };
    return internal(() => {
      const pConn = hit.getter();
      patchInstance(pConn);
      const read = (name, ...a) => { try { return typeof pConn[name] === 'function' ? pConn[name](...a) : undefined; } catch (e) { return { $: 'error', message: String(e?.message || e) }; } };
      const meta = read('getRawMetadata');
      const out = {
        component: meta?.name ?? meta?.type,
        contextName: read('getContextName'),
        pageReference: read('getPageReference'),
        currentView: read('getCurrentView'),
        caseInfo: read('getCaseInfo'),
        rawMetadata: meta,
        configProps: read('getConfigProps'),
        stateProps: read('getStateProps'),
        childCount: (() => { const c = read('getChildren'); return Array.isArray(c) ? c.length : undefined; })(),
        reactProps: Object.keys(hit.fiber.memoizedProps || {}),
      };
      // Added in Pega 26.1: left out on older versions, where there is nothing to read.
      const dataInfo = read('getDataInfo');
      if (dataInfo !== undefined) out.dataInfo = dataInfo;
      const relativePath = read('getRelativePath');
      if (relativePath !== undefined) out.relativePath = relativePath;
      return { found: true, data: snap(out, { n: 6000 }), shape: shape(out, { n: 6000 }) };
    }, { found: false, reason: 'Could not read this component.' });
  }

  function listComponents() {
    const rows = [];
    const seen = new WeakSet();
    const all = G.document ? document.querySelectorAll('*') : [];
    for (let i = 0; i < all.length && i < 8000; i++) {
      const hit = pConnFromFiber(fiberOf(all[i]));
      if (!hit || seen.has(hit.getter)) continue;
      seen.add(hit.getter);
      internal(() => {
        const p = hit.getter();
        const meta = p?.getRawMetadata?.();
        rows.push({ component: meta?.name ?? meta?.type ?? '?', context: p?.getContextName?.() ?? '', tag: all[i].nodeName.toLowerCase(), classes: String(all[i].className || '').slice(0, 60) });
      });
    }
    return rows;
  }

  // ---------------------------------------------------------------- views: the mounted components as a tree, and the page picker
  const allElements = () => (G.document ? Array.from(document.querySelectorAll('*')) : []);
  const componentName = (el) => internal(() => {
    const hit = pConnFromFiber(fiberOf(el));
    if (!hit) return '';
    const meta = hit.getter()?.getRawMetadata?.();
    return String(meta?.name ?? meta?.type ?? '');
  }, '');

  /**
   * The components on the page as a flat list. Each one's nearest ancestor component is its parent, so the panel can nest them
   * into views, regions and fields. Reads only. Components inside closed shadow roots are not reached (same as listComponents).
   */
  function viewTree() {
    const all = allElements();
    const nodes = [];
    const byEl = new Map();
    const seen = new WeakSet();
    for (let i = 0; i < all.length && i < 8000; i++) {
      const hit = pConnFromFiber(fiberOf(all[i]));
      if (!hit || seen.has(hit.getter)) continue;
      seen.add(hit.getter);
      internal(() => {
        const p = hit.getter();
        const meta = p?.getRawMetadata?.();
        const cfg = p?.getConfigProps?.();
        const node = {
          id: nodes.length + 1, parentId: null, index: i,
          component: String(meta?.name ?? meta?.type ?? '?'),
          type: meta?.type != null ? String(meta.type) : '',
          context: String(p?.getContextName?.() ?? ''),
          pageReference: String(p?.getPageReference?.() ?? ''),
          label: typeof cfg?.label === 'string' ? cfg.label.slice(0, 80) : '',
          configKeys: cfg && typeof cfg === 'object' ? Object.keys(cfg).length : 0,
          tag: String(all[i].nodeName || '').toLowerCase(),
        };
        nodes.push(node);
        byEl.set(all[i], node);
      });
    }
    for (const n of nodes) {
      let p = all[n.index].parentElement;
      while (p && !byEl.has(p)) p = p.parentElement || (p.getRootNode ? p.getRootNode().host : null) || null;
      if (p) n.parentId = byEl.get(p).id;
    }
    return nodes;
  }
  /** Everything a component knows, by its position in the page's element list (from viewTree). */
  function inspectIndex(i) {
    const el = allElements()[i];
    return el ? inspectElement(el) : { found: false, reason: 'That element is no longer on the page.' };
  }

  // A highlight box and label drawn over the page, in a closed shadow root so the page's own CSS cannot touch it.
  let overlay = null;
  function ensureOverlay() {
    if (overlay || !G.document || !document.documentElement) return overlay;
    const host = document.createElement('div');
    host.setAttribute('data-lens-overlay', '');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    const root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;box-sizing:border-box;border:2px solid #2563eb;background:rgba(37,99,235,.16);border-radius:3px;pointer-events:none;display:none';
    const tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;font:12px/1.4 system-ui,sans-serif;color:#fff;background:#1e3a8a;padding:3px 8px;border-radius:4px;pointer-events:none;display:none;max-width:60vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    root.append(box, tip);
    document.documentElement.append(host);
    overlay = { box, tip };
    return overlay;
  }
  function place(el, text) {
    const o = ensureOverlay();
    if (!o || !el || !el.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    Object.assign(o.box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    if (text) {
      o.tip.textContent = text;
      Object.assign(o.tip.style, { display: 'block', left: `${Math.max(0, r.left)}px`, top: `${r.top > 28 ? r.top - 26 : r.bottom + 4}px` });
    } else o.tip.style.display = 'none';
  }
  function hideOverlay() { if (overlay) { overlay.box.style.display = 'none'; overlay.tip.style.display = 'none'; } }
  /** Scroll a component into view and outline it for a moment. */
  function highlight(i) {
    const el = allElements()[i];
    if (!el) return false;
    try { el.scrollIntoView?.({ block: 'center', inline: 'nearest' }); } catch { /* ignore */ }
    place(el, componentName(el));
    setTimeout(hideOverlay, 1600);
    return true;
  }

  // The picker: hover to outline the component under the pointer, click to choose it (the click does not reach the page), Escape to cancel.
  let picker = null;
  function stopPicker() {
    if (!picker) return;
    for (const [t, f] of picker.handlers) document.removeEventListener(t, f, true);
    picker = null;
    hideOverlay();
  }
  function startPicker() {
    if (!G.document) return false;
    stopPicker();
    let target = null;
    const swallow = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
    const move = (e) => { target = e.target; const name = componentName(target); place(target, name || 'no component here'); };
    const click = (e) => {
      swallow(e);
      const t = target || e.target;
      const index = allElements().indexOf(t);
      const result = inspectElement(t);
      stopPicker();
      post({ type: 'picked', index, name: componentName(t), result });
    };
    const key = (e) => { if (e.key === 'Escape') { swallow(e); stopPicker(); post({ type: 'picked', cancelled: true }); } };
    const handlers = [['mousemove', move], ['click', click], ['keydown', key], ['mousedown', swallow], ['mouseup', swallow], ['pointerdown', swallow], ['pointerup', swallow], ['touchstart', swallow], ['contextmenu', swallow]];
    for (const [t, f] of handlers) document.addEventListener(t, f, true);
    picker = { handlers };
    return true;
  }

  // ---------------------------------------------------------------- commands from the panel
  G.addEventListener?.('message', (e) => {
    const c = e.source === G && e.data && e.data.__pxr_cmd;
    if (!c) return;
    if (c.cmd === 'replay') {
      post({ type: 'status', status: st.status });
      for (let i = 0; i < st.buf.length; i += 200) post({ type: 'events', items: st.buf.slice(i, i + 200), replay: true });
      for (const [k, v] of rawStore) { const i = k.indexOf(':'); postBody(Number(k.slice(0, i)), k.slice(i + 1), v.text, v.truncated); }
    } else if (c.cmd === 'clear') { st.buf.length = 0; st.q.length = 0; rawStore.clear(); rawTotal = 0; }
    else if (c.cmd === 'pause') st.paused = true;
    else if (c.cmd === 'resume') st.paused = false;
    else if (c.cmd === 'rescan') { scan(document.documentElement); status({ react: st.status.react }); }
  });

  G.__pegaXray = { version: '0.3.3', inspectElement, listComponents, viewTree, inspectIndex, highlight, startPicker, stopPicker, state: st, _snap: snap, _shape: shape };
  post({ type: 'status', status: st.status });
})();
