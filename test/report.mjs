// Tests the panel's pure logic (src/report.js): data-call reading, issue finding and the copy-ready reports.
// Run: node test/report.mjs
import assert from 'node:assert/strict';
await import('../src/report.js'); // a classic script: it registers itself on globalThis
const R = globalThis.XrayReport;

// events shaped like the ones src/hook.js records
let id = 0;
const ev = (o) => ({ id: ++id, key: `0:${id}`, frameId: 0, t: 1700000000000 + id * 1000, status: 'ok', ...o });
const rowsShape = { t: 'object', n: 1, props: { data: { t: 'array', len: 3, item: { t: 'object', n: 2, props: { a: { t: 'number' }, b: { t: 'string', opt: true } } } } } };

const dataCall = ev({ kind: 'pcore', name: 'PCore.getDataApiUtils().getData', access: 'data', ctx: '', args: ['D_Customers', { Region: 'EU' }, 'app/primary_1'], argsShape: { t: 'array', len: 3 }, result: { data: [{ a: 1 }, { a: 2, b: 'x' }] }, shape: rowsShape, ms: 120, async: true });
const req = ev({ kind: 'net', name: 'POST /prweb/api/v1/data_views/D_Customers', access: 'net', parent: dataCall.id, net: { method: 'POST', url: 'https://h/prweb/api/v1/data_views/D_Customers', category: 'data-view', pega: true, reqBody: { dataViewParameters: { Region: 'EU' } } }, http: 200, ms: 95, result: { data: [] } });
const orphan = ev({ kind: 'net', name: 'GET /prweb/api/v1/data_views/D_Orders', access: 'net', net: { method: 'GET', url: 'https://h/prweb/api/v1/data_views/D_Orders', category: 'data-view', pega: true }, http: 200, ms: 50 });
const failed = ev({ kind: 'net', name: 'POST /prweb/api/v1/cases', access: 'net', net: { method: 'POST', url: 'https://h/prweb/api/v1/cases', category: 'case', pega: true, reqBody: { caseTypeID: 'X' } }, http: 422, statusText: 'Unprocessable', status: 'error', ms: 30, result: { errors: [{ message: 'Required field missing' }] }, stack: ['at foo (app.js:1:1)'] });
const throwing = ev({ kind: 'pcore', name: 'PCore.getBoom', access: 'read', args: [], status: 'error', error: { message: 'boom' }, ms: 2 });
const pageErr = ev({ kind: 'issue', name: 'Uncaught error', level: 'error', status: 'error', access: 'event', message: 'x is not a function', source: 'app.js:10:5', stack: ['at a (app.js:10:5)'] });
const warnLog = ev({ kind: 'issue', name: 'console.warn', level: 'warn', status: 'ok', access: 'event', message: 'Deprecated' });
const emptyData = ev({ kind: 'pcore', name: 'PCore.getDataApiUtils().getDataAsync', access: 'data', args: ['D_Empty'], result: { data: [] }, shape: { t: 'object', props: { data: { t: 'array', len: 0 } } }, ms: 10 });
const events = [dataCall, req, orphan, failed, throwing, pageErr, warnLog, emptyData];

// ---- data calls
assert.equal(R.isDataCall(dataCall), true);
assert.equal(R.isDataCall(req, dataCall), false, 'a request started by a data call is part of that call');
assert.equal(R.isDataCall(orphan, null), true, 'a data-view request with no recorded caller is listed on its own');
assert.equal(R.isDataCall(failed, null), false, 'a case request is not a data call');
const info = R.dataInfo(dataCall);
assert.equal(info.name, 'D_Customers');
assert.deepEqual(info.parameters, { Region: 'EU' });
assert.equal(info.context, 'app/primary_1');
assert.equal(R.dataInfo(orphan).name, 'D_Orders', 'name read from the URL');
assert.deepEqual(R.dataInfo(req).parameters, { dataViewParameters: { Region: 'EU' } });
assert.equal(R.rowCount(dataCall), 3, 'row count comes from the shape, not the capped rows');
assert.equal(R.rowsOf(dataCall.result).length, 2);
assert.deepEqual(R.columnsOf(dataCall), [{ name: 'a', type: 'number', optional: false }, { name: 'b', type: 'string', optional: true }]);
assert.equal(R.networkOf(dataCall, events).length, 1);
assert.equal(R.networkOf(dataCall, events)[0], req);

// ---- findings
const found = R.findings(events, 1700000100000);
const types = found.map((f) => f.type);
assert.ok(types.includes('failed'), 'failed request found');
assert.ok(types.includes('page-error'), 'page error found');
assert.ok(types.includes('console-warning'), 'console warning found');
assert.ok(types.includes('empty'), 'empty data found');
assert.equal(found.filter((f) => f.level === 'bad').length, 3, 'failed call, thrown call and page error are errors');
assert.ok(found.every((f) => f.id && f.ev), 'each finding has a stable id');
assert.ok(found[0].ev.t >= found[found.length - 1].ev.t, 'newest first');

// ---- explanations
assert.match(R.explain(failed).lines.join(' '), /HTTP 422/);
assert.match(R.explain(failed).lines.join(' '), /rule or validation/);
assert.equal(R.explain(failed).bad, true);
assert.match(R.explain(emptyData).lines.join(' '), /No rows came back/);
assert.match(R.explain(pageErr).lines.join(' '), /x is not a function/);

// ---- copy-ready reports
const f422 = found.find((f) => f.type === 'failed' && f.ev === failed);
const md = R.issueMarkdown(f422, { events });
assert.match(md, /### Error: /);
assert.match(md, /POST https:\/\/h\/prweb\/api\/v1\/cases/);
assert.match(md, /Required field missing/, 'response body included');
assert.match(md, /caseTypeID/, 'request body included');
assert.match(md, /at foo \(app\.js:1:1\)/, 'call stack included');
const mask = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'string' ? '‹string›' : x)));
const masked = R.issueMarkdown(f422, { events, view: mask });
assert.ok(!/Required field missing/.test(masked) && /‹string›/.test(masked), 'Hide values masks the copied values');
const all = R.issuesMarkdown(found, { tool: 'Lens', version: '0.3.1', origin: 'https://pega.example.test', valuesHidden: false, now: 1700000100000 }, { events });
assert.match(all, /^# Lens: issues/);
assert.match(all, /Found: 3 errors, 1 check, 1 note/);
assert.equal((all.match(/^### /gm) || []).length, found.length, 'every issue is in the report');
const json = R.issuesJson(found, { version: '0.3.1', now: 1700000100000 }, { events });
assert.equal(json.issues.length, found.length);
assert.doesNotThrow(() => JSON.stringify(json), 'the JSON copy is serialisable');

// ---- the views tree
const flat = [
  { id: 1, parentId: null, component: 'RootView', type: 'View', label: '', context: 'app/primary_1', pageReference: 'caseInfo.content' },
  { id: 2, parentId: 1, component: 'DefaultForm', type: 'Template', label: '', context: 'app/primary_1', pageReference: '' },
  { id: 3, parentId: 2, component: 'TextInput', type: 'Field', label: 'First name', context: 'app/primary_1', pageReference: '' },
  { id: 4, parentId: 2, component: 'Dropdown', type: 'Field', label: 'Status', context: 'app/primary_1', pageReference: '' },
  { id: 5, parentId: null, component: 'Footer', type: 'Region', label: '', context: 'app/primary_1', pageReference: '' },
];
const nested = R.nestViews(flat);
assert.equal(nested.length, 2, 'two roots');
assert.equal(nested[0].children[0].children.length, 2, 'the form holds two fields');
assert.equal(R.countViews(nested), 5);
const filtered = R.nestViews(flat, 'first');
assert.equal(R.countViews(filtered), 3, 'a match keeps its ancestors: view, form and the field');
assert.equal(filtered[0].children[0].children[0].match, true);
assert.equal(filtered[0].match, false, 'an ancestor kept for the path is marked as not matching');
assert.equal(R.nestViews(flat, 'nothing like this').length, 0);
const containers = R.nestViews(flat, '', { containersOnly: true });
assert.equal(R.countViews(containers), 3, 'leaves are dropped: the view, the form and the footer root remain');
assert.equal(containers[0].children[0].children.length, 0, 'the form stays as a container; its fields are hidden');
assert.deepEqual(R.viewPath(flat, 3), ['RootView', 'DefaultForm', 'TextInput'], 'the path runs from the outermost component down');
assert.deepEqual(R.viewPath(flat, 5), ['Footer']);

// ---- support notes: only what was actually checked is claimed
assert.equal(R.supportNote('24.2.5').level, 'live');
assert.equal(R.supportNote('25.1.3').level, 'typings');
assert.equal(R.supportNote('26.1.0').level, 'typings');
assert.match(R.supportNote('26.1.0').text, /Not yet run live on a 26\.x app/, 'Pega 26 is not claimed as run live');
assert.equal(R.supportNote('27.1.0').level, 'untested');
assert.equal(R.supportNote(undefined).level, 'unknown');
assert.equal(R.supportNote('unknown (getPCoreVersion not available)').level, 'unknown');

// ---- TypeScript types from a recorded shape
const apiShape = {
  t: 'object', n: 3,
  props: {
    data: { t: 'array', len: 2, item: { t: 'object', n: 3, props: { id: { t: 'number' }, 'full-name': { t: 'string', opt: true }, tag: { t: 'union', of: [{ t: 'null' }, { t: 'string' }] } } } },
    count: { t: 'number' },
    meta: { t: 'object', n: 0, props: {} },
  },
};
const tsText = R.typesFrom(apiShape, 'DCustomersResponse');
assert.match(tsText, /export interface DCustomersResponseDataItem \{/, 'a nested object becomes its own named interface');
assert.match(tsText, /export interface DCustomersResponse \{\n {2}data: DCustomersResponseDataItem\[\];/, 'a list of objects is an array of that interface');
assert.match(tsText, /"full-name"\?: string;/, 'a key that is not an identifier is quoted, and an optional key gets a ?');
assert.match(tsText, /tag: string \| null;/, 'null goes last in a union');
assert.match(tsText, /meta: Record<string, never>;/, 'an empty object is an empty record');
assert.ok(tsText.indexOf('DataItem {') < tsText.indexOf('DCustomersResponse {'), 'children are declared before the root');
assert.equal(R.typesFrom({ t: 'array', len: 1, item: { t: 'object', n: 1, props: { a: { t: 'string' } } } }, 'List'), 'export interface ListItem {\n  a: string;\n}\n\nexport type List = ListItem[];', 'a root list becomes an alias of its item type');
assert.equal(R.typesFrom({ t: 'string' }, 'Plain'), 'export type Plain = string;');
assert.match(R.typesFrom({ t: 'object', n: 150, props: { a: { t: 'string' } } }, 'Wide'), /…and 149 more keys, not shown/, 'a cut-off object says so');
assert.equal(R.typesFrom({ t: 'object', deep: true }, 'Deep'), 'export type Deep = Record<string, unknown>;', 'a shape cut by the depth limit is a loose record');
assert.equal(R.typesFrom({ t: 'object', n: 1, props: { x: { t: 'truncated' } } }, 'T'), 'export interface T {\n  x: unknown;\n}', 'a cut-short shape is unknown');
const clash = R.typesFrom({ t: 'object', n: 2, props: { a: { t: 'object', n: 1, props: { x: { t: 'number' } } }, b: { t: 'object', n: 1, props: { x: { t: 'string' } } } } }, 'Root');
assert.equal((clash.match(/export interface /g) || []).length, 3, 'two different nested objects get three interfaces');
assert.match(R.typesFrom({ t: 'object', n: 1, props: { '1st': { t: 'string' } } }, '9lives'), /export interface T9lives \{/, 'a type name never starts with a digit');

// ---- mock.ts from a recorded value
const rec = { data: [{ id: 1, 'full-name': 'Ada', tag: null }, { id: 2, tag: 'x' }, { id: 3, tag: 'y' }, { id: 4, tag: 'z' }], count: 4, meta: {} };
const mock = R.mockFrom(rec, apiShape, { name: 'DCustomersResponse' });
assert.match(mock, /^\/\/ Mock data for DCustomersResponse, recorded with Lens\./);
assert.match(mock, /The values below are real\. Check them for anything private/, 'a mock with real values says so');
assert.match(mock, /export const mock: DCustomersResponse = \{/, 'the mock is typed with the generated interface');
assert.match(mock, /"full-name": "Ada"/);
assert.match(mock, /\/\/ …1 more item, not included/, 'a list is cut to three items and says how many were left out');
assert.equal((mock.match(/id: \d/g) || []).length, 3);
const hidden = R.mockFrom(rec, apiShape, { name: 'DCustomersResponse', hide: true });
assert.match(hidden, /Values were hidden/, 'a hidden mock says so');
assert.ok(!hidden.includes('Ada') && !hidden.includes('"x"'), 'no real value appears when values are hidden');
assert.match(hidden, /id: 0,/, 'numbers become 0');
assert.match(hidden, /tag: null,/, 'null stays null');
const secrets = R.mockFrom({ user: 'ada', authToken: 'abc123', session: { id: 's-1' }, apiKey: 'k' }, null, { name: 'Login' });
assert.ok(!secrets.includes('abc123') && !secrets.includes('"k"'), 'secret-looking keys are always replaced');
assert.match(secrets, /authToken: "\[redacted\]"/);
assert.match(secrets, /export const mock = \{/, 'with no shape the mock is not annotated');
assert.match(R.mockFrom({ f: { $: 'fn', name: 'go' }, u: { $: 'undefined' }, c: { $: 'circular' } }, null), /f: \(\) => undefined,\n {2}u: undefined,\n {2}c: null \/\* not recorded \*\//, "the hook's markers become code");
assert.match(R.mockFrom({ rows: [1, 2, { $: 'more', n: 28 }] }, null), /…28 more items, not included/, 'a list the hook already cut keeps its count');

// ---- readable type names
assert.equal(R.typeNameFor({ net: { url: 'https://h/prweb/api/v1/data_views/D_Customers' } }, 'res'), 'DCustomersResponse');
assert.equal(R.typeNameFor({ net: { url: 'https://h/prweb/api/v1/cases/OPS-CASE-12/assignments' } }, 'req'), 'AssignmentsRequest');
assert.equal(R.typeNameFor({ net: { url: 'https://h/prweb/api/v1/cases/OPS-CASE-12' } }, 'res'), 'CasesResponse', 'a case id is not used as a name');
assert.equal(R.typeNameFor(dataCall, 'res'), 'DCustomersOutput', 'a data call is named for its data page');
assert.equal(R.typeNameFor(ev({ kind: 'pcore', name: 'PCore.getEnvironmentInfo().getTimeZone' }), 'args'), 'GetTimeZoneInput');

console.log('ok: report logic, all assertions passed');
