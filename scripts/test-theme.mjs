#!/usr/bin/env node
// Redesign S1: the look and the shell. Offline by default.
// Run: npm run test:theme
//
// What it pins:
//   1. The baseline_theme cookie rules (lib/theme.ts): System default, Light, Dark.
//   2. No flash: the root layout writes the cookie's choice on <html> on the
//      server, globals.css lets only data-theme pick `color-scheme`, every
//      colour token is light-dark(), and nothing else in src sets color-scheme
//      or reads prefers-color-scheme (which would fight the choice).
//   3. Light mode can read every raw palette shade 100-400 the app uses.
//   4. Shell rules: top-bar links, the g-shortcuts, scope switch, 16px fields
//      and 44px buttons on touch screens, manifest + icons.
// With THEME_TEST_BASE_URL (a running local server) it also fetches /login with
// each cookie and checks the server-rendered <html data-theme> and theme-color.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(process.env.THEME_TEST_ROOT || process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${String(error?.message ?? error).split("\n").join("\n     ")}`);
  }
}

async function load(rel) {
  return import(pathToFileURL(path.join(root, rel)).href);
}

function walk(dir, filter, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}
const srcFiles = (re) => walk(path.join(root, "src"), (name) => re.test(name));

/** The `:root { ... }` block at the top of globals.css (up to its closing brace at column 0). */
function rootBlock(css) {
  const start = css.indexOf(":root {");
  assert.ok(start >= 0, "globals.css has no :root block");
  const end = css.indexOf("\n}\n", start);
  return css.slice(start, end);
}

// ── 1. cookie rules ──────────────────────────────────────────────────────

await test("theme: System is the default, Light/Dark are kept, anything else falls back to System", async () => {
  const theme = await load("src/lib/theme.ts");
  assert.equal(theme.THEME_COOKIE, "baseline_theme");
  assert.deepEqual([...theme.THEME_PREFERENCES], ["system", "light", "dark"]);
  for (const [input, expected] of [
    [undefined, "system"],
    [null, "system"],
    ["", "system"],
    ["system", "system"],
    ["light", "light"],
    ["dark", "dark"],
    [" Dark ", "dark"],
    ["LIGHT", "light"],
    ["sepia", "system"],
    ["dark;path=/", "system"],
    [42, "system"],
  ]) {
    assert.equal(theme.parseThemePreference(input), expected, `parse(${JSON.stringify(input)})`);
  }
});

await test("theme: <html> always carries data-theme; the cookie is a year, path=/, SameSite=Lax", async () => {
  const theme = await load("src/lib/theme.ts");
  for (const pref of ["system", "light", "dark"]) {
    assert.deepEqual(theme.themeHtmlAttributes(pref), { "data-theme": pref });
    const cookie = theme.themeCookieString(pref);
    assert.match(cookie, new RegExp(`^baseline_theme=${pref};`));
    assert.match(cookie, /path=\//);
    assert.match(cookie, /max-age=31536000/);
    assert.match(cookie, /samesite=lax/i);
    assert.doesNotMatch(cookie, /domain=/i, "cookie stays on this host");
  }
});

await test("theme: the browser bar colour follows the choice (System gives one per OS scheme)", async () => {
  const theme = await load("src/lib/theme.ts");
  assert.deepEqual(theme.themeColorMeta("light"), [{ color: "#3f4920" }]);
  assert.deepEqual(theme.themeColorMeta("dark"), [{ color: "#2a3118" }]);
  assert.deepEqual(theme.themeColorMeta("system").map((m) => m.media), [
    "(prefers-color-scheme: light)",
    "(prefers-color-scheme: dark)",
  ]);
});

await test("theme: the menu line says what System is following, without naming a device brand", async () => {
  const theme = await load("src/lib/theme.ts");
  assert.match(theme.themeChoiceNote("system", true), /Dark right now/);
  assert.match(theme.themeChoiceNote("system", false), /Light right now/);
  assert.match(theme.themeChoiceNote("system", null), /Following this device/);
  assert.match(theme.themeChoiceNote("light", true), /Always light/);
  assert.match(theme.themeChoiceNote("dark", false), /Always dark/);
  for (const pref of ["system", "light", "dark"]) {
    assert.doesNotMatch(theme.themeChoiceNote(pref, true), /mac|iphone|claude|anthropic/i);
  }
});

// ── 2. no flash ──────────────────────────────────────────────────────────

await test("no flash: the root layout reads baseline_theme on the server and writes it on <html>", () => {
  const layout = read("src/app/layout.tsx");
  assert.match(layout, /cookies\(\)/, "layout must read cookies() on the server");
  assert.match(layout, /THEME_COOKIE/, "layout must read the theme cookie");
  assert.match(layout, /<html[\s\S]{0,120}\{\.\.\.themeHtmlAttributes\(theme\)\}/, "<html> must spread themeHtmlAttributes(theme)");
  assert.match(layout, /generateViewport/, "theme-color must come from the same cookie");
  assert.doesNotMatch(layout, /"use client"|localStorage/, "the choice must never come from client storage");
});

await test("no flash: only data-theme decides color-scheme (System = light dark, Light = light, Dark = dark)", () => {
  const css = read("src/app/globals.css");
  const block = rootBlock(css);
  assert.match(block, /color-scheme:\s*light dark;/);
  assert.match(css, /:root\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;\s*\}/);
  assert.match(css, /:root\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark;\s*\}/);
  const schemeLines = css.split("\n").filter((line) => /color-scheme\s*:/.test(line) && !line.trim().startsWith("*") && !line.trim().startsWith("/*"));
  assert.equal(schemeLines.length, 3, `globals.css sets color-scheme only in the three theme rules, got:\n${schemeLines.join("\n")}`);
});

await test("no flash: no other stylesheet or component sets color-scheme or reads prefers-color-scheme", () => {
  const offenders = [];
  for (const file of srcFiles(/\.(css|tsx|ts)$/)) {
    const rel = path.relative(root, file);
    if (rel === path.join("src", "app", "globals.css")) continue;
    if (rel === path.join("src", "lib", "theme.ts")) continue; // theme-color media strings
    if (rel === path.join("src", "components", "layout", "AccountMenu.tsx")) continue; // matchMedia for the menu's live line only
    if (rel === path.join("src", "lib", "briefing", "render.ts")) continue; // the n8n email HTML, not a page
    const text = fs.readFileSync(file, "utf8");
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (/color-scheme\s*:/.test(code) || /prefers-color-scheme/.test(code)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], "these files would cut a page off from the System/Light/Dark choice");
});

await test("no flash: every colour token at :root is light-dark() or deliberately theme-independent", () => {
  const block = rootBlock(read("src/app/globals.css"));
  const declarations = [...block.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)];
  assert.ok(declarations.length > 80, "expected the full token set");
  const SAME_IN_BOTH = new Set(["--hi", "--bar-rule", "--chart-1", "--chart-1-wash", "--chart-2", "--chart-3"]);
  const bad = [];
  for (const [, name, value] of declarations) {
    if (/^var\(--[a-z0-9-]+\)$/.test(value.trim())) continue; // alias of another token
    if (/^light-dark\(/.test(value.trim())) continue;
    if (SAME_IN_BOTH.has(name)) continue;
    bad.push(`${name}: ${value}`);
  }
  assert.deepEqual(bad, [], "a raw colour here would look the same in light and dark");
});

await test("no flash: O2 Olive accents and Night olive values match NOTES.md D3", () => {
  const block = rootBlock(read("src/app/globals.css"));
  const pairs = {
    "--paper": ["#e4e5e0", "#171a10"],
    "--sheet": ["#f8f8f5", "#21261a"],
    "--ink": ["#2f3520", "#eceadf"],
    "--ink-2": ["#575d47", "#bdbdaa"],
    "--brand": ["#4e5a27", "#a9bc6a"],
    "--brand-ink": ["#f4f5ea", "#171a10"],
    "--bar": ["#3f4920", "#2a3118"],
    "--bar-2": ["#353e1a", "#222814"],
    "--danger": ["#b2382a", "#f28470"],
    "--success": ["#4f6b22", "#8db85a"],
    "--warning": ["#8f5e00", "#e3986a"],
  };
  for (const [name, [light, dark]] of Object.entries(pairs)) {
    const match = block.match(new RegExp(`^\\s*${name}:\\s*light-dark\\(([^,]+),\\s*([^)]+)\\);`, "m"));
    assert.ok(match, `${name} missing`);
    assert.equal(match[1].trim().toLowerCase(), light, `${name} light`);
    assert.equal(match[2].trim().toLowerCase(), dark, `${name} dark`);
  }
  assert.match(block, /--hi:\s*#f2b230;/, "marigold 'needs you'");
});

await test("no flash: the v5 brief/Portfolio/record CSS reads the app tokens (one look)", () => {
  const brief = read("src/components/briefs/brief-page.css");
  assert.match(brief, /--surface:\s*var\(--sheet\)/);
  assert.match(brief, /--muted:\s*var\(--muted-foreground\)/);
  assert.match(brief, /--solid-bg:\s*var\(--accent\)/);
  assert.match(brief, /--sans:\s*var\(--font-plex-sans\)/);
  assert.match(brief, /--mono:\s*var\(--font-plex-mono\)/);
  assert.doesNotMatch(brief, /--font-geist/, "Geist is gone");
  for (const rel of ["src/components/briefs/brief-page.css", "src/components/portfolio/portfolio.css", "src/components/projects/pace/pace-section.css"]) {
    const css = read(rel);
    assert.doesNotMatch(css, /font-size:\s*(9|9\.5|10|10\.5|11|11\.5)px/, `${rel}: text under 12px`);
    assert.doesNotMatch(css, /rgba\((225, 29, 72|91, 108, 255|139, 92, 246)/, `${rel}: old crimson/indigo/violet literal`);
  }
  assert.ok(!exists("src/components/briefs/fonts.ts"), "the Geist font module is removed");
});

await test("fonts: Plex is self-hosted (next/font/local), so a build never fetches Google Fonts", async () => {
  // 11/6: Vercel's build failed in next/font/google because Google answered with
  // /l/font?kit=…&skey=… URLs Turbopack could not parse. The files now live in the repo.
  const { createHash } = await import("node:crypto");
  const layout = read("src/app/layout.tsx");
  assert.match(layout, /from "next\/font\/local"/, "layout must load Plex with next/font/local");
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(`${dir}/${d.name}`) : [`${dir}/${d.name}`]));
  const google = walk("src").filter((rel) => /\.(tsx?|jsx?|mjs|css)$/.test(rel) && /next\/font\/google|fonts\.(googleapis|gstatic)\.com/.test(read(rel)));
  assert.deepEqual(google, [], "nothing in src may load fonts from Google");
  const pinned = {
    "IBMPlexSans-Variable-latin.woff2": "056e4e2459f57a0033c8c9c844ff19d6e42ac8602027803d4345823bcc939818",
    "IBMPlexSansCondensed-Regular-latin.woff2": "9427f9b040d9de071b50641d90d1ac4ce5d2a09a39f210652a57b7e7c7c47f49",
    "IBMPlexSansCondensed-Medium-latin.woff2": "98ee889126fecbce6d97f156ad4fbff1806be7bcc8afa4c688848738ec121d0a",
    "IBMPlexSansCondensed-SemiBold-latin.woff2": "63e486a9c9ec9fb7459a4239d1e538c87239a261b26444ca8ae8017f52c5e282",
    "IBMPlexSansCondensed-Bold-latin.woff2": "308af9f2ec9f6477d59b588b6c01fab214775b65bcf9ba2c1122149308dad9b4",
    "IBMPlexMono-Regular-latin.woff2": "c36f509c0a8f9f85f29cb44bc8701d8a9e0b14c499e77a884f789ead7093a7ac",
    "IBMPlexMono-Medium-latin.woff2": "a76f53ca6612e7b3828eec2311098675b7f9849ae4169a8bcef6302aec02a6c0",
    "IBMPlexMono-SemiBold-latin.woff2": "ad4580d8cb4b5f627c2d18457656732f7f7b070f7837fbc380e08054157e6f6c",
  };
  const used = [...layout.matchAll(/path:\s*"\.\.\/fonts\/plex\/([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].sort(), Object.keys(pinned).sort(), "layout must use exactly the eight committed files");
  for (const [file, sha] of Object.entries(pinned)) {
    const bytes = fs.readFileSync(path.join(root, "src/fonts/plex", file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha, `${file} changed`);
  }
  assert.match(read("src/fonts/plex/OFL.txt"), /SIL OPEN FONT LICENSE Version 1\.1/, "the OFL licence sits beside the files");
  for (const [variable, weights] of [["--font-plex-sans", ["400", "500", "600"]], ["--font-plex-cond", ["400", "500", "600", "700"]], ["--font-plex-mono", ["400", "500", "600"]]]) {
    const call = layout.slice(0, layout.indexOf(`variable: "${variable}"`));
    const block = call.slice(call.lastIndexOf("localFont({"));
    assert.deepEqual([...block.matchAll(/weight:\s*"(\d+)"/g)].map((m) => m[1]), weights, `${variable} weights`);
    assert.match(layout.slice(layout.indexOf(`variable: "${variable}"`)), /^variable: "[^"]+",\s*display: "swap",/, `${variable} keeps display swap`);
  }
});

// ── 3. light mode can read the old palette ───────────────────────────────

await test("palette: every 100-400 shade used in src reads as a darker shade in light", () => {
  const css = read("src/app/globals.css");
  const remapped = new Set([...css.matchAll(/--color-([a-z]+-[1-4]00):\s*light-dark\(/g)].map((m) => m[1]));
  const used = new Set();
  const re = /\b(?:text|bg|border|ring|fill|stroke|divide|outline|decoration|placeholder|from|via|to)-((?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[1-4]00)\b/g;
  for (const file of srcFiles(/\.(tsx|ts)$/)) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(re)) used.add(m[1]);
  }
  assert.ok(used.size > 0, "scan found nothing; the regexp is broken");
  const missing = [...used].filter((shade) => !remapped.has(shade)).sort();
  assert.deepEqual(missing, [], "add these to the light-mode remap in globals.css");
});

await test("palette: no dark: variant (it follows the OS, not the account menu)", () => {
  const offenders = srcFiles(/\.tsx$/).filter((file) => /["'`\s]dark:[a-z]/.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(offenders.map((f) => path.relative(root, f)), []);
});

await test("accent: text on the olive fill uses text-on-accent, never text-white (white on Night olive is 2:1)", () => {
  const offenders = [];
  for (const file of srcFiles(/\.tsx$/)) {
    const rel = path.relative(root, file);
    for (const [i, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
      if (/\bbg-accent\b/.test(line) && /\btext-white\b/.test(line)) offenders.push(`${rel}:${i + 1}`);
    }
  }
  assert.deepEqual(offenders, []);
});

await test("links: no unlayered `a { color }` rule (it beat every text-* utility on a Link)", () => {
  const css = read("src/app/globals.css");
  const unlayered = css.replace(/@layer[^{]*\{[\s\S]*?\n\}/g, "");
  assert.doesNotMatch(unlayered, /(^|\n)\s*a\s*\{[^}]*color/, "move it into @layer base");
});

// ── 4. shell ─────────────────────────────────────────────────────────────

const CUT_PAGES = ["/focus", "/planner", "/llm", "/stakeholders", "/weekly-review", "/sprints"];

await test("shell: top bar is Today · Tasks · Portfolio · Launch, More holds Applications · Projects · Calendar", async () => {
  const nav = read("src/components/layout/nav-items.tsx");
  const primary = nav.slice(nav.indexOf("export const PRIMARY_NAV"), nav.indexOf("export const MORE_NAV"));
  const more = nav.slice(nav.indexOf("export const MORE_NAV"), nav.indexOf("export const MORE_ICON"));
  const hrefs = (text) => [...text.matchAll(/href: "([^"]+)",\s+label: "([^"]+)"/g)].map((m) => `${m[2]} ${m[1]}`);
  assert.deepEqual(hrefs(primary), ["Today /", "Tasks /backlog", "Portfolio /portfolio", "Launch /launch"]);
  assert.deepEqual(hrefs(more), ["Applications /applications", "Projects /projects", "Calendar /calendar"]);
  for (const cut of CUT_PAGES) assert.ok(!nav.includes(`"${cut}"`), `nav links ${cut}, which S0 removes`);
});

await test("shell: g-shortcuts only go to top-bar or More pages; no `[` sidebar key", () => {
  const dialog = read("src/components/layout/ShortcutsDialog.tsx");
  const keys = [...dialog.matchAll(/^\s+([a-z]): "([^"]+)",$/gm)].map((m) => m[2]);
  assert.deepEqual(keys, ["/", "/backlog", "/portfolio", "/launch", "/applications", "/projects", "/calendar"]);
  assert.doesNotMatch(dialog, /sidebar/i);
  const bar = read("src/components/layout/TopBar.tsx");
  assert.doesNotMatch(bar, /event\.key === "\["/, "`[` is free for S3's panel width");
  assert.ok(!exists("src/components/layout/Sidebar.tsx"), "the old sidebar is gone");
});

await test("shell: the brief button's phone/desktop visibility lives on wrappers, not on the primitive", () => {
  const bar = read("src/components/layout/TopBar.tsx");
  for (const m of bar.matchAll(/<BriefReadyButton[^>]*>/g)) {
    assert.doesNotMatch(m[0], /className=/, `${m[0]}: a hidden/xl: class here fought the button's own inline-flex, so both showed on a phone`);
  }
});

await test("scope switch: Today uses ?mode (default work), Portfolio ?scope (default personal), Tasks ?scope (default all), other pages have none", async () => {
  const { scopeSwitchFor } = await load("src/lib/scope-switch.ts");
  const today = scopeSwitchFor("/", "");
  assert.equal(today.current, "work");
  assert.deepEqual(today.options.map((o) => o.href), ["/", "/?mode=personal", "/?mode=all"]);
  assert.deepEqual(today.options.map((o) => o.active), [true, false, false]);
  const personal = scopeSwitchFor("/", "mode=personal&week=2026-11-02");
  assert.equal(personal.current, "personal");
  assert.deepEqual(personal.options.map((o) => o.href), ["/?week=2026-11-02", "/?week=2026-11-02&mode=personal", "/?week=2026-11-02&mode=all"]);
  const portfolio = scopeSwitchFor("/portfolio", "scope=work");
  assert.equal(portfolio.current, "work");
  assert.deepEqual(portfolio.options.map((o) => o.href), ["/portfolio?scope=work", "/portfolio", "/portfolio?scope=all"]);
  assert.equal(scopeSwitchFor("/portfolio", "scope=bogus").current, "personal");
  // Redesign S5: Tasks has a scope too (?scope, default all).
  const tasks = scopeSwitchFor("/backlog", "owner=me");
  assert.equal(tasks.current, "all");
  assert.deepEqual(tasks.options.map((o) => o.href), ["/backlog?owner=me&scope=work", "/backlog?owner=me&scope=personal", "/backlog?owner=me"]);
  for (const other of ["/launch", "/projects", "/briefs/AM-1105", "/r/task/x"]) {
    assert.equal(scopeSwitchFor(other, ""), null, other);
  }
});

await test("touch: 16px fields and 44px buttons on a coarse pointer", () => {
  const css = read("src/app/globals.css");
  assert.match(css, /@media \(pointer: coarse\) \{\s*input:not\(\[type="checkbox"\]\)[\s\S]*?select,\s*textarea \{\s*font-size: 16px;/);
  assert.match(read("src/components/ui/Button.tsx"), /pointer-coarse:min-h-11/);
  assert.match(read("src/components/ui/Button.tsx"), /icon: "[^"]*pointer-coarse:min-w-11/);
  assert.match(read("src/components/ui/Field.tsx"), /pointer-coarse:min-h-11/);
  const brief = read("src/components/briefs/brief-page.css");
  assert.match(brief, /@media \(pointer: coarse\) \{[\s\S]*\.brief-page \.btn\.sm[\s\S]*min-height: 44px/);
  assert.match(brief, /\.brief-page textarea \{\s*font-size: 16px/);
});

function pngSize(rel) {
  const buf = fs.readFileSync(path.join(root, rel));
  assert.equal(buf.toString("ascii", 1, 4), "PNG", `${rel} is not a PNG`);
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

await test("home screen: manifest opens Today standalone with 192/512 icons and an apple-touch icon", async () => {
  const { default: manifest } = await load("src/app/manifest.ts");
  const m = manifest();
  assert.equal(m.name, "Baseline");
  assert.equal(m.start_url, "/");
  assert.equal(m.display, "standalone");
  assert.equal(m.theme_color, "#3f4920");
  for (const icon of m.icons) {
    if (icon.type !== "image/png") continue;
    const [w, h] = pngSize(path.join("public", icon.src));
    assert.equal(`${w}x${h}`, icon.sizes, icon.src);
  }
  assert.ok(m.icons.some((i) => i.purpose === "maskable"), "a maskable icon for Android");
  assert.deepEqual(pngSize("src/app/apple-icon.png"), [180, 180]);
  assert.ok(exists("src/app/icon.svg"));
  assert.doesNotMatch(JSON.stringify(m), /claude|anthropic/i);
});

await test("copy: the new shell never names the AI product", () => {
  for (const rel of ["src/components/layout/TopBar.tsx", "src/components/layout/AccountMenu.tsx", "src/components/layout/nav-items.tsx", "src/lib/theme.ts", "src/app/manifest.ts"]) {
    assert.doesNotMatch(read(rel), /claude|anthropic/i, rel);
  }
});

// ── 5. optional: the real server's first paint ───────────────────────────

const base = process.env.THEME_TEST_BASE_URL;
if (base) {
  const host = new URL(base).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("THEME_TEST_BASE_URL must be a local server");
  for (const [cookie, expected, colors] of [
    [null, "system", ["#3f4920", "#2a3118"]],
    ["system", "system", ["#3f4920", "#2a3118"]],
    ["light", "light", ["#3f4920"]],
    ["dark", "dark", ["#2a3118"]],
    ["junk", "system", ["#3f4920", "#2a3118"]],
  ]) {
    await test(`server render: cookie ${cookie ?? "(none)"} -> <html data-theme="${expected}"> in the first byte of HTML`, async () => {
      const response = await fetch(new URL("/login", base), { headers: cookie ? { cookie: `baseline_theme=${cookie}` } : {}, redirect: "manual" });
      assert.equal(response.status, 200);
      const html = await response.text();
      const tag = html.match(/<html[^>]*>/)?.[0] ?? "";
      assert.match(tag, new RegExp(`data-theme="${expected}"`), tag);
      const metas = [...html.matchAll(/<meta name="theme-color"[^>]*content="([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(metas, colors);
      assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
    });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
