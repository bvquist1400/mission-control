#!/usr/bin/env node
// Redesign S1 fix round 1: keyboard, touch and focus rules for the top bar and
// account menu. Offline. Run: npm run test:shell-a11y
//
// Pins (each was a Codex review finding on S1):
//   1. The tab bar's More sheet: focus moves in on open and back to the trigger
//      on close/Escape; the trigger carries aria-expanded + aria-controls; the
//      sheet is labelled and comes AFTER the trigger in the DOM (Tab order).
//   2. Every 34px control in the shell grows to 44px on a coarse pointer.
//   3. A bar-specific focus ring that reads >= 3:1 on the bar in BOTH themes,
//      while the page ring and the paper drop-down panels keep the page ring.
//   4. Choosing a theme in the menu updates the theme-color meta tags.
//   5. Appearance is a real radio group (arrows, roving tabindex).
// The browser-level proof (real Tab/Enter/Escape/arrow keys, emulated touch) is
// in the handoff; this file holds what can be checked without a browser.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(process.env.THEME_TEST_ROOT || process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

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
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

const topBar = read("src/components/layout/TopBar.tsx");
const accountMenu = read("src/components/layout/AccountMenu.tsx");
const css = read("src/app/globals.css");

/** Source of one top-level function in a TSX file. */
function fn(source, name) {
  const start = source.search(new RegExp(`function ${name}\\b`));
  assert.ok(start >= 0, `no function ${name}`);
  const next = source.slice(start + 10).search(/\n(?:\/\*\*|function |export function )/);
  return next < 0 ? source.slice(start) : source.slice(start, start + 10 + next);
}

// ── 1. More sheet ────────────────────────────────────────────────────────

await test("More sheet: trigger has a ref, aria-expanded and aria-controls tied to the sheet id", () => {
  const tabBar = fn(topBar, "TabBar");
  assert.match(tabBar, /const moreButtonRef = useRef<HTMLButtonElement>\(null\)/);
  assert.match(tabBar, /ref=\{moreButtonRef\}/);
  assert.match(tabBar, /aria-expanded=\{moreOpen\}/);
  assert.match(tabBar, /aria-controls=\{moreOpen \? sheetId : undefined\}/);
  assert.match(tabBar, /id=\{sheetId\}/);
});

await test("More sheet: the sheet is labelled", () => {
  const tabBar = fn(topBar, "TabBar");
  assert.match(tabBar, /aria-labelledby=\{`\$\{sheetId\}-title`\}/);
  assert.match(tabBar, /id=\{`\$\{sheetId\}-title`\}/);
});

await test("More sheet: opening moves focus into the sheet; closing (Escape, toggle, link) returns it to the trigger", () => {
  const tabBar = fn(topBar, "TabBar");
  assert.match(tabBar, /useEffect\(\(\) => \{\s*if \(moreOpen\) sheetRef\.current\?\.querySelector<HTMLElement>\("a"\)\?\.focus\(\);\s*\}, \[moreOpen\]\)/);
  assert.match(tabBar, /const close = useCallback\(\(returnFocus: boolean\) => \{\s*setMoreOpen\(false\);\s*if \(returnFocus\) moreButtonRef\.current\?\.focus\(\);/);
  assert.match(tabBar, /useDismiss\(moreOpen, ref, close\)/, "Escape goes through useDismiss, which passes returnFocus=true");
  assert.match(tabBar, /onNavigate=\{\(\) => close\(true\)\}/);
  // useDismiss itself: Escape asks for focus to return; an outside press does not steal it.
  assert.match(topBar, /event\.key === "Escape"\) \{\s*event\.stopPropagation\(\);\s*onClose\(true\)/);
  assert.match(topBar, /contains\(event\.target as Node\)\) onClose\(false\)/);
});

await test("More sheet: the sheet follows the tabs in the DOM, so Tab from More reaches its links", () => {
  const tabBar = fn(topBar, "TabBar");
  assert.ok(tabBar.indexOf('aria-label="Main tabs"') < tabBar.indexOf("id={sheetId}"), "sheet must come after the tab nav");
});

await test("More menus are disclosures, not ARIA menus: no aria-haspopup=true on a trigger whose content is links", () => {
  assert.doesNotMatch(topBar, /aria-haspopup/);
  assert.match(fn(topBar, "MoreMenu"), /role="group"\s+aria-label="More pages"/);
});

await test("account menu: Keyboard shortcuts hands focus to the account button before the dialog opens (so the dialog can return it)", () => {
  assert.match(accountMenu, /close\(true\);\s*onOpenShortcuts\(\);/);
});

await test("account button: aria-haspopup=dialog, and the panel it controls is a labelled dialog", () => {
  assert.match(accountMenu, /aria-haspopup="dialog"/);
  assert.doesNotMatch(accountMenu, /aria-haspopup="true"/);
  assert.match(accountMenu, /role="dialog"\s+aria-label="Account"/);
});

// ── 2. 44px on coarse pointers ───────────────────────────────────────────

await test("touch: every fixed 34px control in the shell has a coarse-pointer size", () => {
  const files = { "TopBar.tsx": topBar, "AccountMenu.tsx": accountMenu, "BriefReadyButton.tsx": read("src/components/layout/BriefReadyButton.tsx") };
  const offenders = [];
  for (const [name, source] of Object.entries(files)) {
    for (const [i, line] of source.split("\n").entries()) {
      if (/(?<![-\w:])(?:h|w)-\[34px\]/.test(line) && !/pointer-coarse:(?:min-h|h)-11/.test(line)) offenders.push(`${name}:${i + 1} ${line.trim().slice(0, 80)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

await test("touch: Work/Personal/All in the bar and the wide Search button grow to 44px, the scope links stretch", () => {
  const bar = fn(topBar, "ScopeSwitch").split('placement === "row"')[1];
  const barNav = bar.slice(bar.indexOf('<nav aria-label={view.label} className="flex min-h-[34px]'));
  assert.match(barNav, /<nav aria-label=\{view\.label\} className="flex min-h-\[34px\] border/, "a min-height (not a fixed h-[34px]) so the nav can grow");
  assert.match(barNav, /className=\{`flex items-center border-r border-bar-rule[^`]*pointer-coarse:min-h-11/, "links carry the 44px and stretch with the nav");
  const wide = topBar.slice(topBar.indexOf('className="hidden h-[34px] w-44'));
  assert.match(wide.slice(0, 260), /pointer-coarse:min-h-11/);
});

// ── 3. focus ring on the bar ─────────────────────────────────────────────

function tokenValue(name, theme) {
  const m = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  assert.ok(m, `--${name} is not defined in globals.css`);
  const value = m[1].trim();
  const pair = value.match(/^light-dark\(\s*([^,]+),\s*([^)]+)\)$/);
  if (pair) return (theme === "light" ? pair[1] : pair[2]).trim();
  const ref = value.match(/^var\(--([\w-]+)\)$/);
  if (ref) return tokenValue(ref[1], theme);
  return value;
}
function lum(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `expected a hex colour, got ${hex}`);
  const f = (i) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(0) + 0.7152 * f(1) + 0.0722 * f(2);
}
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

await test("focus: a bar focus token exists and reads >= 3:1 on the bar in light AND dark", () => {
  for (const theme of ["light", "dark"]) {
    const ratio = contrast(tokenValue("bar-focus", theme), tokenValue("bar", theme));
    assert.ok(ratio >= 3, `${theme}: bar focus ring is ${ratio.toFixed(2)}:1 on the bar`);
  }
});

await test("focus: the bar uses it; drop-down panels (paper) and the rest of the page keep the page ring", () => {
  assert.match(css, /:focus-visible \{\s*outline: 2px solid var\(--focus-ring, var\(--accent-text\)\);\s*outline-offset: 2px;/);
  assert.match(css, /\.bar-surface \{\s*--focus-ring: var\(--bar-focus\);/);
  assert.match(css, /\.bar-surface \.bar-panel \{\s*--focus-ring: var\(--accent-text\);/);
  assert.match(topBar, /<header className="bar-surface /);
  assert.equal((topBar.match(/className="bar-panel /g) ?? []).length, 1, "the More drop-down is a bar-panel");
  assert.match(accountMenu, /className="bar-panel /, "the account panel is a bar-panel");
  // The page ring on paper is unchanged and still readable (>= 3:1).
  for (const theme of ["light", "dark"]) {
    const ratio = contrast(tokenValue("accent-text", theme), tokenValue("paper", theme));
    assert.ok(ratio >= 3, `${theme}: page focus ring ${ratio.toFixed(2)}:1 on paper`);
  }
});

// ── 4. theme-color follows the menu ──────────────────────────────────────

function fakeDocument(initial) {
  const metas = initial.map((m) => ({ attrs: { name: "theme-color", ...m } }));
  const make = (entry) => ({
    ...entry,
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    getAttribute(k) { return this.attrs[k] ?? null; },
  });
  const nodes = metas.map(make);
  return {
    nodes,
    querySelectorAll: (sel) => (sel === 'meta[name="theme-color"]' ? nodes.filter((n) => n.attrs.name === "theme-color") : []),
    createElement: (tag) => { assert.equal(tag, "meta"); return make({ attrs: {} }); },
    head: { appendChild: (n) => nodes.push(n) },
    effective: () => nodes.filter((n) => n.attrs.media !== "not all").map((n) => ({ color: n.attrs.content, media: n.attrs.media })),
  };
}

await test("theme-color: applying a preference rewrites the tags (Light/Dark: one unconditional; System: two media entries)", async () => {
  const { applyThemeColorMeta, themeColorMeta } = await load("src/lib/theme.ts");
  // The server rendered System: two tags.
  const doc = fakeDocument(themeColorMeta("system").map((e) => ({ content: e.color, media: e.media })));
  for (const preference of ["light", "dark", "system", "dark", "light", "system"]) {
    applyThemeColorMeta(doc, preference);
    assert.deepEqual(doc.effective(), themeColorMeta(preference).map((e) => ({ color: e.color, media: e.media })), preference);
  }
  // The server rendered Light: one tag, then System needs a second one.
  const one = fakeDocument([{ content: "#3f4920" }]);
  applyThemeColorMeta(one, "system");
  assert.deepEqual(one.effective(), themeColorMeta("system").map((e) => ({ color: e.color, media: e.media })));
  assert.equal(one.nodes.length, 2);
  // Server-rendered tags are never removed (React owns them).
  assert.equal(doc.nodes.length, 2);
});

await test("theme-color: the account menu's apply function calls it", () => {
  assert.match(accountMenu, /export function applyThemePreference[\s\S]*applyThemeColorMeta\(document, preference\);/);
});

// ── 5. Appearance radio group ────────────────────────────────────────────

await test("radios: arrows move (wrapping), Home/End jump, other keys are ignored", async () => {
  const { themeForRadioKey } = await load("src/lib/theme.ts");
  assert.equal(themeForRadioKey("system", "ArrowRight"), "light");
  assert.equal(themeForRadioKey("light", "ArrowDown"), "dark");
  assert.equal(themeForRadioKey("dark", "ArrowRight"), "system");
  assert.equal(themeForRadioKey("system", "ArrowLeft"), "dark");
  assert.equal(themeForRadioKey("light", "ArrowUp"), "system");
  assert.equal(themeForRadioKey("light", "Home"), "system");
  assert.equal(themeForRadioKey("light", "End"), "dark");
  for (const key of ["Tab", "Enter", " ", "a", "Escape"]) assert.equal(themeForRadioKey("light", key), null, key);
  assert.equal(themeForRadioKey("sepia", "ArrowRight"), null);
});

await test("radios: roving tabindex, the key handler selects and focuses, the menu opens onto the chosen radio", () => {
  assert.match(accountMenu, /tabIndex=\{selected \? 0 : -1\}/);
  assert.match(accountMenu, /data-value=\{value\}/);
  assert.match(accountMenu, /onKeyDown=\{handleRadioKeyDown\}/);
  const handler = fn(accountMenu, "handleRadioKeyDown");
  assert.match(handler, /themeForRadioKey\(from, event\.key\)/);
  assert.match(handler, /event\.preventDefault\(\);\s*choose\(next\);/);
  assert.match(handler, /\.focus\(\)/);
  assert.match(accountMenu, /\[role="radio"\]\[aria-checked="true"\]'\)\?\.focus\(\)/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
