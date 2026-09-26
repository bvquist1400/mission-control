"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { UniversalSearchPalette } from "@/components/layout/UniversalSearchPalette";
import { AccountMenu } from "@/components/layout/AccountMenu";
import { NAV_GROUPS, isActive, type NavItem } from "@/components/layout/nav-items";
import { ShortcutsDialog, GO_TO_KEYS } from "@/components/layout/ShortcutsDialog";
import { TaskDetailModal } from "@/components/tasks/TaskDetailModal";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { BriefReadyButton, useTodayBrief } from "@/components/layout/BriefReadyButton";
import type { TodayBriefStatus } from "@/lib/briefs/button";
import type { CommitmentSummary, TaskUpdatePayload, TaskWithImplementation } from "@/types/database";

const TASK_MODAL_PAGE_SIZE = 200;
const COLLAPSE_COOKIE = "baseline_sidebar";

async function fetchTaskById(taskId: string): Promise<TaskWithImplementation> {
  const response = await fetch(`/api/tasks/${taskId}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to fetch task");
  }
  return response.json();
}

async function fetchTaskModalPage(offset: number): Promise<TaskWithImplementation[]> {
  const searchParams = new URLSearchParams({
    include_done: "true",
    include_parked: "true",
    limit: String(TASK_MODAL_PAGE_SIZE),
    offset: String(offset),
  });
  const response = await fetch(`/api/tasks?${searchParams.toString()}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to fetch tasks");
  }
  return response.json();
}

async function fetchAllTaskModalTasks(): Promise<TaskWithImplementation[]> {
  const tasks: TaskWithImplementation[] = [];
  let offset = 0;
  while (true) {
    const page = await fetchTaskModalPage(offset);
    tasks.push(...page);
    if (page.length < TASK_MODAL_PAGE_SIZE) {
      return tasks;
    }
    offset += TASK_MODAL_PAGE_SIZE;
  }
}

async function fetchTaskModalCommitments(): Promise<CommitmentSummary[]> {
  const response = await fetch("/api/commitments?include_done=true", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to fetch commitments");
  }
  return response.json();
}

function SearchLauncherButton({
  onClick,
  className,
  variant = "full",
}: {
  onClick: () => void;
  className?: string;
  variant?: "full" | "compact" | "icon";
}) {
  const icon = (
    <svg aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35" />
      <circle cx="11" cy="11" r="6.5" />
    </svg>
  );

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label="Open universal search"
        title="Search everything (Cmd/Ctrl K)"
        className={`flex h-9 w-9 items-center justify-center rounded-xl border border-stroke bg-panel text-foreground shadow-sm transition hover:border-accent/40 hover:bg-panel-muted ${className ?? ""}`}
      >
        {icon}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open universal search"
      // Single line: the old two-line version clipped its own title to
      // "Search ever…" and wrapped the subtitle to three lines in a 288px rail.
      className={`flex items-center gap-2.5 rounded-xl border border-stroke bg-panel px-3 py-2 text-left text-sm text-foreground shadow-sm transition hover:border-accent/40 hover:bg-panel-muted ${className ?? ""}`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">Search</span>
      {variant === "full" ? (
        <kbd className="shrink-0 rounded border border-stroke bg-panel-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
          ⌘K
        </kbd>
      ) : null}
    </button>
  );
}

function NavLink({
  item,
  active,
  collapsed,
  showHint,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  showHint: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      title={collapsed ? `${item.label} — ${item.hint}` : item.hint}
      aria-current={active ? "page" : undefined}
      className={`flex items-center rounded-lg border transition ${
        collapsed ? "justify-center px-2 py-2.5" : "gap-2.5 px-3 py-2"
      } ${
        active
          ? "border-accent/30 bg-accent-soft text-accent-text"
          : "border-transparent text-muted-foreground hover:bg-panel-muted hover:text-foreground"
      }`}
    >
      {item.icon}
      {collapsed ? (
        <span className="sr-only">{item.label}</span>
      ) : (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{item.label}</span>
          {showHint ? (
            <span className="mt-0.5 block text-xs leading-snug opacity-80">{item.hint}</span>
          ) : null}
        </span>
      )}
    </Link>
  );
}

function NavList({
  pathname,
  collapsed,
  showHints = false,
  onNavigate,
}: {
  pathname: string;
  collapsed: boolean;
  showHints?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex flex-col gap-4">
      {NAV_GROUPS.map((group) => (
        <div key={group.label} className="flex flex-col gap-1">
          {collapsed ? (
            <span aria-hidden="true" className="mx-auto my-1 h-px w-6 bg-stroke first:hidden" />
          ) : (
            <p className="px-3 pb-0.5 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
              {group.label}
            </p>
          )}
          {group.items.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={isActive(pathname, item.href)}
              collapsed={collapsed}
              showHint={showHints}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}

export function Sidebar({
  userEmail = null,
  defaultCollapsed = false,
  todayBrief = null,
}: {
  userEmail?: string | null;
  defaultCollapsed?: boolean;
  todayBrief?: TodayBriefStatus | null;
}) {
  const pathname = usePathname();
  const brief = useTodayBrief(todayBrief);
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [taskModalTask, setTaskModalTask] = useState<TaskWithImplementation | null>(null);
  const [taskModalAllTasks, setTaskModalAllTasks] = useState<TaskWithImplementation[] | null>(null);
  const [taskModalCommitments, setTaskModalCommitments] = useState<CommitmentSummary[] | null>(null);
  const [taskModalLoading, setTaskModalLoading] = useState(false);
  const isMountedRef = useRef(true);
  const taskModalRequestRef = useRef(0);

  const openSearch = useCallback(() => {
    setMobileOpen(false);
    setSearchOpen(true);
  }, []);

  const closeSearch = useCallback(() => setSearchOpen(false), []);

  // Persisted in a cookie rather than localStorage so the server layout can read
  // it and render the correct width on the first paint — no collapse flicker.
  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      document.cookie = `${COLLAPSE_COOKIE}=${next ? "collapsed" : "expanded"};path=/;max-age=31536000;samesite=lax`;
      return next;
    });
  }, []);

  const closeTaskModal = useCallback(() => {
    taskModalRequestRef.current += 1;
    setTaskModalLoading(false);
    setTaskModalTask(null);
  }, []);

  const openTaskFromSearch = useCallback((taskId: string) => {
    const requestId = taskModalRequestRef.current + 1;
    taskModalRequestRef.current = requestId;
    setTaskModalLoading(true);

    if (!taskModalAllTasks) {
      void fetchAllTaskModalTasks()
        .then((allTasks) => {
          if (isMountedRef.current) setTaskModalAllTasks(allTasks);
        })
        .catch(() => {
          // Non-blocking cache warmup.
        });
    }

    if (!taskModalCommitments) {
      void fetchTaskModalCommitments()
        .then((commitments) => {
          if (isMountedRef.current) setTaskModalCommitments(commitments);
        })
        .catch(() => {
          // Non-blocking cache warmup.
        });
    }

    void fetchTaskById(taskId)
      .then((task) => {
        if (!isMountedRef.current || taskModalRequestRef.current !== requestId) return;
        setTaskModalTask(task);
      })
      .catch(() => {
        if (!isMountedRef.current || taskModalRequestRef.current !== requestId) return;
        router.push(`/backlog?expand=${taskId}`);
      })
      .finally(() => {
        if (!isMountedRef.current || taskModalRequestRef.current !== requestId) return;
        setTaskModalLoading(false);
      });
  }, [router, taskModalAllTasks, taskModalCommitments]);

  const handleTaskModalUpdated = useCallback((taskId: string, updates: TaskUpdatePayload) => {
    setTaskModalTask((current) => (current?.id === taskId ? { ...current, ...updates } : current));
    setTaskModalAllTasks((current) =>
      current ? current.map((task) => (task.id === taskId ? { ...task, ...updates } : task)) : current
    );
  }, []);

  const handleTaskModalDeleted = useCallback((taskId: string) => {
    setTaskModalTask((current) => (current?.id === taskId ? null : current));
    setTaskModalAllTasks((current) => (current ? current.filter((task) => task.id !== taskId) : current));
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
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
        setMobileOpen(false);
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

      if (event.key === "[") {
        event.preventDefault();
        toggleCollapsed();
        return;
      }

      if (event.key.toLowerCase() === "g") {
        goToArmed = true;
        goToTimer = window.setTimeout(disarm, 1500);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      isMountedRef.current = false;
      disarm();
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [router, toggleCollapsed]);

  return (
    <>
      {/* Mobile chrome */}
      <button
        type="button"
        onClick={() => setMobileOpen((open) => !open)}
        aria-controls="mobile-sidebar"
        aria-expanded={mobileOpen}
        aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
        className="fixed left-4 top-4 z-40 rounded-lg border border-stroke bg-panel/95 p-2 text-foreground shadow-sm backdrop-blur md:hidden"
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d={mobileOpen ? "M6 6l12 12M6 18L18 6" : "M4 6h16M4 12h16M4 18h16"} />
        </svg>
      </button>

      <SearchLauncherButton onClick={openSearch} variant="icon" className="fixed right-4 top-4 z-40 lg:hidden" />
      <BriefReadyButton status={brief} variant="chrome" className="fixed right-16 top-4 z-40 lg:hidden" />

      {mobileOpen ? (
        <>
          <button
            type="button"
            aria-label="Close navigation menu"
            onClick={() => setMobileOpen(false)}
            className="fixed inset-0 z-30 bg-black/35 md:hidden"
          />
          <aside
            id="mobile-sidebar"
            className="fixed inset-y-0 left-0 z-40 flex w-72 flex-col overflow-y-auto border-r border-stroke bg-panel p-5 shadow-lg md:hidden"
          >
            <div className="border-b border-stroke pb-4">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Brent&apos;s Hub</p>
              <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-foreground">Baseline</h1>
            </div>
            <SearchLauncherButton onClick={openSearch} className="mt-4 w-full" variant="compact" />
            <div className="mt-4">
              <NavList pathname={pathname} collapsed={false} showHints onNavigate={() => setMobileOpen(false)} />
            </div>
            <AccountMenu email={userEmail} collapsed={false} />
          </aside>
        </>
      ) : null}

      {/* Tablet: a single scrollable row, so labels never crush to ~78px each */}
      <nav className="fixed inset-x-4 bottom-4 z-20 hidden rounded-xl border border-stroke bg-panel/95 p-1.5 shadow-lg backdrop-blur md:block lg:hidden">
        <ul className="flex items-center gap-1 overflow-x-auto">
          {NAV_GROUPS.flatMap((group) => group.items).map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href} className="shrink-0">
                <Link
                  href={item.href}
                  title={item.hint}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-semibold transition ${
                    active ? "bg-accent text-white" : "text-muted-foreground hover:bg-panel-muted hover:text-foreground"
                  }`}
                >
                  {item.icon}
                  <span className="whitespace-nowrap">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Desktop rail */}
      <aside
        className={`hidden min-h-[calc(100vh-2rem)] shrink-0 flex-col rounded-2xl border border-stroke bg-panel p-3 shadow-sm transition-[width] lg:flex ${
          collapsed ? "w-[4.5rem]" : "w-72 p-5"
        }`}
      >
        <div className={`flex items-center gap-2 border-b border-stroke pb-4 ${collapsed ? "justify-center" : ""}`}>
          {collapsed ? null : (
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Brent&apos;s Hub</p>
              <h1 className="mt-1.5 truncate text-2xl font-semibold tracking-tight text-foreground">Baseline</h1>
            </div>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <svg aria-hidden="true" className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9 4v16" />
              {collapsed ? <path d="m13 9 3 3-3 3" /> : <path d="m16 9-3 3 3 3" />}
            </svg>
          </Button>
        </div>

        <BriefReadyButton
          status={brief}
          variant={collapsed ? "rail-collapsed" : "rail"}
          className={collapsed ? "mx-auto mt-4" : "mt-4"}
        />

        <SearchLauncherButton
          onClick={openSearch}
          className={collapsed ? "mx-auto mt-4" : "mt-4 w-full"}
          variant={collapsed ? "icon" : "full"}
        />

        <div className="mt-4 flex-1">
          <NavList pathname={pathname} collapsed={collapsed} />
        </div>

        <AccountMenu email={userEmail} collapsed={collapsed} />
      </aside>

      {searchOpen ? <UniversalSearchPalette onClose={closeSearch} onOpenTask={openTaskFromSearch} /> : null}
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      {taskModalLoading ? (
        <Modal open={taskModalLoading} onClose={closeTaskModal} title="Loading task" size="wide">
          <div className="flex min-h-40 flex-col items-center justify-center gap-3 py-8 text-sm text-muted-foreground">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            <p>Opening task details...</p>
          </div>
        </Modal>
      ) : null}
      <TaskDetailModal
        task={taskModalTask}
        allTasks={taskModalAllTasks ?? (taskModalTask ? [taskModalTask] : [])}
        commitments={taskModalCommitments ?? []}
        onClose={closeTaskModal}
        onTaskUpdated={handleTaskModalUpdated}
        onTaskDeleted={handleTaskModalDeleted}
      />
    </>
  );
}
