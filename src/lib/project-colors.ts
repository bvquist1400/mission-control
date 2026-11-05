/**
 * Project colours (redesign S2, migration 069; spec NOTES.md D2 "Editable project
 * colours" + D3 project colours).
 *
 * Pure and browser-safe: the API, the MCP tools (through the API), the colour
 * editor and every project square use these rules, so there is one definition of
 * a valid colour, of the defaults and of how a colour is shown in each theme.
 *
 * - Stored: `implementations.color` / `projects.color`, "#RRGGBB" or NULL.
 *   NULL = the theme default for that slot.
 * - A square for a task / project shows: the project's own colour, else its
 *   application's colour, else the default (by name, see `slotForName`).
 * - Marigold (`NEEDS_YOU_COLOR`) means "needs you" only: yellow and gold are
 *   never a project colour (`isNeedsYouHue`). A stored value that breaks a rule
 *   (hand-written SQL) is ignored and the default is shown instead.
 * - Light theme shows the stored colour as is (it must reach 3:1 on the light
 *   paper to be saved). Dark theme shows the preset's designed dark pair when the
 *   colour is one of the presets, else the colour lightened just enough to reach
 *   3:1 on the dark paper and sheet (`darkVariant`).
 */

export const PROJECT_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/** "Needs you" (brief button, today marker). Never a project colour. */
export const NEEDS_YOU_COLOR = "#F2B230";

/** Minimum contrast of a square against the paper (WCAG 1.4.11, graphical objects). */
export const MIN_SQUARE_CONTRAST = 3;

/** O2 Olive (light) and Night olive (dark) backgrounds a square sits on (globals.css --paper / --sheet). */
export const THEME_BACKGROUNDS = {
  light: { paper: "#E4E5E0", sheet: "#F8F8F5" },
  dark: { paper: "#171A10", sheet: "#21261A" },
} as const;

export type ProjectColorTheme = keyof typeof THEME_BACKGROUNDS;

export interface ColorPair {
  light: string;
  dark: string;
}

export type ProjectColorSlot = "mm" | "famcal" | "baseline" | "ovenlineup" | "home" | "move" | "work";

interface SlotDefinition extends ColorPair {
  slot: ProjectColorSlot;
  label: string;
  /** Matched against a lower-cased name with "&" kept. */
  pattern: RegExp;
}

/** D3 O2 light / Night olive dark defaults, in match order. */
export const PROJECT_COLOR_SLOTS: readonly SlotDefinition[] = [
  { slot: "mm", label: "M&M", light: "#5B6B2C", dark: "#AEBF62", pattern: /\bm\s*&\s*m\b|menu\s*(?:&|and)\s*market|stock\s*(?:&|and)\s*stir|grocery/ },
  { slot: "famcal", label: "FamCal", light: "#3D6C99", dark: "#72A8E2", pattern: /fam\s*cal/ },
  { slot: "baseline", label: "Baseline", light: "#6E4F9C", dark: "#AD98F0", pattern: /baseline|mission\s*control/ },
  { slot: "ovenlineup", label: "OvenLineup", light: "#B1435C", dark: "#EE7FA0", pattern: /oven\s*line\s*-?\s*up/ },
  { slot: "home", label: "Home", light: "#2B8780", dark: "#52C2B6", pattern: /\bhome\b|\bhouse\b/ },
  { slot: "move", label: "Move", light: "#96592A", dark: "#D8A574", pattern: /\bmov(?:e|es|ing)\b/ },
  { slot: "work", label: "Work", light: "#7C7E74", dark: "#A6A897", pattern: /\bwork\b/ },
];

export const WORK_SLOT = PROJECT_COLOR_SLOTS.find((slot) => slot.slot === "work")!;

/** Five more presets (not tied to a named slot) with their dark pairs; also the pool for other personal projects. */
export const EXTRA_PROJECT_COLORS: readonly (ColorPair & { label: string })[] = [
  { label: "Indigo", light: "#3B5BA5", dark: "#8FA6EB" },
  { label: "Plum", light: "#87387A", dark: "#D88BC8" },
  { label: "Pine", light: "#1E6E55", dark: "#5CC59E" },
  { label: "Slate", light: "#4D5B6E", dark: "#A3B1C4" },
  { label: "Wine", light: "#7D2F45", dark: "#E58A9F" },
];

/** The 12 presets offered in the editor: the seven D3 colours, then the five extras. */
export const PROJECT_COLOR_PRESETS: readonly (ColorPair & { label: string })[] = [
  ...PROJECT_COLOR_SLOTS.map(({ label, light, dark }) => ({ label, light, dark })),
  ...EXTRA_PROJECT_COLORS,
];

// ── colour maths ─────────────────────────────────────────────────────────────

export function normalizeHex(value: string): string {
  return value.toUpperCase();
}

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Lowest contrast of a colour against a theme's paper and sheet. */
export function themeContrast(hex: string, theme: ProjectColorTheme): number {
  const { paper, sheet } = THEME_BACKGROUNDS[theme];
  return Math.min(contrastRatio(hex, paper), contrastRatio(hex, sheet));
}

/** Hue 0–360, saturation and lightness 0–1. */
export function toHsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = channels(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function fromHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return toHex([(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255]);
}

/**
 * Yellow, gold and amber (hue 33°–65°, unless nearly grey: saturation under 0.3)
 * read as the "needs you" marigold in one theme or the other, so they are never a
 * project colour. Lightness is not an escape: a dark ochre turns gold once
 * lightened for dark.
 *
 * Both edges are inclusive and tested on the integer channels, not on a floating
 * hue: #8C4D00 is exactly 33° (float maths gives 32.999…) and #0B0C00 exactly 65°
 * (float gives 65.000…01), and both are in the band. With max/min/d the channel
 * maximum, minimum and range (0–255):
 * - hue = 60° × H / d, where H is the usual sextant numerator (an integer), so
 *   33 ≤ hue ≤ 65 ⇔ 33·d ≤ 60·H ≤ 65·d;
 * - saturation = d / (255 − |max + min − 255|), so s ≥ 0.3 ⇔ 10·d ≥ 3·(255 − |max + min − 255|).
 */
export function isNeedsYouHue(hex: string): boolean {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return false;
  if (10 * d < 3 * (255 - Math.abs(max + min - 255))) return false;
  let sextant: number;
  if (max === r) sextant = g - b;
  else if (max === g) sextant = b - r + 2 * d;
  else sextant = r - g + 4 * d;
  if (sextant < 0) sextant += 6 * d;
  return 60 * sextant >= 33 * d && 60 * sextant <= 65 * d;
}

/** A colour a square may show on the dark paper and sheet: 3:1 on both, and not yellow. */
function isSafeDark(hex: string): boolean {
  return PROJECT_COLOR_PATTERN.test(hex) && !isNeedsYouHue(hex) && themeContrast(hex, "dark") >= MIN_SQUARE_CONTRAST;
}

// ── input rules (API, MCP, editor) ───────────────────────────────────────────

export type ProjectColorProblem = "format" | "needs_you" | "contrast";

export const PROJECT_COLOR_PROBLEM_TEXT: Record<ProjectColorProblem, string> = {
  format: 'color must be a hex colour like "#3B5BA5", or null for the default',
  needs_you: "Yellow and gold are kept for \"needs you\", so they can't be a project colour",
  contrast: "That colour is too pale to read on the light background (it needs 3:1); pick a darker one",
};

/** Why a hex can't be a project colour, or null when it can. */
export function projectColorProblem(hex: string): ProjectColorProblem | null {
  if (!PROJECT_COLOR_PATTERN.test(hex)) return "format";
  if (isNeedsYouHue(hex)) return "needs_you";
  if (themeContrast(hex, "light") < MIN_SQUARE_CONTRAST) return "contrast";
  // The colour dark mode will actually paint must follow the same rule. darkVariant
  // never returns yellow, so this only guards against a future change to it.
  if (!isSafeDark(darkVariant(hex))) return "needs_you";
  return null;
}

export type ProjectColorInput =
  | { ok: true; value: string | null }
  | { ok: false; error: string; problem: ProjectColorProblem };

/**
 * The `color` field of a POST/PATCH body. null (or "") clears it; a string must be
 * "#RRGGBB" (any case, stored upper case) and pass `projectColorProblem`.
 */
export function parseProjectColorInput(value: unknown): ProjectColorInput {
  if (value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, error: PROJECT_COLOR_PROBLEM_TEXT.format, problem: "format" };
  }
  const trimmed = value.trim();
  const problem = projectColorProblem(trimmed);
  if (problem) return { ok: false, error: PROJECT_COLOR_PROBLEM_TEXT[problem], problem };
  return { ok: true, value: normalizeHex(trimmed) };
}

/** The database refused a colour (069's CHECK, 23514 on *_color_hex_check). */
export function isProjectColorCheckViolation(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === "23514" && /color_hex_check/.test(error.message ?? "");
}

/** A stored value the app will show, or null (missing, malformed, or one the rules refuse). */
export function usableStoredColor(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return projectColorProblem(value) === null ? normalizeHex(value) : null;
}

// ── display ──────────────────────────────────────────────────────────────────

/** Hue nudges (degrees, away from the yellow band) and saturation scales tried when rounding lands a lightened colour in the band. */
const HUE_NUDGES = [0, 0.5, 1, 1.5, 2, 3, 4, 6] as const;
const SATURATION_SCALES = [1, 0.97, 0.94, 0.9, 0.85] as const;

const darkVariantCache = new Map<string, string>();

function circularDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

/**
 * The colour a stored light-theme value shows as in dark: the preset's own dark
 * pair, else the same hue lightened in 1% steps until it reaches 3:1 on the dark
 * paper and sheet.
 *
 * Every result is checked as the final rounded hex, not as the HSL it came from:
 * it must reach 3:1 on the dark paper and sheet AND stay out of the yellow band.
 * Rounding to whole channels can move a hue by under a degree, so a colour just
 * outside the band (#171902 at 65.2°) can land inside it (#6D7609 at 64.95°).
 * When that happens the same lightness step is retried with the hue nudged away
 * from the band (and, for a greyish colour, a little less saturation); if
 * nothing fits, a neutral grey of the first lightness that reaches 3:1 is shown.
 * So no stored colour can ever paint a yellow square in dark.
 */
export function darkVariant(hex: string): string {
  const upper = normalizeHex(hex);
  const cached = darkVariantCache.get(upper);
  if (cached) return cached;
  const result = computeDarkVariant(upper);
  if (darkVariantCache.size >= 2048) darkVariantCache.clear();
  darkVariantCache.set(upper, result);
  return result;
}

function computeDarkVariant(upper: string): string {
  const preset = PROJECT_COLOR_PRESETS.find((entry) => entry.light === upper);
  if (preset) return preset.dark;
  if (isSafeDark(upper)) return upper;
  const { h, s, l } = toHsl(upper);
  // Away from the band: down from 33°, up from 65° (whichever edge is nearer round the circle).
  const direction = circularDistance(h, 33) <= circularDistance(h, 65) ? -1 : 1;
  const start = Math.round(l * 100) + 1;
  for (let next = start; next <= 100; next += 1) {
    const plain = fromHsl(h, s, next / 100);
    if (themeContrast(plain, "dark") < MIN_SQUARE_CONTRAST) continue;
    if (!isNeedsYouHue(plain)) return plain;
    // Bright enough but rounded into the band: smallest nudge at this lightness.
    for (const scale of SATURATION_SCALES) {
      for (const nudge of HUE_NUDGES) {
        const hue = (((h + direction * nudge) % 360) + 360) % 360;
        const candidate = fromHsl(hue, s * scale, next / 100);
        if (isSafeDark(candidate)) return candidate;
      }
    }
  }
  for (let next = start; next <= 100; next += 1) {
    const grey = fromHsl(0, 0, next / 100);
    if (isSafeDark(grey)) return grey;
  }
  return "#FFFFFF";
}

export function pairForStoredColor(hex: string): ColorPair {
  const upper = normalizeHex(hex);
  return { light: upper, dark: darkVariant(upper) };
}

/**
 * A pair a square may paint: the light colour passes every input rule (shape, not
 * yellow, 3:1 on the light paper) and the dark one is 3:1 on the dark paper and
 * sheet and not yellow. The renderer checks the final pair, not just the stored
 * value, and falls back to the default when it fails.
 */
export function isPaintablePair(pair: ColorPair): boolean {
  return (
    PROJECT_COLOR_PATTERN.test(pair.light) &&
    !isNeedsYouHue(pair.light) &&
    themeContrast(pair.light, "light") >= MIN_SQUARE_CONTRAST &&
    isSafeDark(pair.dark)
  );
}

/** CSS value that follows the page's light/dark choice (S1 sets color-scheme on <html>). */
export function colorPairCss(pair: ColorPair): string {
  return `light-dark(${pair.light}, ${pair.dark})`;
}

export function slotForName(name: string | null | undefined): SlotDefinition | null {
  if (!name) return null;
  const text = name.toLowerCase();
  return PROJECT_COLOR_SLOTS.find((slot) => slot.pattern.test(text)) ?? null;
}

/** FNV-1a: a stable small hash so an unnamed personal project always gets the same extra colour. */
function stableIndex(key: string, size: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % size;
}

export interface ColorEntity {
  id: string;
  name: string;
  color?: string | null;
}

export interface ProjectColorEntity extends ColorEntity {
  tags?: string[] | null;
}

/**
 * Default colour pair when nothing is stored:
 * - an application: its named slot (M&M, FamCal, Baseline, OvenLineup, …), else Work grey
 *   (Brent's personal apps are the named ones; any other app is day-job work);
 * - a project: its named slot, else a fixed pick from the five extras for a
 *   `personal` project (by id, so it never changes), else Work grey.
 */
export function defaultColorPair(kind: "app" | "project", entity: { id: string; name: string; tags?: string[] | null }): ColorPair {
  const slot = slotForName(entity.name);
  if (slot) return { light: slot.light, dark: slot.dark };
  if (kind === "project" && Array.isArray(entity.tags) && entity.tags.includes("personal")) {
    const extra = EXTRA_PROJECT_COLORS[stableIndex(entity.id, EXTRA_PROJECT_COLORS.length)];
    return { light: extra.light, dark: extra.dark };
  }
  return { light: WORK_SLOT.light, dark: WORK_SLOT.dark };
}

export type SquareSource = "project" | "app" | "default";

export interface ResolvedSquare extends ColorPair {
  /** Whose colour it is (the project with its own colour, else the application, else the project): the row a click opens in the editor. */
  owner: { kind: "app" | "project"; id: string; name: string };
  source: SquareSource;
}

/** Colour overrides by id (the editor's live preview and saved values), applied over embedded rows. */
export type ColorOverrides = ReadonlyMap<string, string | null>;

/** The pair a stored (or draft) colour paints, or null when the value or its final pair breaks a rule (the default shows instead). */
function pairOf(entity: ColorEntity, overrides?: ColorOverrides): ColorPair | null {
  const raw = overrides?.has(entity.id) ? overrides.get(entity.id) : entity.color;
  const usable = usableStoredColor(raw ?? null);
  if (!usable) return null;
  const pair = pairForStoredColor(usable);
  return isPaintablePair(pair) ? pair : null;
}

/**
 * The square for something that belongs to an application and/or a project (a
 * task, a project row, an app row). Project colour → app colour → default.
 * Returns null when there is neither (a standalone to-do has no square).
 */
export function resolveSquare(
  input: { app?: ColorEntity | null; project?: ProjectColorEntity | null },
  overrides?: ColorOverrides
): ResolvedSquare | null {
  const { app, project } = input;
  if (project) {
    const own = pairOf(project, overrides);
    if (own) return { ...own, owner: { kind: "project", id: project.id, name: project.name }, source: "project" };
  }
  if (app) {
    // The square belongs to whoever gives it its colour: clicking it opens the application.
    const appPair = pairOf(app, overrides);
    const owner = { kind: "app" as const, id: app.id, name: app.name };
    if (appPair) return { ...appPair, owner, source: "app" };
    return { ...defaultColorPair("app", app), owner, source: "default" };
  }
  if (project) {
    return { ...defaultColorPair("project", project), owner: { kind: "project", id: project.id, name: project.name }, source: "default" };
  }
  return null;
}

// ── editor check line ────────────────────────────────────────────────────────

export interface ColorCheck {
  ok: boolean;
  problem: ProjectColorProblem | null;
  light: { color: string; ratio: number };
  dark: { color: string; ratio: number; adjusted: boolean };
}

/** What the editor shows under the custom field: both themes' ratios against the paper and sheet. */
export function checkColorForEditor(hex: string): ColorCheck {
  const problem = projectColorProblem(hex);
  if (problem === "format") {
    return { ok: false, problem, light: { color: hex, ratio: 0 }, dark: { color: hex, ratio: 0, adjusted: false } };
  }
  const upper = normalizeHex(hex);
  const dark = darkVariant(upper);
  return {
    ok: problem === null,
    problem,
    light: { color: upper, ratio: themeContrast(upper, "light") },
    dark: { color: dark, ratio: themeContrast(dark, "dark"), adjusted: dark !== upper && !PROJECT_COLOR_PRESETS.some((p) => p.light === upper) },
  };
}

/**
 * What the editor's Custom field holds: nothing, a hex still being typed
 * ("partial"), a full hex the rules refuse, or a colour that can be picked. A
 * missing "#" is added. While it is partial or refused, Done must not save:
 * the row's earlier pick would be saved behind a red check line.
 */
export type CustomColorEntry =
  | { state: "empty" }
  | { state: "partial" }
  | { state: "refused"; hex: string; problem: Exclude<ProjectColorProblem, "format"> }
  | { state: "ok"; hex: string };

export function customColorEntry(text: string): CustomColorEntry {
  const trimmed = text.trim();
  if (!trimmed) return { state: "empty" };
  const typed = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  const problem = projectColorProblem(typed);
  if (problem === "format") return { state: "partial" };
  if (problem) return { state: "refused", hex: normalizeHex(typed), problem };
  return { state: "ok", hex: normalizeHex(typed) };
}

/** Done waits while the Custom field holds something it can't save (see `customColorEntry`). */
export function customEntryBlocksDone(entry: CustomColorEntry): boolean {
  return entry.state === "partial" || entry.state === "refused";
}

export function formatRatio(ratio: number): string {
  return `${(Math.floor(ratio * 10) / 10).toFixed(1)}:1`;
}

type MaybeRelation<T> = T | T[] | null | undefined;

function one<T>(value: MaybeRelation<T>): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** The square's inputs from a task row with its embedded `implementation` / `project` (PostgREST may send either as a one-item array). */
export function squareInputOf(task: {
  implementation?: MaybeRelation<{ id?: string | null; name?: string | null; color?: string | null }>;
  project?: MaybeRelation<{ id?: string | null; name?: string | null; tags?: string[] | null; color?: string | null }>;
}): { app: ColorEntity | null; project: ProjectColorEntity | null } {
  const app = one(task.implementation);
  const project = one(task.project);
  return {
    app: app?.id && app.name ? { id: app.id, name: app.name, color: app.color ?? null } : null,
    project: project?.id && project.name ? { id: project.id, name: project.name, tags: project.tags ?? null, color: project.color ?? null } : null,
  };
}
