// Offline tests for the launch metrics clients, sync, alerts, page model and
// seed import (src/lib/launch-metrics/*). No network: every outbound call goes
// to a fake fetch that records what it was sent. No database.
//
//   npm run test:launch-metrics

import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { readFileSync } from "node:fs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/launch-metrics/${name}`, import.meta.url), "utf8"));

const http = await import("../src/lib/launch-metrics/http.ts");
const appDb = await import("../src/lib/launch-metrics/app-db.ts");
const web = await import("../src/lib/launch-metrics/vercel-analytics.ts");
const gsc = await import("../src/lib/launch-metrics/search-console.ts");

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
    console.log(String(error?.stack ?? error).split("\n").slice(0, 6).map((l) => `    ${l}`).join("\n"));
  }
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** routes: [{ match: (url, init) => bool, reply: (url, init) => Response | throws }] */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    for (const route of routes) {
      if (route.match(url, init)) return route.reply(url, init);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  fn.calls = calls;
  return fn;
}

async function rejectsWithCode(promiseOrFn, code) {
  try {
    await (typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn);
  } catch (error) {
    assert.equal(error?.name, "LaunchSourceError", `expected LaunchSourceError, got ${error}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected code ${code}, nothing thrown`);
}

const NOW = new Date("2026-10-27T19:30:00Z"); // 3:30 PM ET Tue 10/27
const APP_DB_URL = "https://abcdefghijklmnopqrst.supabase.co/functions/v1/launch-metrics";
const APP_DB_TOKEN = "t".repeat(48);

// ─── http helper ──────────────────────────────────────────────────────────

await test("http: refuses non-https, other hosts, ports and userinfo before any call", async () => {
  const fetchImpl = fakeFetch([]);
  for (const url of [
    "http://api.vercel.com/x",
    "https://api.vercel.com.evil.test/x",
    "https://evil.test/api.vercel.com",
    "https://api.vercel.com:8443/x",
    "https://user:pw@api.vercel.com/x",
    "not a url",
  ]) {
    await rejectsWithCode(http.fetchJson(fetchImpl, { url, allowedHosts: ["api.vercel.com"] }), url === "not a url" ? "bad_url" : "host_not_allowed");
  }
  assert.equal(fetchImpl.calls.length, 0);
});

await test("http: refuses redirects, sets no-store and a timeout signal", async () => {
  const fetchImpl = fakeFetch([{ match: () => true, reply: () => jsonResponse({ ok: 1 }) }]);
  await http.fetchJson(fetchImpl, { url: "https://api.vercel.com/x", allowedHosts: ["api.vercel.com"] });
  const init = fetchImpl.calls[0].init;
  assert.equal(init.redirect, "error");
  assert.equal(init.cache, "no-store");
  assert.ok(init.signal instanceof AbortSignal);
  const redirecting = fakeFetch([{ match: () => true, reply: () => new Response(null, { status: 302, headers: { location: "https://evil.test/" } }) }]);
  await rejectsWithCode(http.fetchJson(redirecting, { url: "https://api.vercel.com/x", allowedHosts: ["api.vercel.com"] }), "redirect_refused");
});

await test("http: errors carry a code only, never the body or the token", async () => {
  const secretBody = "SECRET-BODY Bearer abc123 user@example.com";
  const fetchImpl = fakeFetch([{ match: () => true, reply: () => new Response(secretBody, { status: 401 }) }]);
  const error = await rejectsWithCode(
    http.fetchJson(fetchImpl, { url: "https://api.vercel.com/x", allowedHosts: ["api.vercel.com"], headers: { Authorization: "Bearer abc123" } }),
    "http_401"
  );
  assert.equal(error.message, "http_401");
  assert.ok(!JSON.stringify({ m: error.message, s: String(error.stack) }).includes("SECRET-BODY"));
  assert.ok(!String(error.stack).includes("abc123"));
});

await test("http: network error, timeout, bad JSON and oversize bodies map to codes", async () => {
  const network = fakeFetch([{ match: () => true, reply: () => { throw new TypeError("fetch failed: connect ECONNREFUSED secret-host"); } }]);
  await rejectsWithCode(http.fetchJson(network, { url: "https://api.vercel.com/x", allowedHosts: ["api.vercel.com"] }), "network");
  const timeout = fakeFetch([{ match: () => true, reply: () => { throw new DOMException("timed out", "TimeoutError"); } }]);
  await rejectsWithCode(http.fetchJson(timeout, { url: "https://api.vercel.com/x", allowedHosts: ["api.vercel.com"] }), "timeout");
  const badJson = fakeFetch([{ match: () => true, reply: () => new Response("<html>", { status: 200 }) }]);
  await rejectsWithCode(http.fetchJson(badJson, { url: "https://api.vercel.com/x", allowedHosts: ["api.vercel.com"] }), "bad_json");
  const big = fakeFetch([{ match: () => true, reply: () => new Response("x".repeat(5000), { status: 200 }) }]);
  await rejectsWithCode(http.fetchJson(big, { url: "https://api.vercel.com/x", allowedHosts: ["api.vercel.com"], maxBytes: 1000 }), "too_large");
  const declared = fakeFetch([{ match: () => true, reply: () => new Response("{}", { status: 200, headers: { "content-length": "99999999" } }) }]);
  await rejectsWithCode(http.fetchJson(declared, { url: "https://api.vercel.com/x", allowedHosts: ["api.vercel.com"], maxBytes: 1000 }), "too_large");
});

await test("http: an odd code is normalised, and errorCode() never echoes a foreign message", () => {
  assert.equal(new http.LaunchSourceError("Bearer abc 123").code, "error");
  assert.equal(http.errorCode(new Error("db password=hunter2")), "error");
  assert.equal(http.errorCode(new http.LaunchSourceError("http_500")), "http_500");
});

// ─── app database (Grocery launch-metrics function) ───────────────────────

await test("app db: the REAL Grocery reply (schema_version 1) validates and every count it sends is kept", () => {
  const raw = fixture("app-db-summary.json");
  const summary = appDb.validateAppDbSummary(raw, NOW);
  assert.equal(summary.schema_version, 1);
  assert.equal(summary.release_at, "2026-10-21T17:42:00.000Z");
  assert.equal(summary.as_of_date_et, "2026-10-27");
  assert.equal(summary.generated_at, "2026-10-27T19:00:00.123Z");
  // Every count key the Grocery function sends survives (nothing silently dropped).
  assert.deepEqual(Object.keys(summary.totals).sort(), Object.keys(raw.totals).sort());
  assert.deepEqual(summary.totals, raw.totals);
  assert.equal(summary.daily.length, 7);
  for (const [index, day] of summary.daily.entries()) assert.deepEqual(day, raw.daily[index]);
  assert.deepEqual(Object.keys(summary).sort(), ["as_of_date_et", "daily", "generated_at", "release_at", "schema_version", "totals"]);
});

await test("app db: the contract key lists match the Grocery contract exactly", () => {
  const raw = fixture("app-db-summary.json");
  assert.deepEqual([...appDb.APP_DB_TOTAL_REQUIRED, ...appDb.APP_DB_TOTAL_OPTIONAL].sort(), Object.keys(raw.totals).sort());
  assert.deepEqual([...appDb.APP_DB_DAILY_REQUIRED, ...appDb.APP_DB_DAILY_OPTIONAL].sort(), Object.keys(raw.daily[0]).filter((k) => k !== "date").sort());
});

await test("app db: an accounts list, an id, an email or a name anywhere refuses the whole reply", () => {
  const base = fixture("app-db-summary.json");
  const cases = [
    { ...base, accounts: [{ short_id: "0a1b2c3d", sign_in: "Apple" }] },
    { ...base, accounts: [] },
    { ...base, totals: { ...base.totals, user_ids: ["0a1b2c3d"] } },
    { ...base, daily: [{ ...base.daily[0], id: "0a1b2c3d" }] },
    { ...base, daily: [{ ...base.daily[0], note: "someone@example.com" }] },
    { ...base, totals: { ...base.totals, latest_signup: "0a1b2c3d" } },
    { ...base, extra: "0a1b2c3d" },
    { ...base, display_name: "Pat" },
    { ...base, name: 3 },
    { ...base, daily: [{ ...base.daily[0], email: "a@b.c" }] },
    // The two strings the contract allows carry only a timestamp / an ET date.
    { ...base, release_at: "0a1b2c3d" },
    { ...base, release_at: "someone@example.com" },
    { ...base, release_at: "2026-10-21T17:42:00+00:00 0a1b2c3d" },
    { ...base, as_of_date_et: "0a1b2c3d" },
    { ...base, as_of_date_et: "2026-10-27 Pat" },
    { ...base, generated_at: "Pat" },
    { ...base, schema_version: "1" },
  ];
  for (const raw of cases) {
    assert.throws(() => appDb.validateAppDbSummary(raw, NOW), (error) => error.code === "app_db_not_counts", JSON.stringify(raw).slice(0, 160));
  }
});

await test("app db: wrong shapes are refused (version, missing totals, non-integers, negatives, bad or repeated dates)", () => {
  const base = fixture("app-db-summary.json");
  const noRealUsers = { ...base.totals };
  delete noRealUsers.real_users;
  const noVersion = { ...base };
  delete noVersion.schema_version;
  const noRelease = { ...base };
  delete noRelease.release_at;
  const noAsOf = { ...base };
  delete noAsOf.as_of_date_et;
  const cases = [
    null,
    [],
    noVersion,
    { ...base, schema_version: 2 },
    { ...base, schema_version: 0 },
    noRelease,
    noAsOf,
    { ...base, release_at: 5 },
    { ...base, as_of_date_et: "2026-02-30" },
    { ...base, as_of_date_et: "2026-12-01" },
    { ...base, release_at: "2026-13-40T99:00:00Z" },
    { ...base, totals: noRealUsers },
    { ...base, totals: { ...base.totals, real_users: 1.5 } },
    { ...base, totals: { ...base.totals, real_users: -1 } },
    { ...base, totals: { ...base.totals, deleted_accounts: -1 } },
    { ...base, totals: { ...base.totals, real_users: "2" } },
    { ...base, daily: "none" },
    { ...base, daily: [{ ...base.daily[0], date: "2026-02-30" }] },
    { ...base, daily: [base.daily[0], base.daily[0]] },
    { ...base, daily: [{ ...base.daily[0], date: "2026-12-01" }] },
    { ...base, daily: [{ date: "2026-10-26", signups_real: 1 }] },
  ];
  for (const raw of cases) {
    assert.throws(() => appDb.validateAppDbSummary(raw, NOW), (error) => ["app_db_shape", "app_db_not_counts"].includes(error.code), JSON.stringify(raw)?.slice(0, 160));
  }
  // Wrong version and a missing field are shape errors, not "not counts".
  for (const raw of [noVersion, { ...base, schema_version: 2 }, noRelease, noAsOf]) {
    assert.throws(() => appDb.validateAppDbSummary(raw, NOW), (error) => error.code === "app_db_shape");
  }
});

await test("app db: years of daily rows are fine (no refusals from mid-2029 on)", async () => {
  const { dateRange } = await import("../src/lib/launch-metrics/dates.ts");
  const base = fixture("app-db-summary.json");
  const later = new Date("2031-06-01T16:00:00Z");
  const days = dateRange("2026-10-21", "2031-06-01");
  assert.ok(days.length > 1000);
  const raw = { ...base, as_of_date_et: "2031-06-01", daily: days.map((date) => ({ ...base.daily[0], date })) };
  assert.equal(appDb.validateAppDbSummary(raw, later).daily.length, days.length);
});

await test("app db: unknown count fields are dropped; only `date` is the date key", () => {
  const base = fixture("app-db-summary.json");
  const summary = appDb.validateAppDbSummary(
    { ...base, totals: { ...base.totals, households_total: 7 }, daily: [{ ...base.daily[5], future_count: 3 }] },
    NOW
  );
  assert.equal("households_total" in summary.totals, false);
  assert.deepEqual(summary.daily, [base.daily[5]]);
  assert.throws(() => appDb.validateAppDbSummary({ ...base, daily: [{ ...base.daily[5], date: undefined, day: "2026-10-26" }] }, NOW), (error) => error.code === "app_db_shape");
});

await test("app db: rows are daily sign-ups (ET days, deleted and internal too) plus as-of totals", () => {
  const summary = appDb.validateAppDbSummary(fixture("app-db-summary.json"), NOW);
  const rows = appDb.appDbDailyRows(summary, "2026-10-27");
  const find = (date, metric) => rows.find((r) => r.metric_date === date && r.metric === metric)?.value;
  assert.equal(find("2026-10-26", "signups_real"), 2);
  assert.equal(find("2026-10-26", "signups_unconfirmed"), 1);
  assert.equal(find("2026-10-23", "signups_family"), 2);
  assert.equal(find("2026-10-25", "signups_deleted"), 1);
  assert.equal(find("2026-10-25", "signups_internal"), 0);
  assert.equal(find("2026-10-27", "total_real_users"), 2);
  assert.equal(find("2026-10-27", "total_deleted_accounts"), 1);
  assert.equal(find("2026-10-27", "total_real_households"), 2);
  assert.equal(find("2026-10-27", "total_internal_accounts"), 0);
  assert.equal(find("2026-10-27", "total_plus_comp"), 3);
  assert.ok(rows.every((r) => r.source === "app_db" && r.dimension === "" && /^[a-z][a-z0-9_]{0,59}$/.test(r.metric)));
});

await test("app db: fetch sends the bearer token to the one function URL only", async () => {
  const fetchImpl = fakeFetch([{ match: (url) => url === APP_DB_URL, reply: () => jsonResponse(fixture("app-db-summary.json")) }]);
  const summary = await appDb.fetchAppDbSummary({ url: APP_DB_URL, token: APP_DB_TOKEN }, fetchImpl, NOW);
  assert.equal(summary.totals.real_users, 2);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].init.method, "GET");
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, `Bearer ${APP_DB_TOKEN}`);
});

await test("app db: any other URL or a weak token is refused before a call", async () => {
  const fetchImpl = fakeFetch([]);
  for (const url of [
    "http://abcdefghijklmnopqrst.supabase.co/functions/v1/launch-metrics",
    "https://abcdefghijklmnopqrst.supabase.co/functions/v1/other",
    "https://abcdefghijklmnopqrst.supabase.co/functions/v1/launch-metrics?x=1",
    "https://evil.test/functions/v1/launch-metrics",
    "https://abcdefghijklmnopqrst.supabase.co.evil.test/functions/v1/launch-metrics",
    "https://abcdefghijklmnopqrst.supabase.co:444/functions/v1/launch-metrics",
    "https://u:p@abcdefghijklmnopqrst.supabase.co/functions/v1/launch-metrics",
  ]) {
    await rejectsWithCode(appDb.fetchAppDbSummary({ url, token: APP_DB_TOKEN }, fetchImpl, NOW), "app_db_bad_url");
  }
  await rejectsWithCode(appDb.fetchAppDbSummary({ url: APP_DB_URL, token: "short" }, fetchImpl, NOW), "app_db_bad_token");
  assert.equal(fetchImpl.calls.length, 0);
});

await test("app db: a 401 from the function is http_401", async () => {
  const fetchImpl = fakeFetch([{ match: () => true, reply: () => jsonResponse({ error: "unauthorized" }, 401) }]);
  await rejectsWithCode(appDb.fetchAppDbSummary({ url: APP_DB_URL, token: APP_DB_TOKEN }, fetchImpl, NOW), "http_401");
});

// ─── website (Vercel Web Analytics) ───────────────────────────────────────

const WEB_CONFIG = { token: "vercel_token_fixture_0123456789", projectId: "prj_menuandmarket", teamId: "team_brent", tokenExpires: "2027-10-27" };

function vercelFetch() {
  return fakeFetch([
    {
      match: (url) => url.includes("/visits/aggregate") && url.includes("referrerHostname"),
      reply: () => jsonResponse(fixture("vercel-visits-by-referrer.json")),
    },
    { match: (url) => url.includes("/visits/aggregate"), reply: () => jsonResponse(fixture("vercel-visits-by-day.json")) },
    { match: (url) => url.includes("/events/aggregate"), reply: () => jsonResponse(fixture("vercel-events-placement.json")) },
  ]);
}

await test("web: three GETs to api.vercel.com with the documented parameters", async () => {
  const fetchImpl = vercelFetch();
  const result = await web.fetchWebMetrics(WEB_CONFIG, fetchImpl, "2026-10-27");
  assert.equal(fetchImpl.calls.length, 3);
  const urls = fetchImpl.calls.map((c) => new URL(c.url));
  assert.ok(urls.every((u) => u.hostname === "api.vercel.com" && u.protocol === "https:"));
  assert.deepEqual(urls.map((u) => u.pathname), [
    "/v1/query/web-analytics/visits/aggregate",
    "/v1/query/web-analytics/visits/aggregate",
    "/v1/query/web-analytics/events/aggregate",
  ]);
  assert.deepEqual(urls[0].searchParams.getAll("by"), ["day"]);
  assert.deepEqual(urls[1].searchParams.getAll("by"), ["day", "referrerHostname"]);
  assert.deepEqual(urls[2].searchParams.getAll("by"), ["day", "eventData/placement"]);
  assert.equal(urls[2].searchParams.get("filter"), "eventName eq 'App Store tap'");
  assert.ok(urls.every((u) => u.searchParams.get("projectId") === "prj_menuandmarket" && u.searchParams.get("teamId") === "team_brent"));
  assert.equal(urls[0].searchParams.get("since"), "2026-10-21");
  assert.equal(urls[0].searchParams.get("until"), "2026-10-27");
  assert.equal(urls[1].searchParams.get("since"), "2026-10-21");
  assert.ok(fetchImpl.calls.every((c) => c.init.headers.Authorization === `Bearer ${WEB_CONFIG.token}`));
  assert.equal(result.since, "2026-10-21");
});

await test("web: windows roll forward (45 days of totals, 7 days of breakdowns), never before release", async () => {
  const fetchImpl = vercelFetch();
  await web.fetchWebMetrics(WEB_CONFIG, fetchImpl, "2027-01-15");
  const urls = fetchImpl.calls.map((c) => new URL(c.url));
  assert.equal(urls[0].searchParams.get("since"), "2026-12-01");
  assert.equal(urls[1].searchParams.get("since"), "2027-01-08");
  assert.equal(urls[2].searchParams.get("since"), "2027-01-08");
});

await test("web: rows are UTC days; visitor and user ids in a row are never read", async () => {
  const { rows } = await web.fetchWebMetrics(WEB_CONFIG, vercelFetch(), "2026-10-27");
  const get = (date, metric, dimension) => rows.find((r) => r.metric_date === date && r.metric === metric && r.dimension === dimension)?.value;
  assert.equal(get("2026-10-26", "pageviews", ""), 58);
  assert.equal(get("2026-10-26", "visitors", ""), 31);
  assert.equal(get("2026-10-26", "pageviews", "referrer:www.reddit.com"), 30);
  assert.equal(get("2026-10-26", "pageviews", "referrer:(direct)"), 20);
  assert.equal(get("2026-10-26", "pageviews", "referrer:others"), 8);
  assert.equal(get("2026-10-27", "pageviews", "referrer:www.google.com"), 12);
  assert.equal(get("2026-10-26", "app_store_taps", "placement:site-hero"), 4);
  assert.equal(get("2026-10-26", "app_store_taps", ""), 5);
  assert.equal(get("2026-10-27", "app_store_taps", ""), 2);
  const text = JSON.stringify(rows);
  assert.ok(!text.includes("should-never-be-read"));
});

await test("web: malformed replies are web_shape; an expired token is http_403", async () => {
  for (const body of [{}, { data: "x" }, { data: [{ pageviews: 1 }] }, { data: [{ timestamp: "nope", pageviews: 1 }] }, { data: [{ timestamp: "2026-10-26T00:00:00Z", pageviews: -1 }] }]) {
    const fetchImpl = fakeFetch([{ match: () => true, reply: () => jsonResponse(body) }]);
    await rejectsWithCode(web.fetchWebMetrics(WEB_CONFIG, fetchImpl, "2026-10-27"), "web_shape");
  }
  const expired = fakeFetch([{ match: () => true, reply: () => jsonResponse({ error: { code: "forbidden" } }, 403) }]);
  await rejectsWithCode(web.fetchWebMetrics(WEB_CONFIG, expired, "2026-10-27"), "http_403");
});

await test("web: a project or team id that could change the query is refused before a call", async () => {
  const fetchImpl = fakeFetch([]);
  await rejectsWithCode(web.fetchWebMetrics({ ...WEB_CONFIG, projectId: "prj&teamId=other" }, fetchImpl, "2026-10-27"), "web_bad_config");
  await rejectsWithCode(web.fetchWebMetrics({ ...WEB_CONFIG, teamId: "../x" }, fetchImpl, "2026-10-27"), "web_bad_config");
  await rejectsWithCode(web.fetchWebMetrics({ ...WEB_CONFIG, token: "short" }, fetchImpl, "2026-10-27"), "web_bad_token");
  assert.equal(fetchImpl.calls.length, 0);
});

await test("web: dimension values are cleaned (control characters, length)", () => {
  assert.equal(web.cleanDimensionValue("a\u0000b\nc", "x"), "abc");
  assert.equal(web.cleanDimensionValue("   ", "(direct)"), "(direct)");
  assert.equal(web.cleanDimensionValue(42, "(none)"), "(none)");
  assert.equal(web.cleanDimensionValue("y".repeat(500), "x").length, 120);
});

await test("web: config reads env names and ignores a malformed expiry date", () => {
  assert.equal(web.readVercelAnalyticsConfig({}), null);
  const config = web.readVercelAnalyticsConfig({ VERCEL_ANALYTICS_TOKEN: " tok ", VERCEL_ANALYTICS_PROJECT_ID: "prj_1", VERCEL_ANALYTICS_TOKEN_EXPIRES: "next year" });
  assert.deepEqual(config, { token: "tok", projectId: "prj_1", teamId: null, tokenExpires: null });
});

// ─── Search Console ───────────────────────────────────────────────────────

const { privateKey: RSA_PRIVATE, publicKey: RSA_PUBLIC } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const RSA_PEM = RSA_PRIVATE.export({ type: "pkcs8", format: "pem" });
const GSC_CONFIG = {
  clientEmail: "launch-metrics@menuandmarket-123456.iam.gserviceaccount.com",
  privateKeyPem: RSA_PEM,
  siteUrl: "sc-domain:menuandmarket.com",
};

function gscFetch(overrides = {}) {
  return fakeFetch([
    { match: (url) => url === "https://oauth2.googleapis.com/token", reply: overrides.token ?? (() => jsonResponse(fixture("gsc-token.json"))) },
    {
      match: (url) => url.startsWith("https://searchconsole.googleapis.com/"),
      reply: (url, init) => {
        const dims = JSON.parse(init.body).dimensions[0];
        if (overrides[dims]) return overrides[dims](url, init);
        return jsonResponse(fixture(`gsc-query-${dims}.json`));
      },
    },
  ]);
}

function decodeJwt(jwt) {
  const [h, c, s] = jwt.split(".");
  return { header: JSON.parse(Buffer.from(h, "base64url")), claims: JSON.parse(Buffer.from(c, "base64url")), signingInput: `${h}.${c}`, signature: Buffer.from(s, "base64url") };
}

await test("gsc: the assertion is RS256, read-only scope, Google's audience, 10-minute life, and verifies", () => {
  const jwt = gsc.signServiceAccountJwt(GSC_CONFIG, 1_800_000_000);
  const { header, claims, signingInput, signature } = decodeJwt(jwt);
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  assert.deepEqual(claims, {
    iss: GSC_CONFIG.clientEmail,
    scope: "https://www.googleapis.com/auth/webmasters.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: 1_800_000_000,
    exp: 1_800_000_600,
  });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(signingInput);
  assert.ok(verifier.verify(RSA_PUBLIC, signature));
});

await test("gsc: a key pasted with literal \\n works; a non-RSA or broken key is gsc_bad_key; a non-service-account email is refused", () => {
  const escaped = RSA_PEM.replace(/\n/g, "\\n");
  assert.ok(gsc.signServiceAccountJwt({ ...GSC_CONFIG, privateKeyPem: escaped }, 1).split(".").length === 3);
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" });
  assert.throws(() => gsc.signServiceAccountJwt({ ...GSC_CONFIG, privateKeyPem: ec }, 1), (e) => e.code === "gsc_bad_key");
  assert.throws(() => gsc.signServiceAccountJwt({ ...GSC_CONFIG, privateKeyPem: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----" }, 1), (e) => e.code === "gsc_bad_key");
  assert.throws(() => gsc.signServiceAccountJwt({ ...GSC_CONFIG, clientEmail: "brent@gmail.com" }, 1), (e) => e.code === "gsc_bad_email");
});

await test("gsc: token exchange then three queries, only to Google's two hosts, token never in a URL", async () => {
  const fetchImpl = gscFetch();
  const result = await gsc.fetchSearchConsoleMetrics(GSC_CONFIG, fetchImpl, NOW);
  assert.equal(fetchImpl.calls.length, 4);
  const [tokenCall, ...queryCalls] = fetchImpl.calls;
  assert.equal(tokenCall.init.method, "POST");
  const form = new URLSearchParams(tokenCall.init.body);
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  assert.equal(decodeJwt(form.get("assertion")).claims.iss, GSC_CONFIG.clientEmail);
  for (const call of queryCalls) {
    assert.equal(call.url, "https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Amenuandmarket.com/searchAnalytics/query");
    assert.equal(call.init.headers.Authorization, "Bearer ya29.fixture-access-token-not-real");
    assert.equal(call.init.redirect, "error");
  }
  assert.deepEqual(queryCalls.map((c) => JSON.parse(c.init.body).dimensions), [["date"], ["query"], ["page"]]);
  const body = JSON.parse(queryCalls[0].init.body);
  assert.equal(body.startDate, "2026-10-21");
  assert.equal(body.endDate, "2026-10-27");
  assert.equal(body.type, "web");
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes("ya29")));
  assert.ok(!JSON.stringify(result).includes("ya29"));
  assert.ok(!JSON.stringify(result).includes("PRIVATE KEY"));
});

await test("gsc: daily clicks/impressions/position rows and aggregated top lists (own site paths only)", async () => {
  const result = await gsc.fetchSearchConsoleMetrics(GSC_CONFIG, gscFetch(), NOW);
  const get = (date, metric) => result.rows.find((r) => r.metric_date === date && r.metric === metric)?.value;
  assert.equal(get("2026-10-26", "clicks"), 5);
  assert.equal(get("2026-10-26", "impressions"), 61);
  assert.equal(get("2026-10-25", "position"), 12.25);
  assert.equal(result.topLists.top_queries[0].label, "menu and market app");
  assert.deepEqual(result.topLists.top_pages.map((p) => p.label), ["/", "/privacy"]);
  assert.ok(result.topLists.top_queries.length <= 10);
});

await test("gsc: the token step names itself on failure; odd replies are gsc_shape", async () => {
  await rejectsWithCode(gsc.fetchSearchConsoleMetrics(GSC_CONFIG, gscFetch({ token: () => jsonResponse({ error: "invalid_grant" }, 400) }), NOW), "gsc_token_http_400");
  await rejectsWithCode(gsc.fetchSearchConsoleMetrics(GSC_CONFIG, gscFetch({ token: () => jsonResponse({ access_token: "has spaces in it ok?" }) }), NOW), "gsc_token_shape");
  await rejectsWithCode(gsc.fetchSearchConsoleMetrics(GSC_CONFIG, gscFetch({ date: () => jsonResponse({ rows: [{ keys: ["2026-10-26", "x"], clicks: 1 }] }) }), NOW), "gsc_shape");
  await rejectsWithCode(gsc.fetchSearchConsoleMetrics(GSC_CONFIG, gscFetch({ date: () => jsonResponse({ rows: [{ keys: ["2025-01-01"], clicks: 1 }] }) }), NOW), "gsc_shape");
  await rejectsWithCode(gsc.fetchSearchConsoleMetrics(GSC_CONFIG, gscFetch({ query: () => jsonResponse({ error: { code: 403 } }, 403) }), NOW), "http_403");
  const quiet = await gsc.fetchSearchConsoleMetrics(GSC_CONFIG, gscFetch({ date: () => jsonResponse({ responseAggregationType: "byProperty" }) }), NOW);
  assert.deepEqual(quiet.rows, []);
});

await test("gsc: site property must be sc-domain:<host> or https://<host>/", () => {
  assert.equal(gsc.siteHost("sc-domain:menuandmarket.com"), "menuandmarket.com");
  assert.equal(gsc.siteHost("https://menuandmarket.com/"), "menuandmarket.com");
  for (const bad of ["menuandmarket.com", "http://menuandmarket.com/", "https://menuandmarket.com/path/", "sc-domain:", "sc-domain:../x"]) {
    assert.throws(() => gsc.siteHost(bad), (e) => e.code === "gsc_bad_site");
  }
});

await test("gsc: config needs all three env values", () => {
  assert.equal(gsc.readSearchConsoleConfig({ GSC_CLIENT_EMAIL: "a", GSC_SITE_URL: "b" }), null);
  assert.ok(gsc.readSearchConsoleConfig({ GSC_CLIENT_EMAIL: "a", GSC_PRIVATE_KEY: "k", GSC_SITE_URL: "b" }));
});

// ─── sync run, run log, alerts (decision 6), stale rules, route guards ────

const sync = await import("../src/lib/launch-metrics/sync.ts");
const alerts = await import("../src/lib/launch-metrics/alerts.ts");
const stale = await import("../src/lib/launch-metrics/stale.ts");
const guards = await import("../src/lib/launch-metrics/route-guards.ts");
const storeLib = await import("../src/lib/launch-metrics/store.ts");

function memoryStore() {
  const state = { runs: [], daily: new Map(), snapshots: new Map(), tasks: [], comments: [], seq: 0, failUpsert: false };
  const store = {
    state,
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
      if (state.failUpsert) throw new http.LaunchSourceError("db_write");
      for (const row of rows) state.daily.set(`${row.metric_date}|${row.source}|${row.metric}|${row.dimension}`, row.value);
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
  };
  return store;
}

const FULL_ENV = {
  appDb: { url: APP_DB_URL, token: APP_DB_TOKEN },
  web: WEB_CONFIG,
  searchConsole: GSC_CONFIG,
  alertProjectId: null,
};

function allSourcesFetch(overrides = {}) {
  const gscRoutes = gscFetch();
  const vercelRoutes = vercelFetch();
  return fakeFetch([
    { match: (url) => url === APP_DB_URL, reply: overrides.appDb ?? (() => jsonResponse(fixture("app-db-summary.json"))) },
    { match: (url) => url.startsWith("https://api.vercel.com/"), reply: overrides.web ?? ((url, init) => vercelRoutes(url, init)) },
    { match: (url) => url.includes("googleapis.com"), reply: overrides.gsc ?? ((url, init) => gscRoutes(url, init)) },
  ]);
}

let clock = Date.parse("2026-10-27T19:30:00Z");
const tick = (minutes = 60) => { clock += minutes * 60_000; };
const deps = (store, fetchImpl, env = FULL_ENV) => ({ store, env, fetchImpl, now: () => new Date(clock) });

await test("sync: a full run writes all three sources, logs codes only, Apple is not connected", async () => {
  const store = memoryStore();
  const fetchImpl = allSourcesFetch();
  const result = await sync.runLaunchSync(deps(store, fetchImpl), { trigger: "cron", kind: "full" });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.sources, { app_db: "ok", web: "ok", search_console: "ok", apple: "not_connected" });
  const run = store.state.runs[0];
  assert.equal(run.status, "ok");
  assert.ok(run.finished_at);
  assert.equal(store.state.daily.get("2026-10-26|app_db|signups_real|"), 2);
  assert.equal(store.state.daily.get("2026-10-27|app_db|total_real_users|"), 2);
  assert.equal(store.state.daily.get("2026-10-26|web|pageviews|"), 58);
  assert.equal(store.state.daily.get("2026-10-26|search_console|clicks|"), 5);
  assert.ok(store.state.snapshots.has("app_db|2026-10-27"));
  assert.ok(store.state.snapshots.has("search_console|2026-10-27"));
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes("appstoreconnect")));
});

await test("sync: two light runs with the real Grocery reply store every count and raise no app alert", async () => {
  const store = memoryStore();
  const fetchImpl = allSourcesFetch();
  for (let i = 0; i < 2; i += 1) {
    tick();
    const result = await sync.runLaunchSync(deps(store, fetchImpl), { trigger: "cron", kind: "light" });
    assert.equal(result.sources.app_db, "ok");
    assert.ok(!result.alerts.some((a) => a.source === "app_db" && a.action !== "none"), JSON.stringify(result.alerts));
  }
  assert.equal(store.state.tasks.length, 0);
  assert.equal(store.state.daily.get("2026-10-25|app_db|signups_deleted|"), 1);
  assert.equal(store.state.daily.get("2026-10-27|app_db|total_deleted_accounts|"), 1);
  assert.equal(store.state.daily.get("2026-10-27|app_db|total_real_households|"), 2);
  const snapshot = JSON.stringify([...store.state.snapshots.values()]);
  assert.ok(!/@|"accounts"|short_id|\b[0-9a-f]{8}\b/.test(snapshot));
});

await test("sync: a light run skips Search Console", async () => {
  const store = memoryStore();
  const fetchImpl = allSourcesFetch();
  const result = await sync.runLaunchSync(deps(store, fetchImpl), { trigger: "cron", kind: "light" });
  assert.deepEqual(result.sources, { app_db: "ok", web: "ok", search_console: "skipped", apple: "not_connected" });
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes("googleapis.com")));
});

await test("sync: one source failing never stops the others; the run is partial with the code", async () => {
  const store = memoryStore();
  const fetchImpl = allSourcesFetch({ appDb: () => jsonResponse({ error: "secret detail" }, 401) });
  const result = await sync.runLaunchSync(deps(store, fetchImpl), { trigger: "cron", kind: "full" });
  assert.equal(result.status, "partial");
  assert.equal(result.sources.app_db, "http_401");
  assert.equal(result.sources.web, "ok");
  assert.equal(result.sources.search_console, "ok");
  assert.ok(!JSON.stringify(store.state.runs).includes("secret detail"));
});

await test("sync: a reply with account ids is refused and nothing from it is stored", async () => {
  const store = memoryStore();
  const leaky = { ...fixture("app-db-summary.json"), accounts: [{ short_id: "5ee0000e" }] };
  const result = await sync.runLaunchSync(deps(store, allSourcesFetch({ appDb: () => jsonResponse(leaky) })), { trigger: "cron", kind: "light" });
  assert.equal(result.sources.app_db, "app_db_not_counts");
  assert.ok(![...store.state.daily.keys()].some((k) => k.includes("|app_db|")));
  assert.equal(store.state.snapshots.size, 0);
  assert.ok(!JSON.stringify([...store.state.daily.entries()]).includes("5ee0000e"));
});

await test("sync: missing keys are not_configured (status failed, no network call, no alert)", async () => {
  const store = memoryStore();
  const fetchImpl = fakeFetch([]);
  const env = { appDb: null, web: null, searchConsole: null, alertProjectId: null };
  for (let i = 0; i < 3; i += 1) {
    tick();
    const result = await sync.runLaunchSync(deps(store, fetchImpl, env), { trigger: "cron", kind: "full" });
    assert.equal(result.status, "failed");
    assert.deepEqual(result.sources, { app_db: "not_configured", web: "not_configured", search_console: "not_configured", apple: "not_connected" });
  }
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(store.state.tasks.length, 0);
});

await test("sync: a database write failure is db_write for that source only", async () => {
  const store = memoryStore();
  store.state.failUpsert = true;
  const result = await sync.runLaunchSync(deps(store, allSourcesFetch()), { trigger: "cron", kind: "light" });
  assert.deepEqual([result.sources.app_db, result.sources.web], ["db_write", "db_write"]);
  assert.equal(result.status, "failed");
});

await test("sync: a run already in progress (under 5 minutes) makes the next one 'busy' with no new row", async () => {
  const store = memoryStore();
  store.state.runs.push({ id: "r0", trigger: "cron", kind: "full", started_at: new Date(clock - 60_000).toISOString(), finished_at: null, status: "running", sources: {} });
  const result = await sync.runLaunchSync(deps(store, allSourcesFetch()), { trigger: "manual", kind: "full" });
  assert.equal(result.status, "busy");
  assert.equal(store.state.runs.length, 1);
  store.state.runs[0].started_at = new Date(clock - 20 * 60_000).toISOString(); // stuck: ignored
  const later = await sync.runLaunchSync(deps(store, allSourcesFetch()), { trigger: "manual", kind: "full" });
  assert.equal(later.status, "ok");
});

await test("alerts: two failed runs in a row create ONE task for Brent; more failures don't add another", async () => {
  const store = memoryStore();
  const failing = allSourcesFetch({ web: () => jsonResponse({}, 403) });
  tick(); await sync.runLaunchSync(deps(store, failing), { trigger: "cron", kind: "light" });
  assert.equal(store.state.tasks.length, 0, "one failure is not enough");
  tick(); const second = await sync.runLaunchSync(deps(store, failing), { trigger: "cron", kind: "light" });
  assert.deepEqual(second.alerts.find((a) => a.source === "web"), { source: "web", action: "created" });
  assert.equal(store.state.tasks.length, 1);
  const task = store.state.tasks[0];
  assert.equal(task.external_source_id, "source:web");
  assert.equal(task.owner, "brent");
  assert.equal(task.title, "Launch numbers: website visits stopped updating");
  assert.ok(task.status_line.length <= 280);
  assert.match(task.status_line, /key was refused or has expired/);
  assert.ok(!/claude|anthropic/i.test(JSON.stringify(store.state.tasks) + JSON.stringify(store.state.comments)));
  for (let i = 0; i < 3; i += 1) {
    tick(); const again = await sync.runLaunchSync(deps(store, failing), { trigger: "cron", kind: "light" });
    assert.equal(again.alerts.find((a) => a.source === "web").action, "already_open");
  }
  assert.equal(store.state.tasks.length, 1);
  assert.equal(store.state.comments.length, 1);
});

await test("alerts: recovery closes the task with a note; a new outage reopens the same task", async () => {
  const store = memoryStore();
  const failing = allSourcesFetch({ appDb: () => { throw new TypeError("down"); } });
  tick(); await sync.runLaunchSync(deps(store, failing), { trigger: "cron", kind: "light" });
  tick(); await sync.runLaunchSync(deps(store, failing), { trigger: "cron", kind: "light" });
  assert.equal(store.state.tasks.length, 1);
  tick(); const ok = await sync.runLaunchSync(deps(store, allSourcesFetch()), { trigger: "cron", kind: "light" });
  assert.equal(ok.alerts.find((a) => a.source === "app_db").action, "resolved");
  assert.equal(store.state.tasks[0].status, "Done");
  assert.equal(store.state.tasks[0].owner, "agent");
  assert.match(store.state.comments.at(-1).content, /^Recovered: the app sign-ups numbers updated again/);
  tick(); await sync.runLaunchSync(deps(store, failing), { trigger: "cron", kind: "light" });
  assert.equal(store.state.tasks[0].status, "Done", "one failure after recovery: still closed");
  tick(); const reopened = await sync.runLaunchSync(deps(store, failing), { trigger: "cron", kind: "light" });
  assert.equal(reopened.alerts.find((a) => a.source === "app_db").action, "reopened");
  assert.equal(store.state.tasks.length, 1);
  assert.equal(store.state.tasks[0].status, "Planned");
  assert.equal(store.state.tasks[0].owner, "brent");
});

await test("alerts: a task Brent closes during a long outage stays closed until the next outage", async () => {
  const store = memoryStore();
  const failing = allSourcesFetch({ web: () => jsonResponse({}, 500) });
  tick(); await sync.runLaunchSync(deps(store, failing), { trigger: "cron", kind: "light" });
  tick(); await sync.runLaunchSync(deps(store, failing), { trigger: "cron", kind: "light" });
  store.state.tasks[0].status = "Done";
  tick(); const third = await sync.runLaunchSync(deps(store, failing), { trigger: "cron", kind: "light" });
  assert.equal(third.alerts.find((a) => a.source === "web").action, "left_closed");
  assert.equal(store.state.tasks[0].status, "Done");
});

await test("alerts: light runs don't count for Search Console; a skipped run between two failures still alerts", async () => {
  const store = memoryStore();
  const failing = allSourcesFetch({ gsc: () => jsonResponse({}, 400) });
  tick(); await sync.runLaunchSync(deps(store, failing), { trigger: "cron", kind: "full" });
  for (let i = 0; i < 5; i += 1) {
    tick(); await sync.runLaunchSync(deps(store, failing), { trigger: "cron", kind: "light" });
  }
  assert.equal(store.state.tasks.length, 0);
  tick(); await sync.runLaunchSync(deps(store, failing), { trigger: "cron", kind: "full" });
  assert.equal(store.state.tasks.length, 1);
  assert.equal(store.state.tasks[0].external_source_id, "source:search_console");
  assert.match(store.state.tasks[0].status_line, /Google refused the service account key/);
});

await test("alerts: two runs racing to create the task leave one (unique external id)", async () => {
  const store = memoryStore();
  const runs = [
    { id: "a", started_at: "2026-10-27T10:00:00Z", finished_at: "2026-10-27T10:01:00Z", status: "failed", sources: { web: "http_500" } },
    { id: "b", started_at: "2026-10-27T11:00:00Z", finished_at: "2026-10-27T11:01:00Z", status: "failed", sources: { web: "http_500" } },
  ];
  const [first, second] = await Promise.all([
    alerts.evaluateAlerts(store, runs, new Date(clock), null),
    alerts.evaluateAlerts(store, runs, new Date(clock), null),
  ]);
  const actions = [first, second].map((o) => o.find((a) => a.source === "web").action).sort();
  assert.deepEqual(actions, ["already_open", "created"]);
  assert.equal(store.state.tasks.length, 1);
});

await test("alerts: decideAlert and plainReason", () => {
  assert.deepEqual(alerts.decideAlert([]), { action: "none" });
  assert.deepEqual(alerts.decideAlert(["http_500"]), { action: "none" });
  assert.deepEqual(alerts.decideAlert(["http_500", "timeout", "ok"]), { action: "raise", code: "http_500", streak: 2 });
  assert.deepEqual(alerts.decideAlert(["ok", "http_500"]), { action: "recover" });
  assert.equal(alerts.plainReason("timeout"), "the service did not answer");
  assert.equal(alerts.plainReason("app_db_not_counts"), "the reply was not in the expected shape, so nothing was saved");
  assert.equal(alerts.plainReason("weird_code"), "error code weird_code");
});

await test("alerts: a failing alert write never fails the run", async () => {
  const store = memoryStore();
  store.createAlertTask = async () => { throw new http.LaunchSourceError("db_write"); };
  const failing = allSourcesFetch({ web: () => jsonResponse({}, 500) });
  tick(); await sync.runLaunchSync(deps(store, failing), { trigger: "cron", kind: "light" });
  tick(); const result = await sync.runLaunchSync(deps(store, failing), { trigger: "cron", kind: "light" });
  assert.equal(result.alerts.find((a) => a.source === "web").action, "error");
  assert.equal(result.status, "partial");
});

await test("run log: sources read back are codes only; anything else becomes 'error'", () => {
  assert.deepEqual(storeLib.readRunSources({ web: "ok", app_db: "Bearer abc", "bad key": "ok", search_console: 5 }), { web: "ok", app_db: "error", search_console: "error" });
  assert.deepEqual(storeLib.readRunSources(["x"]), {});
  assert.equal(sync.runStatus({ app_db: "ok", web: "ok", search_console: "skipped", apple: "not_connected" }), "ok");
  assert.equal(sync.runStatus({ app_db: "ok", web: "http_500", apple: "not_connected" }), "partial");
  assert.equal(sync.runStatus({ app_db: "timeout", web: "http_500", apple: "not_connected" }), "failed");
});

await test("stale: 2 hours for app db and website, 36 for Search Console, Apple not connected", () => {
  const now = new Date("2026-10-27T20:00:00Z");
  const run = (startedAt, sources) => ({ id: startedAt, trigger: "cron", kind: "full", started_at: startedAt, finished_at: startedAt, status: "ok", sources });
  const runs = [
    run("2026-10-27T19:15:00Z", { app_db: "ok", web: "http_403", search_console: "skipped", apple: "not_connected" }),
    run("2026-10-27T17:15:00Z", { app_db: "ok", web: "ok", search_console: "skipped", apple: "not_connected" }),
    run("2026-10-26T11:30:00Z", { app_db: "ok", web: "ok", search_console: "ok", apple: "not_connected" }),
  ];
  const health = Object.fromEntries(stale.sourceHealth(runs, now).map((h) => [h.source, h]));
  assert.equal(health.app_db.state, "fresh");
  assert.equal(health.web.state, "failing");
  assert.equal(health.web.lastOkAt, "2026-10-27T17:15:00Z");
  assert.equal(health.search_console.state, "fresh");
  assert.equal(health.apple.state, "not_connected");
  const at = (iso) => Object.fromEntries(stale.sourceHealth(runs, new Date(iso)).map((h) => [h.source, h.state]));
  assert.equal(at("2026-10-27T21:14:00Z").app_db, "fresh");
  assert.equal(at("2026-10-27T21:16:00Z").app_db, "stale"); // > 2 h since 19:15
  assert.equal(at("2026-10-27T23:29:00Z").search_console, "fresh");
  assert.equal(at("2026-10-27T23:31:00Z").search_console, "stale"); // > 36 h since 10-26 11:30
  assert.equal(stale.sourceHealth([], now).find((h) => h.source === "web").state, "never");
  const unconfigured = [run("2026-10-27T19:15:00Z", { web: "not_configured" })];
  assert.equal(stale.sourceHealth(unconfigured, now).find((h) => h.source === "web").state, "not_configured");
});

await test("stale: token warning from 30 days out; unfinished runs after 10 minutes", () => {
  assert.equal(stale.tokenDaysLeft("2027-10-27", "2026-10-27"), null);
  assert.equal(stale.tokenDaysLeft("2027-10-27", "2027-09-27"), 30);
  assert.equal(stale.tokenDaysLeft("2027-10-27", "2027-10-30"), -3);
  assert.equal(stale.tokenDaysLeft(null, "2027-10-30"), null);
  const now = new Date("2026-10-27T20:00:00Z");
  assert.equal(stale.isRunUnfinished({ started_at: "2026-10-27T19:49:00Z", finished_at: null }, now), true);
  assert.equal(stale.isRunUnfinished({ started_at: "2026-10-27T19:55:00Z", finished_at: null }, now), false);
});

await test("guards: cron secret (bearer, constant-time), same-origin writes, owner only", () => {
  assert.equal(guards.hasCronAccess("Bearer s3cret-value", "s3cret-value"), true);
  assert.equal(guards.hasCronAccess("bearer s3cret-value", "s3cret-value"), true);
  assert.equal(guards.hasCronAccess("Bearer wrong", "s3cret-value"), false);
  assert.equal(guards.hasCronAccess("s3cret-value", "s3cret-value"), false);
  assert.equal(guards.hasCronAccess(null, "s3cret-value"), false);
  assert.equal(guards.hasCronAccess("Bearer ", ""), false);
  assert.equal(guards.hasCronAccess("Bearer x", undefined), false);
  assert.equal(guards.isSameOriginWrite("https://baseline.example", "baseline.example"), true);
  assert.equal(guards.isSameOriginWrite("https://evil.example", "baseline.example"), false);
  assert.equal(guards.isSameOriginWrite(null, "baseline.example"), false);
  assert.equal(guards.isSameOriginWrite("null", "baseline.example"), false);
  assert.equal(guards.isLaunchOwner("u1", "u1"), true);
  assert.equal(guards.isLaunchOwner("u1", "u2"), false);
  assert.equal(guards.isLaunchOwner("u1", undefined), false);
  assert.equal(guards.isLaunchOwner("u1", "  "), false);
});

await test("env: LAUNCH_METRICS_ALERT_PROJECT_ID must be a uuid", () => {
  assert.equal(sync.readLaunchEnv({ LAUNCH_METRICS_ALERT_PROJECT_ID: "drop table" }).alertProjectId, null);
  assert.equal(sync.readLaunchEnv({ LAUNCH_METRICS_ALERT_PROJECT_ID: "4c2fa95a-a60e-4cec-b0d8-8c6fb62e0a8e" }).alertProjectId, "4c2fa95a-a60e-4cec-b0d8-8c6fb62e0a8e");
});

await test("crons: vercel.json runs the full sync daily and the light sync hourly, with time to finish", () => {
  const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  const crons = vercel.crons.filter((c) => c.path.startsWith("/api/launch-metrics/sync"));
  assert.deepEqual(crons, [
    { path: "/api/launch-metrics/sync?kind=full", schedule: "30 11 * * *" },
    { path: "/api/launch-metrics/sync?kind=light", schedule: "15 * * * *" },
  ]);
  assert.equal(vercel.functions["src/app/api/launch-metrics/sync/route.ts"].maxDuration, 120);
});

// ─── page model, manual entries, dates, words ─────────────────────────────

const pageData = await import("../src/lib/launch-metrics/page-data.ts");
const manual = await import("../src/lib/launch-metrics/manual.ts");
const dates = await import("../src/lib/launch-metrics/dates.ts");
const format = await import("../src/lib/launch-metrics/format.ts");

function pageInput(overrides = {}) {
  const summary = appDb.validateAppDbSummary(fixture("app-db-summary.json"), NOW);
  const daily = [
    ...appDb.appDbDailyRows(summary, "2026-10-26").map((r) => (r.metric.startsWith("total_") ? { ...r, value: r.metric === "total_real_users" ? 1 : r.value } : r)),
    ...appDb.appDbDailyRows(summary, "2026-10-27"),
    ...web.parseVisitsByDay(fixture("vercel-visits-by-day.json")),
    ...web.parseVisitsByReferrer(fixture("vercel-visits-by-referrer.json")),
    ...web.parseAppStoreTaps(fixture("vercel-events-placement.json")),
    ...gsc.dailyRowsFromQuery(gsc.parseQueryRows(fixture("gsc-query-date.json")), "2026-10-21", "2026-10-27"),
  ];
  return {
    daily,
    searchTop: { since: "2026-10-21", until: "2026-10-27", top_queries: [{ label: "menu and market app", clicks: 4, impressions: 9, position: 1.2 }], top_pages: [] },
    runs: [{ id: "r1", trigger: "cron", kind: "full", started_at: "2026-10-27T19:15:00Z", finished_at: "2026-10-27T19:15:20Z", status: "ok", sources: { app_db: "ok", web: "ok", search_console: "ok", apple: "not_connected" } }],
    reddit: [],
    milestones: [{ id: "m1", user_id: "u", happened_at: "2026-10-26T14:30:00Z", label: "First real user", kind: "Users", created_at: "", updated_at: "" }],
    manualReads: [],
    tokenExpires: "2027-10-27",
    ...overrides,
  };
}

await test("page: headline totals come from the newest as-of day; Plus by household; family not counted", () => {
  const view = pageData.buildLaunchView(pageInput(), NOW);
  assert.equal(view.today, "2026-10-27");
  assert.deepEqual(
    { asOf: view.totals.asOfDate, real: view.totals.realUsers, unconfirmed: view.totals.unconfirmed, family: view.totals.familyAccounts, paid: view.totals.plusPaid, trial: view.totals.plusTrial, comp: view.totals.plusComp },
    { asOf: "2026-10-27", real: 2, unconfirmed: 1, family: 2, paid: 0, trial: 1, comp: 3 }
  );
});

await test("page: sign-up days run release → today (ET), with unconfirmed separate and the total line from as-of rows", () => {
  const view = pageData.buildLaunchView(pageInput(), NOW);
  const days = view.signups.days;
  assert.equal(days[0].date, "2026-10-21");
  assert.equal(days.at(-1).date, "2026-10-27");
  const oct26 = days.find((d) => d.date === "2026-10-26");
  assert.deepEqual([oct26.real, oct26.apple, oct26.unconfirmed, oct26.totalReal], [2, 2, 1, 1]);
  assert.equal(days.find((d) => d.date === "2026-10-23").family, 2);
  assert.equal(days.find((d) => d.date === "2026-10-24").totalReal, null);
  assert.deepEqual(view.markers, [{ date: "2026-10-26", label: "First real user", kind: "Users" }]);
});

await test("page: website sums, top referrers (last 7 UTC days) and App Store taps by button", () => {
  const view = pageData.buildLaunchView(pageInput(), NOW);
  assert.equal(view.website.visitorsSum, 40);
  assert.equal(view.website.pageviewsSum, 70);
  assert.equal(view.website.tapsSum, 7);
  assert.deepEqual(view.website.referrers.map((r) => [r.label, r.value, r.secondary]), [
    ["www.reddit.com", 30, 18],
    ["(direct)", 20, 10],
    ["www.google.com", 12, 9],
    ["others", 8, 3],
  ]);
  assert.deepEqual(view.website.placements.map((p) => [p.label, p.value]), [["site-hero", 6], ["site-footer", 1]]);
});

await test("page: Search Console totals, impression-weighted position, click rate and data-through date", () => {
  const view = pageData.buildLaunchView(pageInput(), NOW);
  assert.equal(view.search.clicks, 7);
  assert.equal(view.search.impressions, 104);
  assert.equal(view.search.dataThrough, "2026-10-26");
  assert.ok(Math.abs(view.search.ctr - 7 / 104) < 1e-9);
  const expected = (41.3 * 3 + 12.25 * 40 + 8.4 * 61) / 104;
  assert.ok(Math.abs(view.search.position - expected) < 1e-6);
  assert.equal(view.search.days.find((d) => d.date === "2026-10-23").position, null);
  assert.equal(view.search.topQueries[0].label, "menu and market app");
});

await test("page: an empty database shows waiting states, not zeros as facts", () => {
  const view = pageData.buildLaunchView(pageInput({ daily: [], runs: [], searchTop: null, milestones: [] }), NOW);
  assert.equal(view.totals, null);
  assert.equal(view.signups.hasData, false);
  assert.equal(view.website.hasData, false);
  assert.equal(view.search.hasData, false);
  assert.equal(view.lastRun, null);
  assert.deepEqual(view.health.map((h) => h.state), ["never", "never", "never", "not_connected"]);
});

await test("page: the website token warning shows from 30 days out", () => {
  assert.equal(pageData.buildLaunchView(pageInput(), NOW).tokenDaysLeft, null);
  assert.equal(pageData.buildLaunchView(pageInput({ tokenExpires: "2026-11-10" }), NOW).tokenDaysLeft, 14);
});

await test("page: the page model carries no account id, email or name from any source", () => {
  const text = JSON.stringify(pageData.buildLaunchView(pageInput(), NOW));
  assert.ok(!/@|\b[0-9a-f]{8}\b|should-never-be-read/.test(text));
});

await test("manual: Reddit posts take only the allowlisted fields; New York times; stats stamp stats_as_of", () => {
  const ok = manual.parseRedditInput({ label: " r/apps  launch ", subreddit: "apps", posted_at: "2026-10-26T14:40", views: "1600", upvotes: -2, comments: 0 }, NOW, false);
  assert.ok(ok.ok);
  assert.deepEqual(ok.value, {
    label: "r/apps launch",
    subreddit: "r/apps",
    posted_at: "2026-10-26T18:40:00.000Z",
    views: 1600,
    upvotes: -2,
    comments: 0,
    stats_as_of: NOW.toISOString(),
  });
  const noStats = manual.parseRedditInput({ label: "x", subreddit: "r/apps", posted_at: "2026-10-26T14:40:00Z" }, NOW, false);
  assert.equal(noStats.value.stats_as_of, undefined);
  for (const bad of [
    { label: "x", subreddit: "r/apps", posted_at: "2026-10-26T14:40", user_id: "someone-else" },
    { label: "x", subreddit: "r/apps", posted_at: "2026-10-26T14:40", id: "x" },
    { label: "", subreddit: "r/apps", posted_at: "2026-10-26T14:40" },
    { label: "x", subreddit: "r/a b", posted_at: "2026-10-26T14:40" },
    { label: "x", subreddit: "r/apps", posted_at: "yesterday" },
    { label: "x", subreddit: "r/apps", posted_at: "2031-01-01T00:00" },
    { label: "x", subreddit: "r/apps", posted_at: "2026-10-26T14:40", views: -1 },
    { label: "x", subreddit: "r/apps", posted_at: "2026-10-26T14:40", views: 1.5 },
    { label: "x".repeat(201), subreddit: "r/apps", posted_at: "2026-10-26T14:40" },
    [],
    null,
  ]) {
    assert.equal(manual.parseRedditInput(bad, NOW, false).ok, false, JSON.stringify(bad));
  }
  assert.equal(manual.parseRedditInput({}, NOW, true).ok, false);
  assert.deepEqual(manual.parseRedditInput({ views: "" }, NOW, true).value, { views: null, stats_as_of: NOW.toISOString() });
});

await test("manual: milestones take happened_at, label and kind only", () => {
  const ok = manual.parseMilestoneInput({ happened_at: "2026-10-26 13:56", label: "First feature request", kind: "Feedback" }, NOW, false);
  assert.deepEqual(ok.value, { happened_at: "2026-10-26T17:56:00.000Z", label: "First feature request", kind: "Feedback" });
  assert.equal(manual.parseMilestoneInput({ happened_at: "2026-10-26T13:56", label: "x", kind: "Party" }, NOW, false).ok, false);
  assert.equal(manual.parseMilestoneInput({ happened_at: "2026-10-26T13:56", label: "x", kind: "Users", user_id: "u" }, NOW, false).ok, false);
  assert.deepEqual(manual.parseMilestoneInput({ kind: "Other" }, NOW, true).value, { kind: "Other" });
});

await test("dates: New York wall-clock ↔ UTC across both DST changes", () => {
  assert.equal(dates.etLocalToIso("2026-10-21T13:42"), "2026-10-21T17:42:00.000Z");
  assert.equal(dates.etLocalToIso("2026-12-01T09:00"), "2026-12-01T14:00:00.000Z");
  assert.equal(dates.etLocalToIso("2027-03-14T02:30"), null); // skipped hour
  assert.equal(dates.etLocalToIso("2026-11-01T01:30"), "2026-11-01T05:30:00.000Z"); // repeated hour: daylight
  assert.equal(dates.etLocalToIso("2026-02-30T10:00"), null);
  assert.equal(dates.etLocalToIso("2026-10-21T24:00"), null);
  assert.equal(dates.isoToEtLocal("2026-10-21T17:42:00Z"), "2026-10-21T13:42");
  assert.equal(dates.etDate(new Date("2026-10-27T03:59:00Z")), "2026-10-26");
  assert.equal(dates.etDate(new Date("2026-10-27T04:00:00Z")), "2026-10-27");
  assert.deepEqual(dates.dateRange("2026-10-30", "2026-11-02"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
});

await test("words: footer lines per source state; no product copy names an assistant", () => {
  assert.equal(format.healthLine({ source: "apple", state: "not_connected" }).text, "App Store: not connected yet (comes in phase 2)");
  assert.equal(format.healthLine({ source: "web", state: "failing", lastCode: "http_403", lastOkAt: null }).tone, "danger");
  assert.match(format.healthLine({ source: "app_db", state: "fresh", lastOkAt: "2026-10-27T19:15:20Z" }).text, /^App sign-ups: updated Oct 27, 3:15 PM$/);
  assert.equal(format.formatPercent(7 / 104), "6.7%");
  assert.equal(format.plural(1, "day", "days"), "1 day");
  for (const file of [
    "../src/components/launch/LaunchPage.tsx",
    "../src/components/launch/LaunchManualPanels.tsx",
    "../src/components/launch/DailyChart.tsx",
    "../src/app/launch/page.tsx",
    "../src/lib/launch-metrics/alerts.ts",
    "../src/lib/launch-metrics/format.ts",
  ]) {
    assert.ok(!/claude|anthropic/i.test(readFileSync(new URL(file, import.meta.url), "utf8")), file);
  }
});

await test("nav: the Launch page is in NAV_GROUPS", () => {
  const nav = readFileSync(new URL("../src/components/layout/nav-items.tsx", import.meta.url), "utf8");
  assert.match(nav, /href: "\/launch",\s+label: "Launch"/);
});

// ─── seed import (piece 9) ────────────────────────────────────────────────

const seed = await import("../src/lib/launch-metrics/seed.ts");
const { spawnSync } = await import("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const pathMod = await import("node:path");

const SEED_FILES = {
  "signups.csv": "account,signed_up_et,sign_in,who,household\naaaa1111,2026-10-23 07:08,Apple,Family,Own\nbbbb2222,2026-10-23 07:09,Apple,Family,Own\ncccc3333,2026-10-26 07:10,Apple,Real user,Own\ndddd4444,2026-10-26 07:11,Email,Real user,Own\neeee5555,2026-10-26 14:23,Apple,Internal,Own\n",
  "plus.csv": "as_of,trial,paid,comp\n2026-10-26,0,0,3\n2026-10-27,1,0,3\n",
  "reddit.csv": "post,subreddit,posted_et,views,upvotes,comments,stats_as_of\nr/iPhoneduoapp Oct 26 09:23,r/iPhoneduoapp,2026-10-26 09:23,1600,1,2,2026-10-26 20:03\nr/apps Oct 26 14:40,r/apps,2026-10-26 14:40,,1,0,2026-10-26 15:18\n",
  "milestones.csv": 'when_et,event,kind\n2026-10-21 13:42,Menu & Market 1.0 released,Release\n2026-10-26 11:37,"First Plus free trial (auto-renew off, ends 11/26)",Users\n2026-10-26 13:56,First feature request: dinner suggestions,Feedback\n2026-10-27 08:00,Something new,Party\n',
  "app_store.csv": "read_on,data_through,window,impressions,product_page_views,first_downloads,conversion\n2026-10-26,2026-10-24,Last 30 days,41,16,4,0.286\n",
};

await test("seed: CSV parsing handles quotes, escaped quotes, commas and CRLF", () => {
  assert.deepEqual(seed.parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n'), [["a", "b"], ["x, y", 'he said "hi"']]);
  assert.throws(() => seed.parseCsv('a\n"open'), /unclosed quote/);
});

await test("seed: signups.csv becomes counts per New York day; no account id survives anywhere", () => {
  const plan = seed.buildSeedPlan(SEED_FILES);
  assert.deepEqual(plan.signupDays, [
    { date: "2026-10-23", real: 0, apple: 0, email: 0, family: 2 },
    { date: "2026-10-26", real: 2, apple: 1, email: 1, family: 0 },
  ]);
  assert.equal(plan.skippedInternal, 1);
  const get = (date, metric) => plan.daily.find((r) => r.metric_date === date && r.metric === metric)?.value;
  assert.equal(get("2026-10-21", "total_real_users"), 0);
  assert.equal(get("2026-10-26", "total_real_users"), 2);
  assert.equal(get("2026-10-26", "total_family_accounts"), 2);
  assert.equal(get("2026-10-27", "total_plus_trial"), 1);
  assert.ok(plan.daily.every((r) => r.source === "app_db" && r.variant === "seed"));
  const text = JSON.stringify(plan);
  for (const id of ["aaaa1111", "bbbb2222", "cccc3333", "dddd4444", "eeee5555"]) assert.ok(!text.includes(id), id);
});

await test("seed: Reddit, timeline and App Store hand reads", () => {
  const plan = seed.buildSeedPlan(SEED_FILES);
  assert.deepEqual(plan.reddit[1], { label: "r/apps Oct 26 14:40", subreddit: "r/apps", posted_at: "2026-10-26T18:40:00.000Z", views: null, upvotes: 1, comments: 0, stats_as_of: "2026-10-26T19:18:00.000Z" });
  assert.deepEqual(plan.milestones.map((m) => m.kind), ["Release", "Users", "Feedback", "Other"]);
  assert.equal(plan.milestones[1].label, "First Plus free trial (auto-renew off, ends 11/26)");
  assert.equal(plan.milestones[0].happened_at, "2026-10-21T17:42:00.000Z");
  assert.deepEqual(plan.manualReads, [{ read_on: "2026-10-26", data_through: "2026-10-24", window_label: "Last 30 days", impressions: 41, product_page_views: 16, first_downloads: 4 }]);
});

await test("seed: bad files are refused with the file and row named", () => {
  assert.throws(() => seed.buildSeedPlan({ "signups.csv": "account,signed_up_et,sign_in\nx,2026-10-26 07:10,Apple\n" }), /signups\.csv: missing column who/);
  assert.throws(() => seed.buildSeedPlan({ "signups.csv": "account,signed_up_et,sign_in,who\nx,yesterday,Apple,Real user\n" }), /signups\.csv: row 2/);
  assert.throws(() => seed.buildSeedPlan({ "signups.csv": "account,signed_up_et,sign_in,who\nx,2026-10-26 07:10,Google,Real user\n" }), /sign_in must be Apple or Email/);
  assert.throws(() => seed.buildSeedPlan({ "plus.csv": "as_of,trial,paid,comp\n2026-10-26,1,x,0\n" }), /plus\.csv: row 2: paid/);
  assert.throws(() => seed.buildSeedPlan({ "reddit.csv": "post,subreddit,posted_et,views,upvotes,comments,stats_as_of\na,apps,2026-10-26 09:23,1,1,1,\n" }), /subreddit/);
  assert.throws(() => seed.buildSeedPlan({ "app_store.csv": "read_on,data_through,window,impressions,product_page_views,first_downloads\n2026-10-26,2026-10-24,30d,41,16\n" }), /row 2 has 5 cells/);
});

await test("page: a seeded Plus row for a later day doesn't hide the sign-up totals of the day before", () => {
  const plan = seed.buildSeedPlan(SEED_FILES);
  const view = pageData.buildLaunchView(pageInput({ daily: plan.daily }), NOW);
  assert.deepEqual(
    [view.totals.asOfDate, view.totals.realUsers, view.totals.familyAccounts, view.totals.plusTrial, view.totals.plusComp],
    ["2026-10-26", 2, 2, 1, 3]
  );
});

await test("seed CLI: dry run prints counts only and writes nothing; --apply refuses without a target or a host confirmation", async () => {
  const dir = mkdtempSync(pathMod.join(tmpdir(), "launch-seed-"));
  try {
    for (const [name, text] of Object.entries(SEED_FILES)) writeFileSync(pathMod.join(dir, name), text);
    const cwd = (await import("node:url")).fileURLToPath(new URL("..", import.meta.url));
    const run = (args, env = {}) => spawnSync("npm", ["run", "-s", "launch-metrics:seed", "--", ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, LAUNCH_SEED_SUPABASE_URL: "", LAUNCH_SEED_SERVICE_ROLE_KEY: "", LAUNCH_SEED_USER_ID: "", ...env },
    });
    const dry = run(["--dir", dir]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /2026-10-26: real 2 \(Apple 1, email 1\), family 0/);
    assert.match(dry.stdout, /Dry run: nothing written/);
    for (const id of ["aaaa1111", "cccc3333", "eeee5555"]) assert.ok(!dry.stdout.includes(id) && !dry.stderr.includes(id), id);
    assert.equal(run(["--dir", dir, "--apply"]).status, 2);
    const remote = run(["--dir", dir, "--apply"], {
      LAUNCH_SEED_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      LAUNCH_SEED_SERVICE_ROLE_KEY: "service-key-must-not-print",
      LAUNCH_SEED_USER_ID: "0000beef-0000-4000-8000-00000000c0de",
    });
    assert.equal(remote.status, 2);
    assert.match(remote.stderr, /needs --confirm-host abcdefghijklmnopqrst\.supabase\.co/);
    assert.ok(!(remote.stdout + remote.stderr).includes("service-key-must-not-print"));
    assert.equal(run(["--dir", dir, "--bogus"]).status, 2);
    assert.equal(run([]).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── fix round 1: contract on the page, phone layout, small fixes ─────────

const launchSource = (file) => readFileSync(new URL(`../src/components/launch/${file}`, import.meta.url), "utf8");

await test("page: a deleted account still counts on its sign-up day; deleted and household counts are carried", () => {
  const view = pageData.buildLaunchView(pageInput(), NOW);
  const oct25 = view.signups.days.find((d) => d.date === "2026-10-25");
  assert.deepEqual([oct25.real, oct25.apple, oct25.email, oct25.deleted], [1, 0, 0, 1]);
  assert.equal(view.totals.deletedAccounts, 1);
  assert.equal(view.totals.realHouseholds, 2);
  // own/joined count USERS by how they belong to a household (Grocery contract).
  assert.equal(view.totals.usersInOwnHousehold, 2);
  assert.equal(view.totals.usersJoinedHousehold, 0);
  assert.equal("householdsOwn" in view.totals, false);
});

await test("page: without unconfirmed data (seed only) unconfirmed is unknown, not 0", () => {
  const plan = seed.buildSeedPlan(SEED_FILES);
  const view = pageData.buildLaunchView(pageInput({ daily: plan.daily }), NOW);
  assert.equal(view.totals.unconfirmed, null);
  assert.equal(view.signups.days.find((d) => d.date === "2026-10-26").unconfirmed, null);
  const live = pageData.buildLaunchView(pageInput(), NOW);
  assert.equal(live.totals.unconfirmed, 1);
  assert.equal(live.signups.days.find((d) => d.date === "2026-10-24").unconfirmed, 0);
});

await test("page: the 'No data yet' badge shows only when the source has no rows", () => {
  const never = { source: "app_db", state: "never", lastOkAt: null, lastCode: null };
  assert.equal(format.sourceBadge(never, true), null);
  assert.deepEqual(format.sourceBadge(never, false), { label: "No data yet", tone: "neutral" });
  assert.deepEqual(format.sourceBadge({ ...never, state: "failing", lastCode: "http_500" }, true), { label: "Update failing", tone: "danger" });
  assert.deepEqual(format.sourceBadge({ ...never, state: "stale" }, true), { label: "Out of date", tone: "warning" });
  assert.equal(format.sourceBadge({ ...never, state: "fresh", lastOkAt: "2026-10-27T19:00:00Z" }, true), null);
  assert.equal(format.sourceBadge(undefined, false), null);
});

await test("page: Plus says its own as-of day when it differs from the sign-up totals", () => {
  const plan = seed.buildSeedPlan(SEED_FILES);
  const seeded = pageData.buildLaunchView(pageInput({ daily: plan.daily }), NOW);
  assert.deepEqual([seeded.totals.asOfDate, seeded.totals.plusAsOfDate], ["2026-10-26", "2026-10-27"]);
  const live = pageData.buildLaunchView(pageInput(), NOW);
  assert.equal(live.totals.plusAsOfDate, live.totals.asOfDate);
});

await test("words: Reddit stats use singular and plural correctly", () => {
  assert.equal(format.redditStats(1600, 1, 1), "1,600 views · 1 upvote · 1 comment");
  assert.equal(format.redditStats(null, 2, 0), "views – · 2 upvotes · 0 comments");
  assert.equal(format.redditStats(1, null, null), "1 view · – upvotes · – comments");
});

await test("layout: every grid on the Launch page has explicit shrinkable base columns, and the two-up children can shrink", () => {
  for (const file of ["LaunchPage.tsx", "LaunchManualPanels.tsx", "DailyChart.tsx"]) {
    const text = launchSource(file);
    const classNames = [...text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]);
    for (const cls of classNames.filter((c) => /(^|\s)grid(\s|$)/.test(c))) {
      // An unprefixed grid-cols-N is repeat(N, minmax(0, 1fr)): a wide child can't widen the page.
      assert.match(cls, /(^|\s)grid-cols-\d+(\s|$)/, `${file}: "${cls}" needs an unprefixed grid-cols-N so a wide child can't widen the page`);
    }
  }
  const page = launchSource("LaunchPage.tsx");
  const twoUp = [...page.matchAll(/<div className="mt-6 grid[^"]*">\s*<div className="([^"]*)">/g)];
  assert.ok(twoUp.length >= 2, "both two-up table grids found");
  for (const match of twoUp) assert.match(match[1], /(^|\s)min-w-0(\s|$)/);
});

await test("layout: tables with more than three columns become label/value rows on phones", () => {
  const page = launchSource("LaunchPage.tsx");
  const table = page.slice(page.indexOf("function Table("), page.indexOf("export function LaunchPageBody"));
  assert.match(table, /sm:hidden/, "phone layout hidden from sm up");
  assert.match(table, /hidden sm:block/, "table hidden below sm");
  assert.match(table, /head\.length > 3/);
  // The label column wraps; only the number columns stay on one line.
  assert.match(table, /index > 0 \? "whitespace-nowrap text-right tabular-nums" : "[^"]*\[overflow-wrap:anywhere\]/);
  assert.match(page, /"Family"/);
});

await test("manual: Remove asks first (two-step inline confirm, no browser dialog)", () => {
  const panels = launchSource("LaunchManualPanels.tsx");
  assert.ok(!/window\.confirm|\bconfirm\(/.test(panels));
  assert.ok(!/onClick=\{\(\) => remove\(/.test(panels), "Remove must not delete on the first click");
  assert.match(panels, /Yes, remove/);
  assert.equal((panels.match(/<ConfirmRemove\b/g) ?? []).length, 2);
});

await test("refresh: a network error ends in a message, not a silent failure", () => {
  const panels = launchSource("LaunchManualPanels.tsx");
  const refresh = panels.slice(panels.indexOf("async function refresh()"), panels.indexOf("return (", panels.indexOf("async function refresh()")));
  assert.match(refresh, /catch\s*\{[\s\S]*toast\(/);
});

// @@MORE_TESTS@@

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
