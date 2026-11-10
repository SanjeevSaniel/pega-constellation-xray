# Changelog

## 0.3.0

Renamed to **Constellation Lens**, with a hand-drawn icon, and a lot more to look at.

- **Network**: every request has the same tabs as the browser's Network panel: Headers, Payload, Preview, Response, Initiator and Timing. Request and response bodies are kept in full (the old 300,000-character cutoff is gone), the Response is coloured and numbered with Find, and Preview draws the whole response as you open it. Sensitive headers are hidden until you ask.
- **Data pages**: every call that loads data, with its parameters, rows, columns and the HTTP request it made.
- **Views**: the mounted components as a tree, with views inside views nested, and **Pick on page** to choose a component by clicking it.
- **Issues**: failed calls, page errors, console errors and warnings, slow or stalled requests and loops, each with copy as Markdown or JSON. Severity badges are readable in light and dark.
- **Readable structure**: the Structure tab is a schema tree, and value trees can be expanded and collapsed.
- **Scroll fix**: clicking a row no longer sends the list to the bottom.
- **Icon**: a hand-drawn lens with a constellation inside. The toolbar icon pulses when something is recorded, red for a failure.
- **Reliability**: Chrome puts an idle background worker to sleep and closes its connections; the page bridge now reconnects, and the open panel keeps the worker awake, so recording does not quietly stop.
- **Web Store ready**: the manifest description fits the store's 132-character limit.

Not yet tested against a live Pega app: the tool has been run against a fake runtime and stubbed Chrome APIs. Use **Health** to see what attached.

## 0.2.0

Unreleased working name Peek: Data pages and Issues tabs, a scroll fix and a redesigned panel. Folded into 0.3.0.

## 0.1.0

First release as Pega Constellation X-Ray: Activity, Network, Was it called?, Component and Health tabs, and a Hide values mask.
