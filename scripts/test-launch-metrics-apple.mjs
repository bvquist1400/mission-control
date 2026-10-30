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
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import ts from "typescript";

// TSX → JS for the page render check (TypeScript's own transpiler; types are dropped).
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".tsx")) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      const output = ts.transpileModule(source, {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
        fileName: fileURLToPath(url),
      });
      return { format: "module", source: output.outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

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
    async appleDataThrough() {
      const newest = (metrics) => [...state.daily.values()]
        .filter((row) => row.source === "apple" && row.dimension === "" && metrics.includes(row.metric))
        .map((row) => row.metric_date)
        .sort()
        .at(-1) ?? null;
      return { engagement: newest(["impressions", "product_page_views"]), downloads: newest(["first_downloads", "redownloads"]) };
    },
  };
}

const counts = ({ instancesRead, instancesWaiting, instancesLeft, rowsWritten }) => ({ instancesRead, instancesWaiting, instancesLeft, rowsWritten });

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
  // Another app's row is dropped before any check of its values (next to one of ours) ...
  const mixed = parse("garbage\t6749999999\tFirst-time download\tApp Store search\tmany\n2026-10-26\t6740000001\tFirst-time download\tApp Store search\t1");
  assert.equal(mixed.rowsParsed, 1);
  // ... and a file with only other apps' rows is apple_tsv_app (fix round 1, P3-1).
  assert.throws(() => parse("garbage\t6749999999\tFirst-time download\tApp Store search\tmany"), (e) => e.code === "apple_tsv_app");
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
  assert.deepEqual(counts(result), { instancesRead: 0, instancesWaiting: 0, instancesLeft: 0, rowsWritten: 0 });
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
  assert.deepEqual(counts(await apple.syncApple(CONFIG, fakeApple(empty), memoryStore(), nowFn)), { instancesRead: 0, instancesWaiting: 0, instancesLeft: 0, rowsWritten: 0 });
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

  // Each Apple call takes 4 simulated seconds: the 50 s budget stops the run
  // part-way; what was read is kept and the rest is read on the next run.
  let t = clock;
  const base = fakeApple({ ...model });
  const slowFetch = async (url, init) => { t += 4_000; return base(url, init); };
  const slowStore = memoryStore();
  const slow = await apple.syncApple(CONFIG, slowFetch, slowStore, () => new Date(t));
  assert.ok(slow.instancesRead > 0 && slow.instancesRead < 40, `stopped early (${slow.instancesRead})`);
  assert.equal(slow.instancesLeft, 45 - slow.instancesRead);
  assert.equal(slowStore.state.instances.size, slow.instancesRead);
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
  for (const code of ["apple_request_stopped", "apple_no_request", "apple_bad_key", "apple_bad_config", "apple_checksum", "apple_segment_size", "apple_segment_host", "apple_segment_too_large", "apple_tsv_header", "apple_tsv_shape", "apple_tsv_date", "apple_tsv_number", "apple_tsv_encoding", "apple_gzip", "apple_shape", "apple_reports_missing", "apple_too_many_rows", "apple_too_many_pages", "apple_tsv_app", "apple_timeout", "apple_paging", "apple_no_new_data"]) {
    assert.ok(!alerts.plainReason(code).startsWith("error code"), code);
  }
});

await test("stale: Apple goes stale 72 hours after its last contact, failing after a failed run, not connected without keys", () => {
  const run = (startedAt, apple) => ({ id: startedAt, trigger: "cron", kind: "full", started_at: startedAt, finished_at: startedAt, status: "ok", sources: { apple } });
  const through = { engagement: "2026-10-28", downloads: "2026-10-28" };
  const at = (runs, iso) => stale.sourceHealth(runs, new Date(iso), through).find((h) => h.source === "apple");
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
  assert.deepEqual(view.downloadsWindow, { since: "2026-10-25", until: "2026-10-26", days: 2, spanDays: 2 });
  assert.deepEqual(view.engagementWindow, { since: "2026-10-25", until: "2026-10-26", days: 2, spanDays: 2 });
  assert.equal(view.days[0].date, "2026-10-21");
  assert.deepEqual(view.days.at(-1), { date: "2026-10-26", impressions: 35, pageViews: 10, firstDownloads: 3, redownloads: 1 });
  assert.deepEqual([view.impressions, view.pageViews, view.pageViewsUnique, view.firstDownloads, view.redownloads], [47, 13, 12, 4, 1]);
  assert.ok(Math.abs(view.conversion - 4 / 12) < 1e-9);
  assert.deepEqual(view.sourceTypes.map((r) => [r.label, r.impressions, r.pageViews, r.firstDownloads, r.redownloads]), [
    ["App Store search", 42, 9, 3, 1],
    ["Web referrer", 5, 4, 1, 0],
  ]);
  assert.deepEqual(view.sourceInfo, [{ label: "menuandmarket.com", firstDownloads: 1, pageViews: 5 }]);
  assert.deepEqual(view.campaigns, [{ label: "site-hero", firstDownloads: 1, pageViews: 5 }]);
  const empty = pageData.buildAppStoreView([]);
  assert.deepEqual([empty.hasData, empty.days.length, empty.conversion, empty.downloadsWindow, empty.engagementWindow, empty.conversionWindow], [false, 0, null, null, null, null]);
  assert.deepEqual([empty.firstDownloads, empty.impressions, empty.pageViews], [null, null, null]);
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

// ─── fix round 1 (review da85762f) ────────────────────────────────────────

const DL_HEAD = "Date\tApp Apple Identifier\tDownload Type\tSource Type\tCounts";
function downloadsModel() {
  return {
    requests: [{ id: "req-ongoing", accessType: "ONGOING" }],
    reports: { "req-ongoing": [{ id: "r-dl", name: "App Downloads Standard" }] },
    instances: { "r-dl": [{ id: "i-dl", processingDate: "2026-10-27" }] },
    segments: { "i-dl": [segmentFor(`${DL_HEAD}\n2026-10-26\t${APP_ID}\tFirst-time download\tApp Store search\t1\n`)] },
  };
}

await test("P2-1: an instance listed before its file exists is not recorded; the next run reads it", async () => {
  const model = downloadsModel();
  model.segments["i-dl"] = [];
  const store = memoryStore();
  const first = await apple.syncApple(CONFIG, fakeApple(model), store, nowFn);
  assert.deepEqual(counts(first), { instancesRead: 0, instancesWaiting: 1, instancesLeft: 0, rowsWritten: 0 });
  assert.equal(store.state.instances.has("i-dl"), false);
  model.segments["i-dl"] = [segmentFor(`${DL_HEAD}\n2026-10-26\t${APP_ID}\tFirst-time download\tApp Store search\t9\n`)];
  const later = fakeApple(model);
  const second = await apple.syncApple(CONFIG, later, store, () => new Date(clock + 86_400_000));
  assert.equal(second.instancesRead, 1);
  assert.equal(later.calls.filter((c) => c.url.startsWith(SEGMENT_HOST)).length, 1);
  assert.equal(store.get("2026-10-26", "first_downloads"), 9);
  assert.equal(store.state.instances.get("i-dl").segment_count, 1);
});

await test("P2-1: a still-empty instance doesn't block the others; one empty for over 7 days is recorded as empty and never retried", async () => {
  const model = downloadsModel();
  model.instances["r-dl"] = [
    { id: "i-old-empty", processingDate: "2026-10-21" },
    { id: "i-new-empty", processingDate: "2026-10-29" },
    { id: "i-dl", processingDate: "2026-10-27" },
  ];
  model.segments["i-old-empty"] = [];
  model.segments["i-new-empty"] = [];
  const store = memoryStore();
  const result = await apple.syncApple(CONFIG, fakeApple(model), store, () => new Date("2026-10-30T11:30:00Z"));
  assert.deepEqual([result.instancesRead, result.instancesWaiting], [1, 1]);
  assert.equal(store.get("2026-10-26", "first_downloads"), 1);
  assert.deepEqual({ ...store.state.instances.get("i-old-empty"), fetched_at: "x" }, { instance_id: "i-old-empty", report_name: "App Downloads Standard", granularity: "DAILY", processing_date: "2026-10-21", segment_count: 0, rows_parsed: 0, fetched_at: "x" });
  assert.equal(store.state.instances.has("i-new-empty"), false);
  const again = fakeApple(model);
  await apple.syncApple(CONFIG, again, store, () => new Date("2026-10-31T11:30:00Z"));
  assert.ok(!again.calls.some((c) => c.url.includes("i-old-empty")), "the given-up instance is not asked for again");
  assert.ok(again.calls.some((c) => c.url.includes("i-new-empty/segments")), "the young one is retried");
});

await test("P2-2: an older instance listed after a newer one adds nothing to that day (no new key, totals and breakdowns stay consistent)", async () => {
  const model = downloadsModel();
  model.instances["r-dl"] = [{ id: "i-1028", processingDate: "2026-10-28" }];
  model.segments = { "i-1028": [segmentFor(`${DL_HEAD}\n2026-10-26\t${APP_ID}\tFirst-time download\tApp Store search\t2\n`)] };
  const store = memoryStore();
  await apple.syncApple(CONFIG, fakeApple(model), store, nowFn);
  model.instances["r-dl"].push({ id: "i-1025", processingDate: "2026-10-25" });
  // The older one has Oct 26 (a key the newer one lacks) and Oct 24 (a day the newer one doesn't cover).
  model.segments["i-1025"] = [segmentFor(`${DL_HEAD}\n2026-10-26\t${APP_ID}\tFirst-time download\tWeb referrer\t7\n2026-10-24\t${APP_ID}\tFirst-time download\tWeb referrer\t3\n`)];
  await apple.syncApple(CONFIG, fakeApple(model), store, () => new Date(clock + 86_400_000));
  assert.equal(store.get("2026-10-26", "first_downloads"), 2);
  assert.equal(store.get("2026-10-26", "first_downloads", "source_type:App Store search"), 2);
  assert.equal(store.get("2026-10-26", "first_downloads", "source_type:Web referrer"), undefined, "never inserted into the newer day");
  assert.equal(store.get("2026-10-26", "redownloads"), 0);
  const typesSum = [...store.state.daily.values()]
    .filter((r) => r.metric_date === "2026-10-26" && r.metric === "first_downloads" && r.dimension.startsWith("source_type:"))
    .reduce((sum, r) => sum + r.value, 0);
  assert.equal(typesSum, store.get("2026-10-26", "first_downloads"));
  // The day only the older instance covers is still written, and the instance is recorded.
  assert.equal(store.get("2026-10-24", "first_downloads"), 3);
  assert.ok(store.state.instances.has("i-1025"));
});

await test("P2-2: planInstanceWrites skips a whole day another instance of the same report owns with a newer date, only that report's rows count", () => {
  const head = DL_HEAD;
  const agg = apple.aggregateInstance(apple.parseTsv(`${head}\n2026-10-26\t${APP_ID}\tFirst-time download\tWeb referrer\t7\n2026-10-25\t${APP_ID}\tRedownload\tWeb referrer\t1\n`, DL_STD), DL_STD, APP_ID, "2026-10-25");
  const stored = [
    { metric_date: "2026-10-26", metric: "first_downloads", dimension: "", variant: "standard", apple_processing_date: "2026-10-28" },
    // A newer Detailed row or an engagement row on Oct 25 belongs to another report: it doesn't block.
    { metric_date: "2026-10-25", metric: "first_downloads", dimension: "campaign:site-hero", variant: "detailed", apple_processing_date: "2026-10-28" },
    { metric_date: "2026-10-25", metric: "impressions", dimension: "", variant: "standard", apple_processing_date: "2026-10-28" },
  ];
  const plan = apple.planInstanceWrites(agg, stored, DL_STD, "2026-10-25");
  assert.deepEqual(plan.skippedDays, ["2026-10-26"]);
  assert.ok(plan.rows.every((r) => r.metric_date === "2026-10-25"));
  assert.ok(plan.rows.some((r) => r.metric === "redownloads" && r.dimension === "" && r.value === 1));
});

await test("P3-1: a file with rows but none for ASC_APP_ID fails as apple_tsv_app and the instance is not recorded", async () => {
  const model = downloadsModel();
  model.segments["i-dl"] = [segmentFor(`${DL_HEAD}\n2026-10-26\t${APP_ID}.0\tFirst-time download\tApp Store search\t9\n2026-10-27\t ${APP_ID}.0\tFirst-time download\tApp Store search\t4\n`)];
  const store = memoryStore();
  await rejectsWithCode(apple.syncApple(CONFIG, fakeApple(model), store, nowFn), "apple_tsv_app");
  assert.equal(store.state.instances.has("i-dl"), false);
  assert.equal(store.state.daily.size, 0);
  // A header-only file (a quiet day) is still fine; another app's rows next to ours too.
  assert.deepEqual(apple.aggregateInstance([], DL_STD, APP_ID, "2026-10-27").rows, []);
  assert.match(alerts.plainReason("apple_tsv_app"), /ASC_APP_ID/);
});

await test("P3-2: a slow instance can't run past the deadline; no call starts after it, each timeout is cut to the time left", async () => {
  const model = downloadsModel();
  model.segments["i-dl"] = Array.from({ length: 6 }, (_, i) => segmentFor(`${DL_HEAD}\n2026-10-26\t${APP_ID}\tFirst-time download\tApp Store search\t${i + 1}\n`));
  let t = Date.parse("2026-10-30T11:30:00Z");
  const start = t;
  const base = fakeApple(model);
  const starts = [];
  const slow = async (url, init) => {
    starts.push(t - start);
    t += String(url).startsWith(API) ? 2_000 : 25_000;
    return base(url, init);
  };
  const store = memoryStore();
  await rejectsWithCode(apple.syncApple(CONFIG, slow, store, () => new Date(t)), "apple_timeout");
  assert.ok(Math.max(...starts) <= apple.APPLE_TIME_BUDGET_MS - apple.APPLE_MIN_CALL_MS, `last call started at ${Math.max(...starts)} ms`);
  assert.ok(t - start < 120_000, `simulated ${(t - start) / 1000} s`);
  assert.equal(store.state.instances.has("i-dl"), false, "a cut-short instance is not recorded");
  assert.equal(store.state.daily.size, 0, "nothing partial is written");

  const budget = { deadline: 10_000, now: () => new Date(0) };
  assert.equal(apple.callTimeout(budget, 30_000), 10_000);
  assert.equal(apple.callTimeout({ deadline: 100_000, now: () => new Date(0) }, 30_000), 30_000);
  assert.throws(() => apple.callTimeout({ deadline: 1_000, now: () => new Date(0) }, 30_000), (e) => e.name === "AppleBudgetExhausted");
});

await test("P3-2: the deadline counts from the run's start, and a slow listing stops as apple_timeout", async () => {
  const fetchImpl = fakeApple(downloadsModel());
  await rejectsWithCode(apple.syncApple(CONFIG, fetchImpl, memoryStore(), nowFn, { runStartedAt: clock - 94_000 }), "apple_timeout");
  assert.equal(fetchImpl.calls.length, 0, "no call starts with under 2 s left");
  let t = clock;
  const base = fakeApple(standardModel());
  const starts = [];
  const slowList = async (url, init) => { starts.push(t - clock); t += 19_000; return base(url, init); };
  await rejectsWithCode(apple.syncApple(CONFIG, slowList, memoryStore(), () => new Date(t)), "apple_timeout");
  assert.ok(Math.max(...starts) < apple.APPLE_TIME_BUDGET_MS);
});

await test("P3-2: work left when time runs out continues next run (status ok, nothing lost)", async () => {
  const model = downloadsModel();
  model.instances["r-dl"] = [{ id: "i-a", processingDate: "2026-10-26" }, { id: "i-b", processingDate: "2026-10-27" }];
  model.segments = {
    "i-a": [segmentFor(`${DL_HEAD}\n2026-10-25\t${APP_ID}\tFirst-time download\tApp Store search\t1\n`)],
    "i-b": [segmentFor(`${DL_HEAD}\n2026-10-26\t${APP_ID}\tFirst-time download\tApp Store search\t2\n`)],
  };
  let t = clock;
  const base = fakeApple(model);
  const slow = async (url, init) => { t += String(url).startsWith(API) ? 5_000 : 24_000; return base(url, init); };
  const store = memoryStore();
  const first = await apple.syncApple(CONFIG, slow, store, () => new Date(t));
  assert.deepEqual([first.instancesRead, first.instancesLeft], [1, 1]);
  const second = await apple.syncApple(CONFIG, fakeApple(model), store, nowFn);
  assert.deepEqual([second.instancesRead, second.instancesLeft], [1, 0]);
  assert.deepEqual([store.get("2026-10-25", "first_downloads"), store.get("2026-10-26", "first_downloads")], [1, 2]);
});

await test("P3-3: days a report hasn't covered yet are 'no data yet' (null), not 0; the window and conversion use days both cover", () => {
  const daily = [
    { metric_date: "2026-10-27", source: "apple", metric: "first_downloads", dimension: "", value: 3 },
    { metric_date: "2026-10-27", source: "apple", metric: "redownloads", dimension: "", value: 0 },
    { metric_date: "2026-10-27", source: "apple", metric: "impressions", dimension: "", value: 40 },
    { metric_date: "2026-10-27", source: "apple", metric: "product_page_views", dimension: "", value: 10 },
    { metric_date: "2026-10-27", source: "apple", metric: "product_page_views_unique", dimension: "", value: 8 },
    { metric_date: "2026-10-28", source: "apple", metric: "impressions", dimension: "", value: 50 },
    { metric_date: "2026-10-28", source: "apple", metric: "product_page_views", dimension: "", value: 12 },
    { metric_date: "2026-10-28", source: "apple", metric: "product_page_views_unique", dimension: "", value: 9 },
  ];
  const v = pageData.buildAppStoreView(daily);
  assert.equal(v.dataThrough, "2026-10-28");
  assert.deepEqual([v.engagementThrough, v.downloadsThrough], ["2026-10-28", "2026-10-27"]);
  assert.deepEqual(v.days.find((d) => d.date === "2026-10-28"), { date: "2026-10-28", impressions: 50, pageViews: 12, firstDownloads: null, redownloads: null });
  assert.deepEqual(v.days.find((d) => d.date === "2026-10-21"), { date: "2026-10-21", impressions: null, pageViews: null, firstDownloads: null, redownloads: null });
  assert.deepEqual(v.days.find((d) => d.date === "2026-10-27"), { date: "2026-10-27", impressions: 40, pageViews: 10, firstDownloads: 3, redownloads: 0 });
  assert.deepEqual(v.downloadsWindow, { since: "2026-10-27", until: "2026-10-27", days: 1, spanDays: 1 });
  assert.deepEqual(v.engagementWindow, { since: "2026-10-27", until: "2026-10-28", days: 2, spanDays: 2 });
  assert.deepEqual(v.conversionWindow, { since: "2026-10-27", until: "2026-10-27", days: 1, spanDays: 1 });
  assert.deepEqual([v.firstDownloads, v.pageViews, v.pageViewsUnique, v.impressions], [3, 22, 17, 90]);
  assert.ok(Math.abs(v.conversion - 3 / 8) < 1e-9, "only the day both cover");
  // Only one report so far: its own window, and no conversion.
  const onlyEngagement = pageData.buildAppStoreView(daily.filter((r) => !["first_downloads", "redownloads"].includes(r.metric)));
  assert.equal(onlyEngagement.conversion, null);
  assert.ok(onlyEngagement.days.every((d) => d.firstDownloads === null));
  const page = readFileSync(new URL("../src/components/launch/LaunchPage.tsx", import.meta.url), "utf8");
  assert.match(page, /A day Apple hasn't sent yet is left blank, not 0\./);
});

await test("page: the Launch page renders the App Store section from stored rows, and says why when there are none", async () => {
  const { createElement: h } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { LaunchPageBody } = await import("../src/components/launch/LaunchPage.tsx");
  // The page's Reddit and timeline islands call useRouter() and useToast(); give them a stand-in router and the app's toast provider.
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
  const router = { refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} };
  const { ToastProvider } = await import("../src/components/ui/Toast.tsx");
  const render = (props) => renderToStaticMarkup(h(AppRouterContext.Provider, { value: router }, h(ToastProvider, null, h(LaunchPageBody, props))));
  const store = memoryStore();
  await apple.syncApple(CONFIG, fakeApple(standardModel()), store, nowFn);
  const daily = [...store.state.daily.values()].map(({ metric_date, source, metric, dimension, value }) => ({ metric_date, source, metric, dimension, value }));
  const now = new Date("2026-10-30T15:00:00Z");
  const runs = [{ id: "r1", trigger: "cron", kind: "full", started_at: "2026-10-30T11:30:00Z", finished_at: "2026-10-30T11:31:00Z", status: "ok", sources: { app_db: "not_configured", web: "not_configured", search_console: "not_configured", apple: "ok" } }];
  const manualReads = [{ id: "m", user_id: "u", read_on: "2026-10-27", data_through: "2026-10-25", window_label: "Since release", impressions: 41, product_page_views: 16, first_downloads: 4, created_at: "", updated_at: "" }];
  const input = { daily, searchTop: null, runs, reddit: [], milestones: [], manualReads, tokenExpires: null };
  const html = render({ view: pageData.buildLaunchView(input, now), input, now });
  assert.match(html, /App downloads/);
  assert.match(html, /Data through Oct 26/);
  assert.match(html, /App Store search/);
  assert.match(html, /site-hero/);
  assert.match(html, /Read by hand from App Store Connect \(history\)/);
  assert.match(html, /App Store: data through Oct 26; last reached Apple Oct 30/);
  const emptyInput = { ...input, daily: [], runs: [{ ...runs[0], sources: { apple: "not_connected" } }] };
  const empty = render({ view: pageData.buildLaunchView(emptyInput, now), input: emptyInput, now });
  assert.match(empty, /Not connected yet\. Daily App Store numbers start once the App Store keys are added/);
  assert.match(empty, /App Store: not connected yet/);
  assert.match(empty, /Nothing Apple can show yet \(groups under 5 people are hidden\)/);
  assert.ok(!/claude|anthropic/i.test(html + empty));
});

// ─── fix round 2 (Codex review of e04ede9) ────────────────────────────────

const PROBE_SPEC = apple.APPLE_REPORTS.find((s) => s.family === "downloads" && s.variant === "standard");
const probeRow = (count = "3", date = "2026-10-26") => [date, APP_ID, "First-time download", "App Store search", count].join("\t");
const probeText = (count, date) => `${PROBE_SPEC.required.join("\t")}\n${probeRow(count, date)}\n`;

/** One instance whose segment list is the test's own: `segments` is the list reply. */
function probeModel({ bodies = [probeText()], reply, processingDate = "2026-10-27" } = {}) {
  const parts = bodies.map((text) => segmentFor(text, { gzip: false }));
  const item = (i, id = `seg-${i}`) => ({
    type: "analyticsReportSegments",
    id,
    attributes: { url: `${SEGMENT_HOST}/p/${i}`, checksum: parts[i].checksum, sizeInBytes: parts[i].size },
  });
  const model = {
    requests: [{ id: "req-ongoing", accessType: "ONGOING" }],
    reports: { "req-ongoing": [{ id: "r-dl", name: "App Downloads Standard" }] },
    instances: { "r-dl": [{ id: "i-probe", processingDate }] },
    override(url) {
      if (url.pathname.endsWith("/segments")) return Response.json(reply(item, url));
      if (url.origin === SEGMENT_HOST) return new Response(parts[Number(url.pathname.split("/").at(-1))].bytes);
      return null;
    },
  };
  return model;
}
const whole = (item, n) => ({ data: Array.from({ length: n }, (_, i) => item(i)), links: {}, meta: { paging: { total: n, limit: 200 } } });

await test("completeness: a chain shorter than meta.paging.total stops as apple_paging; nothing written, instance not recorded", async () => {
  const store = memoryStore();
  const model = probeModel({ reply: (item) => ({ data: [item(0)], links: { next: null }, meta: { paging: { total: 2 } } }) });
  await rejectsWithCode(apple.syncApple(CONFIG, fakeApple(model), store, nowFn), "apple_paging");
  assert.equal(store.state.daily.size, 0);
  assert.equal(store.state.instances.size, 0);
  // The next run, with the whole list, reads it (nothing was skipped forever).
  const full = probeModel({ bodies: [probeText(), probeText()], reply: (item) => whole(item, 2) });
  await apple.syncApple(CONFIG, fakeApple(full), store, nowFn);
  assert.equal(store.get("2026-10-26", "first_downloads"), 6);
  assert.equal(store.state.instances.size, 1);
});

await test("completeness: a repeated segment id stops as apple_paging, in one page or across pages; never doubled", async () => {
  for (const reply of [
    (item) => ({ data: [item(0), item(0)], links: { next: null }, meta: { paging: { total: 2 } } }),
    (item) => ({ data: [item(0), item(0)], links: {} }),
    (item, url) =>
      url.searchParams.get("cursor")
        ? { data: [item(0)], meta: { paging: { total: 2 } } }
        : { data: [item(0)], links: { next: `${url.origin}${url.pathname}?cursor=1` }, meta: { paging: { total: 2 } } },
  ]) {
    const store = memoryStore();
    await rejectsWithCode(apple.syncApple(CONFIG, fakeApple(probeModel({ reply })), store, nowFn), "apple_paging");
    assert.equal(store.state.daily.size, 0);
    assert.equal(store.state.instances.size, 0);
  }
});

await test("completeness: two segment ids for one file stop as apple_paging (never added up twice)", () => {
  const seg = (id) => ({ type: "analyticsReportSegments", id, attributes: { url: `${SEGMENT_HOST}/same`, checksum: "a".repeat(32), sizeInBytes: 1 } });
  assert.throws(() => apple.parseSegments([seg("a"), seg("b")]), (error) => error.code === "apple_paging");
});

await test("completeness: every paged list is checked, totals across the whole chain, and a wrong total fails closed", async () => {
  const items = (ids) => ids.map((id) => ({ type: "x", id, attributes: {} }));
  const list = (pages) => {
    const fetchImpl = fakeApple({
      override: (url) => Response.json(pages[Number(url.searchParams.get("p") ?? 0)](`${url.origin}${url.pathname}?p=${Number(url.searchParams.get("p") ?? 0) + 1}`)),
    });
    return apple.listAllPages(fetchImpl, "tkn", `${API}/v1/x`);
  };
  // Total on the first page only is still enforced at the end of the chain.
  await rejectsWithCode(list([(next) => ({ data: items(["a"]), links: { next }, meta: { paging: { total: 3 } } }), () => ({ data: items(["b"]) })]), "apple_paging");
  // Too many.
  await rejectsWithCode(list([() => ({ data: items(["a", "b"]), meta: { paging: { total: 1 } } })]), "apple_paging");
  // Pages that disagree about the total, even if the last one matches.
  await rejectsWithCode(list([(next) => ({ data: items(["a"]), links: { next }, meta: { paging: { total: 3 } } }), () => ({ data: items(["b"]), meta: { paging: { total: 2 } } })]), "apple_paging");
  // A total that isn't a count proves nothing.
  for (const total of ["2", -1, 1.5]) {
    await rejectsWithCode(list([() => ({ data: items(["a"]), meta: { paging: { total } } })]), "apple_paging");
  }
  for (const meta of ["x", { paging: "x" }]) {
    await rejectsWithCode(list([() => ({ data: items(["a"]), meta })]), "apple_paging");
  }
  // An item with no id can't be counted.
  await rejectsWithCode(list([() => ({ data: [{ type: "x" }] })]), "apple_shape");
  // Every list goes through it: a repeat in the instance list stops the source before any file.
  const model = standardModel();
  const fetchImpl = fakeApple({
    ...model,
    instances: { ...model.instances, "r-dl-std": [{ id: "i-dup", processingDate: "2026-10-27" }, { id: "i-dup", processingDate: "2026-10-27" }] },
  });
  await rejectsWithCode(apple.syncApple(CONFIG, fetchImpl, memoryStore(), nowFn), "apple_paging");
  assert.ok(!fetchImpl.calls.some((call) => call.url.startsWith(SEGMENT_HOST)), "no file is read from an unproven list");
});

await test("completeness controls: two distinct segments save 6; missing meta, paging or total stays acceptable", async () => {
  const store = memoryStore();
  await apple.syncApple(CONFIG, fakeApple(probeModel({ bodies: [probeText(), probeText()], reply: (item) => whole(item, 2) })), store, nowFn);
  assert.equal(store.get("2026-10-26", "first_downloads"), 6);
  assert.equal(store.state.instances.get("i-probe").segment_count, 2);
  for (const shape of [{}, { meta: {} }, { meta: null }, { meta: { paging: { limit: 200 } } }, { meta: { paging: null } }, { meta: { paging: { total: null } } }]) {
    const other = memoryStore();
    await apple.syncApple(CONFIG, fakeApple(probeModel({ reply: (item) => ({ data: [item(0)], ...shape }) })), other, nowFn);
    assert.equal(other.get("2026-10-26", "first_downloads"), 3);
    assert.equal(other.state.instances.size, 1);
  }
});

const appleRow = (metric_date, metric, value, dimension = "") => ({ metric_date, source: "apple", metric, dimension, value });
const engagementRows = (date, views = 10) => [appleRow(date, "impressions", 20), appleRow(date, "product_page_views", views), appleRow(date, "product_page_views_unique", views)];
const downloadRows = (date, first = 5) => [appleRow(date, "first_downloads", first), appleRow(date, "redownloads", 0)];

async function renderLaunch(daily, runs = [], at = "2026-10-30T15:00:00Z") {
  const { createElement: h } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
  const { LaunchPageBody } = await import("../src/components/launch/LaunchPage.tsx");
  const { ToastProvider } = await import("../src/components/ui/Toast.tsx");
  const router = { refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} };
  const now = new Date(at);
  const input = { daily, searchTop: null, runs, reddit: [], milestones: [], manualReads: [], tokenExpires: null };
  const view = pageData.buildLaunchView(input, now);
  const html = renderToStaticMarkup(h(AppRouterContext.Provider, { value: router }, h(ToastProvider, null, h(LaunchPageBody, { view, input, now }))));
  const tile = html.slice(html.indexOf("App downloads"), html.indexOf("Website visitors"));
  const section = html.slice(html.indexOf('id="appstore-title"'), html.indexOf('id="website-title"'));
  return { html, tile, section, view };
}
const appleRun = (iso, code = "ok") => ({ id: iso, trigger: "cron", kind: "full", started_at: iso, finished_at: iso, status: "ok", sources: { apple: code } });

await test("missing data: engagement only renders a dash for downloads, never 0 (server HTML)", async () => {
  const { tile, section, view } = await renderLaunch(engagementRows("2026-10-26"), [appleRun("2026-10-30T11:30:00Z")]);
  assert.equal(view.appStore.firstDownloads, null);
  assert.equal(view.appStore.redownloads, null);
  assert.match(tile, />–<\/p>/);
  assert.ok(!/>0<\/p>/.test(tile), "no 0 tile");
  assert.match(tile, /Waiting for Apple(&#x27;|')s downloads report/);
  assert.match(tile, /no day both reports cover yet/);
  assert.match(tile, /20 impressions · 10 page views/);
  assert.match(section, /Waiting for Apple(&#x27;|')s downloads report/);
  assert.ok(!/0 first-time downloads/.test(section), "the chart summary claims no 0 either");
});

await test("missing data: downloads only renders dashes for impressions, page views and conversion", async () => {
  const { tile, section, view } = await renderLaunch(downloadRows("2026-10-26"), [appleRun("2026-10-30T11:30:00Z")]);
  assert.equal(view.appStore.firstDownloads, 5);
  assert.deepEqual([view.appStore.impressions, view.appStore.pageViews, view.appStore.pageViewsUnique, view.appStore.conversion], [null, null, null, null]);
  assert.match(tile, />5<\/p>/);
  assert.match(tile, /– impressions · – page views/);
  assert.match(section, /Waiting for Apple(&#x27;|')s impressions and page views report/);
});

await test("missing data: conversion is never computed across days the two reports don't share", async () => {
  const disjoint = pageData.buildAppStoreView([...engagementRows("2026-10-25"), ...downloadRows("2026-10-26")]);
  assert.equal(disjoint.conversion, null);
  assert.equal(disjoint.conversionWindow, null);
  assert.deepEqual([disjoint.firstDownloads, disjoint.pageViewsUnique], [5, 10], "each headline still shows its own real number");
  assert.equal(disjoint.downloadsWindow.until, "2026-10-26");
  assert.equal(disjoint.engagementWindow.until, "2026-10-25");

  // Only the 26th is shared: the 24th's downloads and the 25th's views stay out.
  const overlap = pageData.buildAppStoreView([...downloadRows("2026-10-24", 100), ...engagementRows("2026-10-25", 100), ...downloadRows("2026-10-26", 2), ...engagementRows("2026-10-26", 8)]);
  assert.ok(Math.abs(overlap.conversion - 2 / 8) < 1e-9);
  assert.deepEqual(overlap.conversionWindow, { since: "2026-10-26", until: "2026-10-26", days: 1, spanDays: 1 });

  // A gap in the shared days is counted and named, not smoothed over.
  const gap = pageData.buildAppStoreView([...downloadRows("2026-10-24", 1), ...engagementRows("2026-10-24", 4), ...downloadRows("2026-10-26", 1), ...engagementRows("2026-10-26", 4)]);
  assert.deepEqual(gap.conversionWindow, { since: "2026-10-24", until: "2026-10-26", days: 2, spanDays: 3 });
  assert.match(format.appStoreTileLine(gap), /25% page view → download, 2 days both reports cover \(Oct 24–Oct 26\)/);
  assert.match(format.appStoreTileLine(gap), /Oct 24–Oct 26, 2 of 3 days \(Apple days\)/);
  assert.match(format.appStoreTileLine(disjoint), /– page view → download \(no day both reports cover yet\)/);
  assert.match(format.appStoreTileLine(disjoint), /20 impressions · 10 page views, Oct 25/);
});

await test("missing data: a real zero on a covered day stays a 0", async () => {
  const rows = [...downloadRows("2026-10-26", 0), ...engagementRows("2026-10-26", 0)];
  const view = pageData.buildAppStoreView(rows);
  assert.equal(view.firstDownloads, 0);
  assert.equal(view.pageViews, 0);
  assert.equal(view.conversion, null, "nothing to divide by");
  assert.match(format.appStoreTileLine(view), /no page views on the 1 day both reports cover/);
  const zeroDownloads = pageData.buildAppStoreView([...downloadRows("2026-10-26", 0), ...engagementRows("2026-10-26", 8)]);
  assert.equal(zeroDownloads.conversion, 0);
  assert.match(format.appStoreTileLine(zeroDownloads), /0\.0% page view → download/);
  const { tile } = await renderLaunch(rows, [appleRun("2026-10-30T11:30:00Z")]);
  assert.match(tile, />0<\/p>/);
  assert.ok(!/>–<\/p>/.test(tile));
});

await test("missing data: source table cells show a dash for a metric no day covers, a 0 where the report covered it", async () => {
  const source = (date, metric, value, label = "App Store search") => appleRow(date, metric, value, `source_type:${label}`);
  const onlyDownloads = pageData.buildAppStoreView([...downloadRows("2026-10-26"), source("2026-10-26", "first_downloads", 5)]);
  assert.deepEqual(onlyDownloads.sourceTypes, [{ label: "App Store search", impressions: null, pageViews: null, firstDownloads: 5, redownloads: 0 }]);
  const both = pageData.buildAppStoreView([...downloadRows("2026-10-26"), ...engagementRows("2026-10-26"), source("2026-10-26", "first_downloads", 5), source("2026-10-26", "impressions", 20, "Web referrer")]);
  assert.deepEqual(both.sourceTypes.map((r) => [r.label, r.impressions, r.pageViews, r.firstDownloads, r.redownloads]), [
    ["App Store search", 0, 0, 5, 0],
    ["Web referrer", 20, 0, 0, 0],
  ]);
  const { section } = await renderLaunch([...downloadRows("2026-10-26"), source("2026-10-26", "first_downloads", 5)], [appleRun("2026-10-30T11:30:00Z")]);
  const row = section.slice(section.indexOf("App Store search"), section.indexOf("</tr>", section.indexOf("App Store search")));
  assert.equal((row.match(/>–</g) ?? []).length, 2, "impressions and page views");
  assert.match(row, />5</);
});

await test("missing data: a Detailed group's missing number is a dash (Apple hides small groups), a stored number stays", async () => {
  const detail = (metric, value, label = "site-hero") => appleRow("2026-10-26", metric, value, `campaign:${label}`);
  const view = pageData.buildAppStoreView([...engagementRows("2026-10-26"), detail("product_page_views", 7), detail("first_downloads", 2, "site-footer"), detail("product_page_views", 0, "site-footer")]);
  assert.deepEqual(view.campaigns, [
    { label: "site-footer", firstDownloads: 2, pageViews: 0 },
    { label: "site-hero", firstDownloads: null, pageViews: 7 },
  ]);
  const { section } = await renderLaunch([...engagementRows("2026-10-26"), detail("product_page_views", 7)], [appleRun("2026-10-30T11:30:00Z")]);
  const row = section.slice(section.indexOf("site-hero</"), section.indexOf("</tr>", section.indexOf("site-hero</")));
  assert.match(row, />–</);
  assert.match(row, />7</);
});

const noKeys = { apple: CONFIG, appDb: null, web: null, searchConsole: null, alertProjectId: null };
function seedDownloads(store, date) {
  store.state.daily.set(`${date}|apple|first_downloads|`, { metric_date: date, source: "apple", metric: "first_downloads", dimension: "", value: 3, variant: "standard", apple_processing_date: date });
}
const freshRun = (store, fetchImpl, at) => sync.runLaunchSync({ store, env: noKeys, fetchImpl, now: () => new Date(at) }, { trigger: "cron", kind: "full" });

await test("freshness rule: 72 hours past Apple's 3-day delay, by data day; a normal late report isn't stale, a re-issue can't reset it", () => {
  assert.equal(stale.APPLE_REPORT_LAG_DAYS, 3);
  // The newest day ends Oct 27 00:00 UTC: 3 days due + 72 hours = Nov 2 00:00.
  assert.equal(stale.appleDataIsStale("2026-10-26", new Date("2026-11-01T23:59:00Z")), false);
  assert.equal(stale.appleDataIsStale("2026-10-26", new Date("2026-11-02T00:01:00Z")), true);
  assert.equal(stale.appleDataIsStale("2026-10-27", new Date("2026-10-30T11:30:00Z")), false, "three days late is normal");
  const code = (before, after, now) => stale.appleRunCode(before, after, new Date(now));
  const at = "2026-10-30T11:30:00Z";
  const same = { engagement: "2026-10-27", downloads: "2026-10-27" };
  assert.equal(code(same, same, at), "apple_no_new_data", "nothing moved");
  assert.equal(code(same, { ...same, downloads: "2026-10-28" }, at), "ok", "either family moving forward is news");
  assert.equal(code({ engagement: null, downloads: null }, { engagement: null, downloads: "2026-10-28" }, at), "ok", "the first report");
  assert.equal(code({ engagement: null, downloads: null }, { engagement: null, downloads: null }, at), "apple_no_new_data", "still waiting");
  assert.equal(code({ engagement: "2026-10-21", downloads: "2026-10-27" }, { engagement: "2026-10-21", downloads: "2026-10-28" }, at), "apple_no_new_data", "one family still out of date");
  assert.equal(code({ engagement: "2026-10-10", downloads: "2026-10-10" }, { engagement: "2026-10-12", downloads: "2026-10-12" }, at), "apple_no_new_data", "catching up, not caught up");
});

await test("freshness: a successful poll with nothing new doesn't reset the clock: Oct 21 data shows out of date on Oct 30", async () => {
  const store = memoryStore();
  seedDownloads(store, "2026-10-21");
  store.state.instances.set("i-probe", { instance_id: "i-probe" });
  const at = "2026-10-30T12:00:00Z";
  const result = await freshRun(store, fakeApple(probeModel({ reply: (item) => whole(item, 1) })), at);
  assert.equal(result.sources.apple, "apple_no_new_data");
  const through = { engagement: null, downloads: "2026-10-21" };
  const health = stale.sourceHealth(store.state.runs, new Date(at), through).find((h) => h.source === "apple");
  assert.equal(health.state, "stale");
  assert.equal(Date.parse(health.lastOkAt), Date.parse(at), "Apple was reached");
  assert.deepEqual(health.appleData.downloads, { through: "2026-10-21", stale: true });
  const line = format.healthLine(health);
  assert.equal(line.tone, "warning");
  assert.match(line.text, /downloads through Oct 21 \(out of date\)/);
  assert.match(line.text, /last reached Apple Oct 30/);
});

await test("freshness: instances with no segment yet are not ok and not fresh; Apple shows as waiting", async () => {
  const store = memoryStore();
  const at = "2026-10-30T12:00:00Z";
  const result = await freshRun(store, fakeApple(probeModel({ bodies: [], reply: () => ({ data: [], links: {}, meta: { paging: { total: 0 } } }) })), at);
  assert.equal(result.sources.apple, "apple_no_new_data");
  assert.equal(store.state.instances.size, 0);
  const health = stale.sourceHealth(store.state.runs, new Date(at)).find((h) => h.source === "apple");
  assert.equal(health.state, "waiting");
  assert.notEqual(format.healthLine(health).tone, "success");
  assert.match(format.healthLine(health).text, /waiting for Apple's first report/);
  assert.equal(format.sourceBadge(health, false).label, "No data yet");
});

await test("freshness: new days count as new; a re-issue of old days does not", async () => {
  const store = memoryStore();
  const fresh = probeModel({ reply: (item) => whole(item, 1) });
  const first = await freshRun(store, fakeApple(fresh), "2026-10-30T12:00:00Z");
  assert.equal(first.sources.apple, "ok");
  // A newer instance re-issuing the same day: rows change, the data doesn't move forward.
  store.state.instances.clear();
  const reissue = probeModel({ bodies: [probeText("9")], reply: (item) => whole(item, 1), processingDate: "2026-10-29" });
  const second = await freshRun(store, fakeApple(reissue), "2026-10-31T12:00:00Z");
  assert.equal(second.sources.apple, "apple_no_new_data");
  assert.equal(store.get("2026-10-26", "first_downloads"), 9, "the re-issue is still saved");
});

await test("freshness: each family stands alone; a family out of date makes the source out of date, the other still reads", () => {
  const at = new Date("2026-10-30T12:00:00Z");
  const run = appleRun("2026-10-30T11:30:00Z");
  const apple1 = stale.sourceHealth([run], at, { engagement: "2026-10-27", downloads: "2026-10-21" }).find((h) => h.source === "apple");
  assert.equal(apple1.state, "stale");
  assert.deepEqual(apple1.appleData, { engagement: { through: "2026-10-27", stale: false }, downloads: { through: "2026-10-21", stale: true } });
  assert.match(format.healthLine(apple1).text, /downloads through Oct 21 \(out of date\), impressions and page views through Oct 27/);
  const apple2 = stale.sourceHealth([run], at, { engagement: "2026-10-27", downloads: null }).find((h) => h.source === "apple");
  assert.equal(apple2.state, "fresh");
  assert.match(format.healthLine(apple2).text, /no downloads report yet, impressions and page views through Oct 27/);
});

await test("freshness: other sources keep their rule; only Apple's code changes (no Apple data read, no new code)", () => {
  const now = new Date("2026-10-30T12:00:00Z");
  const run = { id: "r", trigger: "cron", kind: "full", started_at: "2026-10-30T11:30:00Z", finished_at: "2026-10-30T11:31:00Z", status: "ok", sources: { app_db: "ok", web: "ok", search_console: "ok", apple: "not_connected" } };
  const health = stale.sourceHealth([run], now);
  assert.deepEqual(health.map((h) => h.state), ["fresh", "fresh", "fresh", "not_connected"]);
  assert.ok(health.filter((h) => h.source !== "apple").every((h) => !("appleData" in h)));
  assert.equal(sync.runStatus({ app_db: "ok", apple: "apple_no_new_data" }), "ok");
  assert.equal(sync.runStatus({ app_db: "http_500", apple: "apple_no_new_data" }), "partial");
  assert.equal(sync.runStatus({ app_db: "http_500", apple: "http_500" }), "failed");
  assert.deepEqual(alerts.decideAlert(["ok", "http_500", "http_500"]), { action: "recover" });
  assert.deepEqual(alerts.decideAlert(["http_500", "http_500"]), { action: "raise", code: "http_500", streak: 2 });
});

await test("alerts: a poll with nothing new never closes the two-failure alert; data moving does", async () => {
  const store = memoryStore();
  const stopped = standardModel({ requests: [{ id: "req-old", accessType: "ONGOING", stopped: true }] });
  let at = Date.parse("2026-10-28T11:30:00Z");
  const run = (model) => {
    at += 3_600_000;
    return freshRun(store, fakeApple(model), new Date(at).toISOString());
  };
  await run(stopped);
  await run(stopped);
  assert.equal(store.state.tasks.length, 1);
  assert.equal(store.state.tasks[0].status, "Planned");

  seedDownloads(store, "2026-10-21");
  store.state.instances.set("i-probe", { instance_id: "i-probe" });
  for (let i = 0; i < 3; i += 1) {
    const idle = await run(probeModel({ reply: (item) => whole(item, 1) }));
    assert.equal(idle.sources.apple, "apple_no_new_data");
    assert.equal(idle.alerts.find((a) => a.source === "apple").action, "none");
    assert.equal(store.state.tasks[0].status, "Planned", "still open: no number moved");
  }

  store.state.instances.clear();
  const moved = await run(probeModel({ reply: (item) => whole(item, 1) }));
  assert.equal(moved.sources.apple, "ok");
  assert.equal(moved.alerts.find((a) => a.source === "apple").action, "resolved");
  assert.equal(store.state.tasks[0].status, "Done");
});

await test("alerts: a poll with nothing new is not a failure: it raises nothing, and it breaks a failure streak", () => {
  const code = "apple_no_new_data";
  assert.deepEqual(alerts.decideAlert([code]), { action: "none" });
  assert.deepEqual(alerts.decideAlert([code, code, code]), { action: "none" });
  assert.deepEqual(alerts.decideAlert([code, "http_500", "http_500"]), { action: "none" }, "neither raised again nor closed");
  assert.deepEqual(alerts.decideAlert(["http_500", code, "http_500"]), { action: "none" }, "not two in a row");
  assert.deepEqual(alerts.decideAlert(["http_500", "http_500", code]), { action: "raise", code: "http_500", streak: 2 });
});

await test("page: data through and last reached Apple are shown apart; fresh, stale and failing all say both", async () => {
  const daily = [...engagementRows("2026-10-25"), ...downloadRows("2026-10-26")];
  const fresh = await renderLaunch(daily, [appleRun("2026-10-30T11:30:00Z")]);
  assert.match(fresh.html, /Downloads through Oct 26, impressions and page views through Oct 25\./);
  assert.match(fresh.html, /Last reached Apple Oct 30/);
  assert.match(fresh.html, /App Store: downloads through Oct 26, impressions and page views through Oct 25; last reached Apple Oct 30/);
  assert.match(fresh.html, /A day Apple hasn(&#x27;|')t sent yet is left blank, not 0\./);

  const old = await renderLaunch([...engagementRows("2026-10-21"), ...downloadRows("2026-10-21")], [appleRun("2026-10-30T11:30:00Z", "apple_no_new_data")]);
  assert.match(old.html, /Data through Oct 21 \(out of date\)\./);
  assert.match(old.html, /App Store: data through Oct 21 \(out of date\); last reached Apple Oct 30/);
  assert.match(old.html, /Out of date/);

  const failing = await renderLaunch(downloadRows("2026-10-26"), [appleRun("2026-10-30T11:30:00Z", "http_500"), appleRun("2026-10-29T11:30:00Z")]);
  assert.match(failing.html, /App Store: last try failed \(http_500\); last reached Apple Oct 29/);
  assert.ok(!/claude|anthropic/i.test(fresh.html + old.html + failing.html));
});

await test("store: appleDataThrough asks for each family's newest day total, for this user, since release", async () => {
  const { createSupabaseLaunchStore } = await import("../src/lib/launch-metrics/store.ts");
  const queries = [];
  const client = {
    from(table) {
      const query = { table, filters: {} };
      queries.push(query);
      const chain = {
        select: () => chain,
        eq(column, value) { query.filters[column] = value; return chain; },
        in(column, value) { query.filters[column] = value; return chain; },
        gte(column, value) { query.since = [column, value]; return chain; },
        order(column, options) { query.order = [column, options.ascending]; return chain; },
        limit(n) {
          query.limit = n;
          return Promise.resolve({ data: query.filters.metric.includes("first_downloads") ? [{ metric_date: "2026-10-26" }] : [], error: null });
        },
      };
      return chain;
    },
  };
  const store = createSupabaseLaunchStore(client, "user-1");
  assert.deepEqual(await store.appleDataThrough(), { engagement: null, downloads: "2026-10-26" });
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.equal(query.table, "launch_metric_daily");
    assert.deepEqual([query.filters.user_id, query.filters.source, query.filters.dimension], ["user-1", "apple", ""]);
    assert.deepEqual(query.since, ["metric_date", "2026-10-21"]);
    assert.deepEqual([query.order, query.limit], [["metric_date", false], 1]);
  }
  const failing = createSupabaseLaunchStore({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ in: () => ({ gte: () => ({ order: () => ({ limit: async () => ({ data: null, error: { code: "x" } }) }) }) }) }) }) }) }) }) }, "user-1");
  await rejectsWithCode(failing.appleDataThrough(), "db_read");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
