# Pega Constellation X-Ray

X-ray vision for Pega Constellation apps. A Chrome DevTools panel that records what your page does through **PCore**, **PConnect**, the **store** and the **network**: what was called, with which arguments, what came back, the exact structure of that data, how long it took, and who called it.

Built for debugging custom DX components: "was this API even called?", "what did it return?", "what shape is the data my component receives?".

## Install (unpacked)

1. Open `chrome://extensions`, switch on **Developer mode**.
2. **Load unpacked**, pick this folder.
3. Open your Pega app, open DevTools, go to the **Constellation X-Ray** panel.
4. Click **Turn on for this site** (Chrome asks for permission for that one host only), then **Reload & capture from start**.

Nothing runs on any site you have not switched on.

## What each tab does

| Tab | What you get |
| --- | --- |
| **Activity** | Every PCore call, PConnect call, store change/dispatch and subscribed event, in order. Click one for a plain-English **Summary**, the exact **Input** and **Output**, the **Structure** as a TypeScript type, **Who called it** (call stack, parent and child calls) and the **Raw** event. |
| **Network** | Every request with headers (secrets hidden), body, response body and structure. Recognises DX API, data view, case, assignment and attachment URLs. |
| **Was it called?** | Add a call name or URL (plain text or `/regex/i`). X-Ray shows ✓ called N times or ✗ not called, and jumps to the last result. Saved per site. |
| **Component** | Select an element in **Elements**; X-Ray finds the Constellation component behind it and shows its config props, state props, case info, raw metadata, the structure of its config props, and what it called. |
| **Health** | Checks that X-Ray is seeing your app, plus detected problems: failed calls, stalled requests, slow calls, empty data results, and loops of identical calls. |

**Hide values** replaces every value with its type (`‹string›`) in the panel and in exports, so you can share a screenshot or file showing structure only.

## Versions

Checks are by capability, not version number, so one build is meant to cover **Pega 23, 24, 25, 26 and later**:

- `window.PCore` is captured the moment the runtime assigns it, and the version is read with `PCore.getPCoreVersion()` when that exists.
- PConnect handles are found by walking React fibers (React 16 and 17+), including inside shadow roots.
- The store is optional. If your build does not expose `PCore.getStore()` with `subscribe`, PCore and network recording still work, and **Health** says so.

If a future runtime changes shape, **Health** shows which part stopped matching and **Copy diagnostics** gives you something to report.

> Honest limit: this has been tested against a fake runtime (`npm test`), not yet against every live Pega version. Treat the first run on each version as a check, and use **Health** to see what attached.

## What it records, and what it does not

- PCore: every method on `PCore` and the utility objects it returns (data APIs, REST client, containers, navigation, pub/sub...).
- PConnect: methods on each component's `pConn` and on its actions API, labelled with the component name and context.
- Network: `fetch` and `XMLHttpRequest`. Authorization, cookie, token, CSRF and similar headers and query values are replaced with `[redacted]`. Binary responses are not recorded. Bodies over 300,000 characters are not recorded.
- Calls made before X-Ray attached are missed. Reload after turning it on.
- A PConnect that no mounted component holds is not discovered.
- Inspecting an element works in the top page; for an app inside an iframe, use that frame's DevTools context.

Recording never changes what your page gets back: results are returned as they were, and errors are re-thrown untouched.

## Privacy

Everything stays in your browser. Events go from the page to this DevTools panel and nowhere else; there is no server, no analytics, no network call from the extension. Values on the page you debug can be real data, so use **Hide values** before sharing anything, and do not paste exports into public places.

## Develop

```
npm test        # drives src/hook.js against a fake PCore, PConnect, fetch and store
```

| File | Role |
| --- | --- |
| `src/hook.js` | Page-world recorder (PCore/PConnect/network/store) |
| `src/bridge.js` | Isolated-world relay between the page and the extension |
| `background.js` | Registers the hook per switched-on site, relays events to the panel |
| `panel.html/css/js` | The DevTools panel |
