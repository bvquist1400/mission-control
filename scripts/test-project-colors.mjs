#!/usr/bin/env node
// Project colours (redesign S2, migration 069; Baseline task b13c2e2d). Offline:
// no network, no database. The real database round trip is test:project-colors-db.
//
// - 069 and its rollback: additive, nullable, no default, no row rewritten, the
//   exact CHECK, re-runnable.
// - The rules (src/lib/project-colors.ts): input parsing, yellow/gold refused
//   (marigold is "needs you" only), the light-paper contrast floor, the 12
//   presets (none yellow, all >= 3:1 on the paper and sheet of BOTH themes), the
//   D3 defaults by name, the dark variant, which colour a square shows.
// - The API refuses a bad colour with a plain 400 before any database call.
// - The square, the tag and the editor rendered with react-dom/server; the
//   account menu opens the editor; every surface the plan names draws squares.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");

// TSX → JS for the components (TypeScript's own transpiler; types are dropped).
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

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1"; // any database call would fail loudly
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.MISSION_CONTROL_API_KEY = "colors-test-legacy-key";
process.env.MISSION_CONTROL_USER_ID = "00000000-0000-4000-8000-000000000001";
delete process.env.MISSION_CONTROL_ACTIONS_API_KEY;
delete process.env.MISSION_CONTROL_FAMCAL_API_KEY;

// Key auth makes one network call (auth.admin.getUserById); answer it here. Anything else is a failure.
const networkCalls = [];
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.includes(`/auth/v1/admin/users/${process.env.MISSION_CONTROL_USER_ID}`)) {
    return new Response(JSON.stringify({ id: process.env.MISSION_CONTROL_USER_ID, aud: "authenticated", role: "authenticated", email: "test@example.test" }), { status: 200, headers: { "content-type": "application/json" } });
  }
  networkCalls.push(url);
  throw new Error(`unexpected network call: ${url}`);
};

const src = (file) => pathToFileURL(path.join(ROOT, "src", file)).href;

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}`);
    console.log(error);
  }
}

const colors = await import(src("lib/project-colors.ts"));

// ── 069 ───────────────────────────────────────────────────────────────────────

await test("069: two nullable TEXT columns, no default, exact CHECK, NOT VALID then VALIDATE, no row written", () => {
  const sql = read("supabase/migrations/069_project_colors.sql");
  const body = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  assert.match(body, /ALTER TABLE implementations\s+ADD COLUMN IF NOT EXISTS color TEXT;/);
  assert.match(body, /ALTER TABLE projects\s+ADD COLUMN IF NOT EXISTS color TEXT;/);
  assert.doesNotMatch(body, /ADD COLUMN[^;]*\bDEFAULT\b/i, "no default: ADD COLUMN stays catalog-only");
  assert.doesNotMatch(body, /ADD COLUMN[^;]*\bNOT NULL\b/i);
  assert.doesNotMatch(body, /\b(UPDATE|INSERT|DELETE)\s+(INTO\s+|FROM\s+)?(implementations|projects)\b/i, "no existing row is rewritten");
  const checks = body.match(/CHECK \(color IS NULL OR color ~ '\^#\[0-9A-Fa-f\]\{6\}\$'\) NOT VALID/g) ?? [];
  assert.equal(checks.length, 2);
  assert.match(body, /VALIDATE CONSTRAINT implementations_color_hex_check/);
  assert.match(body, /VALIDATE CONSTRAINT projects_color_hex_check/);
  assert.match(body, /lock_timeout = '10s'/);
  assert.match(body, /NOTIFY pgrst, 'reload schema'/);
  // The app's pattern is the same as the database's.
  assert.equal(colors.PROJECT_COLOR_PATTERN.source, "^#[0-9A-Fa-f]{6}$");
});

await test("069 rollback: drops both checks and columns, IF EXISTS (re-runnable), nothing else", () => {
  const sql = read("supabase/rollbacks/069_project_colors.down.sql");
  const statements = sql.split("\n").filter((line) => /^(ALTER|DROP|CREATE|UPDATE|DELETE|INSERT)/.test(line.trim()));
  assert.deepEqual(statements, [
    "ALTER TABLE implementations DROP CONSTRAINT IF EXISTS implementations_color_hex_check;",
    "ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_color_hex_check;",
    "ALTER TABLE implementations DROP COLUMN IF EXISTS color;",
    "ALTER TABLE projects DROP COLUMN IF EXISTS color;",
  ]);
});

await test("types: the generated schema and the domain rows carry color (string | null)", () => {
  const generated = read("src/types/supabase.generated.ts");
  for (const table of ["implementations", "projects"]) {
    const block = generated.slice(generated.indexOf(`      ${table}: {`), generated.indexOf("Relationships", generated.indexOf(`      ${table}: {`)));
    assert.match(block, /Row: \{[^}]*\n\s+color: string \| null\n/);
    assert.match(block, /Insert: \{[^}]*\n\s+color\?: string \| null\n/);
    assert.match(block, /Update: \{[^}]*\n\s+color\?: string \| null\n/);
  }
  const domain = read("src/types/database.ts");
  assert.equal((domain.match(/^\s+color: string \| null;$/gm) ?? []).length, 2);
});

// ── rules ─────────────────────────────────────────────────────────────────────

await test("input: hex in any case is stored upper case; null and \"\" clear; anything else is the format error", () => {
  assert.deepEqual(colors.parseProjectColorInput("#3b5ba5"), { ok: true, value: "#3B5BA5" });
  assert.deepEqual(colors.parseProjectColorInput(" #3B5BA5 "), { ok: true, value: "#3B5BA5" });
  assert.deepEqual(colors.parseProjectColorInput(null), { ok: true, value: null });
  assert.deepEqual(colors.parseProjectColorInput(""), { ok: true, value: null });
  for (const bad of ["#FFF", "3B5BA5", "#3B5BA", "#3B5BA55", "#GGGGGG", "red", "rgb(1,2,3)", 0x3b5ba5, true, {}, []]) {
    const result = colors.parseProjectColorInput(bad);
    assert.equal(result.ok, false, String(bad));
    assert.equal(result.problem, "format", String(bad));
  }
});

await test("marigold is \"needs you\" only: it, yellow, gold and dark ochre are refused; orange, olive and brown are not", () => {
  for (const yellow of [colors.NEEDS_YOU_COLOR, "#F2B230", "#f2b230", "#FFE14D", "#FFD700", "#B8860B", "#8F5E00", "#E6A817", "#5C4A00"]) {
    const result = colors.parseProjectColorInput(yellow);
    assert.equal(result.ok, false, yellow);
    assert.equal(result.problem, "needs_you", yellow);
    assert.match(result.error, /needs you/);
  }
  for (const fine of ["#5B6B2C", "#96592A", "#B1435C", "#7C7E74", "#6B4E3D", "#6E6E6A"]) {
    assert.equal(colors.projectColorProblem(fine), null, fine);
  }
});

await test("a colour too pale for the light paper (< 3:1) is refused with the plain reason; black is fine", () => {
  for (const pale of ["#E0E0E0", "#FFFFFF", "#9FC5E8", "#FF8800"]) {
    assert.equal(colors.projectColorProblem(pale), "contrast", pale);
  }
  assert.equal(colors.projectColorProblem("#000000"), null);
  assert.match(colors.PROJECT_COLOR_PROBLEM_TEXT.contrast, /3:1/);
});

await test("12 presets: unique, the seven D3 colours first, none yellow, every one >= 3:1 on paper and sheet in BOTH themes", () => {
  const presets = colors.PROJECT_COLOR_PRESETS;
  assert.equal(presets.length, 12);
  assert.equal(new Set(presets.map((p) => p.light)).size, 12);
  assert.deepEqual(presets.slice(0, 7).map((p) => p.light), ["#5B6B2C", "#3D6C99", "#6E4F9C", "#B1435C", "#2B8780", "#96592A", "#7C7E74"]);
  assert.deepEqual(presets.slice(0, 7).map((p) => p.dark), ["#AEBF62", "#72A8E2", "#AD98F0", "#EE7FA0", "#52C2B6", "#D8A574", "#A6A897"]);
  for (const preset of presets) {
    assert.notEqual(preset.light, colors.NEEDS_YOU_COLOR);
    assert.equal(colors.isNeedsYouHue(preset.light), false, preset.label);
    assert.equal(colors.isNeedsYouHue(preset.dark), false, `${preset.label} dark`);
    assert.ok(colors.themeContrast(preset.light, "light") >= 3, `${preset.label} light ${colors.themeContrast(preset.light, "light")}`);
    assert.ok(colors.themeContrast(preset.dark, "dark") >= 3, `${preset.label} dark ${colors.themeContrast(preset.dark, "dark")}`);
    assert.equal(colors.projectColorProblem(preset.light), null, preset.label);
  }
});

await test("contrast maths: WCAG ratios for known pairs", () => {
  assert.equal(Math.round(colors.contrastRatio("#000000", "#FFFFFF") * 10) / 10, 21);
  assert.equal(colors.contrastRatio("#777777", "#777777"), 1);
  assert.equal(colors.formatRatio(4.56), "4.5:1");
});

await test("defaults (null colour): the D3 slot by name for apps and projects; other apps Work grey; other personal projects a fixed extra", () => {
  const cases = [
    ["Menu & Market", "#5B6B2C", "#AEBF62"],
    ["M&M", "#5B6B2C", "#AEBF62"],
    ["Stock & Stir", "#5B6B2C", "#AEBF62"],
    ["FamCal", "#3D6C99", "#72A8E2"],
    ["Baseline", "#6E4F9C", "#AD98F0"],
    ["Mission Control", "#6E4F9C", "#AD98F0"],
    ["OvenLineup", "#B1435C", "#EE7FA0"],
    ["Home", "#2B8780", "#52C2B6"],
    ["Move to Denver", "#96592A", "#D8A574"],
    ["Work", "#7C7E74", "#A6A897"],
  ];
  for (const [name, light, dark] of cases) {
    assert.deepEqual(colors.defaultColorPair("app", { id: "a", name }), { light, dark }, name);
  }
  assert.deepEqual(colors.defaultColorPair("project", { id: "p", name: "Personal — Baseline Redesign", tags: ["personal"] }), { light: "#6E4F9C", dark: "#AD98F0" });
  assert.deepEqual(colors.defaultColorPair("app", { id: "x", name: "ORIEN Research Build" }), { light: "#7C7E74", dark: "#A6A897" });
  assert.deepEqual(colors.defaultColorPair("project", { id: "x", name: "Q4 access audit", tags: [] }), { light: "#7C7E74", dark: "#A6A897" });
  const extras = colors.EXTRA_PROJECT_COLORS.map((c) => c.light);
  const knit = colors.defaultColorPair("project", { id: "11111111-2222-4333-8444-555555555555", name: "Blanket", tags: ["personal", "hobby"] });
  assert.ok(extras.includes(knit.light));
  assert.deepEqual(colors.defaultColorPair("project", { id: "11111111-2222-4333-8444-555555555555", name: "Blanket (renamed)", tags: ["personal"] }), knit, "by id, so it never changes");
  const spread = new Set(Array.from({ length: 40 }, (_, i) => colors.defaultColorPair("project", { id: `p-${i}`, name: "x", tags: ["personal"] }).light));
  assert.ok(spread.size >= 4, "other personal projects spread over the extras");
});

await test("dark variant: a preset uses its designed pair; any other stored colour is lightened just enough (same hue) to reach 3:1 on the dark paper and sheet", () => {
  assert.equal(colors.darkVariant("#3B5BA5"), "#8FA6EB");
  assert.equal(colors.darkVariant("#3b5ba5"), "#8FA6EB");
  for (const hex of ["#000000", "#123456", "#5A1E2E", "#2D4A1F", "#663399"]) {
    const dark = colors.darkVariant(hex);
    assert.ok(colors.themeContrast(dark, "dark") >= 3, `${hex} -> ${dark}`);
    const before = colors.toHsl(hex);
    const after = colors.toHsl(dark);
    if (before.s > 0.05) assert.ok(Math.abs(before.h - after.h) < 4, `${hex} keeps its hue`);
    assert.ok(after.l >= before.l);
  }
  // Already readable on dark: kept as is.
  assert.equal(colors.darkVariant("#C0A0F0"), "#C0A0F0");
  assert.equal(colors.colorPairCss({ light: "#111111", dark: "#EEEEEE" }), "light-dark(#111111, #EEEEEE)");
});

await test("square: project colour, else its app's colour, else the default; drafts/saved overrides win; a cleared draft falls back", () => {
  const app = { id: "app-1", name: "Baseline", color: null };
  const project = { id: "prj-1", name: "Personal — Baseline Redesign", tags: ["personal"], color: null };
  let square = colors.resolveSquare({ app, project });
  assert.equal(square.source, "default");
  assert.equal(square.light, "#6E4F9C");
  assert.deepEqual(square.owner, { kind: "app", id: "app-1", name: "Baseline" }, "a click opens whoever gives the colour");

  square = colors.resolveSquare({ app: { ...app, color: "#1e6e55" }, project });
  assert.equal(square.source, "app");
  assert.deepEqual([square.light, square.dark], ["#1E6E55", "#5CC59E"]);

  square = colors.resolveSquare({ app: { ...app, color: "#1E6E55" }, project: { ...project, color: "#87387A" } });
  assert.equal(square.source, "project");
  assert.equal(square.owner.kind, "project");
  assert.equal(square.light, "#87387A");

  const overrides = new Map([["prj-1", "#3B5BA5"], ["app-1", null]]);
  square = colors.resolveSquare({ app: { ...app, color: "#1E6E55" }, project }, overrides);
  assert.equal(square.light, "#3B5BA5", "the editor's draft wins");
  square = colors.resolveSquare({ app: { ...app, color: "#1E6E55" }, project: { ...project, color: "#87387A" } }, new Map([["prj-1", null], ["app-1", null]]));
  assert.equal(square.source, "default", "Reset clears back to the default");

  square = colors.resolveSquare({ project: { id: "home", name: "Home", tags: ["personal"] } });
  assert.equal(square.light, "#2B8780");
  assert.equal(colors.resolveSquare({}), null, "a standalone to-do has no square");
});

await test("a stored yellow, pale or malformed value (hand-written SQL) is never painted: the square shows the default", () => {
  for (const stored of ["#F2B230", "#FFE14D", "#EEEEEE", "nonsense", "#12345"]) {
    const square = colors.resolveSquare({ app: { id: "a", name: "FamCal", color: stored } });
    assert.equal(square.source, "default", stored);
    assert.equal(square.light, "#3D6C99", stored);
  }
  assert.equal(colors.usableStoredColor("#3b5ba5"), "#3B5BA5");
});

await test("squareInputOf: embedded relations as objects or one-item arrays; nothing without id + name", () => {
  const input = colors.squareInputOf({ implementation: [{ id: "a", name: "FamCal" }], project: { id: "p", name: "Sunday brief", tags: ["personal"] } });
  assert.deepEqual(input, { app: { id: "a", name: "FamCal", color: null }, project: { id: "p", name: "Sunday brief", tags: ["personal"], color: null } });
  assert.deepEqual(colors.squareInputOf({ implementation: null, project: [] }), { app: null, project: null });
});

await test("editor check line: ratios for both themes, adjusted dark shown, problems named", () => {
  const ok = colors.checkColorForEditor("#123456");
  assert.equal(ok.ok, true);
  assert.equal(ok.dark.adjusted, true);
  assert.ok(ok.dark.ratio >= 3);
  const preset = colors.checkColorForEditor("#3B5BA5");
  assert.equal(preset.dark.adjusted, false);
  assert.equal(colors.checkColorForEditor("#F2B230").problem, "needs_you");
  assert.equal(colors.checkColorForEditor("#EEE").problem, "format");
  assert.equal(colors.checkColorForEditor("#E0E0E0").problem, "contrast");
});

// ── API: refusals happen before any database call ─────────────────────────────

const { NextRequest } = await import("next/server.js");
const appRoute = await import(src("app/api/applications/[id]/route.ts"));
const projectRoute = await import(src("app/api/projects/[id]/route.ts"));
const projectsRoute = await import(src("app/api/projects/route.ts"));
const keyHeaders = { "x-mission-control-key": process.env.MISSION_CONTROL_API_KEY, "content-type": "application/json" };
const ID = "00000000-0000-4000-8000-0000000000aa";

async function call(handler, method, url, body, withParams = true) {
  const request = new NextRequest(`http://localhost${url}`, { method, headers: keyHeaders, body: JSON.stringify(body) });
  const response = withParams ? await handler(request, { params: Promise.resolve({ id: ID }) }) : await handler(request);
  return { status: response.status, body: await response.json() };
}

await test("PATCH /api/applications/[id], PATCH /api/projects/[id], POST /api/projects: a bad colour is a plain 400 before the database", async () => {
  for (const [color, problem] of [["#F2B230", /needs you/], ["#ffe14d", /needs you/], ["#EEEEEE", /too pale/], ["#FFF", /hex colour/], [42, /hex colour/]]) {
    const app = await call(appRoute.PATCH, "PATCH", `/api/applications/${ID}`, { color });
    assert.equal(app.status, 400, `app ${color}`);
    assert.match(app.body.error, problem);
    const project = await call(projectRoute.PATCH, "PATCH", `/api/projects/${ID}`, { color });
    assert.equal(project.status, 400, `project ${color}`);
    assert.match(project.body.error, problem);
    const created = await call(projectsRoute.POST, "POST", "/api/projects", { name: "New", color }, false);
    assert.equal(created.status, 400, `create ${color}`);
    assert.match(created.body.error, problem);
  }
  assert.deepEqual(networkCalls, [], "no database call was made for a refused colour");
  assert.equal(colors.isProjectColorCheckViolation({ code: "23514", message: 'new row for relation "projects" violates check constraint "projects_color_hex_check"' }), true);
  assert.equal(colors.isProjectColorCheckViolation({ code: "23514", message: "tasks_start_at_before_due_at" }), false);
});

await test("routes: color is in both PATCH allowlists and the create; 069's CHECK maps to 400", () => {
  for (const file of ["src/app/api/applications/[id]/route.ts", "src/app/api/projects/[id]/route.ts"]) {
    const source = read(file);
    assert.match(source, /'color',\n\s+\];/, file);
    assert.match(source, /parseProjectColorInput\(body\.color\)/, file);
    assert.match(source, /isProjectColorCheckViolation\(error\)/, file);
  }
  const create = read("src/app/api/projects/route.ts");
  assert.match(create, /insertPayload\.color = color/);
});

await test("MCP: create_project, update_project and update_application take color; refusals come back as isError", () => {
  const snapshot = JSON.parse(read("scripts/fixtures/mcp-tools.snapshot.json"));
  const tools = new Map((snapshot.tools ?? snapshot).map((tool) => [tool.name, tool]));
  for (const name of ["create_project", "update_project", "update_application"]) {
    const schema = tools.get(name)?.inputSchema ?? tools.get(name)?.input_schema;
    assert.ok(schema?.properties?.color, `${name} has color`);
  }
  assert.equal(tools.get("create_application")?.inputSchema?.properties?.color, undefined, "create_application unchanged (out of scope)");
  const mcp = read("src/app/api/mcp/route.ts");
  const updateApp = mcp.slice(mcp.indexOf("'update_application',"), mcp.indexOf("// ── APPLICATION STATUS UPDATES"));
  assert.match(updateApp, /res\.ok \? \{\} : \{ isError: true \}/);
  const createProject = mcp.slice(mcp.indexOf("'create_project',"), mcp.indexOf("// ── PROJECT SECTIONS"));
  assert.match(createProject, /res\.ok \? \{\} : \{ isError: true \}/);
});

// ── UI ────────────────────────────────────────────────────────────────────────

const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ProjectColorsProvider } = await import(src("components/project-colors/ProjectColorsProvider.tsx"));
const { ProjectSquare, ProjectTag } = await import(src("components/project-colors/ProjectSquare.tsx"));
const { ProjectColorEditor } = await import(src("components/project-colors/ProjectColorEditor.tsx"));
const { ToastProvider } = await import(src("components/ui/Toast.tsx"));

const catalog = {
  available: true,
  apps: [{ id: "app-b", name: "Baseline", color: null, portfolio_rank: 1 }, { id: "app-f", name: "FamCal", color: "#1E6E55", portfolio_rank: 2 }],
  projects: [{ id: "prj-h", name: "Home", color: null, tags: ["personal"], implementation_id: null, portfolio_rank: 1, stage: "In Progress" }],
};

await test("square: without the provider (or before 069) it is a plain mark; with it, a button that opens the editor", () => {
  const plain = renderToStaticMarkup(h(ProjectSquare, { app: { id: "app-b", name: "Baseline" } }));
  assert.doesNotMatch(plain, /<button/);
  assert.match(plain, /background:light-dark\(#6E4F9C, #AD98F0\)/);
  const live = renderToStaticMarkup(h(ProjectColorsProvider, { initialCatalog: catalog }, h(ProjectSquare, { app: { id: "app-f", name: "FamCal" } })));
  assert.match(live, /<button type="button" aria-label="FamCal colour: edit colours"/);
  assert.match(live, /light-dark\(#1E6E55, #5CC59E\)/, "the stored colour from the layout's list, not the default");
  const off = renderToStaticMarkup(h(ProjectColorsProvider, { initialCatalog: { ...catalog, available: false } }, h(ProjectSquare, { app: { id: "app-f", name: "FamCal" } })));
  assert.doesNotMatch(off, /<button/);
  const inside = renderToStaticMarkup(h(ProjectColorsProvider, { initialCatalog: catalog }, h(ProjectSquare, { app: { id: "app-f", name: "FamCal" }, editable: false })));
  assert.doesNotMatch(inside, /<button/, "never a button inside another button");
});

await test("tag: the colour owner's short name next to the square; a project lane fills its app and tags from the list", () => {
  const tag = renderToStaticMarkup(h(ProjectColorsProvider, { initialCatalog: catalog }, h(ProjectTag, { project: { id: "p9", name: "Personal — Knitting", tags: ["personal"] } })));
  assert.match(tag, />Knitting</);
  const withApp = { ...catalog, projects: [...catalog.projects, { id: "prj-x", name: "Sunday brief", color: null, tags: ["personal"], implementation_id: "app-f", portfolio_rank: 2, stage: "Planned" }] };
  const lane = renderToStaticMarkup(h(ProjectColorsProvider, { initialCatalog: withApp }, h(ProjectSquare, { project: { id: "prj-x", name: "Sunday brief" } })));
  assert.match(lane, /light-dark\(#1E6E55, #5CC59E\)/, "a project with no own colour shows its application's");
});

await test("editor: 12 presets (no marigold), custom hex, both previews, Reset and Done; non-modal panel", () => {
  const html = renderToStaticMarkup(
    h(ToastProvider, null,
      h(ProjectColorEditor, { catalog, focusId: "prj-h", drafts: new Map([["prj-h", "#3B5BA5"]]), setDrafts: () => {}, onCatalog: () => {}, onClose: () => {} }))
  );
  assert.match(html, /role="dialog" aria-modal="false"/);
  assert.match(html, />Project colours</);
  const presetButtons = html.match(/aria-label="[^"]+ #[0-9A-F]{6}"/g) ?? [];
  assert.equal(presetButtons.length, 12);
  assert.doesNotMatch(html, /#F2B230/i, "marigold is never offered");
  assert.match(html, /aria-pressed="true" aria-label="Indigo #3B5BA5"/, "the draft is the chosen preset");
  assert.match(html, />Custom</);
  assert.match(html, />Light</);
  assert.match(html, />Dark</);
  assert.match(html, /was default/, "the row says what it was before the draft");
  assert.match(html, /Reset Home/);
  assert.match(html, />Done</);
  assert.match(html, /1 not saved yet/);
  assert.match(html, /Yellow is kept for/);
  assert.doesNotMatch(html, /Claude|Anthropic/);
});

await test("editor before 069: says colours can't be saved yet", () => {
  const html = renderToStaticMarkup(
    h(ToastProvider, null,
      h(ProjectColorEditor, { catalog: { ...catalog, available: false }, focusId: null, drafts: new Map(), setDrafts: () => {}, onCatalog: () => {}, onClose: () => {} }))
  );
  assert.match(html, /can&#x27;t be saved yet/);
});

await test("account menu: \"Project colours…\" opens the editor (no more placeholder); the layout reads the list and wraps the app", () => {
  const menu = read("src/components/layout/AccountMenu.tsx");
  assert.doesNotMatch(menu, /coming soon/);
  assert.match(menu, /openColourEditor\(\);/);
  const layout = read("src/app/layout.tsx");
  assert.match(layout, /loadProjectColorCatalog\(supabase, user\.id\)/);
  assert.match(layout, /<ProjectColorsProvider initialCatalog=\{colorCatalog\}>/);
});

await test("surfaces: Today cards, week board, waiting strip, Tasks rows, Portfolio, project page and list, Applications draw squares", () => {
  const surfaces = {
    "src/components/today/cards/NowTaskCard.tsx": /<ProjectTag \{\.\.\.squareInputOf\(task\)\}/,
    "src/components/today/cards/BoardTaskCard.tsx": /<ProjectTag \{\.\.\.task\.squareInput\}/,
    "src/components/today/sections/WeekBoard.tsx": /squareInput: squareInputOf\(task\)/,
    "src/components/today/sections/WeekBoard.tsx#waiting": /<ProjectTag \{\.\.\.item\.squareInput\} editable=\{false\}/,
    "src/components/today/sections/WaitingStrip.tsx": /<ProjectSquare \{\.\.\.squareInputOf\(task\)\} editable=\{false\}/,
    "src/components/tasks/TaskGrid.tsx": /<ProjectTag \{\.\.\.squareInputOf\(task\)\}/,
    "src/components/portfolio/PortfolioPage.tsx": /<LaneSquare app=\{app\} \/>/,
    "src/components/portfolio/PortfolioTasks.tsx": /<TaskSquare task=\{task\} \/>/,
    "src/lib/portfolio.ts": /appId: task\.implementation_id,\n\s+projectId: task\.project_id,/,
    "src/components/projects/ProjectDetail.tsx": /<ProjectSquare\s+size="md"/,
    "src/components/projects/ProjectTable.tsx": /<ProjectSquare/,
    "src/components/projects/ProjectCard.tsx": /<ProjectSquare/,
    "src/app/applications/page.tsx": /<ProjectSquare app=\{\{ id: implementation\.id/,
    "src/components/implementations/ImplementationDetail.tsx": /<ProjectSquare size="md"/,
    "src/components/implementations/ImplementationCard.tsx": /<ProjectSquare/,
  };
  for (const [file, pattern] of Object.entries(surfaces)) assert.match(read(file.split("#")[0]), pattern, file);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
