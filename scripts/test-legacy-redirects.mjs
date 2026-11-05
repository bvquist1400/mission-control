#!/usr/bin/env node
// Offline test for redesign S0 (Baseline 06416585): the removed pages redirect,
// nothing in the app still links to them, and what S0 kept is still there.
// Run: npm run test:legacy-redirects
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const { legacyRedirectTarget, LEGACY_PATHS } = await import(
  pathToFileURL(path.join(root, "src/lib/legacy-redirects.ts")).href
);
const { toBrowserSearchResult } = await import(
  pathToFileURL(path.join(root, "src/lib/search/browser.ts")).href
);

let checks = 0;
function eq(actual, expected, label) {
  checks += 1;
  assert.equal(actual, expected, label);
}
function ok(value, label) {
  checks += 1;
  assert.ok(value, label);
}
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));

const UUID = "3f2b8c1e-9a4d-4e7b-8c21-5d6e7f8a9b0c";

// --- 1. Where each old URL lands ----------------------------------------------
eq(legacyRedirectTarget("focus"), "/", "/focus -> Today");
eq(legacyRedirectTarget("planner"), "/", "/planner -> Today");
eq(legacyRedirectTarget("llm"), "/", "/llm -> Today");
eq(legacyRedirectTarget("weekly-review"), "/", "/weekly-review -> Today");
eq(legacyRedirectTarget("stakeholders"), "/portfolio", "/stakeholders -> Portfolio");
eq(legacyRedirectTarget("stakeholder-detail", UUID), `/r/stakeholder/${UUID}`, "/stakeholders/[id] -> record page");
eq(legacyRedirectTarget("sprints"), "/backlog", "/sprints -> Backlog");
eq(legacyRedirectTarget("sprint-detail", UUID), `/backlog?sprint=${UUID}`, "/sprints/[id] -> Backlog sprint filter");
// A hostile id can't add a path segment, a query parameter or leave the app.
eq(legacyRedirectTarget("sprint-detail", "x&expand=1#y"), "/backlog?sprint=x%26expand%3D1%23y", "sprint id is encoded");
eq(legacyRedirectTarget("stakeholder-detail", "../../login"), "/r/stakeholder/..%2F..%2Flogin", "stakeholder id is encoded");
eq(legacyRedirectTarget("stakeholder-detail", "//evil.example"), "/r/stakeholder/%2F%2Fevil.example", "no protocol-relative target");
eq(legacyRedirectTarget("sprint-detail", "x%26expand%3D1"), "/backlog?sprint=x%26expand%3D1", "an id Next left percent-encoded is not encoded twice");
eq(legacyRedirectTarget("sprint-detail", "100%"), "/backlog?sprint=100%25", "a bad escape is kept, not thrown");
eq(legacyRedirectTarget("stakeholder-detail", "..%2F..%2Flogin"), "/r/stakeholder/..%2F..%2Flogin", "an encoded ../ stays one segment");
eq(legacyRedirectTarget("sprint-detail"), "/backlog", "no id -> plain Backlog");
eq(legacyRedirectTarget("stakeholder-detail"), "/portfolio", "no id -> Portfolio");

// --- 2. Every shim page exists and is wired to the map -------------------------
const SHIMS = [
  ["src/app/focus/page.tsx", "focus"],
  ["src/app/planner/page.tsx", "planner"],
  ["src/app/llm/page.tsx", "llm"],
  ["src/app/weekly-review/page.tsx", "weekly-review"],
  ["src/app/sprints/page.tsx", "sprints"],
  ["src/app/sprints/[id]/page.tsx", "sprint-detail"],
  ["src/app/stakeholders/page.tsx", "stakeholders"],
  ["src/app/stakeholders/[id]/page.tsx", "stakeholder-detail"],
];
for (const [file, key] of SHIMS) {
  ok(exists(file), `${file} exists (old links must not 404)`);
  const source = read(file);
  assert.match(source, /from "next\/navigation"/, `${file} redirects through next/navigation`);
  assert.match(source, new RegExp(`redirect\\(legacyRedirectTarget\\("${key}"`), `${file} calls the ${key} rule`);
  assert.doesNotMatch(source, /use client|useEffect|fetch\(/, `${file} stays a plain server shim`);
  assert.ok(source.split("\n").length < 20, `${file} is a thin shim`);
  checks += 4;
}
for (const [oldPath, key] of Object.entries(LEGACY_PATHS)) {
  ok(SHIMS.some(([file, k]) => k === key && file === `src/app${oldPath}/page.tsx`), `${oldPath} has its shim`);
}

// --- 3. Nav, shortcuts and the palette no longer point at removed screens ------
const REMOVED = ["/focus", "/planner", "/llm", "/weekly-review", "/sprints", "/stakeholders"];
const nav = read("src/components/layout/nav-items.tsx");
for (const href of [...nav.matchAll(/href:\s*"([^"]+)"/g)].map((m) => m[1])) {
  ok(!REMOVED.includes(href), `nav has no entry for removed ${href}`);
  const dir = href === "/" ? "src/app/page.tsx" : `src/app${href}/page.tsx`;
  ok(exists(dir), `nav entry ${href} has a page`);
}
for (const label of ["Sprints", "Stakeholders", "Weekly Review", "Focus", "Planner"]) {
  assert.doesNotMatch(nav, new RegExp(`label:\\s*"${label}"`), `nav label ${label}`);
  checks += 1;
}
const shortcuts = read("src/components/layout/ShortcutsDialog.tsx");
const goTo = shortcuts.slice(shortcuts.indexOf("GO_TO_KEYS"), shortcuts.indexOf("};", shortcuts.indexOf("GO_TO_KEYS")));
const goToTargets = [...goTo.matchAll(/:\s*"(\/[^"]*)"/g)].map((m) => m[1]);
ok(goToTargets.length >= 5, "go-to keys still defined");
for (const href of goToTargets) {
  ok(!REMOVED.includes(href), `go-to key does not target removed ${href}`);
  ok(exists(href === "/" ? "src/app/page.tsx" : `src/app${href}/page.tsx`), `go-to ${href} has a page`);
}
for (const key of ["s", "k", "w"]) {
  assert.doesNotMatch(goTo, new RegExp(`\\b${key}:\\s*"`), `go-to key ${key} removed`);
  checks += 1;
}

const sprintHit = toBrowserSearchResult({
  id: `record:sprint:${UUID}`, title: "Sprint 1", text: "", url: `https://x.test/r/sprint/${UUID}`, metadata: { entity: "sprint" },
});
eq(sprintHit.href, `/backlog?sprint=${UUID}`, "search: a sprint opens the Backlog filter");
const personHit = toBrowserSearchResult({
  id: `record:stakeholder:${UUID}`, title: "Casey", text: "", url: `https://x.test/r/stakeholder/${UUID}`, metadata: { entity: "stakeholder" },
});
eq(personHit.href, `/r/stakeholder/${UUID}`, "search: a stakeholder opens the record page");

// --- 4. No page or component links to a removed URL (class check) --------------
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx?|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const linkPattern = new RegExp(
  "(href=|router\\.(push|replace)\\(|redirect\\(|permanentRedirect\\(|window\\.location\\.href\\s*=)\\s*[{(]?\\s*[\"'`]" +
    "(/focus|/planner|/llm|/weekly-review|/sprints|/stakeholders)([\"'`/?#]|$)"
);
for (const file of walk(path.join(root, "src"))) {
  const rel = path.relative(root, file);
  if (rel.startsWith("src/app/api/")) continue;
  const source = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(source, linkPattern, `${rel} links to a removed page`);
  checks += 1;
}

// --- 5. Dead code is gone; what is kept is still there -------------------------
for (const gone of [
  "src/components/today/briefing",
  "src/components/today/FocusStatusBar.tsx",
  "src/components/today/FocusContextBar.tsx",
  "src/components/today/PlannerCard.tsx",
  "src/components/today/CapacityMeter.tsx",
  "src/components/sprints",
  "src/components/stakeholders",
  "src/app/api/llm",
]) {
  ok(!exists(gone), `${gone} deleted`);
}
// Anything that imports a deleted module would break `tsc`/`next build`; also pin the two Today edits.
const today = read("src/app/page.tsx");
assert.doesNotMatch(today, /FocusStatusBar/, "Today has no Focus bar");
const nowPanel = read("src/components/today/sections/NowPanel.tsx") + read("src/components/today/sections/NowPanelSection.tsx");
assert.doesNotMatch(nowPanel, /Not synced today|syncNote|queryLatestSyncEvent/, "Today has no sync line");
checks += 2;

for (const kept of [
  "src/app/api/focus/route.ts",
  "src/app/api/focus/[id]/route.ts",
  "src/app/api/focus/clear/route.ts",
  "src/app/api/planner/plan/route.ts",
  "src/app/api/planner/sync-today/route.ts",
  "src/app/api/planner/sync-today/latest/route.ts",
  "src/app/api/sprints/route.ts",
  "src/app/api/sprints/[id]/route.ts",
  "src/app/api/stakeholders/route.ts",
  "src/app/api/stakeholders/[id]/route.ts",
  "src/app/api/commitments/route.ts",
  "src/app/api/briefing/weekly-review/route.ts",
  "src/app/api/briefing/monthly-review/route.ts",
  "src/lib/llm/catalog.ts",
  "src/lib/today/queries.ts",
  "src/app/r/[kind]/[id]/page.tsx",
]) {
  ok(exists(kept), `${kept} kept`);
}
// Sprint stays as a Backlog filter and a Today chip; both link to the filter, not a removed page.
assert.match(read("src/components/backlog/BacklogList.tsx"), /searchParams\.get\("sprint"\)/, "Backlog reads ?sprint=");
assert.match(read("src/components/today/sections/TodayHeaderChips.tsx"), /\/backlog\?sprint=/, "sprint chip -> Backlog filter");
checks += 2;

console.log(`legacy-redirects: ${checks} checks passed`);
