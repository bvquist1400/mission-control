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

await test("app db: the contract fixture validates and keeps counts only", () => {
  const summary = appDb.validateAppDbSummary(fixture("app-db-summary.json"), NOW);
  assert.equal(summary.totals.real_users, 2);
  assert.equal(summary.totals.real_unconfirmed, 1);
  assert.equal(summary.totals.plus_trial, 1);
  assert.equal(summary.daily.length, 3);
  assert.deepEqual(Object.keys(summary).sort(), ["daily", "generated_at", "totals"]);
});

await test("app db: an accounts list, an id or an email anywhere refuses the whole reply", () => {
  const base = fixture("app-db-summary.json");
  const cases = [
    { ...base, accounts: [{ short_id: "5ee0000e", sign_in: "Apple" }] },
    { ...base, accounts: [] },
    { ...base, totals: { ...base.totals, user_ids: ["5ee0000e"] } },
    { ...base, daily: [{ ...base.daily[0], id: "5ee0000e" }] },
    { ...base, daily: [{ ...base.daily[0], note: "someone@example.com" }] },
    { ...base, totals: { ...base.totals, latest_signup: "5ee0000e" } },
    { ...base, extra: "5ee0000e" },
    { ...base, daily: [{ ...base.daily[0], email: "a@b.c" }] },
  ];
  for (const raw of cases) {
    assert.throws(() => appDb.validateAppDbSummary(raw, NOW), (error) => error.code === "app_db_not_counts", JSON.stringify(raw).slice(0, 120));
  }
});

await test("app db: wrong shapes are refused (missing totals, non-integers, negatives, bad or repeated dates)", () => {
  const base = fixture("app-db-summary.json");
  const noRealUsers = { ...base.totals };
  delete noRealUsers.real_users;
  const cases = [
    null,
    [],
    { ...base, generated_at: "yesterday" },
    { ...base, totals: noRealUsers },
    { ...base, totals: { ...base.totals, real_users: 1.5 } },
    { ...base, totals: { ...base.totals, real_users: -1 } },
    { ...base, totals: { ...base.totals, real_users: "2" } },
    { ...base, daily: "none" },
    { ...base, daily: [{ ...base.daily[0], date: "2026-02-30" }] },
    { ...base, daily: [base.daily[0], base.daily[0]] },
    { ...base, daily: [{ ...base.daily[0], date: "2026-12-01" }] },
    { ...base, daily: [{ date: "2026-10-26", signups_real: 1 }] },
  ];
  for (const raw of cases) {
    assert.throws(() => appDb.validateAppDbSummary(raw, NOW), (error) => error.code === "app_db_shape", JSON.stringify(raw)?.slice(0, 120));
  }
});

await test("app db: unknown count fields are dropped, `day` works as the date key", () => {
  const base = fixture("app-db-summary.json");
  const summary = appDb.validateAppDbSummary(
    { ...base, schema_version: 2, totals: { ...base.totals, households_total: 7 }, daily: [{ day: "2026-10-26", signups_real: 1, signups_apple: 1, signups_email: 0, future_count: 3 }] },
    NOW
  );
  assert.equal("households_total" in summary.totals, false);
  assert.deepEqual(summary.daily, [{ date: "2026-10-26", signups_real: 1, signups_apple: 1, signups_email: 0 }]);
});

await test("app db: rows are daily sign-ups (ET days) plus as-of totals", () => {
  const summary = appDb.validateAppDbSummary(fixture("app-db-summary.json"), NOW);
  const rows = appDb.appDbDailyRows(summary, "2026-10-27");
  const find = (date, metric) => rows.find((r) => r.metric_date === date && r.metric === metric)?.value;
  assert.equal(find("2026-10-26", "signups_real"), 2);
  assert.equal(find("2026-10-26", "signups_unconfirmed"), 1);
  assert.equal(find("2026-10-23", "signups_family"), 2);
  assert.equal(find("2026-10-27", "total_real_users"), 2);
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

// @@MORE_TESTS@@

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
