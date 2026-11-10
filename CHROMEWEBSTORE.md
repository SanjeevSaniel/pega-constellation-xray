# Chrome Web Store submission notes

Everything the Developer Dashboard asks for, written once. Nothing here is submitted until you do it in the dashboard.

## Listing

| Field | Value |
| --- | --- |
| Name | Lens |
| Summary (132 characters at most) | See inside a Pega Constellation app: a DevTools panel that records PCore, PConnect, store and API calls and the shape of their data. |
| Category | Developer Tools |
| Language | English |

### Description

Lens shows you what a Pega Constellation app is really doing.

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

## The publishing process, step by step

Dashboard: https://chrome.google.com/webstore/devconsole (sign in with the Google account that will own the extension). Menus and rules change, so check the dashboard's own prompts as you go.

| # | Step | Who | What to do |
| --- | --- | --- | --- |
| 1 | Developer account | You | Sign in to the dashboard, accept the developer agreement, pay the one-time registration fee, and verify your contact email. Turn on two-step verification on the Google account. |
| 2 | Publisher type | You | Say whether you are a trader (a business) or not, as the dashboard asks. A trader's contact details are shown publicly. |
| 3 | Make the assets | Together | Screenshots, a small promo tile, and a privacy policy page at a public URL (see Assets and Privacy above). I can write and host the privacy page on your site. |
| 4 | Try it on a real Pega app | You | Load the unpacked build, switch it on, and check Network, Data pages, Views and Issues on a real app. It has run live on Pega 24.2.5 only; check the picker and other versions if you can. |
| 5 | Build the upload zip | Me | `git archive` with the files at the root of the zip (command below), then I check its file list. |
| 6 | Add new item | You | In the dashboard choose **Add new item** and upload the store zip. The dashboard reads the manifest and fills in name, version and icon. |
| 7 | Store listing tab | You | Paste the description and summary from this file, choose the category, add the screenshots, promo tile and the privacy policy URL. |
| 8 | Privacy tab | You | Paste the single-purpose statement, each permission justification, answer the remote-code question (none), tick the data-use boxes as in Privacy practices, and certify the three statements. |
| 9 | Distribution tab | You | Visibility: public, unlisted or private (unlisted is a safe first choice). Regions: all. Pricing: free. |
| 10 | Test instructions | You | Reviewers cannot reach a Pega app. Say that Lens records a Constellation app inside DevTools, describe what they will see (the Lens tab, Turn on for this site, Health), and consider adding a short screen recording. |
| 11 | Submit for review | You | **Submit for review**. Choose whether it publishes automatically once approved, or waits for you to publish. |
| 12 | Wait | Chrome | Review takes from hours to some days. Broad host permissions and a recorder injected into the page can mean a closer review. Fix what the reviewer asks and resubmit. |
| 13 | Publish | You | If you chose deferred publishing, press **Publish** once approved. |
| 14 | Updates | Together | Bump the version in `manifest.json`, update `CHANGELOG.md`, build a new store zip, and upload it as a new version in the dashboard. Each update is reviewed again. |

## Before submitting

- Register a developer account (one-time fee) and verify the contact email; turn on two-step verification.
- Upload `lens-v<version>-store.zip`: the files must sit at the **root** of the zip (`manifest.json` at the top), unlike the GitHub release zip, which has a folder.
- Expect an in-depth review because of the broad optional host permissions and a recorder injected into the page. The justifications above are written for that.
- Trademark: the name uses "Constellation", which is Pega's product name. The description says plainly that this is independent and not affiliated. If the store objects to the name, rename and keep the rest.
- Honest limit: it has run live on one Pega app (24.2.5, React 17+) but not on other versions, and the page picker is unconfirmed. Say so in the release notes.

## Build the upload zip

```
git archive --format=zip -o lens-v0.3.1-store.zip HEAD
```

`.gitattributes` already leaves out tests, tools and `package.json`.
