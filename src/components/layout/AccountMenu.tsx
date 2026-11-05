"use client";

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase";
import { useToast } from "@/components/ui/Toast";
import {
  THEME_BAR_COLORS,
  THEME_LABELS,
  THEME_PAPER_COLORS,
  THEME_PREFERENCES,
  themeChoiceNote,
  themeCookieString,
  type ThemePreference,
} from "@/lib/theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribeToScheme(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** The device's own light/dark setting, live; null on the server. */
function useSystemIsDark(): boolean | null {
  return useSyncExternalStore(
    subscribeToScheme,
    () => window.matchMedia(DARK_QUERY).matches,
    () => null
  );
}

/** Two-colour preview for each choice (mockup d3-olive.html, theme frame). */
const PREVIEW: Record<ThemePreference, [string, string]> = {
  system: [THEME_PAPER_COLORS.light, THEME_PAPER_COLORS.dark],
  light: [THEME_PAPER_COLORS.light, THEME_BAR_COLORS.light],
  dark: [THEME_PAPER_COLORS.dark, THEME_BAR_COLORS.dark],
};

/**
 * Applies a theme choice at once (no reload) and remembers it on this device.
 * The cookie is what the server reads on the next page load, so that page
 * paints in the right colours from the start.
 */
export function applyThemePreference(preference: ThemePreference): void {
  document.cookie = themeCookieString(preference);
  document.documentElement.dataset.theme = preference;
}

/**
 * The account button at the right of the top bar ("B") and its menu: who is
 * signed in, Appearance (System · Light · Dark), Project colours (S2),
 * Keyboard shortcuts, Sign out.
 */
export function AccountMenu({
  email,
  theme,
  onOpenShortcuts,
}: {
  email: string | null;
  theme: ThemePreference;
  onOpenShortcuts: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [preference, setPreference] = useState<ThemePreference>(theme);
  const [signingOut, setSigningOut] = useState(false);
  const systemIsDark = useSystemIsDark();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const initial = (email?.trim()?.[0] ?? "B").toUpperCase();

  const close = useCallback((returnFocus = false) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) close();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        close(true);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  function choose(next: ThemePreference) {
    applyThemePreference(next);
    setPreference(next);
  }

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      router.push("/login");
      router.refresh();
    } catch (error) {
      setSigningOut(false);
      toast({
        tone: "danger",
        message: error instanceof Error ? error.message : "Couldn't sign out.",
      });
    }
  }

  const itemClass =
    "flex min-h-11 w-full items-center gap-2 border-b border-rule-2 px-3.5 text-left text-sm font-medium text-foreground transition last:border-b-0 hover:bg-panel-muted disabled:cursor-not-allowed";

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Account and appearance"
        title={email ?? "Account"}
        className={`flex h-[34px] w-[34px] items-center justify-center border font-cond text-sm font-semibold transition pointer-coarse:h-11 pointer-coarse:w-11 ${
          open ? "border-bar-ink bg-bar-ink text-bar" : "border-bar-ink-2 text-bar-ink hover:border-bar-ink"
        }`}
      >
        {initial}
      </button>

      {open ? (
        <div
          id={menuId}
          role="dialog"
          aria-label="Account"
          className="absolute right-0 top-[calc(100%+10px)] z-50 w-[300px] max-w-[calc(100vw-24px)] border-[1.5px] border-foreground bg-panel text-foreground shadow-lg"
        >
          <div className="border-b border-stroke px-3.5 py-3">
            <p className="truncate font-cond text-[15px] font-semibold leading-tight" title={email ?? undefined}>
              {email ?? "Signed in"}
            </p>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">Signed in on this device</p>
          </div>

          <p id={`${menuId}-appearance`} className="px-3.5 pb-1 pt-3 font-mono text-xs font-semibold text-muted-foreground">
            Appearance
          </p>
          <div role="radiogroup" aria-labelledby={`${menuId}-appearance`} className="grid grid-cols-3 gap-1.5 px-3.5 pb-1.5 pt-2">
            {THEME_PREFERENCES.map((value) => {
              const selected = preference === value;
              const [a, b] = PREVIEW[value];
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => choose(value)}
                  className={`flex min-h-11 flex-col items-center gap-1.5 px-1.5 pb-2 pt-1.5 font-cond text-[13px] font-semibold transition ${
                    selected ? "border-2 border-brand bg-brand-wash" : "border border-stroke hover:bg-panel-muted"
                  }`}
                >
                  <span aria-hidden="true" className="flex h-[30px] w-full border border-stroke">
                    <i className="block flex-1" style={{ background: a }} />
                    <i className="block flex-1" style={{ background: b }} />
                  </span>
                  {THEME_LABELS[value]}
                </button>
              );
            })}
          </div>
          <p className="border-b border-stroke px-3.5 pb-3 pt-0.5 font-mono text-xs leading-snug text-muted-foreground" aria-live="polite">
            {themeChoiceNote(preference, systemIsDark)}
          </p>

          <div>
            <button type="button" disabled className={`${itemClass} text-muted-foreground hover:bg-transparent`}>
              Project colours…
              <span className="ml-auto font-mono text-xs text-muted-foreground">coming soon</span>
            </button>
            <button
              type="button"
              className={itemClass}
              onClick={() => {
                close();
                onOpenShortcuts();
              }}
            >
              Keyboard shortcuts
              <kbd className="ml-auto border border-stroke px-1.5 py-0.5 font-mono text-xs text-muted-foreground">?</kbd>
            </button>
            <button type="button" className={itemClass} onClick={handleSignOut} disabled={signingOut}>
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
