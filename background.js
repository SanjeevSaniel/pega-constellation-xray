// Pega Constellation X-Ray service worker.
// 1. Registers the page hook for a site the user switched on (least privilege: nothing runs elsewhere).
// 2. Relays events from a tab's bridge ports to the DevTools panel for that tab, and commands back.

const tabs = new Map(); // tabId -> { panel: Port|null, bridges: Set<Port> }

function entry(tabId) {
  if (!tabs.has(tabId)) tabs.set(tabId, { panel: null, bridges: new Set() });
  return tabs.get(tabId);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'bridge' && port.sender?.tab) {
    const tabId = port.sender.tab.id;
    const e = entry(tabId);
    e.bridges.add(port);
    port.onMessage.addListener((msg) => e.panel?.postMessage({ ...msg, frameId: port.sender.frameId }));
    port.onDisconnect.addListener(() => e.bridges.delete(port));
    e.panel?.postMessage({ type: 'bridge-up', frameId: port.sender.frameId, url: port.sender.url });
  } else if (port.name.startsWith('panel:')) {
    const tabId = Number(port.name.slice(6));
    const e = entry(tabId);
    e.panel = port;
    port.onMessage.addListener((msg) => e.bridges.forEach((b) => b.postMessage(msg)));
    port.onDisconnect.addListener(() => {
      if (e.panel === port) e.panel = null;
    });
    port.postMessage({ type: 'bridges', count: e.bridges.size });
  }
});

const idFor = (host) => `pxr_${host.replace(/[^a-z0-9]/gi, '_')}`;

async function enable(origin, tabId) {
  const url = new URL(origin);
  const matches = [`${url.protocol}//${url.hostname}/*`];
  const id = idFor(url.hostname);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [`${id}_hook`, `${id}_bridge`] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  await chrome.scripting.registerContentScripts([
    { id: `${id}_hook`, matches, js: ['src/hook.js'], runAt: 'document_start', allFrames: true, world: 'MAIN', persistAcrossSessions: true },
    { id: `${id}_bridge`, matches, js: ['src/bridge.js'], runAt: 'document_start', allFrames: true, world: 'ISOLATED', persistAcrossSessions: true },
  ]);
  // Also attach to the page that is already open. It misses what happened before this moment; reload to capture from the start.
  if (tabId != null) {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['src/hook.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['src/bridge.js'], world: 'ISOLATED' });
  }
}

async function disable(origin) {
  const id = idFor(new URL(origin).hostname);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [`${id}_hook`, `${id}_bridge`] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
}

async function isEnabled(origin) {
  const id = idFor(new URL(origin).hostname);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [`${id}_hook`] });
  return existing.length > 0;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const work = msg.type === 'enable' ? enable(msg.origin, msg.tabId).then(() => ({ ok: true }))
    : msg.type === 'disable' ? disable(msg.origin).then(() => ({ ok: true }))
    : msg.type === 'status' ? isEnabled(msg.origin).then((enabled) => ({ ok: true, enabled }))
    : null;
  if (!work) return false;
  work.then(reply, (err) => reply({ ok: false, error: String(err?.message || err) }));
  return true; // async reply
});
