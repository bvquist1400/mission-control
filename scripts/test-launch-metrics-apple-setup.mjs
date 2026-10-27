#!/usr/bin/env node
// Offline tests for scripts/launch-metrics/apple-create-requests.mjs.
// Every key here is generated on the fly; fetch is always a mock. Nothing
// talks to Apple or any other network service.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APPLE_API_ORIGIN,
  MAX_TOKEN_LIFETIME_SECONDS,
  createAppleJwt,
  run,
} from './launch-metrics/apple-create-requests.mjs';

const KEY_ID = 'ABCDE12345';
const ISSUER = '57246542-96fe-1a63-e053-0824d011072a';
const APP_ID = '1476097583';
const BODY_MARKER = 'BODY_MARKER_must_never_be_printed';
const HEADER_MARKER = 'HEADER_MARKER_must_never_be_printed';

const tempRoots = [];
process.on('exit', () => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-setup-test-'));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function makeKeyFile({ mode = 0o600, dir = makeTempDir(), pem } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const text = pem ?? privateKey.export({ type: 'pkcs8', format: 'pem' });
  const file = path.join(dir, 'AuthKey_TEST.p8');
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, mode);
  return { file, text, publicKey };
}

function keyBodyLines(pemText) {
  return pemText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('-----'));
}

function requestItem(id, accessType, stoppedDueToInactivity = false) {
  return {
    type: 'analyticsReportRequests',
    id,
    attributes: { accessType, stoppedDueToInactivity, note: BODY_MARKER },
    relationships: { reports: { links: { related: `${APPLE_API_ORIGIN}/v1/analyticsReportRequests/${id}/reports?m=${BODY_MARKER}` } } },
    links: { self: `${APPLE_API_ORIGIN}/v1/analyticsReportRequests/${id}` },
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': HEADER_MARKER },
  });
}

// `total` is Apple's count for the WHOLE list (all pages), not this page.
function listBody(items, next, total = items.length) {
  return {
    data: items,
    links: { self: `${APPLE_API_ORIGIN}/v1/apps/${APP_ID}/analyticsReportRequests`, ...(next ? { next } : {}) },
    meta: { paging: { total, limit: 200 } },
  };
}

function appleError(status, code) {
  return jsonResponse(status, {
    errors: [{ id: 'err-1', status: String(status), code, title: `TITLE ${BODY_MARKER}`, detail: `DETAIL ${BODY_MARKER}` }],
  });
}

// A scripted fetch: answers GETs with `existing` (or a custom handler), and
// POSTs by echoing a created request with a fresh id.
function mockFetch({ existing = [], onGet, onPost } = {}) {
  const calls = [];
  let created = 0;
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body, redirect: init.redirect, signal: init.signal };
    calls.push(call);
    if (call.method === 'GET') {
      if (onGet) return onGet(call, calls);
      return jsonResponse(200, listBody(existing));
    }
    if (call.method === 'POST') {
      if (onPost) return onPost(call, calls);
      const parsed = JSON.parse(call.body);
      created += 1;
      return jsonResponse(201, {
        data: requestItem(`new-request-${created}`, parsed.data.attributes.accessType, false),
        links: { self: `${APPLE_API_ORIGIN}/v1/analyticsReportRequests/new-request-${created}` },
      });
    }
    throw new Error(`unexpected method ${call.method}`);
  };
  return { fetchImpl, calls };
}

async function runCli(args, { fetchImpl, now } = {}) {
  const out = [];
  const err = [];
  const usedFetch = fetchImpl ?? mockFetch().fetchImpl;
  const code = await run(args, {
    fetch: usedFetch,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    now,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function goArgs(keyFile, extra = []) {
  return ['--key', keyFile, '--key-id', KEY_ID, '--issuer', ISSUER, '--app-id', APP_ID, '--go', ...extra];
}

function checkArgs(keyFile, extra = []) {
  return ['--key', keyFile, '--key-id', KEY_ID, '--issuer', ISSUER, '--app-id', APP_ID, '--check', ...extra];
}

// After a POST with an unknown outcome the message must say Apple may or may
// not have created it, say NOT to run --go again, point at the PM, and never
// promise that a re-run is safe or won't duplicate.
const RERUN_ADVICE = /run (it |the same command |the script )?again(?! with --go)|re-?run (it|is|when)|won'?t (make a )?duplicate|is safe|no duplicate/i;
function assertUncertainCreateMessage(text) {
  assert.match(text, /Apple may or may not have created it/);
  assert.match(text, /Do NOT run it with --go again/);
  assert.match(text, /Tell the PM/);
  assert.ok(!RERUN_ADVICE.test(text), `re-run advice after an uncertain create: ${text}`);
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function assertNoLeaks(result, { keyText, tokens = [] }) {
  const all = `${result.out}\n${result.err}`;
  assert.ok(!all.includes(BODY_MARKER), 'response body text leaked into output');
  assert.ok(!all.includes(HEADER_MARKER), 'response header leaked into output');
  if (keyText) {
    for (const line of keyBodyLines(keyText)) {
      assert.ok(!all.includes(line), 'private key text leaked into output');
    }
    assert.ok(!all.includes('PRIVATE KEY'), 'PEM armour leaked into output');
  }
  for (const token of tokens) {
    assert.ok(!all.includes(token), 'JWT leaked into output');
    for (const part of token.split('.')) assert.ok(!all.includes(part), 'JWT segment leaked into output');
  }
  assert.ok(!/Bearer/i.test(all), 'Authorization header leaked into output');
}

function tokensFrom(calls) {
  return calls.map((call) => String(call.headers.Authorization ?? call.headers.authorization ?? '').replace(/^Bearer /, '')).filter(Boolean);
}

// ---------------------------------------------------------------- JWT

test('JWT: ES256 header, Apple claims, lifetime <= 20 minutes, signature verifies', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const nowMs = Date.UTC(2026, 9, 26, 15, 0, 0);
  const token = createAppleJwt({ privateKey, keyId: KEY_ID, issuerId: ISSUER, nowMs });
  const parts = token.split('.');
  assert.equal(parts.length, 3);

  const header = decodeSegment(parts[0]);
  assert.deepEqual(header, { alg: 'ES256', kid: KEY_ID, typ: 'JWT' });

  const payload = decodeSegment(parts[1]);
  assert.deepEqual(Object.keys(payload).sort(), ['aud', 'exp', 'iat', 'iss']);
  assert.equal(payload.iss, ISSUER);
  assert.equal(payload.aud, 'appstoreconnect-v1');
  assert.equal(payload.iat, Math.floor(nowMs / 1000));
  assert.ok(payload.exp > payload.iat);
  assert.ok(payload.exp - payload.iat <= 20 * 60, 'token lifetime must be at most 20 minutes');
  assert.ok(MAX_TOKEN_LIFETIME_SECONDS <= 20 * 60);

  const signature = Buffer.from(parts[2], 'base64url');
  assert.equal(signature.length, 64, 'ES256 JOSE signature is raw r||s (64 bytes), not DER');
  const ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
  assert.ok(ok, 'signature must verify with the matching public key');

  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey;
  const wrong = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: other, dsaEncoding: 'ieee-p1363' }, signature);
  assert.ok(!wrong, 'signature must not verify with an unrelated key');
});

test('JWT sent to Apple is a Bearer token for the configured key id, on Apple\'s host only', async () => {
  const { file, publicKey } = makeKeyFile();
  const { fetchImpl, calls } = mockFetch({ existing: [requestItem('r-on', 'ONGOING'), requestItem('r-snap', 'ONE_TIME_SNAPSHOT')] });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 0, result.err);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(new URL(call.url).origin, APPLE_API_ORIGIN);
  assert.equal(new URL(call.url).pathname, `/v1/apps/${APP_ID}/analyticsReportRequests`);
  assert.equal(call.redirect, 'error', 'redirects must not be followed with the token attached');
  assert.ok(call.signal, 'requests carry a timeout signal');
  const [token] = tokensFrom(calls);
  const [h, p, s] = token.split('.');
  assert.equal(decodeSegment(h).kid, KEY_ID);
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

// ---------------------------------------------------------------- dry run

test('dry run is the default without --go and makes zero fetch calls', async () => {
  const { file, text } = makeKeyFile();
  const { fetchImpl, calls } = mockFetch();
  const args = ['--key', file, '--key-id', KEY_ID, '--issuer', ISSUER, '--app-id', APP_ID];
  const result = await runCli(args, { fetchImpl });
  assert.equal(result.code, 0, result.err);
  assert.equal(calls.length, 0);
  assert.match(result.out, /dry run/i);
  assert.match(result.out, /no requests were sent/i);
  assertNoLeaks(result, { keyText: text });
});

test('explicit --dry-run makes zero fetch calls', async () => {
  const { file, text } = makeKeyFile();
  const { fetchImpl, calls } = mockFetch();
  const args = ['--key', file, '--key-id', KEY_ID, '--issuer', ISSUER, '--app-id', APP_ID, '--dry-run'];
  const result = await runCli(args, { fetchImpl });
  assert.equal(result.code, 0, result.err);
  assert.equal(calls.length, 0);
  assertNoLeaks(result, { keyText: text });
});

test('--go together with --dry-run is refused before any fetch', async () => {
  const { file } = makeKeyFile();
  const { fetchImpl, calls } = mockFetch();
  const result = await runCli(goArgs(file, ['--dry-run']), { fetchImpl });
  assert.equal(result.code, 2);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- --go behaviour

test('existing active ONGOING and existing snapshot: no POST, both reported as already existed', async () => {
  const { file, text } = makeKeyFile();
  const { fetchImpl, calls } = mockFetch({ existing: [requestItem('r-on-1', 'ONGOING'), requestItem('r-snap-1', 'ONE_TIME_SNAPSHOT')] });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 0, result.err);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  assert.match(result.out, /r-on-1.*ONGOING.*already existed.*stopped: no/);
  assert.match(result.out, /r-snap-1.*ONE_TIME_SNAPSHOT.*already existed/);
  assertNoLeaks(result, { keyText: text, tokens: tokensFrom(calls) });
});

test('existing active ONGOING only: POSTs just the one-time snapshot', async () => {
  const { file, text } = makeKeyFile();
  const { fetchImpl, calls } = mockFetch({ existing: [requestItem('r-on-1', 'ONGOING')] });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 0, result.err);
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].body).data.attributes.accessType, 'ONE_TIME_SNAPSHOT');
  assert.match(result.out, /r-on-1.*ONGOING.*already existed/);
  assert.match(result.out, /new-request-1.*ONE_TIME_SNAPSHOT.*created/);
  assertNoLeaks(result, { keyText: text, tokens: tokensFrom(calls) });
});

test('no requests yet: POSTs ONGOING then ONE_TIME_SNAPSHOT with Apple\'s documented body', async () => {
  const { file, text } = makeKeyFile();
  const { fetchImpl, calls } = mockFetch({ existing: [] });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 0, result.err);
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 2);
  for (const post of posts) {
    assert.equal(post.url, `${APPLE_API_ORIGIN}/v1/analyticsReportRequests`);
    assert.equal(post.headers['Content-Type'], 'application/json');
    assert.equal(post.redirect, 'error');
  }
  assert.deepEqual(JSON.parse(posts[0].body), {
    data: {
      type: 'analyticsReportRequests',
      attributes: { accessType: 'ONGOING' },
      relationships: { app: { data: { type: 'apps', id: APP_ID } } },
    },
  });
  assert.equal(JSON.parse(posts[1].body).data.attributes.accessType, 'ONE_TIME_SNAPSHOT');
  assert.match(result.out, /new-request-1.*ONGOING.*created.*stopped: no/);
  assert.match(result.out, /new-request-2.*ONE_TIME_SNAPSHOT.*created/);
  assertNoLeaks(result, { keyText: text, tokens: tokensFrom(calls) });
});

test('stopped ONGOING request: creates a new ONGOING and says the old one was stopped', async () => {
  const { file, text } = makeKeyFile();
  const { fetchImpl, calls } = mockFetch({ existing: [requestItem('r-old', 'ONGOING', true), requestItem('r-snap-1', 'ONE_TIME_SNAPSHOT')] });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 0, result.err);
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].body).data.attributes.accessType, 'ONGOING');
  assert.match(result.out, /r-old.*ONGOING.*stopped: yes/);
  assert.match(result.out, /stopped due to inactivity/i);
  assert.match(result.out, /new-request-1.*ONGOING.*created/);
  assertNoLeaks(result, { keyText: text, tokens: tokensFrom(calls) });
});

test('a stopped ONE_TIME_SNAPSHOT still counts as existing (no second snapshot)', async () => {
  const { file } = makeKeyFile();
  const { fetchImpl, calls } = mockFetch({ existing: [requestItem('r-on', 'ONGOING'), requestItem('r-snap', 'ONE_TIME_SNAPSHOT', true)] });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 0, result.err);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('GET follows Apple paging links on Apple\'s host only', async () => {
  const { file } = makeKeyFile();
  const next = `${APPLE_API_ORIGIN}/v1/apps/${APP_ID}/analyticsReportRequests?cursor=abc&limit=200`;
  const { fetchImpl, calls } = mockFetch({
    onGet: (call) => (call.url.includes('cursor=abc')
      ? jsonResponse(200, listBody([requestItem('r-snap', 'ONE_TIME_SNAPSHOT')], undefined, 2))
      : jsonResponse(200, listBody([requestItem('r-on', 'ONGOING')], next, 2))),
  });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 0, result.err);
  assert.equal(calls.filter((c) => c.method === 'GET').length, 2);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('a paging link to another host is never fetched (token stays on Apple\'s host)', async () => {
  const { file } = makeKeyFile();
  const { fetchImpl, calls } = mockFetch({
    onGet: () => jsonResponse(200, listBody([requestItem('r-on', 'ONGOING')], 'https://evil.example.com/steal')),
  });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 1);
  assert.ok(calls.every((c) => new URL(c.url).origin === APPLE_API_ORIGIN));
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  assert.ok(!result.err.includes('evil.example.com'));
});

test('a malformed list response fails closed without POSTing', async () => {
  const { file } = makeKeyFile();
  const { fetchImpl, calls } = mockFetch({ onGet: () => jsonResponse(200, { data: 'nope', note: BODY_MARKER }) });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 1);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  assertNoLeaks(result, {});
});

// A listed request the script can't read (no attributes, no accessType, an
// accessType it doesn't know) must stop the run before any POST: guessing
// "nothing exists" would ask Apple for duplicates with an Admin key.
for (const [label, attributes] of [
  ['attributes missing', undefined],
  ['attributes null', null],
  ['attributes not an object', 'ONGOING'],
  ['attributes an array', ['ONGOING']],
  ['accessType missing', { stoppedDueToInactivity: false }],
  ['accessType lower-case "ongoing"', { accessType: 'ongoing', stoppedDueToInactivity: false }],
  ['accessType unknown value', { accessType: 'WEEKLY', stoppedDueToInactivity: false }],
  ['accessType not a string', { accessType: 1, stoppedDueToInactivity: false }],
  ['stoppedDueToInactivity not a boolean', { accessType: 'ONGOING', stoppedDueToInactivity: 'true' }],
]) {
  test(`a listed request with ${label} stops the run before any POST (exit 1)`, async () => {
    const { file, text } = makeKeyFile();
    const item = { type: 'analyticsReportRequests', id: 'r-odd', ...(attributes === undefined ? {} : { attributes }) };
    const { fetchImpl, calls } = mockFetch({ existing: [item] });
    const result = await runCli(goArgs(file), { fetchImpl });
    assert.equal(result.code, 1, result.out);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'no POST after an unreadable list item');
    assert.equal(result.out, '', 'nothing reported as existing or created');
    assert.match(result.err, /while listing report requests was not in the expected shape/);
    assert.match(result.err, /before creating anything/);
    assert.ok(!/ongoing|WEEKLY|r-odd/.test(result.err), 'the odd value is not echoed');
    assertNoLeaks(result, { keyText: text, tokens: tokensFrom(calls) });
  });
}

test('one unreadable item among readable ones still stops the run before any POST', async () => {
  const { file } = makeKeyFile();
  const odd = { type: 'analyticsReportRequests', id: 'r-odd', attributes: { stoppedDueToInactivity: false } };
  const { fetchImpl, calls } = mockFetch({ existing: [requestItem('r-on', 'ONGOING', true), odd] });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 1);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('a listed request with stoppedDueToInactivity absent reads as not stopped (no new ONGOING)', async () => {
  const { file } = makeKeyFile();
  const onGoing = { type: 'analyticsReportRequests', id: 'r-on', attributes: { accessType: 'ONGOING' } };
  const { fetchImpl, calls } = mockFetch({ existing: [onGoing, requestItem('r-snap', 'ONE_TIME_SNAPSHOT')] });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 0, result.err);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  assert.match(result.out, /r-on: ONGOING, already existed, stopped: no/);
});

test('a paging link carrying a user name or password is never fetched', async () => {
  for (const next of [
    `https://user:pw@api.appstoreconnect.apple.com/v1/apps/${APP_ID}/analyticsReportRequests?cursor=x`,
    `https://user@api.appstoreconnect.apple.com/v1/apps/${APP_ID}/analyticsReportRequests?cursor=x`,
    `https://:pw@api.appstoreconnect.apple.com/v1/apps/${APP_ID}/analyticsReportRequests?cursor=x`,
  ]) {
    const { file } = makeKeyFile();
    const { fetchImpl, calls } = mockFetch({ onGet: () => jsonResponse(200, listBody([requestItem('r-on', 'ONGOING')], next)) });
    const result = await runCli(goArgs(file), { fetchImpl });
    assert.equal(result.code, 1, next);
    assert.equal(calls.length, 1, `only the first GET is sent, not ${next}`);
    assert.ok(calls.every((c) => !new URL(c.url).username && !new URL(c.url).password));
    assert.ok(!result.err.includes('user') && !result.err.includes('pw'));
  }
});

// After a POST has gone out, Apple may have made the request even when the
// reply is odd or lost. The message must say so and must NOT advise a re-run
// (a fresh list can't prove the create has finished); --check reads only.
test('POST accepted but reply in an odd shape: says Apple may or may not have created it, no re-run advice; --check sees it without POSTing', async () => {
  const { file } = makeKeyFile();
  const server = [];
  const { fetchImpl, calls } = mockFetch({
    onGet: () => jsonResponse(200, listBody(server.slice())),
    onPost: (call) => {
      const accessType = JSON.parse(call.body).data.attributes.accessType;
      server.push(requestItem(`srv-${server.length + 1}`, accessType));
      return jsonResponse(201, { data: { type: 'analyticsReportRequests', id: 'has spaces!' } });
    },
  });
  const first = await runCli(goArgs(file), { fetchImpl });
  assert.equal(first.code, 1);
  assert.match(first.err, /while creating the ONGOING request was not in the expected shape/);
  assertUncertainCreateMessage(first.err);
  assert.ok(!/without making further changes/.test(first.err));
  assert.ok(!first.err.includes('has spaces'));
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1, 'no snapshot POST after the uncertain ONGOING');

  const check = await runCli(checkArgs(file), { fetchImpl });
  assert.equal(check.code, 0, check.err);
  assert.match(check.out, /srv-1: ONGOING, exists, stopped: no/);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1, '--check sent no POST');
});

test('POST reply naming a different access type than requested is a shape error', async () => {
  const { file } = makeKeyFile();
  const { fetchImpl } = mockFetch({
    existing: [requestItem('r-snap', 'ONE_TIME_SNAPSHOT')],
    onPost: () => jsonResponse(201, { data: requestItem('new-1', 'ONE_TIME_SNAPSHOT') }),
  });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 1);
  assert.match(result.err, /creating the ONGOING request was not in the expected shape/);
  assertUncertainCreateMessage(result.err);
});

test('POST reply without attributes still reports the requested access type', async () => {
  const { file } = makeKeyFile();
  const { fetchImpl } = mockFetch({
    existing: [requestItem('r-snap', 'ONE_TIME_SNAPSHOT')],
    onPost: () => jsonResponse(201, { data: { type: 'analyticsReportRequests', id: 'new-1' } }),
  });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /new-1: ONGOING, created, stopped: no/);
});

test('network failure or server error on a POST says Apple may or may not have created it', async () => {
  for (const onPost of [
    () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); },
    () => appleError(503, 'SERVICE_UNAVAILABLE'),
  ]) {
    const { file } = makeKeyFile();
    const { fetchImpl } = mockFetch({ existing: [], onPost });
    const result = await runCli(goArgs(file), { fetchImpl });
    assert.equal(result.code, 1);
    assert.match(result.err, /creating the ONGOING request/);
    assertUncertainCreateMessage(result.err);
  }
});

test('a 4xx on a POST does not claim Apple may have created it', async () => {
  const { file } = makeKeyFile();
  const { fetchImpl } = mockFetch({ existing: [], onPost: () => appleError(403, 'FORBIDDEN_ERROR') });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 1);
  assert.ok(!/may (already|or may not) have created/.test(result.err));
});

test('a network failure while listing says nothing was created', async () => {
  const { file } = makeKeyFile();
  const fetchImpl = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 1);
  assert.match(result.err, /network error ENOTFOUND/);
  assert.match(result.err, /Nothing else was sent/);
  assert.ok(!/may (already|or may not) have created/.test(result.err));
});

// ---------------------------------------------------------------- fix round 2: uncertain creates (F1)

// Codex's delayed-completion sequence: the ONGOING POST reaches Apple, the reply
// times out, and Apple finishes creating it only later. A re-run at that point
// would list the old snapshot only and POST a second ONGOING, so the first run
// must stop and must not advise running --go again.
test('F1: timed-out ONGOING create still pending at Apple: exit 1, one POST, no re-run advice', async () => {
  const { file, text } = makeKeyFile();
  const server = [requestItem('existing-snap', 'ONE_TIME_SNAPSHOT')];
  const { fetchImpl, calls } = mockFetch({
    onGet: () => jsonResponse(200, listBody(server.slice())),
    onPost: () => { throw new DOMException('Synthetic response timeout; Apple still processing', 'TimeoutError'); },
  });
  const first = await runCli(goArgs(file), { fetchImpl });
  assert.equal(first.code, 1);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1, 'exactly one POST, nothing after the uncertain one');
  assert.match(first.err, /network error TIMEOUT/);
  assert.match(first.err, /creating the ONGOING request/);
  assertUncertainCreateMessage(first.err);
  assert.ok(!/created/.test(first.out.replace(/may or may not have created/g, '')), 'nothing reported as created');
  assert.ok(!/^Done/m.test(first.out), 'no Done line');
  assertNoLeaks(first, { keyText: text, tokens: tokensFrom(calls) });

  // Apple's pending create completes later; the PM's read-only check shows it
  // and still sends no POST.
  server.push(requestItem('first-on', 'ONGOING'));
  const check = await runCli(checkArgs(file), { fetchImpl });
  assert.equal(check.code, 0, check.err);
  assert.match(check.out, /first-on: ONGOING, exists, stopped: no/);
  assert.match(check.out, /existing-snap: ONE_TIME_SNAPSHOT, exists/);
  assert.match(check.out, /Nothing was created or changed/);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1, '--check added no POST');
});

// Every way a POST outcome can be unknown gets the same stop message, and no
// second POST is sent in that run.
for (const [label, onPost] of [
  ['network reset', () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); }],
  ['timeout', () => { throw new DOMException('timeout', 'TimeoutError'); }],
  ['HTTP 500', () => appleError(500, 'INTERNAL_ERROR')],
  ['HTTP 502 with a non-JSON body', () => new Response(`<html>${BODY_MARKER}</html>`, { status: 502 })],
  ['HTTP 503', () => appleError(503, 'SERVICE_UNAVAILABLE')],
  ['201 with a non-JSON body', () => new Response(`not json ${BODY_MARKER}`, { status: 201 })],
  ['201 without data', () => jsonResponse(201, { links: {} })],
  ['201 with attributes: null', () => jsonResponse(201, { data: { type: 'analyticsReportRequests', id: 'new-1', attributes: null } })],
]) {
  test(`F1: uncertain create (${label}): exit 1, one POST, "may or may not", do not re-run --go`, async () => {
    const { file, text } = makeKeyFile();
    const { fetchImpl, calls } = mockFetch({ existing: [], onPost });
    const result = await runCli(goArgs(file), { fetchImpl });
    assert.equal(result.code, 1);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1, 'no snapshot POST after the uncertain ONGOING');
    assert.match(result.err, /creating the ONGOING request/);
    assertUncertainCreateMessage(result.err);
    assertNoLeaks(result, { keyText: text, tokens: tokensFrom(calls) });
  });
}

test('F1: an uncertain snapshot create (after a confirmed ONGOING) gets the same stop message', async () => {
  const { file } = makeKeyFile();
  const { fetchImpl, calls } = mockFetch({
    existing: [requestItem('r-on', 'ONGOING')],
    onPost: () => appleError(503, 'SERVICE_UNAVAILABLE'),
  });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 1);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  assert.match(result.err, /creating the ONE_TIME_SNAPSHOT request/);
  assertUncertainCreateMessage(result.err);
});

// Opus fr1 follow-up: the reply to our own POST may leave attributes out, but
// attributes: null is not "left out" and must not be read as the requested type.
test('POST reply with attributes: null is a shape error (not read as the requested type)', async () => {
  const { file } = makeKeyFile();
  const { fetchImpl } = mockFetch({
    existing: [requestItem('r-snap', 'ONE_TIME_SNAPSHOT')],
    onPost: () => jsonResponse(201, { data: { type: 'analyticsReportRequests', id: 'new-1', attributes: null } }),
  });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 1);
  assert.match(result.err, /creating the ONGOING request was not in the expected shape/);
  assert.ok(!/new-1: ONGOING, created/.test(result.out));
  assertUncertainCreateMessage(result.err);
});

// ---------------------------------------------------------------- --check (read-only)

for (const [label, existing] of [
  ['no requests at all', []],
  ['only a stopped ONGOING', [requestItem('r-old', 'ONGOING', true)]],
  ['only a snapshot', [requestItem('r-snap', 'ONE_TIME_SNAPSHOT')]],
]) {
  test(`--check with ${label}: lists, exit 0, zero POSTs (where --go would create)`, async () => {
    const { file, text } = makeKeyFile();
    const { fetchImpl, calls } = mockFetch({ existing });
    const result = await runCli(checkArgs(file), { fetchImpl });
    assert.equal(result.code, 0, result.err);
    assert.equal(calls.filter((c) => c.method !== 'GET').length, 0, 'no POST or other write');
    assert.equal(calls.length, 1);
    assert.match(result.out, new RegExp(`Check only: ${existing.length} report request`));
    for (const item of existing) assert.match(result.out, new RegExp(`${item.id}: ${item.attributes.accessType}, exists`));
    assert.ok(!/created/.test(result.out.replace('Nothing was created', '')));
    assertNoLeaks(result, { keyText: text, tokens: tokensFrom(calls) });
  });
}

test('--check follows paging and applies the same completeness checks (incomplete list: exit 1)', async () => {
  const { file } = makeKeyFile();
  const next = `${APPLE_API_ORIGIN}/v1/apps/${APP_ID}/analyticsReportRequests?cursor=2`;
  const paged = mockFetch({
    onGet: (call) => (call.url.includes('cursor=2')
      ? jsonResponse(200, listBody([requestItem('r-snap', 'ONE_TIME_SNAPSHOT')], undefined, 2))
      : jsonResponse(200, listBody([requestItem('r-on', 'ONGOING')], next, 2))),
  });
  const ok = await runCli(checkArgs(file), { fetchImpl: paged.fetchImpl });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /Check only: 2 report requests/);
  assert.equal(paged.calls.length, 2);

  const short = mockFetch({ onGet: () => jsonResponse(200, listBody([requestItem('r-on', 'ONGOING')], undefined, 2)) });
  const bad = await runCli(checkArgs(file), { fetchImpl: short.fetchImpl });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /incomplete/);
  assert.equal(short.calls.filter((c) => c.method !== 'GET').length, 0);
});

test('--check with an Apple error exits 1 and sends nothing else', async () => {
  const { file } = makeKeyFile();
  const { fetchImpl, calls } = mockFetch({ onGet: () => appleError(401, 'NOT_AUTHORIZED') });
  const result = await runCli(checkArgs(file), { fetchImpl });
  assert.equal(result.code, 1);
  assert.match(result.err, /HTTP 401/);
  assert.equal(calls.length, 1);
});

test('--check together with --go or --dry-run is refused before any fetch; key refusals apply to --check', async () => {
  const { file } = makeKeyFile();
  for (const extra of [['--go'], ['--dry-run']]) {
    const { fetchImpl, calls } = mockFetch();
    const result = await runCli(checkArgs(file, extra), { fetchImpl });
    assert.equal(result.code, 2, extra.join(' '));
    assert.equal(calls.length, 0);
  }
  const loose = makeKeyFile({ mode: 0o644 });
  const { fetchImpl, calls } = mockFetch();
  const refused = await runCli(checkArgs(loose.file), { fetchImpl });
  assert.equal(refused.code, 2);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- fix round 2: provably complete list (F2)

function rawListOnce(body) {
  return mockFetch({ onGet: () => jsonResponse(200, body) });
}
const SNAP = requestItem('existing-snap', 'ONE_TIME_SNAPSHOT');

// Codex's three bodies: one item returned, Apple says there are two.
for (const links of [[], 'invalid', { next: null }]) {
  test(`F2: total 2 with one item and links ${JSON.stringify(links)}: exit 1, zero POSTs`, async () => {
    const { file } = makeKeyFile();
    const { fetchImpl, calls } = rawListOnce({ data: [SNAP], links, meta: { paging: { total: 2, limit: 1 } } });
    const result = await runCli(goArgs(file), { fetchImpl });
    assert.equal(result.code, 1, result.out);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
    assert.match(result.err, /before creating anything/);
    assert.equal(result.out, '', 'nothing reported as existing before the list is proven complete');
  });
}

test('F2 control: complete list (one item, total 1, next null) still creates exactly one ONGOING', async () => {
  const { file } = makeKeyFile();
  const { fetchImpl, calls } = rawListOnce({ data: [SNAP], links: { next: null }, meta: { paging: { total: 1, limit: 200 } } });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 0, result.err);
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].body).data.attributes.accessType, 'ONGOING');
});

test('F2 control: no links and no meta at all reads as one complete page', async () => {
  const { file } = makeKeyFile();
  const { fetchImpl, calls } = rawListOnce({ data: [requestItem('r-on', 'ONGOING'), SNAP] });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 0, result.err);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('F2 control: valid multi-page list with no total, then with the whole-list total on each page', async () => {
  const { file } = makeKeyFile();
  const next = `${APPLE_API_ORIGIN}/v1/apps/${APP_ID}/analyticsReportRequests?cursor=2`;
  for (const meta of [undefined, { paging: { total: 2, limit: 1 } }]) {
    const { fetchImpl, calls } = mockFetch({
      onGet: (call) => jsonResponse(200, call.url.includes('cursor=2')
        ? { data: [SNAP], links: { next: null }, ...(meta ? { meta } : {}) }
        : { data: [requestItem('r-on', 'ONGOING')], links: { next }, ...(meta ? { meta } : {}) }),
    });
    const result = await runCli(goArgs(file), { fetchImpl });
    assert.equal(result.code, 0, result.err);
    assert.equal(calls.filter((c) => c.method === 'GET').length, 2);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  }
});

for (const [label, body] of [
  ['links null', { data: [SNAP], links: null }],
  ['links an array', { data: [SNAP], links: [] }],
  ['links a string', { data: [SNAP], links: 'invalid' }],
  ['links a number', { data: [SNAP], links: 5 }],
  ['links.next a number', { data: [SNAP], links: { next: 5 } }],
  ['links.next an object', { data: [SNAP], links: { next: {} } }],
  ['links.next an array', { data: [SNAP], links: { next: [] } }],
  ['links.next true', { data: [SNAP], links: { next: true } }],
  ['links.next an empty string', { data: [SNAP], links: { next: '' } }],
  ['meta a string', { data: [SNAP], meta: 'x' }],
  ['meta.paging an array', { data: [SNAP], meta: { paging: [] } }],
  ['total a string', { data: [SNAP], meta: { paging: { total: '1' } } }],
  ['total negative', { data: [SNAP], meta: { paging: { total: -1 } } }],
  ['total a fraction', { data: [SNAP], meta: { paging: { total: 1.5 } } }],
  ['total null', { data: [SNAP], meta: { paging: { total: null } } }],
  ['the same id twice on one page', { data: [SNAP, SNAP], meta: { paging: { total: 2 } } }],
]) {
  test(`F2: list with ${label} is a shape error: exit 1, zero POSTs`, async () => {
    const { file } = makeKeyFile();
    const { fetchImpl, calls } = rawListOnce(body);
    const result = await runCli(goArgs(file), { fetchImpl });
    assert.equal(result.code, 1, result.out);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
    assert.match(result.err, /while listing report requests was not in the expected shape\. Stopped before creating anything/);
  });
}

for (const [label, body] of [
  ['no links, total 2, one item', { data: [SNAP], meta: { paging: { total: 2 } } }],
  ['links with self only, total 3, one item', { data: [SNAP], links: { self: `${APPLE_API_ORIGIN}/x` }, meta: { paging: { total: 3 } } }],
  ['total 0 but one item', { data: [SNAP], meta: { paging: { total: 0 } } }],
  ['empty list, total 1', { data: [], links: { next: null }, meta: { paging: { total: 1 } } }],
]) {
  test(`F2: ${label}: incomplete, exit 1, zero POSTs`, async () => {
    const { file } = makeKeyFile();
    const { fetchImpl, calls } = rawListOnce(body);
    const result = await runCli(goArgs(file), { fetchImpl });
    assert.equal(result.code, 1, result.out);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
    assert.match(result.err, /list of report requests was incomplete/);
    assert.match(result.err, /Stopped before creating anything\. Tell the PM\./);
  });
}

test('F2: the same id on two pages, or totals that disagree between pages: exit 1, zero POSTs', async () => {
  const next = `${APPLE_API_ORIGIN}/v1/apps/${APP_ID}/analyticsReportRequests?cursor=2`;
  for (const [first, second] of [
    [{ data: [SNAP], links: { next }, meta: { paging: { total: 2 } } }, { data: [SNAP], meta: { paging: { total: 2 } } }],
    [{ data: [SNAP], links: { next }, meta: { paging: { total: 2 } } }, { data: [requestItem('r-on', 'ONGOING')], meta: { paging: { total: 3 } } }],
  ]) {
    const { file } = makeKeyFile();
    const { fetchImpl, calls } = mockFetch({ onGet: (call) => jsonResponse(200, call.url.includes('cursor=2') ? second : first) });
    const result = await runCli(goArgs(file), { fetchImpl });
    assert.equal(result.code, 1, result.out);
    assert.equal(calls.filter((c) => c.method === 'GET').length, 2);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
    assert.match(result.err, /before creating anything/);
  }
});

test('F2: a paging chain with fresh ids on every page stops at the 10-page cap with zero POSTs', async () => {
  const { file } = makeKeyFile();
  let page = 0;
  const { fetchImpl, calls } = mockFetch({
    onGet: () => {
      page += 1;
      const next = `${APPLE_API_ORIGIN}/v1/apps/${APP_ID}/analyticsReportRequests?cursor=${page}`;
      return jsonResponse(200, { data: [requestItem(`r-snap-${page}`, 'ONE_TIME_SNAPSHOT')], links: { next } });
    },
  });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 1);
  assert.equal(calls.filter((c) => c.method === 'GET').length, 10);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

// ---------------------------------------------------------------- error paths

test('GET error prints HTTP status and Apple error code only', async () => {
  const { file, text } = makeKeyFile();
  const { fetchImpl, calls } = mockFetch({ onGet: () => appleError(401, 'NOT_AUTHORIZED') });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 1);
  assert.match(result.err, /401/);
  assert.match(result.err, /NOT_AUTHORIZED/);
  assert.ok(!result.err.includes('TITLE'));
  assert.ok(!result.err.includes('DETAIL'));
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  assertNoLeaks(result, { keyText: text, tokens: tokensFrom(calls) });
});

test('POST error (409) prints status and code only and stops', async () => {
  const { file, text } = makeKeyFile();
  const { fetchImpl, calls } = mockFetch({ existing: [], onPost: () => appleError(409, 'ENTITY_ERROR.ATTRIBUTE.INVALID') });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 1);
  assert.match(result.err, /409/);
  assert.match(result.err, /ENTITY_ERROR\.ATTRIBUTE\.INVALID/);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1, 'stops after the first failed create');
  assertNoLeaks(result, { keyText: text, tokens: tokensFrom(calls) });
});

test('error body that is not JSON prints status only', async () => {
  const { file } = makeKeyFile();
  const { fetchImpl, calls } = mockFetch({
    onGet: () => new Response(`<html>${BODY_MARKER}</html>`, { status: 503, headers: { 'x-request-id': HEADER_MARKER } }),
  });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 1);
  assert.match(result.err, /503/);
  assertNoLeaks(result, { tokens: tokensFrom(calls) });
});

test('an Apple error code with odd characters is not echoed', async () => {
  const { file } = makeKeyFile();
  const { fetchImpl } = mockFetch({ onGet: () => appleError(400, `<script>${BODY_MARKER}</script>`) });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 1);
  assert.match(result.err, /400/);
  assertNoLeaks(result, {});
});

test('a network failure prints no message text', async () => {
  const { file } = makeKeyFile();
  const fetchImpl = async () => {
    const error = new TypeError(`fetch failed ${BODY_MARKER}`);
    error.cause = { code: 'ECONNRESET', message: BODY_MARKER };
    throw error;
  };
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 1);
  assert.match(result.err, /network/i);
  assertNoLeaks(result, {});
});

test('a timeout is labelled TIMEOUT (the DOMException\'s numeric code is not used)', async () => {
  const { file } = makeKeyFile();
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.equal(typeof timeout.code, 'number', 'precondition: DOMException carries a numeric code');
  const result = await runCli(goArgs(file), { fetchImpl: async () => { throw timeout; } });
  assert.equal(result.code, 1);
  assert.match(result.err, /network error TIMEOUT/);
  assert.ok(!result.err.includes('aborted due to timeout'));
});

// ---------------------------------------------------------------- refusals

test('refuses a key file inside a git repository (no fetch)', async () => {
  const repo = makeTempDir();
  fs.mkdirSync(path.join(repo, '.git'));
  const nested = path.join(repo, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  const { file, text } = makeKeyFile({ dir: nested });
  const { fetchImpl, calls } = mockFetch();
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 2);
  assert.equal(calls.length, 0);
  assert.match(result.err, /git/i);
  assertNoLeaks(result, { keyText: text });
});

test('refuses a key file inside a git worktree (.git file) too', async () => {
  const repo = makeTempDir();
  fs.writeFileSync(path.join(repo, '.git'), 'gitdir: /somewhere/else\n');
  const { file } = makeKeyFile({ dir: repo });
  const { fetchImpl, calls } = mockFetch();
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 2);
  assert.equal(calls.length, 0);
});

test('refuses a symlink whose target sits inside a git repository', async () => {
  const repo = makeTempDir();
  fs.mkdirSync(path.join(repo, '.git'));
  const { file } = makeKeyFile({ dir: repo });
  const outside = makeTempDir();
  const link = path.join(outside, 'link.p8');
  fs.symlinkSync(file, link);
  const { fetchImpl, calls } = mockFetch();
  const result = await runCli(goArgs(link), { fetchImpl });
  assert.equal(result.code, 2);
  assert.equal(calls.length, 0);
});

for (const mode of [0o640, 0o604, 0o644, 0o660, 0o606]) {
  test(`refuses a key file with mode ${mode.toString(8)} (group/world readable or writable)`, async () => {
    const { file, text } = makeKeyFile({ mode });
    const { fetchImpl, calls } = mockFetch();
    const result = await runCli(goArgs(file), { fetchImpl });
    assert.equal(result.code, 2);
    assert.equal(calls.length, 0);
    assert.match(result.err, /chmod 600/);
    assertNoLeaks(result, { keyText: text });
  });
}

test('the same refusals apply in dry run', async () => {
  const { file } = makeKeyFile({ mode: 0o644 });
  const result = await runCli(['--key', file, '--key-id', KEY_ID, '--issuer', ISSUER, '--app-id', APP_ID]);
  assert.equal(result.code, 2);
});

for (const appId of ['abc', '12a4', '-1', '1e9', '', '../1', '1476097583/x']) {
  test(`refuses non-numeric app id ${JSON.stringify(appId)} (no fetch)`, async () => {
    const { file } = makeKeyFile();
    const { fetchImpl, calls } = mockFetch();
    const result = await runCli(['--key', file, '--key-id', KEY_ID, '--issuer', ISSUER, '--app-id', appId, '--go'], { fetchImpl });
    assert.equal(result.code, 2);
    assert.equal(calls.length, 0);
  });
}

test('refuses a key file that is not an EC P-256 private key, without echoing it', async () => {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const { file } = makeKeyFile({ pem: rsa });
  const { fetchImpl, calls } = mockFetch();
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 2);
  assert.equal(calls.length, 0);
  assertNoLeaks(result, { keyText: rsa });
});

test('refuses garbage key text without echoing it', async () => {
  const junk = `not a key ${BODY_MARKER}\n`;
  const { file } = makeKeyFile({ pem: junk });
  const result = await runCli(goArgs(file));
  assert.equal(result.code, 2);
  assertNoLeaks(result, {});
});

test('refuses a missing key file, a directory, and missing arguments', async () => {
  const dir = makeTempDir();
  const missing = await runCli(goArgs(path.join(dir, 'nope.p8')));
  assert.equal(missing.code, 2);
  const isDir = await runCli(goArgs(dir));
  assert.equal(isDir.code, 2);
  const { file } = makeKeyFile();
  const noIssuer = await runCli(['--key', file, '--key-id', KEY_ID, '--app-id', APP_ID, '--go']);
  assert.equal(noIssuer.code, 2);
  const unknown = await runCli(goArgs(file, ['--verbose']));
  assert.equal(unknown.code, 2);
});

test('an unknown argument is refused without echoing it (it could be a pasted key or token)', async () => {
  const { file, text } = makeKeyFile();
  const secretish = 'eyJhbGciOiJFUzI1NiJ9.SECRET_ARG_MARKER.sig';
  const pemLine = keyBodyLines(text)[0];
  for (const extra of [[secretish], [`--token=${secretish}`], [`--${secretish}`], [pemLine], ['--go=SECRET_ARG_MARKER']]) {
    const { fetchImpl, calls } = mockFetch();
    const result = await runCli(goArgs(file, extra), { fetchImpl });
    assert.equal(result.code, 2);
    assert.equal(calls.length, 0);
    const all = `${result.out}\n${result.err}`;
    assert.match(result.err, /Unknown argument/);
    assert.ok(!all.includes('SECRET_ARG_MARKER'), `echoed ${extra}`);
    assert.ok(!all.includes(pemLine.slice(0, 20)), 'echoed a key line');
  }
});

test('refuses a malformed key id or issuer id', async () => {
  const { file } = makeKeyFile();
  const badKid = await runCli(['--key', file, '--key-id', 'AB"C', '--issuer', ISSUER, '--app-id', APP_ID, '--go']);
  assert.equal(badKid.code, 2);
  const badIss = await runCli(['--key', file, '--key-id', KEY_ID, '--issuer', 'not-a-uuid', '--app-id', APP_ID, '--go']);
  assert.equal(badIss.code, 2);
});

test('--flag=value form works', async () => {
  const { file } = makeKeyFile();
  const { fetchImpl, calls } = mockFetch({ existing: [requestItem('r-on', 'ONGOING'), requestItem('r-snap', 'ONE_TIME_SNAPSHOT')] });
  const result = await runCli([`--key=${file}`, `--key-id=${KEY_ID}`, `--issuer=${ISSUER}`, `--app-id=${APP_ID}`, '--go'], { fetchImpl });
  assert.equal(result.code, 0, result.err);
  assert.equal(calls.length, 1);
});

test('the script never writes files: the temp dir holds only the key afterwards', async () => {
  const dir = makeTempDir();
  const { file } = makeKeyFile({ dir });
  const { fetchImpl } = mockFetch({ existing: [] });
  const result = await runCli(goArgs(file), { fetchImpl });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(file)]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'key file mode untouched');
});

// ---------------------------------------------------------------- the real command line

test('command line: dry run exits 0 and refusals exit 2 (no network in either)', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = fileURLToPath(new URL('./launch-metrics/apple-create-requests.mjs', import.meta.url));
  const { file, text } = makeKeyFile();
  const dry = spawnSync(process.execPath, [script, '--key', file, '--key-id', KEY_ID, '--issuer', ISSUER, '--app-id', APP_ID], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Dry run: no requests were sent/);
  assertNoLeaks({ out: dry.stdout, err: dry.stderr }, { keyText: text });

  const loose = makeKeyFile({ mode: 0o644 });
  const refused = spawnSync(process.execPath, [script, '--key', loose.file, '--key-id', KEY_ID, '--issuer', ISSUER, '--app-id', APP_ID, '--go'], { encoding: 'utf8' });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /chmod 600/);
  assert.equal(refused.stdout, '');

  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
});
