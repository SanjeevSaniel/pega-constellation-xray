# Lens

See inside a Pega Constellation app. A Chrome DevTools panel that records what your page does through **PCore**, **PConnect**, the **store** and the **network**: what was called, with which arguments, what came back, the exact structure of that data, how long it took, and who called it.

Built for debugging custom DX components: "was this API even called?", "what did it return?", "what shape is the data my component receives?", "why did that fail?".

Lens was called *Pega Constellation X-Ray* in 0.1. The folder and repository keep the old name for now.

## Install from a release (easiest)

1. Download the latest zip from the [Releases](https://github.com/SanjeevSaniel/pega-constellation-xray/releases) page and unzip it somewhere permanent.
2. Follow the steps below, choosing that unzipped folder in step 2.

## Install (unpacked)

1. Open `chrome://extensions`, switch on **Developer mode**.
2. **Load unpacked**, pick this folder.
3. Open your Pega app, open DevTools (F12), go to the **Lens** tab (the one with the magnifier).
4. Click **Turn on for this site** (Chrome asks for permission for that one host only), then **Reload & capture from start**.

Nothing runs on any site you have not switched on. The toolbar icon opens a short reminder of these steps, and pulses whenever Lens records something in that tab (red when it recorded a failure).

## What each tab does

| Tab | What you get |
| --- | --- |
| **Activity** | Every PCore call, PConnect call, store change/dispatch and subscribed event, in order. Click one for a plain-English **Summary**, the exact **Input** and **Output**, the **Structure** as a readable schema (name, type, how many, which keys are optional; TypeScript is one click away), the **HTTP** requests it made, **Who called it** (call stack, parent and child calls) and the **Raw** event. |
| **Data pages** | Every call that loads data, in one list: the data page or view, its parameters, how many rows came back and how long it took. Open one for its **Input** (name, context, parameters, raw arguments), its **Output** (row count, a columns table that shows which columns are missing in some rows, the rows themselves and the full tree) and the **HTTP** request it made, with request and response. You do not need the browser's Network tab. |
| **Network** | Every request with the same tabs as the browser's Network panel: **Headers** (general, response and request headers), **Payload** (query string parameters and the request body), **Preview** (a tree), **Response** (the full text, any size: pretty or raw, copy, download), **Structure**, **Initiator** (the PCore call that started it, and the call stack) and **Timing** (where the time went: stalled, DNS, connection, SSL, waiting, download). Recognises DX API, data view, case, assignment and attachment URLs. |
| **Views** | The components mounted on the page as a tree: views, regions, templates and fields, with views inside views nested. Each row shows how many components it holds ("4 inside"). Select one for what it was given (config props, state props, case info, raw metadata), the structure of its config props, what it called, and a breadcrumb showing where it sits. **Pick on page** is a UI inspector: hover to outline the component under the pointer, click to choose it (the click does not reach the page), Escape to cancel. **Containers only** hides the components that hold nothing, so the nesting stands out. |
| **Issues** | Everything worth a look, newest first: failed calls and requests, uncaught page errors, unhandled promise rejections, `console.error` and `console.warn`, stalled or slow requests, empty data results and loops of identical calls. Filter by Error, Check or Note. Every issue has **Copy issue (Markdown)**, **Copy as JSON** and **Show the call**; the whole list can be copied or downloaded as Markdown, ready for a ticket or a chat. |
| **Was it called?** | Add a call name or URL (plain text or `/regex/i`). Lens shows ✓ called N times or ✗ not called, and jumps to the last result. Saved per site. |
| **Component** | Select an element in **Elements**; Lens finds the Constellation component behind it and shows its config props, state props, case info, raw metadata, the structure of its config props, and what it called. |
| **Health** | Checks that Lens is seeing your app, a pointer to Issues, and **Copy diagnostics**. |

Values are shown as trees with a peek at the keys when a branch is closed, long text shortened until you click it, and Expand all / Collapse all. The list keeps your place: clicking a row never moves it, and new rows only pull the list down when you were already at the bottom (otherwise a "↓ N new" button appears). The mark in the header plays one pulse whenever something is recorded.

**Hide values** replaces every value with its type (`‹string›`) in the panel, in copied reports and in exports, so you can share a screenshot or file showing structure only. Error messages are kept, because they say what went wrong; check them before sharing.

## Versions

Checks are by capability, not version number, so one build is meant to cover **Pega 23, 24, 25, 26 and later**:

- `window.PCore` is captured the moment the runtime assigns it, and the version is read with `PCore.getPCoreVersion()` when that exists.
- PConnect handles are found by walking React fibers (React 16 and 17+), including inside shadow roots.
- The store is optional. If your build does not expose `PCore.getStore()` with `subscribe`, PCore and network recording still work, and **Health** says so.

If a future runtime changes shape, **Health** shows which part stopped matching and **Copy diagnostics** gives you something to report.

> Tested live: it has been run on a real Pega Constellation app (PCore 24.2.5, React 17+). There it attached to PCore, the store and the components, and the Activity, Data pages, Network, Views and Issues tabs filled with real traffic. Not yet confirmed live: the **Pick on page** picker, and other Pega versions. It is also tested against a fake runtime (`npm test`) and the panel against stubbed Chrome APIs. Use **Health** to see what attached on your app, and treat the first run on each version as a check.

The **Data pages** tab reads the data page name and parameters from the call's arguments by their values (a string that is not a context, an object with a parameters-like key). Lens does not know Pega's exact signatures, so the tab says "read from the argument values" and always shows the raw arguments too.

## What it records, and what it does not

- PCore: every method on `PCore` and the utility objects it returns (data APIs, REST client, containers, navigation, pub/sub...).
- PConnect: methods on each component's `pConn` and on its actions API, labelled with the component name and context.
- Network: `fetch` and `XMLHttpRequest`. Request and response bodies are kept in full as raw text (up to 30 million characters each, 80 million in the page and 150 million in the panel, oldest dropped first) and sent to the panel in pieces. Binary responses are not recorded. Authorization, cookie, token, CSRF and similar headers and query values are hidden in the panel by default; **Show sensitive values** reveals them, and they never go into exports or copied reports. Exports do not include raw bodies.
- Page errors: uncaught errors, unhandled promise rejections, resource load failures, and `console.error` / `console.warn` (up to 300 per page). Your page's own handlers and console methods always run unchanged.
- Calls made before Lens attached are missed. Reload after turning it on.
- A PConnect that no mounted component holds is not discovered.
- Inspecting an element works in the top page; for an app inside an iframe, use that frame's DevTools context.

Recording never changes what your page gets back: results are returned as they were, and errors are re-thrown untouched.

## Privacy

Everything stays in your browser. Events go from the page to this DevTools panel and nowhere else; there is no server, no analytics, no network call from the extension. Headers with cookies and tokens are held in memory in the panel so you can reveal them; copies and exports leave them out. Values on the page you debug can be real data, and console messages can contain it too, so use **Hide values** before sharing anything, and do not paste exports or copied reports into public places.

## Develop

```
npm test        # drives src/hook.js against a fake runtime, and the panel's logic (src/report.js) against sample events
```

| File | Role |
| --- | --- |
| `src/hook.js` | Page-world recorder (PCore/PConnect/network/store/page errors) |
| `src/bridge.js` | Isolated-world relay between the page and the extension |
| `src/report.js` | The panel's pure logic: explanations, data-call reader, issue finder, views tree, copy-ready reports. Tested in `test/report.mjs` |
| `src/mark.js` | The mark (a lens with a small constellation inside, teal to blue), drawn on a canvas. Used for the PNG icons and the animated toolbar icon |
| `background.js` | Registers the hook per switched-on site, relays events to the panel, pulses the toolbar icon |
| `panel.html/css/js` | The DevTools panel |
| `popup.html` | The short reminder behind the toolbar icon |
| `icons/` | PNG icons (Chrome does not accept SVG for these). Regenerate with `CANVAS_FROM=/path/to/a/project/with/@napi-rs/canvas/package.json node tools/make-icons.mjs` |

## Licence

MIT. See `LICENSE`.
