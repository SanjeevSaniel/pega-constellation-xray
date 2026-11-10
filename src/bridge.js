// Isolated-world bridge: page hook (window.postMessage) <-> extension service worker (port).
// A Manifest V3 service worker sleeps when idle and closes its ports, so the bridge reconnects the next time the page has
// something to say. When it reconnects, the worker tells the panel, and the panel asks the hook to replay what it holds.
(() => {
  if (globalThis.__pegaXrayBridge) return;
  globalThis.__pegaXrayBridge = true;
  let port = null;

  const connect = () => {
    try {
      port = chrome.runtime.connect({ name: 'bridge' });
    } catch {
      port = null; // the extension was reloaded or removed: nothing more to do on this page
      return null;
    }
    port.onMessage.addListener((cmd) => window.postMessage({ __pxr_cmd: cmd }, '*'));
    port.onDisconnect.addListener(() => { port = null; });
    return port;
  };
  connect();

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.__pxr) return;
    try {
      (port || connect())?.postMessage(e.data);
    } catch {
      port = null;
      try { connect()?.postMessage(e.data); } catch { /* gone: nothing to do */ }
    }
  });
})();
