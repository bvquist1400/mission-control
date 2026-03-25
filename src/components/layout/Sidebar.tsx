"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { UniversalSearchPalette } from "@/components/layout/UniversalSearchPalette";
import { TaskDetailModal } from "@/components/tasks/TaskDetailModal";
import { Modal } from "@/components/ui/Modal";
import type { CommitmentSummary, TaskUpdatePayload, TaskWithImplementation } from "@/types/database";

const TASK_MODAL_PAGE_SIZE = 200;

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

const navItems = [
  { href: "/", label: "Today", hint: "Daily operating view" },
  { href: "/weekly-review", label: "Weekly Review", hint: "Shipped work, drag, and next-week calls" },
  { href: "/llm", label: "AI Playbooks", hint: "Prompt patterns and workflow tips" },
  { href: "/backlog", label: "Backlog", hint: "All tasks with filters and edits" },
  { href: "/sprints", label: "Sprints", hint: "Week-level planning and sprint snapshots" },
  { href: "/applications", label: "Applications", hint: "Portfolio health and updates" },
  { href: "/projects", label: "Projects", hint: "Track work within applications" },
  { href: "/stakeholders", label: "Stakeholders", hint: "People and commitments" },
  { href: "/focus", label: "Focus", hint: "Planner directives" },
  { href: "/planner", label: "Planner", hint: "Plan generation and refresh" },
  { href: "/calendar", label: "Calendar", hint: "Imported schedule metadata" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === href;
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

function SearchLauncherButton({
  onClick,
  className,
  compact = false,
}: {
  onClick: () => void;
  className?: string;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-3 rounded-xl border border-stroke bg-panel px-3 py-2 text-left text-sm text-foreground shadow-sm transition hover:border-accent/40 hover:bg-panel-muted ${className ?? ""}`}
      aria-label="Open universal search"
    >
      <svg className="h-4 w-4 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35" />
        <circle cx="11" cy="11" r="6.5" />
      </svg>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{compact ? "Search" : "Search everything"}</p>
        {!compact ? <p className="text-xs text-muted-foreground">Tasks, projects, stakeholders, meetings, email</p> : null}
      </div>
      {!compact ? (
        <span className="rounded-md border border-stroke bg-panel-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Cmd/Ctrl K
        </span>
      ) : null}
    </button>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
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

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
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
          if (!isMountedRef.current) {
            return;
          }

          setTaskModalAllTasks(allTasks);
        })
        .catch(() => {
          // Non-blocking cache warmup.
        });
    }

    if (!taskModalCommitments) {
      void fetchTaskModalCommitments()
        .then((commitments) => {
          if (!isMountedRef.current) {
            return;
          }

          setTaskModalCommitments(commitments);
        })
        .catch(() => {
          // Non-blocking cache warmup.
        });
    }

    void fetchTaskById(taskId)
      .then((task) => {
        if (!isMountedRef.current || taskModalRequestRef.current !== requestId) {
          return;
        }

        setTaskModalTask(task);
      })
      .catch(() => {
        if (!isMountedRef.current || taskModalRequestRef.current !== requestId) {
          return;
        }

        router.push(`/backlog?expand=${taskId}`);
      })
      .finally(() => {
        if (!isMountedRef.current || taskModalRequestRef.current !== requestId) {
          return;
        }

        setTaskModalLoading(false);
      });
  }, [router, taskModalAllTasks, taskModalCommitments]);

  const handleTaskModalUpdated = useCallback((taskId: string, updates: TaskUpdatePayload) => {
    setTaskModalTask((current) => (current?.id === taskId ? { ...current, ...updates } : current));
    setTaskModalAllTasks((current) => (
      current
        ? current.map((task) => (task.id === taskId ? { ...task, ...updates } : task))
        : current
    ));
  }, []);

  const handleTaskModalDeleted = useCallback((taskId: string) => {
    setTaskModalTask((current) => (current?.id === taskId ? null : current));
    setTaskModalAllTasks((current) => (current ? current.filter((task) => task.id !== taskId) : current));
  }, []);

  useEffect(() => {
    isMountedRef.current = true;

    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMobileOpen(false);
        setSearchOpen((current) => !current);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      isMountedRef.current = false;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setMobileOpen((open) => !open)}
        aria-controls="mobile-sidebar"
        aria-expanded={mobileOpen}
        aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
        className="fixed left-4 top-4 z-40 rounded-lg border border-stroke bg-panel/95 p-2 text-foreground shadow-sm backdrop-blur md:hidden"
      >
        {mobileOpen ? (
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M6 18L18 6" />
          </svg>
        ) : (
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        )}
      </button>

      <SearchLauncherButton
        onClick={openSearch}
        compact
        className="fixed right-4 top-4 z-40 lg:hidden"
      />

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
            className="fixed inset-y-0 left-0 z-40 w-72 border-r border-stroke bg-panel p-5 shadow-lg md:hidden"
          >
            <div className="border-b border-stroke pb-5">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Brent&apos;s Hub</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Baseline</h1>
            </div>

            <SearchLauncherButton onClick={openSearch} className="mt-4 w-full" />

            <nav className="mt-4 space-y-2">
              {navItems.map((item) => {
                const active = isActive(pathname, item.href);

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    className={`block rounded-xl border px-4 py-3 transition ${
                      active
                        ? "border-accent/30 bg-accent-soft text-accent"
                        : "border-transparent bg-transparent text-muted-foreground hover:border-stroke hover:bg-panel-muted hover:text-foreground"
                    }`}
                  >
                    <p className="text-sm font-semibold">{item.label}</p>
                    <p className="mt-1 text-xs leading-relaxed">{item.hint}</p>
                  </Link>
                );
              })}
            </nav>
          </aside>
        </>
      ) : null}

      <nav className="fixed inset-x-4 bottom-4 z-20 hidden rounded-xl border border-stroke bg-panel/95 p-2 shadow-lg backdrop-blur md:block lg:hidden">
        <ul className="grid gap-2" style={{ gridTemplateColumns: `repeat(${navItems.length}, minmax(0, 1fr))` }}>
          {navItems.map((item) => {
            const active = isActive(pathname, item.href);

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`block rounded-lg px-2 py-2 text-center text-xs font-semibold transition ${
                    active ? "bg-accent text-white" : "text-muted-foreground hover:bg-panel-muted hover:text-foreground"
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <aside className="hidden min-h-[calc(100vh-2rem)] w-72 shrink-0 rounded-2xl border border-stroke bg-panel p-5 shadow-sm lg:block">
        <div className="border-b border-stroke pb-5">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Brent&apos;s Hub</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Baseline</h1>
        </div>

        <SearchLauncherButton onClick={openSearch} className="mt-4 w-full" />

        <nav className="mt-4 space-y-2">
          {navItems.map((item) => {
            const active = isActive(pathname, item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block rounded-xl border px-4 py-3 transition ${
                  active
                    ? "border-accent/30 bg-accent-soft text-accent"
                    : "border-transparent bg-transparent text-muted-foreground hover:border-stroke hover:bg-panel-muted hover:text-foreground"
                }`}
              >
                <p className="text-sm font-semibold">{item.label}</p>
                <p className="mt-1 text-xs leading-relaxed">{item.hint}</p>
              </Link>
            );
          })}
        </nav>
      </aside>

      {searchOpen ? <UniversalSearchPalette onClose={closeSearch} onOpenTask={openTaskFromSearch} /> : null}
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
