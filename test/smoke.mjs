// Drives src/hook.js against a fake Constellation runtime. Run: node test/smoke.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const code = fs.readFileSync(new URL('../src/hook.js', import.meta.url), 'utf8');
const posted = [];
const listeners = [];
const consoleCalls = [];
let storeCb = null;

const ctx = {
  console: { log: console.log, error: (...a) => consoleCalls.push(['error', ...a]), warn: (...a) => consoleCalls.push(['warn', ...a]) }, setTimeout, clearTimeout, Promise, Date, Error, Map, Set, WeakMap, WeakSet, Proxy, Reflect, JSON, Object, Array, Number, String, Symbol,
  performance: { now: () => Date.now() },
  location: { href: 'https://pega.example.test/prweb/app' },
  postMessage: (m) => posted.push(m),
  addEventListener: (type, fn) => listeners.push([type, fn]),
  fetch: async () => ({
    ok: true, status: 200, statusText: 'OK',
    headers: { get: () => 'application/json', forEach: (cb) => cb('application/json', 'content-type') },
    clone() { return { text: async () => JSON.stringify({ data: [{ id: 1 }, { id: 2, note: 'x' }] }) }; },
  }),
  Request: class {},
  URL, URLSearchParams,
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx);

assert.ok(ctx.__pegaXray, 'hook installed');
const st = ctx.__pegaXray.state;

// ---- fake runtime
const store = {
  s: { data: { 'app/primary_1': { caseInfo: { id: 'C-1' } } } },
  getState() { return this.s; },
  subscribe(cb) { storeCb = cb; return () => {}; },
  dispatch(a) { return a; },
};
const pConnRaw = {
  getActionsApi() { return { updateFieldValue: (p, v) => ({ ok: true, p, v }) }; },
  getValue: (ref) => (ref === '.Name' ? 'Ada' : undefined),
  getContextName: () => 'app/primary_1',
  getRawMetadata: () => ({ name: 'DemoField', type: 'TextInput' }),
};
ctx.PCore = {
  getPCoreVersion: () => '24.2.0',
  getStore: () => store,
  getDataApiUtils: () => ({ getData: async () => ({ data: [{ a: 1 }, { a: 2, b: 'x' }] }) }),
  getPConn: () => pConnRaw,
};

const PCore = ctx.PCore;
assert.equal(typeof PCore.getStore().getState, 'function', 'proxied PCore still works');

// ---- PCore async data call
const res = await PCore.getDataApiUtils().getData('D_Demo', { p: 1 }, 'app/primary_1');
assert.equal(res.data.length, 2, 'original result untouched');
await new Promise((r) => setTimeout(r, 20));
const dataEv = st.buf.find((e) => e.name === 'PCore.getDataApiUtils().getData');
assert.ok(dataEv, 'data call recorded');
assert.equal(dataEv.status, 'ok');
assert.equal(dataEv.access, 'data');
assert.equal(dataEv.argsShape.len, 3);
assert.equal(dataEv.shape.props.data.item.props.b.opt, true, 'optional key detected in merged array shape');

// ---- PConnect through PCore, with component label
const pConn = PCore.getPConn();
assert.equal(pConn.getValue('.Name'), 'Ada');
pConn.getActionsApi().updateFieldValue('.Name', 'Grace');
const valEv = st.buf.find((e) => e.name === 'pConn.getValue');
assert.ok(valEv && valEv.comp === 'DemoField' && valEv.ctx === 'app/primary_1', 'pConn call labelled with component and context');
const writeEv = st.buf.find((e) => e.name.endsWith('updateFieldValue'));
assert.ok(writeEv && writeEv.access === 'write' && writeEv.comp === 'DemoField', 'actions call attributed to its component');

// ---- fetch with secret redaction
const r = await ctx.fetch('https://pega.example.test/prweb/api/v1/data_views/D_Demo?token=abc', { method: 'POST', body: '{"q":1}', headers: { Authorization: 'Bearer secret', 'X-Thing': 'ok' } });
assert.equal(r.status, 200);
await new Promise((r2) => setTimeout(r2, 30));
const net = st.buf.find((e) => e.kind === 'net');
assert.ok(net, 'fetch recorded');
assert.equal(net.net.category, 'data-view');
assert.equal(net.net.reqHeaders.Authorization, '[redacted]');
assert.equal(net.net.reqHeaders['X-Thing'], 'ok');
assert.ok(net.net.url.includes('token=%5Bredacted%5D'), 'query secret redacted');
assert.equal(net.http, 200);
assert.equal(net.shape.props.data.t, 'array');

// ---- store diff
store.s = { data: { 'app/primary_1': { caseInfo: { id: 'C-2' } } } };
storeCb();
const stEv = st.buf.find((e) => e.kind === 'store' && e.name.startsWith('state changed'));
assert.ok(stEv, 'store change recorded');
assert.ok(stEv.changed.some((p) => p.startsWith('data.app/primary_1')), 'changed path reported');
store.dispatch({ type: 'TEST_ACTION' });
assert.ok(st.buf.some((e) => e.name === 'dispatch TEST_ACTION'), 'dispatch recorded');

// ---- status
await new Promise((r2) => setTimeout(r2, 10));
assert.equal(st.status.pcore, true);
assert.equal(st.status.store, true);
assert.equal(st.status.version, '24.2.0');

// ---- never breaks the page: errors propagate untouched
PCore.getBoom = () => { throw new Error('boom'); };
assert.throws(() => PCore.getBoom(), /boom/);
assert.ok(st.buf.some((e) => e.name === 'PCore.getBoom' && e.status === 'error'));

// ---- page errors and console issues
const fire = (type, ev) => listeners.filter(([t]) => t === type).forEach(([, fn]) => fn(ev));
fire('error', { message: 'Boom in app', filename: 'https://pega.example.test/app.js', lineno: 10, colno: 5, error: new Error('Boom in app') });
fire('unhandledrejection', { reason: new Error('Async boom') });
ctx.console.error('Something failed', { id: 7 });
ctx.console.warn('Careful');
const issues = st.buf.filter((e) => e.kind === 'issue');
assert.equal(issues.length, 4, 'four issues recorded');
assert.ok(issues.some((e) => e.name === 'Uncaught error' && e.message === 'Boom in app' && e.source.endsWith('app.js:10:5') && e.level === 'error'), 'uncaught error recorded with its place');
assert.ok(issues.some((e) => e.name === 'Unhandled promise rejection' && /Async boom/.test(e.message)), 'unhandled rejection recorded');
assert.ok(issues.some((e) => e.name === 'console.error' && e.message.includes('Something failed') && e.level === 'error'), 'console.error recorded');
assert.ok(issues.some((e) => e.name === 'console.warn' && e.level === 'warn'), 'console.warn recorded');
assert.ok(consoleCalls.some((c) => c[0] === 'error' && c[1] === 'Something failed'), 'the page console.error still ran');
assert.ok(consoleCalls.some((c) => c[0] === 'warn' && c[1] === 'Careful'), 'the page console.warn still ran');

console.log(`ok: ${st.buf.length} events recorded, all assertions passed`);
process.exit(0);
