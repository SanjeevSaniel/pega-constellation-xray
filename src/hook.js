/* Constellation Lens: page-world hook.
 *
 * Records what a Pega Constellation page does through PCore, PConnect, the Redux-style store and the network:
 * the call, its arguments, what came back (data and exact shape), how long it took, and who called it.
 *
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
  const WRITE_RE = /^(set|update|trigger|open|save|create|refresh|close|dispatch|invoke|run|show|navigate|publish|notify|clear|accept|ignore|delete|submit|validate|add|remove|reset)/i;
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
  const MAX_BODY = 300000;

  function parseBody(text) {
    if (text == null) return undefined;
    if (typeof text !== 'string') return text;
    if (text.length > MAX_BODY) return `[body larger than ${MAX_BODY} characters, not recorded]`;
    try { return JSON.parse(text); } catch { return text; }
  }
  function describeBody(b) {
    if (b == null) return undefined;
    if (typeof b === 'string') return parseBody(b);
    if (typeof FormData !== 'undefined' && b instanceof FormData) return Object.fromEntries(Array.from(b.entries()).map(([k, v]) => [k, typeof v === 'string' ? v : `[file ${v.name}, ${v.size} bytes]`]));
    if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return Object.fromEntries(b.entries());
    if (typeof Blob !== 'undefined' && b instanceof Blob) return `[blob ${b.size} bytes]`;
    return `[${Object.prototype.toString.call(b)}]`;
  }
  const headersToObj = (h) => {
    const o = {};
    try {
      if (!h) return o;
      if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => { o[k] = v; });
      else if (Array.isArray(h)) h.forEach(([k, v]) => { o[k] = v; });
      else Object.assign(o, h);
    } catch { /* ignore */ }
    return redactObj(o);
  };

  function netEvent(method, url, reqHeaders, reqBody, via) {
    const cat = categorize(url);
    const parent = st.stack[st.stack.length - 1] || 0;
    return emit({
      kind: 'net', name: `${method} ${redactUrl(url).replace(/^https?:\/\/[^/]+/, '')}`, access: 'net', status: 'pending', parent,
      net: { via, method, url: redactUrl(url), category: cat, pega: cat !== 'other' || PEGA_URL.test(String(url)), reqHeaders, reqBody: snap(reqBody), reqShape: reqBody === undefined ? undefined : shape(reqBody) },
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
        const ev = netEvent(method, url, headersToObj(init?.headers || req?.headers), describeBody(init?.body), 'fetch');
        const t0 = perf();
        p.then(
          (res) => {
            const ct = res.headers?.get?.('content-type') || '';
            const base = { ms: Math.round(perf() - t0), http: res.status, statusText: res.statusText, status: res.ok ? 'ok' : 'error', resHeaders: headersToObj(res.headers), contentType: ct };
            if (!textual(ct)) return patch(ev, { ...base, result: `[${ct || 'binary'} not recorded]` });
            res.clone().text().then(
              (txt) => { const body = parseBody(txt); patch(ev, { ...base, result: snap(body), shape: shape(body), bytes: txt.length }); },
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
          const ev = netEvent(m.method, m.url, redactObj(m.headers), describeBody(body), 'xhr');
          const t0 = perf();
          this.addEventListener('loadend', () => {
            try {
              const ct = this.getResponseHeader('content-type') || '';
              const base = { ms: Math.round(perf() - t0), http: this.status, statusText: this.statusText, status: this.status >= 200 && this.status < 400 ? 'ok' : 'error', contentType: ct };
              if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json') return patch(ev, { ...base, result: `[${this.responseType} not recorded]` });
              const raw = this.responseType === 'json' ? this.response : this.responseText;
              const body2 = typeof raw === 'string' ? parseBody(raw) : raw;
              patch(ev, { ...base, result: snap(body2), shape: shape(body2) });
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

  // ---------------------------------------------------------------- commands from the panel
  G.addEventListener?.('message', (e) => {
    const c = e.source === G && e.data && e.data.__pxr_cmd;
    if (!c) return;
    if (c.cmd === 'replay') {
      post({ type: 'status', status: st.status });
      for (let i = 0; i < st.buf.length; i += 200) post({ type: 'events', items: st.buf.slice(i, i + 200), replay: true });
    } else if (c.cmd === 'clear') { st.buf.length = 0; st.q.length = 0; }
    else if (c.cmd === 'pause') st.paused = true;
    else if (c.cmd === 'resume') st.paused = false;
    else if (c.cmd === 'rescan') { scan(document.documentElement); status({ react: st.status.react }); }
  });

  G.__pegaXray = { version: '0.1.0', inspectElement, listComponents, state: st, _snap: snap, _shape: shape };
  post({ type: 'status', status: st.status });
})();
