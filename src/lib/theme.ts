// Light / dark choice (redesign S1). Pure, so the server layout, the account
// menu and the tests share one set of rules.
//
// The choice lives in a cookie on this device (`baseline_theme`), never in the
// database: the root layout reads it on the server and writes it as
// <html data-theme="…">, so the first paint already has the right colours.
// "system" leaves `color-scheme: light dark` in charge (globals.css), so the
// page follows the OS, live, from the first paint.

export const THEME_COOKIE = "baseline_theme";

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const DEFAULT_THEME: ThemePreference = "system";

/** One year, like the old sidebar cookie. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function parseThemePreference(value: unknown): ThemePreference {
  if (typeof value !== "string") return DEFAULT_THEME;
  const normalized = value.trim().toLowerCase();
  return (THEME_PREFERENCES as readonly string[]).includes(normalized)
    ? (normalized as ThemePreference)
    : DEFAULT_THEME;
}

/** Attributes for <html>; data-theme is always present so CSS and tests can rely on it. */
export function themeHtmlAttributes(preference: ThemePreference): { "data-theme": ThemePreference } {
  return { "data-theme": preference };
}

/** The `document.cookie` string the account menu writes. */
export function themeCookieString(preference: ThemePreference): string {
  return `${THEME_COOKIE}=${preference};path=/;max-age=${THEME_COOKIE_MAX_AGE};samesite=lax`;
}

/** Top-bar colours, also used for the browser's theme-color and the web-app manifest. */
export const THEME_BAR_COLORS = {
  light: "#3f4920",
  dark: "#2a3118",
} as const;

export const THEME_PAPER_COLORS = {
  light: "#e4e5e0",
  dark: "#171a10",
} as const;

/** `<meta name="theme-color">` entries for a preference (System: one per OS scheme). */
export function themeColorMeta(
  preference: ThemePreference
): Array<{ color: string; media?: string }> {
  if (preference === "light") return [{ color: THEME_BAR_COLORS.light }];
  if (preference === "dark") return [{ color: THEME_BAR_COLORS.dark }];
  return [
    { media: "(prefers-color-scheme: light)", color: THEME_BAR_COLORS.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_BAR_COLORS.dark },
  ];
}

export const THEME_LABELS: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/** The line under the three choices in the account menu. */
export function themeChoiceNote(preference: ThemePreference, systemIsDark: boolean | null): string {
  if (preference === "light") return "Always light on this device.";
  if (preference === "dark") return "Always dark on this device.";
  if (systemIsDark === null) return "Following this device. It changes on its own when the device switches.";
  return `Following this device: ${systemIsDark ? "Dark" : "Light"} right now. It changes on its own when the device switches.`;
}
