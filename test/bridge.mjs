// Tests src/bridge.js against a fake chrome.runtime: when the service worker sleeps and closes the port,
// the bridge must reconnect the next time the page has something to say. Run: node test/bridge.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const code = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
const ports = [];
const pageListeners = [];
const toPage = [];

const makePort = () => {
  const p = { sent: [], closed: false, msgL: [], discL: [] };
  p.postMessage = (m) => { if (p.closed) throw new Error('Attempting to use a disconnected port object'); p.sent.push(m); };
  p.onMessage = { addListener: (f) => p.msgL.push(f) };
  p.onDisconnect = { addListener: (f) => p.discL.push(f) };
  p.close = () => { p.closed = true; p.discL.forEach((f) => f()); }; // what the worker going to sleep looks like from the page
  return p;
};

const win = { addEventListener: (t, f) => { if (t === 'message') pageListeners.push(f); }, postMessage: (m) => toPage.push(m) };
const ctx = { chrome: { runtime: { connect: () => { const p = makePort(); ports.push(p); return p; } } }, window: win, globalThis: null };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx);

const fromPage = (data) => pageListeners.forEach((f) => f({ source: win, data }));

assert.equal(ports.length, 1, 'connects once at start');
fromPage({ __pxr: 1, type: 'events', items: [1] });
assert.deepEqual(ports[0].sent.map((m) => m.items), [[1]], 'a page message reaches the worker');

fromPage({ type: 'not ours' });
assert.equal(ports[0].sent.length, 1, 'messages that are not the recorder\'s are ignored');

ports[0].close(); // the worker went to sleep
fromPage({ __pxr: 1, type: 'events', items: [2] });
assert.equal(ports.length, 2, 'it reconnects when the page next has something to say');
assert.deepEqual(ports[1].sent.map((m) => m.items), [[2]], 'and the message is delivered on the new port, not lost');

// a command from the panel still reaches the page through the new port
ports[1].msgL.forEach((f) => f({ cmd: 'replay' }));
assert.equal(JSON.stringify(toPage.pop()), JSON.stringify({ __pxr_cmd: { cmd: 'replay' } }), 'commands from the panel are relayed to the page');

// a port that dies without the disconnect event: the failed send is retried on a fresh port
ports[1].closed = true;
fromPage({ __pxr: 1, type: 'events', items: [3] });
assert.deepEqual(ports[2].sent.map((m) => m.items), [[3]], 'a dead port is replaced and the message is not lost');

console.log('ok: bridge reconnects after the service worker sleeps');
