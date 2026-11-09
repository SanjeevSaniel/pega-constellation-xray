// Isolated-world bridge: page hook (window.postMessage) <-> extension service worker (port).
(() => {
  if (globalThis.__pegaXrayBridge) return;
  globalThis.__pegaXrayBridge = true;
  const port = chrome.runtime.connect({ name: 'bridge' });

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.__pxr) return;
    try { port.postMessage(e.data); } catch { /* extension reloaded: nothing to do */ }
  });

  port.onMessage.addListener((cmd) => window.postMessage({ __pxr_cmd: cmd }, '*'));
  port.onDisconnect.addListener(() => { globalThis.__pegaXrayBridge = false; });
})();
