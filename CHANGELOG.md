# Changelog

## Unreleased

Checked against Pega 26.1, and it can now write code from what it records. The Web Store package (0.3.2) is unchanged.

- **Copy as TypeScript**: turns the recorded structure of a request, response, argument list or call output into named interfaces (one per object, children first, optional keys marked), ready to paste. It replaces the old one-block `type Shape`.
- **Copy as mock**: writes a `mock.ts` with those types and a sample of the recorded data (lists cut to three items). It keeps real values unless Hide values is on, then it keeps the structure and empties the values. Secret-looking keys are always replaced. The header says which it is.
- **Pega 26.1**: compared the 24.2.5, 25.1 and 26.1 PCore and PConnect typings. Every call Lens reads is still there. Streamed data pages (`Accept: text/event-stream`) are now read in pieces, capped at 1,000,000 characters or 60 seconds, instead of waiting for a body that may never end. The Component tab shows the new `getDataInfo()` and `getRelativePath()` when a component has them. `switch…` calls such as `switchLocale` are listed as writes. The new PCore getters (`getGenAIUtils`, `getAutosaveUtils`, `getNetworkUtils` and others) are recorded like any other call.
- **Health**: says how far Lens has been checked on the version it sees (run live on 24.2.5, should work on 25.1 and 26.1 with a check once, not checked elsewhere). The README has the same table.
- **Honest limits**: not yet run on a live Pega 25 or 26 app, and the new buttons were tested through the report logic and the recorder tests, not clicked in a real DevTools panel.

## 0.3.2

A new icon, ready for the Chrome Web Store. Nothing else changed.

- **Icon**: modern and flat, on a transparent background: an orange lens (`#d4572f`) with white touches, a small glare and a burst of rays on the glass. The orange was chosen because it keeps at least 3:1 contrast on a white page, the light and dark Chrome toolbars and the dark DevTools tab strip; the white always sits on orange, never on the page. The 128 px icon keeps the store's transparent padding, and the 16 px icon drops the finer details. The toolbar icon still pulses when something is recorded, and the whole lens turns red for a failure.
- **Store files**: `tools/make-store-assets.mjs` draws the small promo tile into `store/`. The docs and `store/` are left out of the upload zip.

## 0.3.1

The name is now just **Lens** (it is still "for Pega Constellation apps"). Nothing else changed.

## 0.3.0

Renamed to **Lens**, with a hand-drawn icon, and a lot more to look at.

- **Network**: every request has the same tabs as the browser's Network panel: Headers, Payload, Preview, Response, Initiator and Timing. Request and response bodies are kept in full (the old 300,000-character cutoff is gone), the Response is coloured and numbered with Find, and Preview draws the whole response as you open it. Sensitive headers are hidden until you ask.
- **Data pages**: every call that loads data, with its parameters, rows, columns and the HTTP request it made.
- **Views**: the mounted components as a tree, with views inside views nested, and **Pick on page** to choose a component by clicking it.
- **Issues**: failed calls, page errors, console errors and warnings, slow or stalled requests and loops, each with copy as Markdown or JSON. Severity badges are readable in light and dark.
- **Readable structure**: the Structure tab is a schema tree, and value trees can be expanded and collapsed.
- **Scroll fix**: clicking a row no longer sends the list to the bottom.
- **Icon**: a hand-drawn lens with a constellation inside. The toolbar icon pulses when something is recorded, red for a failure.
- **Reliability**: Chrome puts an idle background worker to sleep and closes its connections; the page bridge now reconnects, and the open panel keeps the worker awake, so recording does not quietly stop.
- **Web Store ready**: the manifest description fits the store's 132-character limit.

Run live on a real Pega Constellation app (PCore 24.2.5, React 17+): it attached to PCore, the store and the components, and the Activity, Data pages, Network, Views and Issues tabs filled with real traffic. Not yet confirmed live: the page picker, and other Pega versions. Use **Health** to see what attached.

## 0.2.0

Unreleased working name Peek: Data pages and Issues tabs, a scroll fix and a redesigned panel. Folded into 0.3.0.

## 0.1.0

First release as Pega Constellation X-Ray: Activity, Network, Was it called?, Component and Health tabs, and a Hide values mask.
