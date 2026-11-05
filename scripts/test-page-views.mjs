#!/usr/bin/env node
// Offline test for Vercel Web Analytics page-view reporting.
// Run: npm run test:page-views
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const { toRoutePattern, sanitizeAnalyticsUrl, beforeSendPageView } = await import(
  pathToFileURL(path.join(root, "src/lib/analytics/route-pattern.ts")).href
);

let checks = 0;
function eq(actual, expected, label) {
  checks += 1;
  assert.equal(actual, expected, label);
}

const UUID = "3f2b8c1e-9a4d-4e7b-8c21-5d6e7f8a9b0c";
const UUID_UPPER = UUID.toUpperCase();
const UUID_MIXED = "3F2b8C1e-9A4d-4E7b-8c21-5D6e7F8a9B0c";

// --- 1. Every routed page / route handler under src/app is accounted for -----
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/^(page|route)\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const appDir = path.join(root, "src/app");
const found = walk(appDir).map((file) => {
  const rel = path.relative(appDir, path.dirname(file)).split(path.sep);
  const segments = rel.filter((s) => s && !/^\(.*\)$/.test(s));
  return {
    kind: path.basename(file).startsWith("page") ? "page" : "route",
    route: "/" + segments.join("/"),
  };
});

// Pages: filesystem route -> [concrete sample path, expected reported pattern]
const PAGES = {
  "/": ["/", "/"],
  "/applications": ["/applications", "/applications"],
  "/applications/[id]": [`/applications/${UUID}`, "/applications/[id]"],
  "/backlog": ["/backlog", "/backlog"],
  "/briefs/[code]": ["/briefs/AM-1105", "/briefs/[code]"],
  "/calendar": ["/calendar", "/calendar"],
  "/calendar/events/[id]": [`/calendar/events/${UUID}`, "/calendar/events/[id]"],
  "/focus": ["/focus", "/focus"],
  "/implementations": ["/implementations", "/implementations"],
  "/implementations/[id]": [`/implementations/${UUID}`, "/implementations/[id]"],
  "/launch": ["/launch", "/launch"],
  "/llm": ["/llm", "/llm"],
  "/login": ["/login", "/login"],
  "/planner": ["/planner", "/planner"],
  "/portfolio": ["/portfolio", "/portfolio"],
  "/projects": ["/projects", "/projects"],
  "/projects/[id]": [`/projects/${UUID}`, "/projects/[id]"],
  "/projects/templates": ["/projects/templates", "/projects/templates"],
  "/r/[kind]/[id]": [`/r/task/${UUID}`, "/r/task/[id]"],
  "/sprints": ["/sprints", "/sprints"],
  "/sprints/[id]": [`/sprints/${UUID}`, "/sprints/[id]"],
  "/stakeholders": ["/stakeholders", "/stakeholders"],
  "/stakeholders/[id]": [`/stakeholders/${UUID}`, "/stakeholders/[id]"],
  "/triage": ["/triage", "/triage"],
  "/weekly-review": ["/weekly-review", "/weekly-review"],
};

const foundPages = found.filter((f) => f.kind === "page").map((f) => f.route).sort();
assert.deepEqual(
  foundPages,
  Object.keys(PAGES).sort(),
  "Every page under src/app needs a row in PAGES (add new pages to scripts/test-page-views.mjs and src/lib/analytics/route-pattern.ts)"
);
checks += 1;

for (const [route, [sample, expected]] of Object.entries(PAGES)) {
  eq(toRoutePattern(sample), expected, `page ${route}: ${sample}`);
  eq(toRoutePattern(`${sample}/`), expected, `page ${route}: trailing slash`);
  eq(toRoutePattern(`${sample}?x=1&token=abc#frag`), expected, `page ${route}: query+hash`);
  eq(
    sanitizeAnalyticsUrl(`https://mission-control.example.com${sample}?filter=secret#h`),
    `https://mission-control.example.com${expected}`,
    `page ${route}: absolute url`
  );
}

// Route handlers (api, oauth, auth callback, well-known) are never reported.
const handlers = found.filter((f) => f.kind === "route");
assert.ok(handlers.length > 0, "expected route handlers on disk");
for (const { route } of handlers) {
  const sample = route.replace(/\[\.\.\.[^\]]+\]/g, "a/b").replace(/\[[^\]]+\]/g, UUID);
  eq(toRoutePattern(sample), null, `route handler dropped: ${route}`);
  eq(
    sanitizeAnalyticsUrl(`https://mission-control.example.com${sample}?code=abc`),
    null,
    `route handler dropped (absolute): ${route}`
  );
}

// --- 2. Id collapsing --------------------------------------------------------
for (const id of [UUID, UUID_UPPER, UUID_MIXED]) {
  eq(toRoutePattern(`/r/task/${id}`), "/r/task/[id]", `uuid case ${id}`);
  eq(toRoutePattern(`/projects/${id}`), "/projects/[id]");
  eq(toRoutePattern(`/applications/${id}`), "/applications/[id]");
  eq(toRoutePattern(`/sprints/${id}`), "/sprints/[id]");
  eq(toRoutePattern(`/stakeholders/${id}`), "/stakeholders/[id]");
  eq(toRoutePattern(`/implementations/${id}`), "/implementations/[id]");
  eq(toRoutePattern(`/calendar/events/${id}`), "/calendar/events/[id]");
}
// /r/<kind>/<id>: known kinds are kept, unknown kinds do not leak.
for (const kind of ["task", "note", "application", "project", "sprint", "stakeholder", "commitment", "email", "calendar"]) {
  eq(toRoutePattern(`/r/${kind}/${UUID}`), `/r/${kind}/[id]`, `r kind ${kind}`);
}
eq(toRoutePattern(`/r/mystery-kind/${UUID}`), "/r/[kind]/[id]");
eq(toRoutePattern("/r/task/not-a-uuid-but-slot"), "/r/task/[id]", "dynamic slot is always collapsed");
// Brief codes.
eq(toRoutePattern("/briefs/AM-1105"), "/briefs/[code]");
eq(toRoutePattern("/briefs/am-1105"), "/briefs/[code]");
eq(toRoutePattern("/briefs/AM%2D1105"), "/briefs/[code]");
eq(toRoutePattern("/briefs/PM-7/"), "/briefs/[code]");
// Calendar event ids are not always uuids.
eq(toRoutePattern("/calendar/events/abc123_20261105T140000Z"), "/calendar/events/[id]");
// Static children win over the [id] slot.
eq(toRoutePattern("/projects/templates"), "/projects/templates");
eq(toRoutePattern("/projects/templates/"), "/projects/templates");
// Deeper than the known page keeps collapsing the id and any id-like pieces.
eq(toRoutePattern(`/projects/${UUID}/extra/${UUID}`), "/projects/[id]/extra/[id]");

// --- 3. Slashes, queries, hashes, encoding ----------------------------------
eq(toRoutePattern(""), "/");
eq(toRoutePattern("/?a=1"), "/");
eq(toRoutePattern("/#top"), "/");
eq(toRoutePattern("//portfolio//"), "/portfolio");
eq(toRoutePattern("/portfolio?tab=secret#x"), "/portfolio");
eq(toRoutePattern("/login?next=%2Fprojects%2F" + UUID), "/login");
eq(toRoutePattern("/login/"), "/login");
eq(toRoutePattern("/launch#section"), "/launch");

// --- 4. Unknown paths: uuid-looking and long-id segments become [id] ---------
eq(toRoutePattern(`/something/${UUID}`), "/something/[id]");
eq(toRoutePattern(`/something/${UUID_UPPER}/deep`), "/something/[id]/deep");
eq(toRoutePattern("/something/0123456789abcdef0123"), "/something/[id]");
eq(toRoutePattern("/something/aB3dE5gH7jK9mN1pQ3sT5v"), "/something/[id]");
eq(toRoutePattern("/something/123456"), "/something/[id]");
eq(toRoutePattern("/something/jane.doe@example.com"), "/something/[id]");
eq(toRoutePattern("/something/new"), "/something/new");
eq(toRoutePattern("/not-a-page"), "/not-a-page");
eq(toRoutePattern("/wp-admin/setup.php"), "/wp-admin/setup.php");

// --- 5. Never reported -------------------------------------------------------
for (const p of [
  "/api",
  "/api/",
  "/api/tasks",
  `/api/tasks/${UUID}`,
  "/API/tasks",
  "/oauth/authorize?client_id=x&code_challenge=y",
  "/oauth/token",
  "/oauth/register",
  "/oauth",
  "/auth/callback?code=abc",
  "/.well-known/oauth-authorization-server",
  "/_next/static/chunk.js",
  "/_vercel/insights/script.js",
]) {
  eq(toRoutePattern(p), null, `dropped: ${p}`);
  eq(sanitizeAnalyticsUrl(`https://x.example.com${p}`), null, `dropped abs: ${p}`);
}

// --- 6. URL handling ---------------------------------------------------------
eq(
  sanitizeAnalyticsUrl(`https://mission-control.example.com/r/task/${UUID}?a=b#c`),
  "https://mission-control.example.com/r/task/[id]"
);
eq(
  sanitizeAnalyticsUrl("http://localhost:3000/projects/" + UUID),
  "http://localhost:3000/projects/[id]",
  "scheme + host + port kept"
);
eq(
  sanitizeAnalyticsUrl(`https://user:pass@mission-control.example.com/focus`),
  "https://mission-control.example.com/focus",
  "credentials stripped"
);
eq(sanitizeAnalyticsUrl(`/projects/${UUID}?x=1`), "/projects/[id]", "relative url");
eq(sanitizeAnalyticsUrl("javascript:alert(1)"), null, "non-http scheme dropped");
eq(sanitizeAnalyticsUrl(""), "/" , "empty url");
eq(sanitizeAnalyticsUrl(undefined), null, "missing url dropped");

// --- 7. beforeSend wrapper ----------------------------------------------------
const kept = beforeSendPageView({ type: "pageview", url: `https://h.example.com/projects/${UUID}?q=1#z` });
assert.deepEqual(kept, { type: "pageview", url: "https://h.example.com/projects/[id]" });
checks += 1;
const keptEvent = beforeSendPageView({ type: "event", url: `https://h.example.com/focus?x=1`, name: "n" });
assert.deepEqual(keptEvent, { type: "event", url: "https://h.example.com/focus", name: "n" });
checks += 1;
eq(beforeSendPageView({ type: "pageview", url: "https://h.example.com/oauth/authorize?x=1" }), null);
eq(beforeSendPageView({ type: "pageview", url: "https://h.example.com/api/tasks" }), null);

// --- 8. Wiring: layout gates on deployment role, wrapper uses beforeSend -----
const layout = fs.readFileSync(path.join(root, "src/app/layout.tsx"), "utf8");
assert.match(layout, /isMcpDeployment\(\)/, "layout must check isMcpDeployment()");
assert.match(layout, /!isMcpDeployment\(\)\s*&&\s*<PageViewAnalytics\s*\/>/, "layout must render analytics only off the MCP deployment");
assert.equal((layout.match(/<PageViewAnalytics/g) ?? []).length, 1, "analytics rendered once");
checks += 3;
const wrapper = fs.readFileSync(path.join(root, "src/components/analytics/PageViewAnalytics.tsx"), "utf8");
assert.match(wrapper, /^["']use client["']/, "wrapper must be a client component");
assert.match(wrapper, /from ["']@vercel\/analytics\/next["']/);
assert.match(wrapper, /beforeSend=\{beforeSendPageView\}/, "wrapper must pass the route-pattern beforeSend");
checks += 3;

console.log(`page-views: ${checks} checks passed`);
