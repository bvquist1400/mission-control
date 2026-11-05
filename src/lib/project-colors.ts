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
 * Yellow, gold and amber (hue 33°–65°, unless nearly grey) read as the "needs
 * you" marigold in one theme or the other, so they are never a project colour.
 * Lightness is not an escape: a dark ochre turns gold once lightened for dark.
 */
export function isNeedsYouHue(hex: string): boolean {
  const { h, s } = toHsl(hex);
  return s >= 0.3 && h >= 33 && h <= 65;
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

/**
 * The colour a stored light-theme value shows as in dark: the preset's own dark
 * pair, else the same hue lightened in 1% steps until it reaches 3:1 on the dark
 * paper and sheet.
 */
export function darkVariant(hex: string): string {
  const upper = normalizeHex(hex);
  const preset = PROJECT_COLOR_PRESETS.find((entry) => entry.light === upper);
  if (preset) return preset.dark;
  if (themeContrast(upper, "dark") >= MIN_SQUARE_CONTRAST) return upper;
  const { h, s, l } = toHsl(upper);
  for (let next = Math.round(l * 100) + 1; next <= 100; next += 1) {
    const candidate = fromHsl(h, s, next / 100);
    if (themeContrast(candidate, "dark") >= MIN_SQUARE_CONTRAST) return candidate;
  }
  return "#FFFFFF";
}

export function pairForStoredColor(hex: string): ColorPair {
  const upper = normalizeHex(hex);
  return { light: upper, dark: darkVariant(upper) };
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

function colorOf(entity: ColorEntity, overrides?: ColorOverrides): string | null {
  const raw = overrides?.has(entity.id) ? overrides.get(entity.id) : entity.color;
  return usableStoredColor(raw ?? null);
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
    const own = colorOf(project, overrides);
    if (own) return { ...pairForStoredColor(own), owner: { kind: "project", id: project.id, name: project.name }, source: "project" };
  }
  if (app) {
    // The square belongs to whoever gives it its colour: clicking it opens the application.
    const appColor = colorOf(app, overrides);
    const owner = { kind: "app" as const, id: app.id, name: app.name };
    if (appColor) return { ...pairForStoredColor(appColor), owner, source: "app" };
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
