/* Lens: the panel's pure logic.
 *
 * Plain-English explanations, the data-call reader, the issue finder and the copy-ready reports. No DOM and no chrome.*
 * in here, so the panel and the tests (test/report.mjs) use the same code.
 * Everything it reads comes from events recorded by src/hook.js; nothing here assumes more about Pega than the hook saw.
 */
(function (root) {
  'use strict';

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const isMeta = (v) => !!v && typeof v === 'object' && '$' in v;
  const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && !isMeta(v);
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtTime = (t) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`; };

  const KIND = { pcore: 'PCore', pconn: 'PConnect', net: 'Network', store: 'Store', pubsub: 'Event', nav: 'Page', issue: 'Page error' };

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

  const labelCategory = (c) => ({ 'data-view': 'data view', case: 'case or assignment', attachment: 'attachment', 'dx-api': 'DX API', pega: 'Pega server', other: 'not recognised as Pega' }[c] || 'other');

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

  /** Plain-English lines for one event. `bad` is true when the first line describes a failure. */
  function explain(ev) {
    const lines = [];
    let bad = false;
    const who = ev.comp ? `The ${ev.comp} component${ev.ctx ? ` (context ${ev.ctx})` : ''}` : 'Your code or the Pega runtime';
    if (ev.kind === 'nav') return { lines: [ev.name], bad };
    if (ev.kind === 'issue') {
      bad = ev.level !== 'warn';
      lines.push(`${ev.name}${ev.message ? `: ${ev.message}` : ''}.`);
      if (ev.source) lines.push(`Reported at ${ev.source}.`);
      return { lines, bad };
    }
    if (ev.kind === 'net') {
      const n = ev.net || {};
      let path = '';
      try { path = n.url ? new URL(n.url, 'http://x').pathname : ''; } catch { path = n.url || ''; }
      lines.push(`${n.method} request to ${path} (${labelCategory(n.category)}).`);
      if (ev.status === 'pending') lines.push('Still waiting for the response.');
      else if (ev.status === 'error' && ev.http == null) { bad = true; lines.push('The request never got a response (network error, blocked or cancelled).'); }
      else {
        bad = ev.status === 'error';
        if (ev.streaming) lines.push(`Answered HTTP ${ev.http} as a stream that is still open. What is shown has arrived so far${ev.bytes ? ` (${(ev.bytes / 1024).toFixed(1)} KB)` : ''}.`);
        else if (ev.streamNote) lines.push(`Answered HTTP ${ev.http} as a stream. ${ev.streamNote}`);
        else lines.push(`Answered HTTP ${ev.http} in ${ev.ms} ms with ${describeShape(ev.shape)}${ev.bytes ? ` (${(ev.bytes / 1024).toFixed(1)} KB)` : ''}.`);
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
      if (ev.access === 'data' && rowCount(ev) === 0) lines.push('No rows came back. Check the data page name, its parameters, and the context passed.');
    }
    return { lines, bad };
  }

  // ------------------------------------------------------------------ data calls (inputs and outputs)

  /** Rows the call returned: a list, or the `data` list of an object. Undefined when the result is not row-shaped. */
  function rowsOf(result) {
    if (Array.isArray(result)) return result;
    if (isPlain(result) && Array.isArray(result.data)) return result.data;
    return undefined;
  }
  /** The real row count comes from the recorded shape, because the recorded rows are capped. */
  function rowCount(ev) {
    const s = ev.shape;
    if (!s) return undefined;
    if (s.t === 'array') return s.len;
    if (s.t === 'object' && s.props?.data?.t === 'array') return s.props.data.len;
    return undefined;
  }
  function itemShape(ev) {
    const s = ev.shape;
    if (!s) return undefined;
    if (s.t === 'array') return s.item;
    if (s.t === 'object' && s.props?.data?.t === 'array') return s.props.data.item;
    return undefined;
  }
  const typeName = (s) => (!s ? 'unknown' : s.t === 'union' ? s.of.map(typeName).join(' | ') : s.t === 'array' ? `${typeName(s.item)}[]` : s.t);
  /** The columns of the rows returned, with their types and whether any row lacked them. */
  function columnsOf(ev) {
    const item = itemShape(ev);
    if (!item || item.t !== 'object') return [];
    return Object.entries(item.props || {}).map(([name, s]) => ({ name, type: typeName(s), optional: !!s.opt }));
  }

  /** Is this event a call to load data? Network calls to a data view count only when no recorded data call started them. */
  function isDataCall(ev, parentEv) {
    if (ev.kind === 'pcore' || ev.kind === 'pconn') return ev.access === 'data';
    if (ev.kind === 'net') return ev.net?.category === 'data-view' && !(parentEv && parentEv.access === 'data');
    return false;
  }

  const NAME_KEY = /^(data(page|view)?(name)?|name|viewname|datapage|dataview)$/i;
  const PARAM_KEY = /param/i;
  const looksLikeContext = (s) => typeof s === 'string' && /^[\w-]+\/[\w-]+/.test(s);

  /**
   * Reads a data call's input. The names are a best guess from the arguments (Lens does not know Pega's signatures),
   * so the panel labels them as such and always shows the raw arguments too.
   */
  function dataInfo(ev) {
    const out = { name: '', parameters: undefined, context: '', other: [], guessed: true };
    if (ev.kind === 'net') {
      const m = /\/data_views\/([^/?#]+)/.exec(ev.net?.url || '');
      out.name = m ? decodeURIComponent(m[1]) : '';
      out.parameters = ev.net?.reqBody;
      out.guessed = false;
      return out;
    }
    const args = Array.isArray(ev.args) ? ev.args : [];
    const used = new Set();
    const firstString = args.findIndex((a) => typeof a === 'string' && !looksLikeContext(a));
    if (firstString >= 0) { out.name = args[firstString]; used.add(firstString); }
    args.forEach((a, i) => {
      if (used.has(i)) return;
      if (isPlain(a)) {
        const nameKey = Object.keys(a).find((k) => NAME_KEY.test(k) && typeof a[k] === 'string');
        if (!out.name && nameKey) { out.name = a[nameKey]; }
        const paramKey = Object.keys(a).find((k) => PARAM_KEY.test(k));
        if (paramKey && out.parameters === undefined) { out.parameters = a[paramKey]; used.add(i); return; }
        if (out.parameters === undefined && i > firstString) { out.parameters = a; used.add(i); return; }
      }
      if (!out.context && looksLikeContext(a)) { out.context = a; used.add(i); }
    });
    args.forEach((a, i) => { if (!used.has(i)) out.other.push({ position: i + 1, value: a }); });
    return out;
  }

  /** The HTTP requests a call started (recorded as its children), so the Network tab is not needed. */
  function networkOf(ev, events) {
    const out = [];
    const walk = (parent, depth) => {
      for (const e of events) {
        if (e.frameId === parent.frameId && e.parent === parent.id && e !== parent) {
          if (e.kind === 'net') out.push(e);
          else if (depth < 3) walk(e, depth + 1);
        }
      }
    };
    walk(ev, 0);
    return out;
  }

  // ------------------------------------------------------------------ issues

  const isFailed = (ev) => ev.status === 'error' || (ev.http != null && ev.http >= 400);

  /**
   * Everything worth a look, newest first: failed calls, page errors, stalled and slow calls, empty data, loops.
   * Each has a stable `id` so a list can keep its place while new ones arrive.
   */
  function findings(events, now = Date.now()) {
    const out = [];
    const dup = new Map();
    for (const ev of events) {
      if (ev.kind === 'nav') continue;
      if (ev.kind === 'issue') {
        out.push({ id: `p:${ev.key}`, level: ev.level === 'warn' ? 'warn' : 'bad', type: ev.level === 'warn' ? 'console-warning' : 'page-error', ev, text: `${ev.name}${ev.message ? `: ${ev.message}` : ''}` });
        continue;
      }
      if (isFailed(ev)) out.push({ id: `f:${ev.key}`, level: 'bad', type: 'failed', ev, text: `${ev.name} failed${ev.http ? ` with HTTP ${ev.http}` : ''}${ev.error?.message ? `: ${ev.error.message}` : ''}` });
      else if (ev.status === 'pending' && now - ev.t > 5000) out.push({ id: `w:${ev.key}`, level: 'warn', type: 'stalled', ev, text: `${ev.name} has been waiting for ${Math.round((now - ev.t) / 1000)} s with no answer` });
      else if (ev.ms > 3000) out.push({ id: `s:${ev.key}`, level: 'warn', type: 'slow', ev, text: `${ev.name} was slow: ${ev.ms} ms` });
      else if (ev.access === 'data' && ev.status === 'ok' && rowCount(ev) === 0) out.push({ id: `e:${ev.key}`, level: 'info', type: 'empty', ev, text: `${ev.name} returned no rows` });
      if (ev.access !== 'read' && ev.kind !== 'store' && ev.kind !== 'pubsub' && ev.kind !== 'issue') {
        const k = `${ev.frameId}|${ev.name}|${JSON.stringify(ev.args)?.slice(0, 200)}`;
        const g = dup.get(k) || { ev, n: 0, first: ev.t, last: ev.t };
        g.n++; g.last = ev.t; dup.set(k, g);
      }
    }
    for (const g of dup.values()) {
      if (g.n >= 5 && g.last - g.first < 4000) out.push({ id: `l:${g.ev.key}`, level: 'warn', type: 'loop', ev: g.ev, text: `${g.ev.name} ran ${g.n} times in ${((g.last - g.first) / 1000).toFixed(1)} s with identical input (a loop or a re-render storm?)` });
    }
    return out.reverse().slice(0, 300);
  }

  // ------------------------------------------------------------------ copy-ready reports

  const LEVEL_WORD = { bad: 'Error', warn: 'Check', info: 'Note' };
  const MAX_BLOCK = 6000;
  function block(label, value, view, lang = 'json') {
    if (value === undefined) return '';
    let text;
    try { text = typeof value === 'string' ? value : JSON.stringify(view(value), null, 2); } catch { text = String(value); }
    if (text === undefined) return '';
    const cut = text.length > MAX_BLOCK ? `${text.slice(0, MAX_BLOCK)}\n… (${text.length - MAX_BLOCK} more characters not copied)` : text;
    return `\n**${label}**\n\n\`\`\`${lang}\n${cut}\n\`\`\`\n`;
  }

  /**
   * One issue as Markdown, ready to paste into a ticket or a chat.
   * opts: { view } masks values (the Hide values switch); { events } adds the HTTP calls it started.
   */
  function issueMarkdown(f, opts = {}) {
    const view = opts.view || ((v) => v);
    const ev = f.ev;
    const lines = [];
    lines.push(`### ${LEVEL_WORD[f.level] || 'Issue'}: ${f.text}`);
    lines.push('');
    lines.push(`- Time: ${new Date(ev.t).toISOString()}`);
    lines.push(`- Type: ${KIND[ev.kind] || ev.kind}`);
    if (ev.ms != null) lines.push(`- Duration: ${ev.ms} ms`);
    if (ev.comp) lines.push(`- Component: ${ev.comp}`);
    if (ev.ctx) lines.push(`- Context: ${ev.ctx}`);
    if (ev.net) { lines.push(`- Request: ${ev.net.method} ${ev.net.url}`); lines.push(`- HTTP: ${ev.http != null ? `${ev.http} ${ev.statusText || ''}`.trim() : 'no response'}`); }
    if (ev.frameUrl) lines.push(`- Frame: ${ev.frameUrl}`);
    const say = explain(ev).lines;
    if (say.length) { lines.push('', '**What happened**', '', ...say.map((l) => `- ${l}`)); }
    let md = lines.join('\n') + '\n';
    if (ev.kind === 'net') md += block('Request body', ev.net?.reqBody, view);
    else if (ev.kind !== 'issue') md += block('Input (arguments)', ev.args, view);
    if (ev.error) md += block('Error', ev.error, view);
    if (ev.kind === 'issue' && ev.message) md += block('Message', ev.message, view, 'text');
    if (ev.status !== 'pending' && ev.result !== undefined) md += block(ev.kind === 'net' ? 'Response body' : 'Output', ev.result, view);
    if (opts.events) {
      const nets = networkOf(ev, opts.events);
      if (nets.length) md += `\n**HTTP requests it made**\n\n${nets.map((n) => `- ${n.net.method} ${n.net.url} → ${n.http != null ? n.http : 'no response'} in ${n.ms ?? '?'} ms`).join('\n')}\n`;
    }
    if (ev.stack?.length) md += block('Call stack', ev.stack.join('\n'), view, 'text');
    return md;
  }

  /** The whole list as Markdown with a short header (tool, page, time, whether values are hidden). */
  function issuesMarkdown(list, meta = {}, opts = {}) {
    const bad = list.filter((f) => f.level === 'bad').length;
    const warn = list.filter((f) => f.level === 'warn').length;
    const head = [
      `# Lens: issues`,
      '',
      `- Tool: ${meta.tool || 'Lens'}${meta.version ? ` ${meta.version}` : ''}`,
      meta.origin ? `- Page: ${meta.origin}` : '',
      meta.runtime ? `- Pega runtime: ${meta.runtime}` : '',
      `- Copied: ${new Date(meta.now || Date.now()).toISOString()}`,
      `- Values hidden: ${meta.valuesHidden ? 'yes' : 'no'}`,
      `- Found: ${plural(bad, 'error')}, ${plural(warn, 'check')}, ${plural(list.length - bad - warn, 'note')}`,
    ].filter((l) => l !== '');
    return `${head.join('\n')}\n\n${list.map((f) => issueMarkdown(f, opts)).join('\n---\n\n')}`;
  }

  /** The same list as JSON for tools. Values go through `view`, so Hide values applies. */
  function issuesJson(list, meta = {}, opts = {}) {
    const view = opts.view || ((v) => v);
    return {
      tool: meta.tool || 'Lens',
      version: meta.version,
      origin: meta.origin,
      runtime: meta.runtime,
      copiedAt: new Date(meta.now || Date.now()).toISOString(),
      valuesHidden: !!meta.valuesHidden,
      issues: list.map((f) => ({
        level: f.level, type: f.type, text: f.text,
        event: view({ ...f.ev, stack: f.ev.stack }),
        network: opts.events ? networkOf(f.ev, opts.events).map((n) => ({ method: n.net.method, url: n.net.url, http: n.http, ms: n.ms })) : undefined,
      })),
    };
  }

  // ------------------------------------------------------------------ views

  /** Nests the recorder's flat component list into a tree by parentId. With a filter it keeps the matches and their ancestors. */
  function nestViews(flat, q = '', opts = {}) {
    const byId = new Map(flat.map((n) => [n.id, { ...n, children: [], match: true, forceOpen: false }]));
    const roots = [];
    for (const n of byId.values()) {
      const parent = n.parentId != null ? byId.get(n.parentId) : null;
      if (parent && parent !== n) parent.children.push(n); else roots.push(n);
    }
    // Containers only: drop the components that hold nothing (the leaves), so views inside views stand out. Roots always stay.
    const strip = (list) => list.map((n) => ({ ...n, children: strip(n.children.filter((c) => c.children.length > 0)) }));
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return opts.containersOnly ? strip(roots) : roots;
    const hay = (n) => `${n.component} ${n.type} ${n.label} ${n.context} ${n.pageReference}`.toLowerCase();
    const prune = (list) => list.flatMap((n) => {
      const kids = prune(n.children);
      const self = hay(n).includes(needle);
      if (!self && !kids.length) return [];
      return [{ ...n, children: kids, match: self, forceOpen: kids.length > 0 }];
    });
    const found = prune(roots);
    return opts.containersOnly ? strip(found) : found;
  }
  /** The names from the outermost component down to the one with this id, for a breadcrumb. */
  function viewPath(flat, id) {
    const byId = new Map(flat.map((n) => [n.id, n]));
    const out = [];
    for (let n = byId.get(id), i = 0; n && i < 60; n = n.parentId != null ? byId.get(n.parentId) : null, i++) out.unshift(n.component);
    return out;
  }
  const countViews = (roots) => roots.reduce((n, r) => n + 1 + countViews(r.children), 0);

  // ---------------------------------------------------------------- how far Lens has been checked against each Pega version
  /**
   * Says, in plain words, how far Lens has been checked against a Pega version. It claims only what was done: it ran live on
   * Pega 24.2.5 (PCore 24.2.5, React 17+). Pega 25.1 and 26.1 were checked by comparing the published PCore and PConnect typings
   * with the calls Lens reads, not by running it on a live app. `level` is 'live', 'typings', 'unknown' or 'untested'.
   */
  function supportNote(version) {
    const m = /^(\d+)\.(\d+)/.exec(String(version || ''));
    if (!m) return { level: 'unknown', text: 'Lens could not read the Pega version, so it cannot say how far it has been checked on this app.' };
    const major = Number(m[1]);
    if (major === 24) return { level: 'live', text: 'Run live on Pega 24.2.5. This is the release line it was verified on.' };
    if (major === 25) return { level: 'typings', text: 'Should work on Pega 25. Lens was run live on 24.2.5, and the Pega 25.1 PCore and PConnect typings show every call it reads is still there. Check it once: if a line above is not green, use Copy diagnostics.' };
    if (major === 26) return { level: 'typings', text: 'Should work on Pega 26. Lens was run live on 24.2.5, and the Pega 26.1 PCore and PConnect typings show every call it reads is still there, and streamed data pages are handled. Check it once: if a line above is not green, use Copy diagnostics.' };
    return { level: 'untested', text: `Lens has not been checked on Pega ${m[1]}.${m[2]}. It reads PCore and PConnect by what they expose, so it may still work: use Health to see what attached.` };
  }

  // ---------------------------------------------------------------- TypeScript types and mock data from what was recorded
  const pascal = (s) => {
    const name = String(s).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('') || 'Item';
    return /^\d/.test(name) ? `T${name}` : name;
  };
  const isIdent = (k) => /^[A-Za-z_$][\w$]*$/.test(k);
  const propKey = (k) => (isIdent(k) ? k : JSON.stringify(k));

  /**
   * TypeScript for a recorded shape: one named `export interface` per object, children first and the root last, so the text can be
   * pasted into a file as it is. Optional keys (missing in some items) get a `?`. A key can only be optional if the recording
   * showed an item without it, so the types are a good starting point, not a guarantee. Shapes the hook cut short become unknown.
   */
  function typesFrom(shape, rootName = 'Root') {
    const decls = [];
    const used = new Set();
    const claim = (want) => {
      const base = pascal(want);
      let name = base;
      let i = 2;
      while (used.has(name)) name = `${base}${i++}`;
      used.add(name);
      return name;
    };
    const ref = (s, hint) => {
      if (!s) return 'unknown';
      switch (s.t) {
        case 'object': {
          if (s.deep) return 'Record<string, unknown>';
          const keys = Object.keys(s.props || {});
          if (!keys.length) return s.n ? 'Record<string, unknown>' : 'Record<string, never>';
          const name = claim(hint);
          const lines = keys.map((k) => `  ${propKey(k)}${s.props[k].opt ? '?' : ''}: ${ref(s.props[k], name + pascal(k))};`);
          const more = s.n > keys.length ? `\n  // …and ${s.n - keys.length} more keys, not shown` : '';
          decls.push(`export interface ${name} {\n${lines.join('\n')}${more}\n}`);
          return name;
        }
        case 'array': {
          if (!s.item) return 'unknown[]';
          const inner = ref(s.item, `${hint}Item`);
          return /[|&(]/.test(inner) ? `(${inner})[]` : `${inner}[]`;
        }
        case 'union': {
          const parts = [];
          s.of.forEach((x, i) => { const t = ref(x, i ? `${hint}Variant${i + 1}` : hint); if (!parts.includes(t)) parts.push(t); });
          parts.sort((a, b) => (a === 'null') - (b === 'null')); // null last, the way it is usually written
          return parts.join(' | ');
        }
        case 'string': case 'number': case 'boolean': case 'bigint': case 'symbol': case 'undefined': return s.t;
        case 'null': return 'null';
        case 'date': return 'Date';
        case 'function': return '(...args: unknown[]) => unknown';
        case 'promise': return 'Promise<unknown>';
        default: return 'unknown'; // node, circular, truncated
      }
    };
    const top = ref(shape, rootName);
    if (!decls.length || !decls[decls.length - 1].startsWith(`export interface ${top} `)) decls.push(`export type ${claim(rootName)} = ${top};`);
    return decls.join('\n\n');
  }

  const SECRET_KEY = /authorization|cookie|token|csrf|api[-_]?key|secret|pzauth|password|session/i;

  /** A value as TypeScript source. The hook's markers (a cut-off list, a function) become comments or placeholders. */
  function source(v, indent = 0) {
    const pad = '  '.repeat(indent);
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v !== 'object') return String(v);
    if (isMeta(v)) return v.$ === 'fn' ? '() => undefined' : v.$ === 'undefined' ? 'undefined' : 'null /* not recorded */';
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      const rows = v.map((x) => (isMeta(x) && x.$ === 'more' ? `${pad}  // …${x.n} more ${x.n === 1 ? 'item' : 'items'}, not included` : `${pad}  ${source(x, indent + 1)},`));
      return `[\n${rows.join('\n')}\n${pad}]`;
    }
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    return `{\n${keys.map((k) => `${pad}  ${propKey(k)}: ${source(v[k], indent + 1)},`).join('\n')}\n${pad}}`;
  }

  /**
   * A value ready to be written out as mock data. Secret-looking keys are always replaced. With `hide`, every value is replaced by an
   * empty one of its type (so the file has the structure and none of the data). Lists are cut to `rows` items.
   */
  function prepareMock(v, hide, rows, key) {
    if (isMeta(v)) return v;
    if (Array.isArray(v)) {
      const real = v.filter((x) => !(isMeta(x) && x.$ === 'more'));
      const out = real.slice(0, rows).map((x) => prepareMock(x, hide, rows));
      const rest = v.reduce((n, x) => n + (isMeta(x) && x.$ === 'more' ? x.n : 0), 0) + Math.max(0, real.length - rows);
      if (rest > 0) out.push({ $: 'more', n: rest });
      return out;
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, prepareMock(x, hide, rows, k)]));
    if (typeof v === 'string' && key && SECRET_KEY.test(key)) return '[redacted]';
    if (!hide) return v;
    return typeof v === 'string' ? '' : typeof v === 'number' ? 0 : typeof v === 'boolean' ? false : v;
  }

  /**
   * A mock.ts for a recorded value: its types (typesFrom) and `export const mock` typed with them. `opts.hide` writes structure only,
   * `opts.rows` is how many list items to keep (3 by default). The header says whether the values are real, because a recording of a
   * live app can hold data that should not be committed.
   */
  function mockFrom(value, shape, opts = {}) {
    const name = pascal(opts.name || 'Root');
    const hide = !!opts.hide;
    const rows = opts.rows || 3;
    const note = hide
      ? 'Values were hidden: text is empty, numbers are 0 and booleans are false. Fill in sample data before you use it.'
      : 'The values below are real. Check them for anything private before you share or commit this file.';
    const types = shape ? typesFrom(shape, name) : '';
    const typed = shape ? `: ${name}` : '';
    return [`// Mock data for ${name}, recorded with Lens.`, `// ${note}`, '', types, types ? '' : null, `export const mock${typed} = ${source(prepareMock(value, hide, rows))};`, ''].filter((x) => x !== null).join('\n');
  }

  /** A readable name for the type of what a call took or returned: the data page or the end of the address, then Request or Response. */
  function typeNameFor(ev, side) {
    const lastPath = (url) => {
      let segs = [];
      try { segs = new URL(url, 'http://x').pathname.split('/').filter(Boolean); } catch { segs = []; }
      // A case or work id (OPS-CASE-12, ORG-APP-WORK%20C-1001), a number or a long hex id names a record, not a kind of data.
      const looksLikeId = (s) => /^(\d+|[0-9a-f-]{16,})$/i.test(s) || (/\d$/.test(s) && /[-%]/.test(s));
      const real = segs.filter((s) => !looksLikeId(s));
      return real[real.length - 1] || 'Data';
    };
    let base;
    if (ev.net) base = lastPath(ev.net.url || ev.net.urlFull || '');
    else if (isDataCall(ev, null) && dataInfo(ev).name) base = dataInfo(ev).name;
    else base = String(ev.name || 'Call').split('.').pop().replace(/\(\)/g, '') || 'Call';
    const suffix = ev.net ? (side === 'req' ? 'Request' : 'Response') : side === 'args' ? 'Input' : 'Output';
    return `${pascal(base)}${suffix}`;
  }

  const api = { nestViews, countViews, viewPath, plural, fmtTime, KIND, HTTP_HELP, labelCategory, describeShape, explain, rowsOf, rowCount, itemShape, columnsOf, typeName, isDataCall, dataInfo, networkOf, isFailed, findings, issueMarkdown, issuesMarkdown, issuesJson, supportNote, typesFrom, mockFrom, typeNameFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XrayReport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
