// Offline tests for the App Store client (src/lib/launch-metrics/apple.ts) and
// its wiring into the sync, alerts, stale rules and the Launch page model.
// No network: a fake Apple API answers every call. No database: an in-memory
// store that applies migration 065's keep-latest-Apple rule.
//
// The report files under scripts/fixtures/launch-metrics/apple/ are built from
// Apple's documented report fields, not from a real file.
//
//   npm run test:launch-metrics-apple

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const apple = await import("../src/lib/launch-metrics/apple.ts");
const sync = await import("../src/lib/launch-metrics/sync.ts");
const alerts = await import("../src/lib/launch-metrics/alerts.ts");
const stale = await import("../src/lib/launch-metrics/stale.ts");
const pageData = await import("../src/lib/launch-metrics/page-data.ts");
const format = await import("../src/lib/launch-metrics/format.ts");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}`);
    console.log(String(error?.stack ?? error).split("\n").slice(0, 8).map((l) => `    ${l}`).join("\n"));
  }
}

async function rejectsWithCode(promiseOrFn, code) {
  try {
    await (typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn);
  } catch (error) {
    assert.equal(error?.name, "LaunchSourceError", `expected LaunchSourceError, got ${error?.stack ?? error}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected code ${code}, nothing thrown`);
}

const tsv = (name) => readFileSync(new URL(`./fixtures/launch-metrics/apple/${name}`, import.meta.url), "utf8");

// A throwaway P-256 key, made for this run only.
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const APP_ID = "6740000001";
const CONFIG = { privateKeyPem: PEM, keyId: "ABCDE12345", issuerId: "6a1e8f0c-1b2c-4d3e-8f90-123456789abc", appId: APP_ID };
const API = "https://api.appstoreconnect.apple.com";
const SEGMENT_HOST = "https://iosanalytics-reports.apple.com";

const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function decodeJwt(jwt) {
  const [h, p, s] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString("utf8")),
    claims: JSON.parse(Buffer.from(p, "base64url").toString("utf8")),
    signature: Buffer.from(s, "base64url"),
    signingInput: `${h}.${p}`,
  };
}

// ─── a fake App Store Connect API ─────────────────────────────────────────

const REPORT_IDS = {
  "App Store Discovery and Engagement Standard": "r-eng-std",
  "App Store Discovery and Engagement Detailed": "r-eng-det",
  "App Downloads Standard": "r-dl-std",
  "App Downloads Detailed": "r-dl-det",
};

function segmentFor(text, { gzip = true, checksum, size, url } = {}) {
  const bytes = gzip ? gzipSync(Buffer.from(text, "utf8")) : Buffer.from(text, "utf8");
  return { bytes, checksum: checksum ?? md5(bytes), size: size ?? bytes.length, url };
}

/**
 * model = {
 *   requests: [{ id, accessType, stopped }],
 *   reports: { [requestId]: [{ id, name }] },
 *   instances: { [reportId]: [{ id, processingDate, granularity? }] },
 *   segments: { [instanceId]: [segmentFor(...)] },
 *   pageSize: 1 by default for lists (so paging is always exercised),
 * }
 */
function fakeApple(model) {
  const calls = [];
  const pageSize = model.pageSize ?? 2;
  const segmentBytes = new Map();
  const listReply = (url, items) => {
    const offset = Number(url.searchParams.get("cursor") ?? "0");
    const page = items.slice(offset, offset + pageSize);
    const next = offset + pageSize < items.length ? (() => {
      const nextUrl = new URL(url);
      nextUrl.searchParams.set("cursor", String(offset + pageSize));
      return nextUrl.toString();
    })() : undefined;
    return Response.json({ data: page, links: { self: url.toString(), ...(next ? { next } : {}) }, meta: { paging: { total: items.length, limit: pageSize } } });
  };
  const fn = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    if (model.override) {
      const reply = model.override(url, init);
      if (reply) return reply;
    }
    if (url.origin === API) {
      let match;
      if ((match = url.pathname.match(/^\/v1\/apps\/(\d+)\/analyticsReportRequests$/))) {
        return listReply(url, (model.requests ?? []).map((r) => ({ type: "analyticsReportRequests", id: r.id, attributes: { accessType: r.accessType, stoppedDueToInactivity: r.stopped ?? false } })));
      }
      if ((match = url.pathname.match(/^\/v1\/analyticsReportRequests\/([^/]+)\/reports$/))) {
        return listReply(url, (model.reports?.[match[1]] ?? []).map((r) => ({ type: "analyticsReports", id: r.id, attributes: { name: r.name, category: "APP_STORE_ENGAGEMENT" } })));
      }
      if ((match = url.pathname.match(/^\/v1\/analyticsReports\/([^/]+)\/instances$/))) {
        const granularity = url.searchParams.get("filter[granularity]");
        const items = (model.instances?.[match[1]] ?? []).filter((i) => !granularity || (i.granularity ?? "DAILY") === granularity);
        return listReply(url, items.map((i) => ({ type: "analyticsReportInstances", id: i.id, attributes: { granularity: i.granularity ?? "DAILY", processingDate: i.processingDate } })));
      }
      if ((match = url.pathname.match(/^\/v1\/analyticsReportInstances\/([^/]+)\/segments$/))) {
        const segments = model.segments?.[match[1]] ?? [];
        return listReply(url, segments.map((segment, index) => {
          const segUrl = segment.url ?? `${SEGMENT_HOST}/segments/${match[1]}-${index}.gz?sig=signed`;
          segmentBytes.set(segUrl, segment.bytes);
          return { type: "analyticsReportSegments", id: `${match[1]}-s${index}`, attributes: { checksum: segment.checksum, sizeInBytes: segment.size, url: segUrl } };
        }));
      }
      return Response.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
    }
    if (segmentBytes.has(url.toString())) {
      return new Response(segmentBytes.get(url.toString()), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  fn.calls = calls;
  return fn;
}

function standardModel(extra = {}) {
  return {
    requests: [{ id: "req-ongoing", accessType: "ONGOING" }],
    reports: {
      "req-ongoing": [
        { id: "r-other", name: "App Sessions Standard" },
        ...Object.entries(REPORT_IDS).map(([name, id]) => ({ id, name })),
      ],
    },
    instances: {
      "r-eng-std": [{ id: "i-eng-std-1027", processingDate: "2026-10-27" }, { id: "i-eng-std-weekly", processingDate: "2026-10-27", granularity: "WEEKLY" }],
      "r-eng-det": [{ id: "i-eng-det-1027", processingDate: "2026-10-27" }],
      "r-dl-std": [{ id: "i-dl-std-1027", processingDate: "2026-10-27" }],
      "r-dl-det": [{ id: "i-dl-det-1027", processingDate: "2026-10-27" }],
    },
    segments: {
      "i-eng-std-1027": [segmentFor(tsv("engagement-standard.tsv"))],
      "i-eng-det-1027": [segmentFor(tsv("engagement-detailed.tsv"), { gzip: false })],
      "i-dl-std-1027": [segmentFor(tsv("downloads-standard.tsv"))],
      "i-dl-det-1027": [segmentFor(tsv("downloads-detailed.tsv"))],
    },
    ...extra,
  };
}

// ─── an in-memory store with 065's keep-latest-Apple rule ─────────────────

function memoryStore() {
  const state = { runs: [], daily: new Map(), snapshots: new Map(), tasks: [], comments: [], instances: new Map(), seq: 0, upserts: [] };
  const key = (row) => `${row.metric_date}|${row.source}|${row.metric}|${row.dimension}`;
  return {
    state,
    get: (date, metric, dimension = "") => state.daily.get(`${date}|apple|${metric}|${dimension}`)?.value,
    async recentRuns(limit) {
      return [...state.runs].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, limit).map((r) => ({ ...r, sources: { ...r.sources } }));
    },
    async insertRun(run) {
      const id = `run-${++state.seq}`;
      state.runs.push({ id, ...run, finished_at: null, status: "running", sources: {} });
      return id;
    },
    async finishRun(id, result) {
      Object.assign(state.runs.find((r) => r.id === id), result);
    },
    async upsertDaily(rows) {
      state.upserts.push(rows.length);
      for (const row of rows) {
        const old = state.daily.get(key(row));
        // 065: an Apple row with a newer stored processing date is kept.
        if (old && old.source === "apple" && old.apple_processing_date && (!row.apple_processing_date || row.apple_processing_date < old.apple_processing_date)) continue;
        state.daily.set(key(row), { ...row, variant: row.variant ?? null, apple_processing_date: row.apple_processing_date ?? null });
      }
    },
    async upsertSnapshot(source, asOf, capturedAt, payload) {
      state.snapshots.set(`${source}|${asOf}`, payload);
    },
    async findAlertTask(ext) {
      const t = state.tasks.find((task) => task.external_source_id === ext);
      return t ? { id: t.id, status: t.status } : null;
    },
    async createAlertTask(task) {
      if (state.tasks.some((t) => t.external_source_id === task.external_source_id)) return null;
      const row = { id: `task-${++state.seq}`, status: "Planned", owner: "brent", ...task };
      state.tasks.push(row);
      return { id: row.id, status: row.status };
    },
    async updateAlertTask(id, patch) {
      Object.assign(state.tasks.find((t) => t.id === id), patch);
    },
    async addTaskComment(taskId, content) {
      state.comments.push({ taskId, content });
    },
    async knownAppleInstances(ids) {
      return new Set(ids.filter((id) => state.instances.has(id)));
    },
    async appleRowsFor(dates) {
      return [...state.daily.values()]
        .filter((row) => row.source === "apple" && dates.includes(row.metric_date))
        .map(({ metric_date, metric, dimension, variant, apple_processing_date }) => ({ metric_date, metric, dimension, variant, apple_processing_date }));
    },
    async recordAppleInstance(record) {
      state.instances.set(record.instance_id, record);
    },
  };
}

let clock = Date.parse("2026-10-30T11:30:00Z");
const nowFn = () => new Date(clock);

// ─── JWT ──────────────────────────────────────────────────────────────────

await test("jwt: ES256 with kid, iss, aud appstoreconnect-v1, at most 20 minutes; the signature verifies", () => {
  const nowSeconds = Math.floor(clock / 1000);
  const jwt = apple.signAppleJwt(CONFIG, nowSeconds);
  const { header, claims, signature, signingInput } = decodeJwt(jwt);
  assert.deepEqual(header, { alg: "ES256", kid: "ABCDE12345", typ: "JWT" });
  assert.deepEqual(Object.keys(claims).sort(), ["aud", "exp", "iat", "iss"]);
  assert.equal(claims.iss, CONFIG.issuerId);
  assert.equal(claims.aud, "appstoreconnect-v1");
  assert.equal(claims.iat, nowSeconds);
  assert.ok(claims.exp - claims.iat <= 20 * 60 && claims.exp > claims.iat);
  assert.equal(signature.length, 64, "raw r||s (ieee-p1363), not DER");
  assert.ok(verify("sha256", Buffer.from(signingInput), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature));
  const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey;
  assert.ok(!verify("sha256", Buffer.from(signingInput), { key: other, dsaEncoding: "ieee-p1363" }, signature));
  assert.ok(!jwt.includes("PRIVATE"));
});

await test("jwt: a key pasted with literal \\n or on one line still loads; an RSA or P-384 key, junk or bad ids are refused", async () => {
  const escaped = PEM.replace(/\n/g, "\\n");
  assert.ok(apple.signAppleJwt({ ...CONFIG, privateKeyPem: escaped }, 1));
  const oneLine = PEM.replace(/\n/g, " ");
  assert.ok(apple.signAppleJwt({ ...CONFIG, privateKeyPem: oneLine }, 1));
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ type: "pkcs8", format: "pem" });
  for (const pem of [rsa, p384, "not a key", "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"]) {
    const error = await rejectsWithCode(() => apple.signAppleJwt({ ...CONFIG, privateKeyPem: pem }, 1), "apple_bad_key");
    assert.ok(!String(error.stack).includes("BEGIN"));
  }
  for (const bad of [{ keyId: "x" }, { issuerId: "not-a-uuid" }, { appId: "12ab" }, { appId: "" }, { privateKeyPem: "  " }]) {
    await rejectsWithCode(() => apple.signAppleJwt({ ...CONFIG, ...bad }, 1), "apple_bad_config");
  }
});

await test("env: no ASC_* value = null (not connected); some set = a config that fails as apple_bad_config", () => {
  assert.equal(apple.readAppleConfig({}), null);
  assert.equal(apple.readAppleConfig({ ASC_PRIVATE_KEY: "  ", ASC_KEY_ID: "" }), null);
  const partial = apple.readAppleConfig({ ASC_KEY_ID: "ABCDE12345" });
  assert.ok(partial);
  assert.throws(() => apple.validateAppleConfig(partial), (e) => e.code === "apple_bad_config");
  const full = apple.readAppleConfig({ ASC_PRIVATE_KEY: PEM, ASC_KEY_ID: " ABCDE12345 ", ASC_ISSUER_ID: CONFIG.issuerId, ASC_APP_ID: APP_ID });
  assert.deepEqual({ ...full, privateKeyPem: "x" }, { ...CONFIG, privateKeyPem: "x" });
  assert.equal(sync.readLaunchEnv({}).apple, null);
});

// ─── listing, paging, requests ────────────────────────────────────────────

await test("paging: every page is read; next links must stay on Apple's API host and never repeat", async () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ type: "analyticsReportRequests", id: `req-${i}`, attributes: { accessType: "ONE_TIME_SNAPSHOT" } }));
  const model = { requests: items.map((i) => ({ id: i.id, accessType: "ONE_TIME_SNAPSHOT" })), pageSize: 2 };
  const fetchImpl = fakeApple(model);
  const all = await apple.listAllPages(fetchImpl, "tkn", `${API}/v1/apps/${APP_ID}/analyticsReportRequests?limit=200`);
  assert.equal(all.length, 5);
  assert.equal(fetchImpl.calls.length, 3);
  for (const call of fetchImpl.calls) assert.equal(call.init.headers.Authorization, "Bearer tkn");

  const offHost = fakeApple({ override: (url) => (url.origin === API ? Response.json({ data: [], links: { next: "https://evil.example/v1/next" } }) : null) });
  await rejectsWithCode(apple.listAllPages(offHost, "tkn", `${API}/v1/x`), "apple_shape");
  assert.equal(offHost.calls.length, 1, "the token is never sent to the other host");

  const loop = fakeApple({ override: (url) => (url.origin === API ? Response.json({ data: [], links: { next: `${API}/v1/x?cursor=1` } }) : null) });
  await rejectsWithCode(apple.listAllPages(loop, "tkn", `${API}/v1/x`), "apple_shape");

  const notList = fakeApple({ override: () => Response.json({ data: { id: "x" } }) });
  await rejectsWithCode(apple.listAllPages(notList, "tkn", `${API}/v1/x`), "apple_shape");

  const endless = fakeApple({ override: (url) => Response.json({ data: [], links: { next: `${API}/v1/x?cursor=${Number(url.searchParams.get("cursor") ?? 0) + 1}` } }) });
  await rejectsWithCode(apple.listAllPages(endless, "tkn", `${API}/v1/x`), "apple_too_many_pages");
});

await test("requests: the running ONGOING request plus snapshots; stopped → apple_request_stopped; none → apple_no_request", async () => {
  const parsed = apple.parseReportRequests([
    { type: "analyticsReportRequests", id: "a", attributes: { accessType: "ONGOING", stoppedDueToInactivity: true } },
    { type: "analyticsReportRequests", id: "b", attributes: { accessType: "ONGOING", stoppedDueToInactivity: false } },
    { type: "analyticsReportRequests", id: "c", attributes: { accessType: "ONE_TIME_SNAPSHOT" } },
  ]);
  assert.deepEqual(apple.pickRequests(parsed).map((r) => r.id), ["c", "b"]);
  assert.throws(() => apple.pickRequests([{ id: "a", accessType: "ONGOING", stopped: true }, { id: "c", accessType: "ONE_TIME_SNAPSHOT", stopped: false }]), (e) => e.code === "apple_request_stopped");
  assert.throws(() => apple.pickRequests([{ id: "c", accessType: "ONE_TIME_SNAPSHOT", stopped: false }]), (e) => e.code === "apple_no_request");
  assert.throws(() => apple.parseReportRequests([{ type: "analyticsReportRequests", id: "a", attributes: { accessType: "WEEKLY" } }]), (e) => e.code === "apple_shape");
  assert.throws(() => apple.parseReportRequests([{ type: "analyticsReportRequests", id: "a", attributes: { accessType: "ONGOING", stoppedDueToInactivity: "yes" } }]), (e) => e.code === "apple_shape");
  assert.throws(() => apple.parseReportRequests([{ type: "apps", id: "a" }]), (e) => e.code === "apple_shape");

  const store = memoryStore();
  const stopped = fakeApple({ requests: [{ id: "req-old", accessType: "ONGOING", stopped: true }] });
  await rejectsWithCode(apple.syncApple(CONFIG, stopped, store, nowFn), "apple_request_stopped");
  assert.equal(stopped.calls.length, 1, "nothing read after the stopped request");
  assert.equal(store.state.daily.size, 0);
});

// ─── segments: download, size, checksum, gzip ─────────────────────────────

await test("segments: gzip and plain text both decode; the size and the checksum (md5 or sha256) must match", async () => {
  const text = tsv("downloads-standard.tsv");
  const gz = gzipSync(Buffer.from(text));
  assert.equal(apple.decodeSegment(gz), text);
  assert.equal(apple.decodeSegment(Buffer.from(text)), text);
  assert.ok(apple.checksumMatches(gz, md5(gz)));
  assert.ok(apple.checksumMatches(gz, md5(gz).toUpperCase()));
  assert.ok(apple.checksumMatches(gz, sha256(gz)));
  assert.equal(apple.checksumMatches(gz, md5(Buffer.from("other"))), false);
  assert.throws(() => apple.checksumMatches(gz, "crc32:1234"), (e) => e.code === "apple_checksum");
  assert.throws(() => apple.decodeSegment(Buffer.from([0x1f, 0x8b, 0, 1, 2, 3])), (e) => e.code === "apple_gzip");
  assert.throws(() => apple.decodeSegment(Buffer.from([0xff, 0xfe, 0xfd])), (e) => e.code === "apple_tsv_encoding");
});

await test("segments: downloaded without the token, only from apple.com hosts; size or checksum mismatch stops the source", async () => {
  const ok = segmentFor("x");
  const url = `${SEGMENT_HOST}/a.gz?sig=1`;
  const serve = (bytes) => async (input, init) => {
    serve.calls.push({ input, init });
    return new Response(bytes, { status: 200 });
  };
  serve.calls = [];
  await apple.downloadSegment(serve(ok.bytes), { url, checksum: ok.checksum, sizeInBytes: ok.size });
  const sent = serve.calls[0].init;
  assert.equal(sent.headers.Authorization, undefined);
  assert.equal(sent.redirect, "error");
  for (const bad of ["https://evil.example/a.gz", "http://iosanalytics-reports.apple.com/a.gz", "https://apple.com.evil.example/a", "https://notapple.com/a", "https://x.apple.com:444/a"]) {
    const never = async () => assert.fail("must not fetch");
    await rejectsWithCode(apple.downloadSegment(never, { url: bad, checksum: ok.checksum, sizeInBytes: ok.size }), "apple_segment_host");
  }
  await rejectsWithCode(apple.downloadSegment(serve(ok.bytes), { url, checksum: md5(Buffer.from("nope")), sizeInBytes: ok.size }), "apple_checksum");
  await rejectsWithCode(apple.downloadSegment(serve(ok.bytes), { url, checksum: ok.checksum, sizeInBytes: ok.size + 5 }), "apple_segment_size");
  await rejectsWithCode(apple.downloadSegment(serve(ok.bytes), { url, checksum: ok.checksum, sizeInBytes: ok.size - 1 }), "apple_segment_size");
  await rejectsWithCode(apple.downloadSegment(serve(ok.bytes), { url, checksum: ok.checksum, sizeInBytes: 25_000_000 }), "apple_segment_too_large");
  const redirect = async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
  await rejectsWithCode(apple.downloadSegment(redirect, { url, checksum: ok.checksum, sizeInBytes: ok.size }), "redirect_refused");
});

await test("sync: a checksum mismatch stores nothing from that instance and leaves it unrecorded (retried next run)", async () => {
  const model = standardModel();
  model.segments["i-dl-std-1027"] = [segmentFor(tsv("downloads-standard.tsv"), { checksum: md5(Buffer.from("tampered")) })];
  const store = memoryStore();
  await rejectsWithCode(apple.syncApple(CONFIG, fakeApple(model), store, nowFn), "apple_checksum");
  assert.equal(store.get("2026-10-26", "first_downloads"), undefined);
  assert.equal(store.state.instances.has("i-dl-std-1027"), false);
  // The fixed file is read on the next run.
  model.segments["i-dl-std-1027"] = [segmentFor(tsv("downloads-standard.tsv"))];
  await apple.syncApple(CONFIG, fakeApple(model), store, nowFn);
  assert.equal(store.get("2026-10-26", "first_downloads"), 3);
  assert.ok(store.state.instances.has("i-dl-std-1027"));
});

// ─── TSV: by header name, fail closed ─────────────────────────────────────

const ENG_STD = apple.APPLE_REPORTS.find((r) => r.name === "App Store Discovery and Engagement Standard");
const DL_STD = apple.APPLE_REPORTS.find((r) => r.name === "App Downloads Standard");
const DL_DET = apple.APPLE_REPORTS.find((r) => r.name === "App Downloads Detailed");

await test("tsv: columns are read by name in any order; CRLF, a BOM and a trailing blank line are fine", () => {
  const text = "﻿Counts\tDownload Type\tApp Apple Identifier\tDate\tSource Type\r\n2\tFirst-time download\t6740000001\t2026-10-26\tApp Store search\r\n\r\n";
  const rows = apple.parseTsv(text, DL_STD);
  assert.deepEqual(rows, [{ counts: "2", "download type": "First-time download", "app apple identifier": "6740000001", date: "2026-10-26", "source type": "App Store search" }]);
  assert.equal(apple.parseTsv(tsv("engagement-standard.tsv"), ENG_STD).length, 8);
});

await test("tsv: an unknown, duplicate or missing column fails closed (apple_tsv_header); a ragged row is apple_tsv_shape", () => {
  const good = tsv("downloads-standard.tsv");
  const [header, ...rest] = good.split("\n");
  const unknown = [`${header}\tRevenue`, ...rest.map((line) => (line ? `${line}\t9.99` : line))].join("\n");
  assert.throws(() => apple.parseTsv(unknown, DL_STD), (e) => e.code === "apple_tsv_header");
  const renamed = good.replace("Download Type", "Download Kind");
  assert.throws(() => apple.parseTsv(renamed, DL_STD), (e) => e.code === "apple_tsv_header");
  const duplicate = good.replace("App Version", "Counts");
  assert.throws(() => apple.parseTsv(duplicate, DL_STD), (e) => e.code === "apple_tsv_header");
  assert.throws(() => apple.parseTsv("", DL_STD), (e) => e.code === "apple_tsv_header");
  // A Detailed report needs its Source Info and Campaign columns.
  assert.throws(() => apple.parseTsv(good, DL_DET), (e) => e.code === "apple_tsv_header");
  const ragged = `${header}\n2026-10-26\tMenu & Market\t6740000001\n`;
  assert.throws(() => apple.parseTsv(ragged, DL_STD), (e) => e.code === "apple_tsv_shape");
});

await test("tsv: a bad date, a date after the processing day or a non-number count fails closed", () => {
  const head = "Date\tApp Apple Identifier\tDownload Type\tSource Type\tCounts";
  const parse = (line) => apple.aggregateInstance(apple.parseTsv(`${head}\n${line}\n`, DL_STD), DL_STD, APP_ID, "2026-10-27");
  assert.throws(() => parse("10/26/2026\t6740000001\tFirst-time download\tApp Store search\t1"), (e) => e.code === "apple_tsv_date");
  assert.throws(() => parse("2026-10-30\t6740000001\tFirst-time download\tApp Store search\t1"), (e) => e.code === "apple_tsv_date");
  assert.throws(() => parse("2026-10-26\t6740000001\tFirst-time download\tApp Store search\tmany"), (e) => e.code === "apple_tsv_number");
  assert.throws(() => parse("2026-10-26\t6740000001\tFirst-time download\tApp Store search\t-1"), (e) => e.code === "apple_tsv_number");
  // Another app's row is dropped before any check of its values.
  assert.deepEqual(parse("garbage\t6749999999\tFirst-time download\tApp Store search\tmany").rows, []);
  // Pre-launch days are counted as parsed but not stored.
  const early = parse("2026-09-01\t6740000001\tFirst-time download\tApp Store search\t4");
  assert.deepEqual([early.rows.length, early.rowsParsed], [0, 1]);
});

// ─── aggregate ────────────────────────────────────────────────────────────

function rowsOf(aggregate) {
  return Object.fromEntries(aggregate.rows.map((r) => [`${r.metric_date}|${r.metric}|${r.dimension}`, r.value]));
}

await test("aggregate: Standard engagement → impressions and page views (+ uniques) per day and by source type; other apps dropped", () => {
  const agg = apple.aggregateInstance(apple.parseTsv(tsv("engagement-standard.tsv"), ENG_STD), ENG_STD, APP_ID, "2026-10-27");
  assert.deepEqual(rowsOf(agg), {
    "2026-10-25|impressions|": 12,
    "2026-10-25|impressions_unique|": 10,
    "2026-10-25|product_page_views|": 3,
    "2026-10-25|product_page_views_unique|": 3,
    "2026-10-25|impressions|source_type:App Store search": 12,
    "2026-10-25|product_page_views|source_type:App Store search": 3,
    "2026-10-26|impressions|": 35,
    "2026-10-26|impressions_unique|": 30,
    "2026-10-26|product_page_views|": 10,
    "2026-10-26|product_page_views_unique|": 9,
    "2026-10-26|impressions|source_type:App Store search": 30,
    "2026-10-26|impressions|source_type:Web referrer": 5,
    "2026-10-26|product_page_views|source_type:App Store search": 6,
    "2026-10-26|product_page_views|source_type:Web referrer": 4,
  });
  assert.deepEqual(agg.dates, ["2026-10-25", "2026-10-26"]);
  assert.equal(agg.rowsParsed, 7, "the other app's row is not counted");
  for (const row of agg.rows) {
    assert.equal(row.source, "apple");
    assert.equal(row.variant, "standard");
    assert.equal(row.apple_processing_date, "2026-10-27");
  }
  assert.ok(!JSON.stringify(agg).includes("900"), "Another App's numbers never appear");
});

await test("aggregate: Standard downloads → first-time and redownloads; updates ignored; a day's zero is written", () => {
  const agg = apple.aggregateInstance(apple.parseTsv(tsv("downloads-standard.tsv"), DL_STD), DL_STD, APP_ID, "2026-10-27");
  const rows = rowsOf(agg);
  assert.equal(rows["2026-10-26|first_downloads|"], 3);
  assert.equal(rows["2026-10-26|redownloads|"], 1);
  assert.equal(rows["2026-10-25|first_downloads|"], 1);
  assert.equal(rows["2026-10-25|redownloads|"], 0, "a day in the file with no redownloads is a stored zero");
  assert.equal(rows["2026-10-26|first_downloads|source_type:Web referrer"], 1);
  assert.ok(!Object.keys(rows).some((k) => k.includes("App Store browse")), "updates are not downloads");
  assert.ok(!Object.values(rows).includes(50));
});

await test("aggregate: Detailed reports add only source_info: and campaign: rows (never a total), empty values skipped", () => {
  const ENG_DET = apple.APPLE_REPORTS.find((r) => r.name === "App Store Discovery and Engagement Detailed");
  const eng = apple.aggregateInstance(apple.parseTsv(tsv("engagement-detailed.tsv"), ENG_DET), ENG_DET, APP_ID, "2026-10-27");
  assert.deepEqual(rowsOf(eng), {
    "2026-10-26|product_page_views|source_info:menuandmarket.com": 5,
    "2026-10-26|product_page_views|campaign:site-hero": 5,
  });
  const dl = apple.aggregateInstance(apple.parseTsv(tsv("downloads-detailed.tsv"), DL_DET), DL_DET, APP_ID, "2026-10-27");
  assert.deepEqual(rowsOf(dl), { "2026-10-26|first_downloads|source_info:menuandmarket.com": 1, "2026-10-26|first_downloads|campaign:site-hero": 1 });
  for (const row of [...eng.rows, ...dl.rows]) assert.equal(row.variant, "detailed");
});

await test("aggregate: labels are cleaned (control characters, long values) and fit the dimension column", () => {
  const head = "Date\tApp Apple Identifier\tDownload Type\tSource Type\tCounts";
  const agg = apple.aggregateInstance(apple.parseTsv(`${head}\n2026-10-26\t6740000001\tFirst-time download\tWeb\u0007 referrer${"x".repeat(400)}\t1\n`, DL_STD), DL_STD, APP_ID, "2026-10-27");
  const dim = agg.rows.find((r) => r.dimension.startsWith("source_type:")).dimension;
  assert.ok(dim.length <= 300);
  assert.ok(!/[\u0000-\u001f]/.test(dim));
  assert.ok(dim.startsWith("source_type:Web referrer"));
});

// ─── the full Apple run ───────────────────────────────────────────────────

await test("syncApple: reads the four reports' DAILY instances, writes the metrics, records each instance once", async () => {
  const store = memoryStore();
  const fetchImpl = fakeApple(standardModel());
  const result = await apple.syncApple(CONFIG, fetchImpl, store, nowFn);
  assert.equal(result.instancesRead, 4);
  assert.equal(result.instancesLeft, 0);
  assert.equal(store.get("2026-10-26", "impressions"), 35);
  assert.equal(store.get("2026-10-26", "product_page_views_unique"), 9);
  assert.equal(store.get("2026-10-26", "first_downloads"), 3);
  assert.equal(store.get("2026-10-26", "redownloads"), 1);
  assert.equal(store.get("2026-10-26", "first_downloads", "campaign:site-hero"), 1);
  assert.equal(store.get("2026-10-26", "product_page_views", "source_info:menuandmarket.com"), 5);
  assert.equal(store.get("2026-10-26", "impressions", "source_type:App Store search"), 30, "Detailed never overwrites a Standard row");
  assert.deepEqual([...store.state.instances.keys()].sort(), ["i-dl-det-1027", "i-dl-std-1027", "i-eng-det-1027", "i-eng-std-1027"]);
  const rec = store.state.instances.get("i-eng-std-1027");
  assert.deepEqual({ ...rec, fetched_at: "x" }, { instance_id: "i-eng-std-1027", report_name: "App Store Discovery and Engagement Standard", granularity: "DAILY", processing_date: "2026-10-27", segment_count: 1, rows_parsed: 7, fetched_at: "x" });
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes("i-eng-std-weekly")), "weekly instances are not read");
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes("r-other")), "other reports are not read");
  // Only Apple's API host ever gets the token.
  for (const call of fetchImpl.calls) {
    const host = new URL(call.url).hostname;
    if (call.init.headers?.Authorization) assert.equal(host, "api.appstoreconnect.apple.com");
    else assert.match(host, /\.apple\.com$/);
  }
});

await test("syncApple: idempotent; a second run reads no segment and writes nothing", async () => {
  const store = memoryStore();
  await apple.syncApple(CONFIG, fakeApple(standardModel()), store, nowFn);
  const before = JSON.stringify([...store.state.daily.entries()]);
  const writes = store.state.upserts.length;
  const again = fakeApple(standardModel());
  const result = await apple.syncApple(CONFIG, again, store, nowFn);
  assert.deepEqual(result, { instancesRead: 0, instancesLeft: 0, rowsWritten: 0 });
  assert.ok(!again.calls.some((c) => c.url.includes("/segments") || c.url.startsWith(SEGMENT_HOST)));
  assert.equal(store.state.upserts.length, writes);
  assert.equal(JSON.stringify([...store.state.daily.entries()]), before);
});

await test("syncApple: several segments of one instance add up; the snapshot's history is read before the ongoing instance", async () => {
  const text = tsv("downloads-standard.tsv");
  const [header, ...lines] = text.trim().split("\n");
  const model = standardModel({
    requests: [{ id: "req-ongoing", accessType: "ONGOING" }, { id: "req-snap", accessType: "ONE_TIME_SNAPSHOT", stopped: true }],
  });
  model.reports["req-snap"] = [{ id: "r-dl-std-snap", name: "App Downloads Standard" }];
  model.instances["r-dl-std-snap"] = [{ id: "i-snap-1027", processingDate: "2026-10-27" }, { id: "i-snap-1023", processingDate: "2026-10-23" }];
  model.segments["i-snap-1023"] = [segmentFor(`${header}\n2026-10-22\tMenu & Market\t6740000001\tFirst-time download\t1.0\tiPhone\tiOS 26.0\tApp Store browse\tProduct page\t\tUS\t2\n`)];
  // The snapshot says 9 for Oct 26 at the same processing date; the ongoing instance (read after it) wins.
  model.segments["i-snap-1027"] = [segmentFor(`${header}\n2026-10-26\tMenu & Market\t6740000001\tFirst-time download\t1.0\tiPhone\tiOS 26.0\tApp Store search\tProduct page\t\tUS\t9\n`)];
  model.segments["i-dl-std-1027"] = [segmentFor(`${header}\n${lines.slice(0, 3).join("\n")}\n`), segmentFor(`${header}\n${lines.slice(3).join("\n")}\n`, { gzip: false })];
  const store = memoryStore();
  const fetchImpl = fakeApple(model);
  await apple.syncApple(CONFIG, fetchImpl, store, nowFn);
  assert.equal(store.get("2026-10-22", "first_downloads"), 2);
  assert.equal(store.get("2026-10-26", "first_downloads"), 3);
  assert.equal(store.get("2026-10-26", "first_downloads", "source_type:App Store search"), 2);
  assert.equal(store.state.instances.get("i-dl-std-1027").segment_count, 2);
  const order = fetchImpl.calls.filter((c) => c.url.includes("/segments")).map((c) => new URL(c.url).pathname.split("/")[3]);
  assert.ok(order.indexOf("i-snap-1023") < order.indexOf("i-snap-1027"));
  assert.ok(order.indexOf("i-snap-1027") < order.indexOf("i-dl-std-1027"));
});

await test("latest wins: a newer instance replaces a day (keys it no longer has become 0); an older one arriving later never overwrites", async () => {
  const head = "Date\tApp Apple Identifier\tDownload Type\tSource Type\tCounts";
  const model = standardModel();
  model.reports["req-ongoing"] = [{ id: "r-dl-std", name: "App Downloads Standard" }];
  model.instances = { "r-dl-std": [{ id: "i-1027", processingDate: "2026-10-27" }] };
  model.segments = { "i-1027": [segmentFor(`${head}\n2026-10-26\t${APP_ID}\tFirst-time download\tWeb referrer\t4\n2026-10-26\t${APP_ID}\tFirst-time download\tApp Store search\t1\n`)] };
  const store = memoryStore();
  await apple.syncApple(CONFIG, fakeApple(model), store, nowFn);
  assert.equal(store.get("2026-10-26", "first_downloads"), 5);
  assert.equal(store.get("2026-10-26", "first_downloads", "source_type:Web referrer"), 4);

  // Apple re-issues the day in a newer instance: Web referrer is gone, search is 2.
  model.instances["r-dl-std"].push({ id: "i-1028", processingDate: "2026-10-28" });
  model.segments["i-1028"] = [segmentFor(`${head}\n2026-10-26\t${APP_ID}\tFirst-time download\tApp Store search\t2\n`)];
  await apple.syncApple(CONFIG, fakeApple(model), store, nowFn);
  assert.equal(store.get("2026-10-26", "first_downloads"), 2);
  assert.equal(store.get("2026-10-26", "first_downloads", "source_type:App Store search"), 2);
  assert.equal(store.get("2026-10-26", "first_downloads", "source_type:Web referrer"), 0, "never merged with the older instance");
  assert.equal(store.state.daily.get("2026-10-26|apple|first_downloads|source_type:Web referrer").apple_processing_date, "2026-10-28");

  // An older instance listed only now (e.g. the snapshot) doesn't win against the newer one.
  model.instances["r-dl-std"].push({ id: "i-1025", processingDate: "2026-10-25" });
  model.segments["i-1025"] = [segmentFor(`${head}\n2026-10-26\t${APP_ID}\tFirst-time download\tApp Store search\t7\n`)];
  await apple.syncApple(CONFIG, fakeApple(model), store, nowFn);
  assert.equal(store.get("2026-10-26", "first_downloads"), 2);
  assert.equal(store.get("2026-10-26", "first_downloads", "source_type:App Store search"), 2);
  assert.ok(store.state.instances.has("i-1025"), "read once, recorded, never re-read");
  assert.equal(apple.zeroMissing({ rows: [], dates: ["2026-10-26"] }, [{ metric_date: "2026-10-26", metric: "first_downloads", dimension: "", variant: "standard", apple_processing_date: "2026-10-28" }], DL_STD, "2026-10-25").length, 0);
});

await test("latest wins: a Standard re-issue never zeroes Detailed rows, and the reverse", () => {
  const stored = [
    { metric_date: "2026-10-26", metric: "first_downloads", dimension: "campaign:site-hero", variant: "detailed", apple_processing_date: "2026-10-27" },
    { metric_date: "2026-10-26", metric: "first_downloads", dimension: "source_type:Web referrer", variant: "standard", apple_processing_date: "2026-10-27" },
    { metric_date: "2026-10-26", metric: "impressions", dimension: "", variant: "standard", apple_processing_date: "2026-10-27" },
  ];
  const std = apple.zeroMissing({ rows: [], dates: ["2026-10-26"] }, stored, DL_STD, "2026-10-28");
  assert.deepEqual(std.map((r) => r.dimension), ["source_type:Web referrer"], "only its own metrics and dimensions");
  const det = apple.zeroMissing({ rows: [], dates: ["2026-10-26"] }, stored, DL_DET, "2026-10-28");
  assert.deepEqual(det.map((r) => r.dimension), ["campaign:site-hero"]);
});

await test("syncApple: other apps' rows never reach the store", async () => {
  const store = memoryStore();
  await apple.syncApple(CONFIG, fakeApple(standardModel()), store, nowFn);
  const text = JSON.stringify([...store.state.daily.values()]);
  assert.ok(!/example\.org|promo/.test(text));
  assert.ok(![...store.state.daily.values()].some((row) => [900, 800, 70, 60, 50].includes(row.value)));
});

await test("syncApple: report names Apple no longer uses → apple_reports_missing; no reports yet is fine", async () => {
  const renamed = standardModel();
  renamed.reports["req-ongoing"] = [{ id: "r-x", name: "App Store Discovery and Engagement" }];
  await rejectsWithCode(apple.syncApple(CONFIG, fakeApple(renamed), memoryStore(), nowFn), "apple_reports_missing");
  const empty = standardModel();
  empty.reports["req-ongoing"] = [];
  assert.deepEqual(await apple.syncApple(CONFIG, fakeApple(empty), memoryStore(), nowFn), { instancesRead: 0, instancesLeft: 0, rowsWritten: 0 });
});

await test("syncApple: a run reads at most 40 instances and stops starting new ones after its time budget", async () => {
  const head = "Date\tApp Apple Identifier\tDownload Type\tSource Type\tCounts";
  const model = standardModel();
  model.reports["req-ongoing"] = [{ id: "r-dl-std", name: "App Downloads Standard" }];
  model.instances = { "r-dl-std": [] };
  model.segments = {};
  for (let i = 0; i < 45; i += 1) {
    const id = `i-${String(i).padStart(2, "0")}`;
    model.instances["r-dl-std"].push({ id, processingDate: "2026-10-27" });
    model.segments[id] = [segmentFor(`${head}\n2026-10-26\t${APP_ID}\tFirst-time download\tApp Store search\t1\n`)];
  }
  model.pageSize = 50;
  const store = memoryStore();
  const first = await apple.syncApple(CONFIG, fakeApple(model), store, nowFn);
  assert.deepEqual([first.instancesRead, first.instancesLeft], [40, 5]);
  const second = await apple.syncApple(CONFIG, fakeApple(model), store, nowFn);
  assert.deepEqual([second.instancesRead, second.instancesLeft], [5, 0]);

  let t = clock;
  const slowNow = () => new Date((t += 20_000));
  const slow = await apple.syncApple(CONFIG, fakeApple({ ...model }), memoryStore(), slowNow);
  assert.ok(slow.instancesRead < 5, `stopped early (${slow.instancesRead})`);
  assert.ok(slow.instancesLeft > 0);
});

await test("syncApple: HTTP errors are codes only; Apple's error body and the token never appear", async () => {
  const fetchImpl = fakeApple({ override: () => new Response(JSON.stringify({ errors: [{ code: "NOT_AUTHORIZED", detail: "SECRET-DETAIL for ABCDE12345" }] }), { status: 401 }) });
  const error = await rejectsWithCode(apple.syncApple(CONFIG, fetchImpl, memoryStore(), nowFn), "http_401");
  const jwt = fetchImpl.calls[0].init.headers.Authorization.slice(7);
  const text = `${error.message} ${error.stack}`;
  assert.ok(!text.includes("SECRET-DETAIL"));
  assert.ok(!text.includes(jwt));
});

await test("source: apple.ts never logs, never writes a segment or key to disk, and has no new dependency", () => {
  const source = readFileSync(new URL("../src/lib/launch-metrics/apple.ts", import.meta.url), "utf8");
  assert.ok(!/console\.|process\.stdout|writeFile|fs\./.test(source));
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  for (const name of imports) assert.ok(name.startsWith("node:") || name.startsWith("./"), name);
  assert.ok(!/claude|anthropic/i.test(source));
});

// ─── wired into the sync, alerts, stale rules, page ───────────────────────

const appleEnv = (overrides = {}) => ({ appDb: null, web: null, searchConsole: null, apple: CONFIG, alertProjectId: null, ...overrides });
const deps = (store, fetchImpl, env = appleEnv()) => ({ store, env, fetchImpl, now: nowFn });

await test("sync: the full run reads Apple; the hourly light run skips it; no keys = not_connected with no call", async () => {
  const store = memoryStore();
  const fetchImpl = fakeApple(standardModel());
  const full = await sync.runLaunchSync(deps(store, fetchImpl), { trigger: "cron", kind: "full" });
  assert.equal(full.sources.apple, "ok");
  assert.equal(store.get("2026-10-26", "first_downloads"), 3);

  const light = fakeApple(standardModel());
  clock += 3_600_000;
  const lightRun = await sync.runLaunchSync(deps(store, light), { trigger: "cron", kind: "light" });
  assert.equal(lightRun.sources.apple, "skipped");
  assert.equal(light.calls.length, 0);

  const none = fakeApple(standardModel());
  clock += 3_600_000;
  const notConnected = await sync.runLaunchSync(deps(memoryStore(), none, appleEnv({ apple: null })), { trigger: "manual", kind: "full" });
  assert.equal(notConnected.sources.apple, "not_connected");
  assert.equal(none.calls.length, 0);

  const partial = sync.readLaunchEnv({ ASC_APP_ID: APP_ID });
  clock += 3_600_000;
  const bad = await sync.runLaunchSync(deps(memoryStore(), fakeApple(standardModel()), appleEnv({ apple: partial.apple })), { trigger: "cron", kind: "full" });
  assert.equal(bad.sources.apple, "apple_bad_config");
});

await test("sync: Apple failing doesn't stop the other sources and is logged as a code", async () => {
  const store = memoryStore();
  const model = standardModel({ requests: [{ id: "req-old", accessType: "ONGOING", stopped: true }] });
  clock += 3_600_000;
  const result = await sync.runLaunchSync(deps(store, fakeApple(model)), { trigger: "cron", kind: "full" });
  assert.equal(result.sources.apple, "apple_request_stopped");
  assert.equal(store.state.runs[0].sources.apple, "apple_request_stopped");
  assert.equal(result.status, "failed");
});

await test("alerts: Apple failing on two full runs creates ONE task for Brent with a plain reason; recovery closes it", async () => {
  const store = memoryStore();
  const stopped = standardModel({ requests: [{ id: "req-old", accessType: "ONGOING", stopped: true }] });
  for (let i = 0; i < 2; i += 1) {
    clock += 3_600_000;
    await sync.runLaunchSync(deps(store, fakeApple(stopped)), { trigger: "cron", kind: "full" });
    clock += 3_600_000;
    await sync.runLaunchSync(deps(store, fakeApple(stopped)), { trigger: "cron", kind: "light" }); // skipped: doesn't break the streak
  }
  assert.equal(store.state.tasks.length, 1);
  const task = store.state.tasks[0];
  assert.equal(task.external_source_id, "source:apple");
  assert.equal(task.title, "Launch numbers: App Store stopped updating");
  assert.equal(task.owner, "brent");
  assert.match(task.status_line, /setup script has to run again/);
  assert.ok(task.status_line.length <= 280);
  assert.ok(!/claude|anthropic/i.test(JSON.stringify(store.state.tasks) + JSON.stringify(store.state.comments)));
  clock += 3_600_000;
  const ok = await sync.runLaunchSync(deps(store, fakeApple(standardModel())), { trigger: "manual", kind: "full" });
  assert.equal(ok.alerts.find((a) => a.source === "apple").action, "resolved");
  assert.equal(store.state.tasks[0].status, "Done");
});

await test("alerts: not_connected and skipped never alert; every Apple code has a plain reason", async () => {
  const store = memoryStore();
  for (let i = 0; i < 3; i += 1) {
    clock += 3_600_000;
    await sync.runLaunchSync(deps(store, fakeApple(standardModel()), appleEnv({ apple: null })), { trigger: "cron", kind: "full" });
  }
  assert.equal(store.state.tasks.length, 0);
  for (const code of ["apple_request_stopped", "apple_no_request", "apple_bad_key", "apple_bad_config", "apple_checksum", "apple_segment_size", "apple_segment_host", "apple_segment_too_large", "apple_tsv_header", "apple_tsv_shape", "apple_tsv_date", "apple_tsv_number", "apple_tsv_encoding", "apple_gzip", "apple_shape", "apple_reports_missing", "apple_too_many_rows", "apple_too_many_pages"]) {
    assert.ok(!alerts.plainReason(code).startsWith("error code"), code);
  }
});

await test("stale: Apple is fresh for 72 hours after a good full run, failing after a failed one, not connected without keys", () => {
  const run = (startedAt, apple) => ({ id: startedAt, trigger: "cron", kind: "full", started_at: startedAt, finished_at: startedAt, status: "ok", sources: { apple } });
  const at = (runs, iso) => stale.sourceHealth(runs, new Date(iso)).find((h) => h.source === "apple");
  const runs = [run("2026-10-29T12:00:00Z", "skipped"), run("2026-10-28T11:30:00Z", "ok")];
  assert.equal(at(runs, "2026-10-31T11:29:00Z").state, "fresh");
  assert.equal(at(runs, "2026-10-31T11:31:00Z").state, "stale");
  assert.equal(at([run("2026-10-29T11:30:00Z", "http_401"), ...runs], "2026-10-29T12:00:00Z").state, "failing");
  assert.equal(at([run("2026-10-29T11:30:00Z", "not_connected")], "2026-10-29T12:00:00Z").state, "not_connected");
  assert.equal(at([], "2026-10-29T12:00:00Z").state, "never");
  assert.equal(format.healthLine({ source: "apple", state: "not_connected" }).text, "App Store: not connected yet (the App Store keys aren't set up)");
});

await test("page: App Store days, 30-day window to data-through, conversion on unique page views, source types and Detailed lists", async () => {
  const store = memoryStore();
  await apple.syncApple(CONFIG, fakeApple(standardModel()), store, nowFn);
  const daily = [...store.state.daily.values()].map(({ metric_date, source, metric, dimension, value }) => ({ metric_date, source, metric, dimension, value }));
  const view = pageData.buildAppStoreView(daily);
  assert.equal(view.hasData, true);
  assert.equal(view.dataThrough, "2026-10-26");
  assert.deepEqual(view.window, { since: "2026-10-21", until: "2026-10-26" });
  assert.equal(view.days[0].date, "2026-10-21");
  assert.deepEqual(view.days.at(-1), { date: "2026-10-26", impressions: 35, pageViews: 10, firstDownloads: 3, redownloads: 1 });
  assert.deepEqual([view.impressions, view.pageViews, view.pageViewsUnique, view.firstDownloads, view.redownloads], [47, 13, 12, 4, 1]);
  assert.ok(Math.abs(view.conversion - 4 / 12) < 1e-9);
  assert.deepEqual(view.sourceTypes.map((r) => [r.label, r.impressions, r.pageViews, r.firstDownloads, r.redownloads]), [
    ["App Store search", 42, 9, 3, 1],
    ["Web referrer", 5, 4, 1, 0],
  ]);
  assert.deepEqual(view.sourceInfo, [{ label: "menuandmarket.com", value: 1, secondary: 5 }]);
  assert.deepEqual(view.campaigns, [{ label: "site-hero", value: 1, secondary: 5 }]);
  const empty = pageData.buildAppStoreView([]);
  assert.deepEqual([empty.hasData, empty.days.length, empty.conversion, empty.window], [false, 0, null, null]);
});

await test("page: the Launch page shows the App Store section with Apple's time zone, explains empty Detailed lists and keeps the hand reads", () => {
  const page = readFileSync(new URL("../src/components/launch/LaunchPage.tsx", import.meta.url), "utf8");
  assert.match(page, /Apple's report days \(Apple's own dates, not New York time\)/);
  assert.match(page, /an empty list means too few people to show, not zero/);
  assert.match(page, /Read by hand from App Store Connect \(history\)/);
  assert.match(page, /caption="App Store numbers read by hand"/);
  assert.match(page, /sourceBadge\(view, "apple"\)/);
  assert.ok(!/Not connected yet<\/StateBadge>/.test(page), "the badge follows the run log now");
  assert.ok(!/claude|anthropic/i.test(page));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
