"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import { UniversalSearchPalette } from "@/components/layout/UniversalSearchPalette";
import { AccountMenu } from "@/components/layout/AccountMenu";
import { MORE_ICON, MORE_NAV, PRIMARY_NAV, isActive, isMoreActive } from "@/components/layout/nav-items";
import { ShortcutsDialog, GO_TO_KEYS } from "@/components/layout/ShortcutsDialog";
import { useTaskPanel } from "@/components/tasks/panel/TaskPanelProvider";
import { BriefReadyButton, useTodayBrief } from "@/components/layout/BriefReadyButton";
import { scopeSwitchFor } from "@/lib/scope-switch";
import type { TodayBriefStatus } from "@/lib/briefs/button";
import type { ThemePreference } from "@/lib/theme";

function SearchGlyph({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={`${className} shrink-0`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="square">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </svg>
  );
}

/** The drafting-target mark from the mockup (square, cross, circle). */
function BaselineMark() {
  return (
    <svg aria-hidden="true" className="h-[22px] w-[22px] shrink-0" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <rect x="1.5" y="1.5" width="19" height="19" />
      <path d="M11 1.5v19M1.5 11h19" />
      <circle cx="11" cy="11" r="4" />
    </svg>
  );
}

function Caret() {
  return (
    <svg aria-hidden="true" className="ml-1 h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

/** Closes a popover on an outside pointer press or Escape. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, onClose: (returnFocus: boolean) => void) {
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose(true);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, ref, onClose]);
}

function MoreList({ pathname, onNavigate }: { pathname: string; onNavigate: () => void }) {
  return (
    <ul>
      {MORE_NAV.map((item) => {
        const active = isActive(pathname, item);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-12 items-center gap-3 border-b border-rule-2 px-3.5 py-2 transition last:border-b-0 hover:bg-panel-muted ${
                active ? "bg-brand-wash" : ""
              }`}
            >
              <span className={active ? "text-brand" : "text-muted-foreground"}>{item.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-cond text-[15px] font-semibold text-foreground">{item.label}</span>
                <span className="block truncate font-mono text-xs text-muted-foreground">{item.hint}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Desktop "More ▾" tab with its drop-down. */
function MoreMenu({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);
  useDismiss(open, ref, close);
  const active = isMoreActive(pathname);

  return (
    <div ref={ref} className="relative flex">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={`-mb-px flex items-center border-b-[3px] px-3 font-cond text-[15px] transition xl:px-[18px] ${
          active || open
            ? "border-bar-ink font-semibold text-bar-ink"
            : "border-transparent font-medium text-bar-ink-2 hover:text-bar-ink"
        }`}
      >
        More
        <Caret />
      </button>
      {open ? (
        <div
          id={menuId}
          role="group"
          aria-label="More pages"
          className="bar-panel absolute left-0 top-full z-50 mt-1 w-72 border-[1.5px] border-foreground bg-panel text-foreground shadow-lg"
        >
          <MoreList pathname={pathname} onNavigate={() => close(true)} />
        </div>
      ) : null}
    </div>
  );
}

/** Work / Personal / All, only on pages that have a scope (lib/scope-switch.ts). */
function ScopeSwitch({ placement }: { placement: "bar" | "row" }) {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const view = scopeSwitchFor(pathname, searchParams?.toString() ?? "");
  if (!view) return null;

  if (placement === "row") {
    return (
      <nav aria-label={view.label} className="grid grid-cols-3 border-b border-stroke bg-panel lg:hidden">
        {view.options.map((option) => (
          <Link
            key={option.value}
            href={option.href}
            aria-current={option.active ? "page" : undefined}
            className={`flex min-h-11 items-center justify-center border-r border-stroke font-cond text-sm last:border-r-0 ${
              option.active ? "bg-foreground font-semibold text-panel" : "font-medium text-muted-foreground"
            }`}
          >
            {option.label}
          </Link>
        ))}
      </nav>
    );
  }

  return (
    <nav aria-label={view.label} className="flex min-h-[34px] border border-bar-ink-2">
      {view.options.map((option) => (
        <Link
          key={option.value}
          href={option.href}
          aria-current={option.active ? "page" : undefined}
          className={`flex items-center border-r border-bar-rule px-3 font-cond text-[13px] last:border-r-0 pointer-coarse:min-h-11 ${
            option.active ? "bg-bar-ink font-semibold text-bar" : "font-medium text-bar-ink-2 hover:text-bar-ink"
          }`}
        >
          {option.label}
        </Link>
      ))}
    </nav>
  );
}

/** Phone/tablet: the five tabs at the bottom; More opens a sheet above them. */
function TabBar({ pathname }: { pathname: string }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const sheetId = useId();
  const close = useCallback((returnFocus: boolean) => {
    setMoreOpen(false);
    if (returnFocus) moreButtonRef.current?.focus();
  }, []);
  useDismiss(moreOpen, ref, close);
  const moreActive = isMoreActive(pathname);

  // Opening the sheet moves focus into it (the first link), so a keyboard or
  // switch user lands on the new links instead of staying on the trigger.
  useEffect(() => {
    if (moreOpen) sheetRef.current?.querySelector<HTMLElement>("a")?.focus();
  }, [moreOpen]);

  const tabClass = (active: boolean) =>
    `flex min-h-14 flex-col items-center justify-center gap-1 font-cond text-xs transition ${
      active ? "font-bold text-foreground shadow-[inset_0_3px_0_var(--ink)]" : "font-medium text-muted-foreground"
    }`;

  return (
    <div ref={ref} className="lg:hidden">
      <nav
        aria-label="Main tabs"
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t-[1.5px] border-foreground bg-panel pb-[env(safe-area-inset-bottom)]"
      >
        {PRIMARY_NAV.map((item) => {
          const active = isActive(pathname, item);
          return (
            <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={tabClass(active)}>
              {item.icon}
              {item.label}
            </Link>
          );
        })}
        <button
          ref={moreButtonRef}
          type="button"
          onClick={() => setMoreOpen((current) => !current)}
          aria-expanded={moreOpen}
          aria-controls={moreOpen ? sheetId : undefined}
          className={tabClass(moreActive || moreOpen)}
        >
          {MORE_ICON}
          More
        </button>
      </nav>
      {/*
        The sheet comes after the tabs in the DOM (it is fixed-position, so it
        still draws above them): Tab from More lands on the sheet's links, and
        Shift+Tab from the first link returns to More.
      */}
      {moreOpen ? (
        <nav
          ref={sheetRef}
          id={sheetId}
          aria-labelledby={`${sheetId}-title`}
          className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-40 border-t-[1.5px] border-foreground bg-panel shadow-lg"
        >
          <p id={`${sheetId}-title`} className="px-3.5 pb-1 pt-3 font-mono text-xs font-semibold text-muted-foreground">
            More pages
          </p>
          <MoreList pathname={pathname} onNavigate={() => close(true)} />
        </nav>
      ) : null}
    </div>
  );
}

/**
 * The app's top bar (redesign S1, mockup d3-olive.html): the mark, Today ·
 * Tasks · Portfolio · Launch · More, today's brief, Work / Personal / All,
 * search and the account menu. Under 1024px it becomes a slim bar on top and
 * a five-tab bar at the bottom. It also owns the global shortcuts (⌘K, ?, g +
 * key) and the task window opened from search.
 */
export function TopBar({
  userEmail = null,
  todayBrief = null,
  theme,
}: {
  userEmail?: string | null;
  todayBrief?: TodayBriefStatus | null;
  theme: ThemePreference;
}) {
  const pathname = usePathname() ?? "";
  const brief = useTodayBrief(todayBrief);
  const router = useRouter();
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const { openTask } = useTaskPanel();

  const openSearch = useCallback(() => setSearchOpen(true), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);

  // A task picked in search opens in the task panel on the page you're on.
  const openTaskFromSearch = useCallback((taskId: string) => openTask(taskId), [openTask]);

  useEffect(() => {
    // `g` starts a two-key "go to" chord, the convention in GitHub/Linear/Gmail.
    let goToArmed = false;
    let goToTimer = 0;

    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      return (
        target.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
      );
    }

    function disarm() {
      goToArmed = false;
      window.clearTimeout(goToTimer);
    }

    function handleKeyDown(event: KeyboardEvent) {
      // Search is reachable even mid-typing; everything else is not.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((current) => !current);
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) {
        return;
      }

      if (goToArmed) {
        const href = GO_TO_KEYS[event.key.toLowerCase()];
        disarm();
        if (href) {
          event.preventDefault();
          router.push(href);
        }
        return;
      }

      if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      if (event.key.toLowerCase() === "g") {
        goToArmed = true;
        goToTimer = window.setTimeout(disarm, 1500);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      disarm();
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [router]);

  return (
    <>
      <header className="bar-surface sticky top-0 z-30 bg-bar pt-[env(safe-area-inset-top)] text-bar-ink">
        <div className="flex h-[52px] items-stretch px-4 sm:px-6 lg:h-14">
          <Link
            href="/"
            aria-label="Baseline, Today"
            className="flex items-center gap-2.5 pr-4 lg:border-r lg:border-bar-rule lg:pr-6 xl:pr-7"
          >
            <BaselineMark />
            <b className="hidden font-cond text-[17px] font-bold tracking-[0.02em] min-[420px]:inline">BASELINE</b>
          </Link>

          <nav aria-label="Main" className="ml-2 hidden lg:flex">
            {PRIMARY_NAV.map((item) => {
              const active = isActive(pathname, item);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={item.hint}
                  aria-current={active ? "page" : undefined}
                  className={`-mb-px flex items-center border-b-[3px] px-3 font-cond text-[15px] transition xl:px-[18px] ${
                    active
                      ? "border-bar-ink font-semibold text-bar-ink"
                      : "border-transparent font-medium text-bar-ink-2 hover:text-bar-ink"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
            <MoreMenu pathname={pathname} />
          </nav>

          <div className="ml-auto flex items-center gap-2 sm:gap-3 xl:gap-3.5">
            {/* Visibility lives on wrappers: a primitive's className is for layout only. */}
            <div className="hidden xl:flex">
              <BriefReadyButton status={brief} variant="bar" />
            </div>
            <div className="flex xl:hidden">
              <BriefReadyButton status={brief} variant="compact" />
            </div>
            <div className="hidden lg:block">
              <Suspense fallback={null}>
                <ScopeSwitch placement="bar" />
              </Suspense>
            </div>
            <button
              type="button"
              onClick={openSearch}
              aria-label="Search everything"
              title="Search everything (⌘K)"
              className="hidden h-[34px] w-44 items-center gap-2 bg-bar-2 px-2.5 text-left text-[13px] text-bar-ink-2 transition hover:text-bar-ink pointer-coarse:min-h-11 xl:flex"
            >
              <SearchGlyph />
              <span className="flex-1">Search</span>
              <kbd className="border border-white/20 px-1 py-0.5 font-mono text-xs">⌘K</kbd>
            </button>
            <button
              type="button"
              onClick={openSearch}
              aria-label="Search everything"
              title="Search everything (⌘K)"
              className="flex h-[34px] w-[34px] items-center justify-center bg-bar-2 text-bar-ink transition pointer-coarse:h-11 pointer-coarse:w-11 xl:hidden"
            >
              <SearchGlyph />
            </button>
            <AccountMenu email={userEmail} theme={theme} onOpenShortcuts={openShortcuts} />
          </div>
        </div>
      </header>

      <Suspense fallback={null}>
        <ScopeSwitch placement="row" />
      </Suspense>

      <TabBar pathname={pathname} />

      {searchOpen ? <UniversalSearchPalette onClose={closeSearch} onOpenTask={openTaskFromSearch} /> : null}
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </>
  );
}
