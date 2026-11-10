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
const all = R.issuesMarkdown(found, { tool: 'Peek', version: '0.2.0', origin: 'https://pega.example.test', valuesHidden: false, now: 1700000100000 }, { events });
assert.match(all, /^# Pega Constellation X-Ray: issues/);
assert.match(all, /Found: 3 errors, 1 check, 1 note/);
assert.equal((all.match(/^### /gm) || []).length, found.length, 'every issue is in the report');
const json = R.issuesJson(found, { version: '0.2.0', now: 1700000100000 }, { events });
assert.equal(json.issues.length, found.length);
assert.doesNotThrow(() => JSON.stringify(json), 'the JSON copy is serialisable');

console.log('ok: report logic, all assertions passed');
