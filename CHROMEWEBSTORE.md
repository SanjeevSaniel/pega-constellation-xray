# Chrome Web Store submission notes

Everything the Developer Dashboard asks for, written once. Nothing here is submitted until you do it in the dashboard.

## Listing

| Field | Value |
| --- | --- |
| Name | Constellation Lens |
| Summary (132 characters at most) | See inside a Pega Constellation app: a DevTools panel that records PCore, PConnect, store and API calls and the shape of their data. |
| Category | Developer Tools |
| Language | English |

### Description

Constellation Lens shows you what a Pega Constellation app is really doing.

Open DevTools on your Pega app, switch the Lens tab on for that site, reload, and see every PCore call, PConnect call, store change and network request: what was called, with which arguments, what came back and its exact structure.

- Network, like the browser's own panel: Headers, Payload, Preview, Response (coloured, numbered, with Find), Initiator and Timing. Bodies are kept in full.
- Data pages: every call that loads data, with its parameters, rows, columns and the HTTP request it made.
- Views: the mounted components as a tree, with views inside views, and a picker to choose a component by clicking it on the page.
- Issues: failed calls, page errors, console errors and warnings, slow requests and loops, each copyable as Markdown or JSON.
- Component details: config props, state props, case info and metadata, and the structure of each.
- Hide values: show structure only, so a screenshot or a report can be shared safely.

Everything stays in your browser. There is no server, no analytics and no tracking. The tool does nothing on a site until you switch it on for that site.

Independent project. Not affiliated with or endorsed by Pegasystems.

## Single purpose

A DevTools panel that records and displays what a Pega Constellation web app does (its PCore, PConnect, store and network activity) so developers can debug it.

## Permission justifications

| Permission | Why it is needed |
| --- | --- |
| `scripting` | Registers the recorder (a content script) on a site only after the user switches Lens on for that site, and attaches it to the page that is already open. |
| `storage` | Saves the "Was it called?" expectations a developer adds, per site, in the browser's local storage. Nothing else is stored. |
| Optional host permissions (`http://*/*`, `https://*/*`) | Not granted at install. When the user clicks "Turn on for this site", Chrome asks for that one host only, and the recorder runs only there. Pega apps run on customer-specific hosts, so the host cannot be listed in advance. |

Remote code: none. All code is in the package. There are no external requests from the extension. It uses no `eval`, no inline scripts and no `innerHTML`; the one `eval` in the source is the DevTools API `chrome.devtools.inspectedWindow.eval`.

## Privacy practices

- Data handled: the activity of the page being debugged (calls, arguments, results, request and response bodies and headers). It is shown in the DevTools panel for the same tab and nowhere else.
- Data transmitted off the device: none.
- Sold or transferred to third parties: no. Used for anything other than the single purpose: no.
- Sensitive headers (authorization, cookies, tokens) are hidden by default, and never included in exports or copied reports.
- A privacy policy page is still to be written and hosted (the dashboard asks for a URL). It should say the points above in plain words.

## Assets to prepare

- Screenshots: 1280 x 800 (or 640 x 400), up to five. Suggested: Network Response, Data pages, Views with the picker, Issues, the Health tab.
- Small promo tile: 440 x 280. Marquee (optional): 1400 x 560.
- Icon: 128 x 128 is in the package. The store recommends about 96 x 96 of artwork with transparent padding; this icon fills the tile edge to edge, which is accepted but may look larger than neighbours.

## Before submitting

- Register a developer account (one-time fee) and verify the contact email; turn on two-step verification.
- Upload `constellation-lens-v<version>-store.zip`: the files must sit at the **root** of the zip (`manifest.json` at the top), unlike the GitHub release zip, which has a folder.
- Expect an in-depth review because of the broad optional host permissions and a recorder injected into the page. The justifications above are written for that.
- Trademark: the name uses "Constellation", which is Pega's product name. The description says plainly that this is independent and not affiliated. If the store objects to the name, rename and keep the rest.
- Honest limit: the tool has not yet been run against a live Pega app. Say so in the release notes, and try it on a real app before submitting.

## Build the upload zip

```
git archive --format=zip -o constellation-lens-v0.3.0-store.zip HEAD
```

`.gitattributes` already leaves out tests, tools and `package.json`.
