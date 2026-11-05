"use client";

import {
  Suspense,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { TaskPanel } from "@/components/tasks/panel/TaskPanel";
import {
  LEGACY_EXPAND_PARAM,
  TASK_PARAM,
  hrefWithTask,
  panelScreenForPath,
  taskIdFromParams,
  type PanelWidths,
} from "@/lib/task-panel";
import type { CommitmentSummary, TaskUpdatePayload, TaskWithImplementation } from "@/types/database";

/** What a page hears about saves made in the panel (lists that keep their own rows follow along). */
export interface TaskPanelEvents {
  onTaskUpdated?: (taskId: string, updates: TaskUpdatePayload) => void;
  onTaskDeleted?: (taskId: string) => void;
  onDatesChanged?: (changes: Array<{ task_id: string; due_at: string | null }>) => void;
}

interface TaskPanelContextValue {
  /** Opens a task in the panel (a row the page already has shows at once, then refreshes). */
  openTask: (task: string | TaskWithImplementation) => void;
  closeTask: () => void;
  /** Rows the page shows: the panel starts from them instead of a blank frame. */
  seedTasks: (tasks: TaskWithImplementation[]) => void;
  subscribe: (events: TaskPanelEvents) => () => void;
  /** Internal (the panel itself). */
  getSeed: (taskId: string) => TaskWithImplementation | null;
  getSeedList: () => TaskWithImplementation[];
  loadCommitments: () => Promise<CommitmentSummary[]>;
  emitUpdated: (taskId: string, updates: TaskUpdatePayload) => void;
  emitDeleted: (taskId: string) => void;
  emitDatesChanged: (changes: Array<{ task_id: string; due_at: string | null }>) => void;
  /** Checklist ticks, comments, links: no row change for the page, but it re-reads on close. */
  markChanged: () => void;
  /** The list the last task card was clicked in (↑ / ↓ stay in it) and the control clicked (focus returns there). */
  getOpenContext: () => { list: Element | null; opener: HTMLElement | null; scrollY: number };
  /** True right after openTask ran in this browser: that panel slides in and takes focus; one from the first HTML doesn't. */
  openedHere: () => boolean;
}

const TaskPanelContext = createContext<TaskPanelContextValue | null>(null);

export function useTaskPanel(): TaskPanelContextValue {
  const ctx = useContext(TaskPanelContext);
  if (!ctx) throw new Error("useTaskPanel must be used inside TaskPanelProvider");
  return ctx;
}

/** Keeps a page's own rows in step with saves made in the panel. */
export function useTaskPanelEvents(events: TaskPanelEvents) {
  const { subscribe } = useTaskPanel();
  const latest = useRef(events);
  useEffect(() => {
    latest.current = events;
  });
  useEffect(
    () =>
      subscribe({
        onTaskUpdated: (taskId, updates) => latest.current.onTaskUpdated?.(taskId, updates),
        onTaskDeleted: (taskId) => latest.current.onTaskDeleted?.(taskId),
        onDatesChanged: (changes) => latest.current.onDatesChanged?.(changes),
      }),
    [subscribe]
  );
}

/** Seeds the panel with the rows a section shows (Today's islands call this on render). */
export function useSeedTaskPanel(tasks: TaskWithImplementation[]) {
  const { seedTasks } = useTaskPanel();
  useEffect(() => {
    seedTasks(tasks);
  }, [tasks, seedTasks]);
}

function currentLocation() {
  return { pathname: window.location.pathname, search: window.location.search, hash: window.location.hash };
}

/**
 * The one task panel for every page (redesign S3). The URL is the state:
 * `?task=<id>` opens it (a link, a reload, Back all work), and this provider
 * only writes the URL. Opening from a closed panel adds a history entry so
 * Back closes it; ↑ / ↓ and a second open replace it. Saves refresh the page
 * (server-rendered sections re-read) and tell subscribed lists.
 */
export function TaskPanelProvider({ widths, children }: { widths: PanelWidths; children: ReactNode }) {
  const router = useRouter();
  const seeds = useRef(new Map<string, TaskWithImplementation>());
  const listeners = useRef(new Set<TaskPanelEvents>());
  /** The open panel's history entry is ours (pushed when it opened), so closing can step back. */
  const pushedRef = useRef(false);
  const changedRef = useRef(false);
  const refreshTimer = useRef<number | null>(null);
  const commitmentsRef = useRef<Promise<CommitmentSummary[]> | null>(null);

  const openContext = useRef<{ list: Element | null; opener: HTMLElement | null; scrollY: number }>({ list: null, opener: null, scrollY: 0 });

  // A click on a task card (anything carrying data-task-open, outside the panel) records its list
  // and the control clicked, before the panel exists.
  useEffect(() => {
    function onClick(event: MouseEvent) {
      const target = event.target instanceof Element ? event.target : null;
      const card = target?.closest("[data-task-open]");
      if (!card || card.closest(".tp-panel")) return;
      const control = target?.closest("button, a");
      openContext.current = {
        list: card.closest("[data-task-list]"),
        opener: control instanceof HTMLElement ? control : null,
        scrollY: openContext.current.scrollY,
      };
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  const scheduleRefresh = useCallback(() => {
    changedRef.current = true;
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      router.refresh();
    }, 600);
  }, [router]);

  const openedAt = useRef(0);

  const openTask = useCallback((task: string | TaskWithImplementation) => {
    openedAt.current = Date.now();
    const id = typeof task === "string" ? task : task.id;
    if (typeof task !== "string") seeds.current.set(task.id, task);
    const here = currentLocation();
    const alreadyOpen = new URLSearchParams(here.search).has(TASK_PARAM);
    // The phone sheet hides the page under it; this is where to put the page back on close.
    if (!alreadyOpen) openContext.current.scrollY = window.scrollY;
    const href = hrefWithTask(here.pathname, here.search, id, here.hash);
    if (alreadyOpen) {
      window.history.replaceState(null, "", href);
    } else {
      window.history.pushState(null, "", href);
      pushedRef.current = true;
    }
  }, []);

  const closeTask = useCallback(() => {
    const here = currentLocation();
    const params = new URLSearchParams(here.search);
    if (!params.has(TASK_PARAM) && !params.has(LEGACY_EXPAND_PARAM)) return;
    if (pushedRef.current) {
      pushedRef.current = false;
      window.history.back();
    } else {
      window.history.replaceState(null, "", hrefWithTask(here.pathname, here.search, null, here.hash));
    }
    if (changedRef.current) {
      changedRef.current = false;
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
      router.refresh();
    }
  }, [router]);

  const seedTasks = useCallback((tasks: TaskWithImplementation[]) => {
    for (const task of tasks) seeds.current.set(task.id, task);
  }, []);

  const subscribe = useCallback((events: TaskPanelEvents) => {
    listeners.current.add(events);
    return () => {
      listeners.current.delete(events);
    };
  }, []);

  const value = useMemo<TaskPanelContextValue>(
    () => ({
      openTask,
      closeTask,
      seedTasks,
      subscribe,
      getSeed: (taskId) => seeds.current.get(taskId) ?? null,
      getSeedList: () => Array.from(seeds.current.values()),
      loadCommitments: () => {
        if (!commitmentsRef.current) {
          commitmentsRef.current = fetch("/api/commitments?include_done=true", { cache: "no-store" })
            .then((response) => (response.ok ? response.json() : []))
            .then((rows: unknown) => (Array.isArray(rows) ? (rows as CommitmentSummary[]) : []))
            .catch(() => {
              commitmentsRef.current = null;
              return [];
            });
        }
        return commitmentsRef.current;
      },
      emitUpdated: (taskId, updates) => {
        const seed = seeds.current.get(taskId);
        if (seed) seeds.current.set(taskId, { ...seed, ...updates } as TaskWithImplementation);
        listeners.current.forEach((listener) => listener.onTaskUpdated?.(taskId, updates));
        scheduleRefresh();
      },
      emitDeleted: (taskId) => {
        seeds.current.delete(taskId);
        listeners.current.forEach((listener) => listener.onTaskDeleted?.(taskId));
        scheduleRefresh();
      },
      emitDatesChanged: (changes) => {
        listeners.current.forEach((listener) => listener.onDatesChanged?.(changes));
        scheduleRefresh();
      },
      markChanged: () => scheduleRefresh(),
      getOpenContext: () => openContext.current,
      openedHere: () => Date.now() - openedAt.current < 1500,
    }),
    [openTask, closeTask, seedTasks, subscribe, scheduleRefresh]
  );

  return (
    <TaskPanelContext.Provider value={value}>
      {children}
      {/* useSearchParams needs a Suspense boundary on static pages; dynamic pages render it on the server. */}
      <Suspense fallback={null}>
        <TaskPanelHost widths={widths} />
      </Suspense>
    </TaskPanelContext.Provider>
  );
}

function TaskPanelHost({ widths }: { widths: PanelWidths }) {
  const params = useSearchParams();
  const pathname = usePathname() ?? "/";
  const taskId = taskIdFromParams(params, pathname);
  const screen = panelScreenForPath(pathname);
  // Widths start from the cookies the server read; a resize updates them here too,
  // because the layout's props don't re-render on client navigation.
  const [known, setKnown] = useState<PanelWidths>(widths);
  const saveWidth = useCallback((width: number) => setKnown((current) => ({ ...current, [screen]: width })), [screen]);

  // The old Tasks link (?expand=<id>) becomes ?task=<id>, so closing the panel can't reopen it.
  const legacy = params?.get(LEGACY_EXPAND_PARAM) ?? null;
  const direct = params?.get(TASK_PARAM) ?? null;
  useEffect(() => {
    if (taskId && legacy && !direct) {
      const here = currentLocation();
      window.history.replaceState(null, "", hrefWithTask(here.pathname, here.search, taskId, here.hash));
    }
  }, [taskId, legacy, direct]);

  if (!taskId) return null;
  return <TaskPanel key={screen} taskId={taskId} screen={screen} initialWidth={known[screen]} onWidthSaved={saveWidth} />;
}
