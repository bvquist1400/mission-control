"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Modal } from "@/components/ui/Modal";
import type { TaskCardData } from "@/components/tasks/TaskCard";
import { TaskCreateForm } from "@/components/tasks/TaskCreateForm";
import { getTaskVisualState, TaskStateBadge } from "@/components/tasks/task-state";
import { useTodayModal } from "@/components/today/TodayModalProvider";
import { useSprints } from "@/hooks/useSprints";
import type { ImplementationSummary, TaskWithImplementation } from "@/types/database";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";
import {
  addDateOnlyDays,
  getDisplayedWeekRange,
  isDueAtInWeekStarting,
} from "@/lib/today/week-board";

const TIME_ZONE = DEFAULT_WORKDAY_CONFIG.timezone;

type WeekColumnKey = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "weekend";

interface WeekBoardTaskData extends TaskCardData {
  priorityScore: number;
  projectName: string | null;
  waitingOn: string | null;
  followUpAt: string | null;
  needsReview: boolean;
  dependencyBlocked: boolean;
}

interface WeekBoardColumn {
  key: WeekColumnKey;
  title: string;
  subtitle: string;
  tasks: WeekBoardTaskData[];
  dueDate: string;
  isCurrentDay: boolean;
}

interface WaitingTask {
  id: string;
  title: string;
  waitingOn: string;
  followUpAt: string | null;
}

interface WeekBoardProps {
  weekBoardTasks: TaskWithImplementation[];
  waitingTasks: TaskWithImplementation[];
  needsReviewCount: number;
  syncedTaskIds: string[];
  updatedAt: string;
  hasError: boolean;
}

function taskToCardData(
  task: TaskWithImplementation,
  dueState: TaskCardData["dueState"],
  syncedToday: boolean
): TaskCardData {
  return {
    id: task.id,
    title: task.title,
    tags: task.tags ?? [],
    estimatedMinutes: task.estimated_minutes,
    dueAt: task.due_at,
    dueState,
    status: task.status,
    blocker: task.blocker,
    pinned: Boolean(task.pinned),
    syncedToday,
    implementationName: task.implementation?.name ?? null,
    dependencyBlocked: Boolean(task.dependency_blocked),
    updatedAt: task.updated_at ?? null,
  };
}

function taskToWeekBoardData(
  task: TaskWithImplementation,
  dueState: TaskCardData["dueState"],
  syncedToday: boolean
): WeekBoardTaskData {
  return {
    ...taskToCardData(task, dueState, syncedToday),
    priorityScore: task.priority_score,
    projectName: task.project?.name ?? null,
    waitingOn: task.waiting_on,
    followUpAt: task.follow_up_at,
    needsReview: task.needs_review,
    dependencyBlocked: Boolean(task.dependency_blocked),
  };
}

function taskToWaitingTask(
  task: Pick<TaskWithImplementation, "id" | "title" | "waiting_on" | "follow_up_at">
): WaitingTask {
  return {
    id: task.id,
    title: task.title,
    waitingOn: task.waiting_on || "Unknown",
    followUpAt: task.follow_up_at,
  };
}

function getDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  return `${year}-${month}-${day}`;
}

function getDueState(dueAt: string | null, now: Date, timeZone: string): TaskCardData["dueState"] {
  if (!dueAt) {
    return null;
  }

  const dueDate = new Date(dueAt);
  if (dueDate.getTime() < now.getTime()) {
    return "Overdue";
  }

  const dueDay = getDateInTimeZone(dueDate, timeZone);
  const todayDay = getDateInTimeZone(now, timeZone);
  if (dueDay === todayDay) {
    return "Due Today";
  }

  return "Due Soon";
}

function formatDateOnlyLabel(dateOnly: string, includeYear = false): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(new Date(`${dateOnly}T12:00:00Z`));
}

function buildDateOnlyDueAt(dateOnly: string): string {
  return `${dateOnly}T23:59:59.999Z`;
}

function compareTasksByDueThenPriority(a: WeekBoardTaskData, b: WeekBoardTaskData): number {
  const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
  const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;

  if (aDue !== bDue) {
    return aDue - bDue;
  }

  if (a.priorityScore !== b.priorityScore) {
    return b.priorityScore - a.priorityScore;
  }

  return a.title.localeCompare(b.title);
}

function buildWeekBoardColumns(
  tasks: WeekBoardTaskData[],
  weekStart: string,
  todayDate: string
): WeekBoardColumn[] {
  const monday = weekStart;
  const tuesday = addDateOnlyDays(weekStart, 1);
  const wednesday = addDateOnlyDays(weekStart, 2);
  const thursday = addDateOnlyDays(weekStart, 3);
  const friday = addDateOnlyDays(weekStart, 4);
  const saturday = addDateOnlyDays(weekStart, 5);
  const sunday = addDateOnlyDays(weekStart, 6);
  const grouped: Record<WeekColumnKey, WeekBoardTaskData[]> = {
    monday: [],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    weekend: [],
  };

  for (const task of tasks) {
    if (!task.dueAt) {
      continue;
    }

    const dueDate = getDateInTimeZone(new Date(task.dueAt), TIME_ZONE);
    if (dueDate <= monday) {
      grouped.monday.push(task);
    } else if (dueDate === tuesday) {
      grouped.tuesday.push(task);
    } else if (dueDate === wednesday) {
      grouped.wednesday.push(task);
    } else if (dueDate === thursday) {
      grouped.thursday.push(task);
    } else if (dueDate === friday) {
      grouped.friday.push(task);
    } else if (dueDate === saturday || dueDate === sunday) {
      grouped.weekend.push(task);
    }
  }

  return [
    {
      key: "monday",
      title: "Monday",
      subtitle: formatDateOnlyLabel(monday),
      tasks: grouped.monday.sort(compareTasksByDueThenPriority),
      dueDate: monday,
      isCurrentDay: monday === todayDate,
    },
    {
      key: "tuesday",
      title: "Tuesday",
      subtitle: formatDateOnlyLabel(tuesday),
      tasks: grouped.tuesday.sort(compareTasksByDueThenPriority),
      dueDate: tuesday,
      isCurrentDay: tuesday === todayDate,
    },
    {
      key: "wednesday",
      title: "Wednesday",
      subtitle: formatDateOnlyLabel(wednesday),
      tasks: grouped.wednesday.sort(compareTasksByDueThenPriority),
      dueDate: wednesday,
      isCurrentDay: wednesday === todayDate,
    },
    {
      key: "thursday",
      title: "Thursday",
      subtitle: formatDateOnlyLabel(thursday),
      tasks: grouped.thursday.sort(compareTasksByDueThenPriority),
      dueDate: thursday,
      isCurrentDay: thursday === todayDate,
    },
    {
      key: "friday",
      title: "Friday",
      subtitle: formatDateOnlyLabel(friday),
      tasks: grouped.friday.sort(compareTasksByDueThenPriority),
      dueDate: friday,
      isCurrentDay: friday === todayDate,
    },
    {
      key: "weekend",
      title: "Weekend",
      subtitle: `${formatDateOnlyLabel(saturday)} - ${formatDateOnlyLabel(sunday)}`,
      tasks: grouped.weekend.sort(compareTasksByDueThenPriority),
      dueDate: saturday,
      isCurrentDay: saturday === todayDate || sunday === todayDate,
    },
  ];
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(new Date(value));
}

function formatUpdatedTime(updatedAt: string, timeZone: string): string {
  const updatedDate = new Date(updatedAt);
  if (Number.isNaN(updatedDate.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(updatedDate);
}

function getBoardEdgeClass(task: WeekBoardTaskData): string {
  if (task.dueState === "Overdue") {
    return "border-l-red-400";
  }

  if (task.dueState === "Due Today") {
    return "border-l-accent";
  }

  if (task.status === "Blocked/Waiting" || task.blocker || task.dependencyBlocked || task.needsReview) {
    return "border-l-amber-400";
  }

  return "border-l-stroke";
}

async function markTaskDone(taskId: string): Promise<void> {
  const response = await fetch(`/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "Done" }),
  });

  if (!response.ok) {
    throw new Error("Failed to mark task as done");
  }
}

async function setTaskPinned(taskId: string, pinned: boolean): Promise<void> {
  const response = await fetch(`/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pinned }),
  });

  if (!response.ok) {
    throw new Error("Failed to update pinned state");
  }
}

async function setTaskDueAt(taskId: string, dueAt: string): Promise<void> {
  const response = await fetch(`/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ due_at: dueAt }),
  });

  if (!response.ok) {
    throw new Error("Failed to move task");
  }
}

function WeeklyTaskCard({
  task,
  completing,
  pinning,
  moving,
  dragging,
  onOpen,
  onDone,
  onTogglePinned,
  onDragStart,
  onDragEnd,
}: {
  task: WeekBoardTaskData;
  completing: boolean;
  pinning: boolean;
  moving: boolean;
  dragging: boolean;
  onOpen: () => void;
  onDone: () => void;
  onTogglePinned: (taskId: string, nextPinned: boolean) => void | Promise<void>;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
}) {
  return (
    <article
      draggable={!completing && !pinning && !moving}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", task.id);
        onDragStart(task.id);
      }}
      onDragEnd={onDragEnd}
      className={`cursor-grab rounded-xl border border-l-4 border-stroke bg-panel p-2.5 shadow-sm transition-colors hover:border-foreground/20 hover:bg-panel-muted/50 active:cursor-grabbing ${
        dragging ? "opacity-50" : ""
      } ${moving ? "opacity-60" : ""} ${getBoardEdgeClass(task)}`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="block w-full text-left focus:outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <h3 className="text-sm font-semibold leading-snug text-foreground">{task.title}</h3>
        {(() => {
          const state = getTaskVisualState({
            status: task.status,
            dependencyBlocked: task.dependencyBlocked,
            updatedAt: task.updatedAt,
          });
          return state ? <TaskStateBadge state={state} className="mt-1" /> : null;
        })()}
      </button>

      <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
        <button
          type="button"
          onClick={onDone}
          disabled={completing}
          aria-label="Mark task complete"
          className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-1.5 text-xs font-semibold text-green-400 transition hover:border-green-500/50 hover:bg-green-500/20 disabled:opacity-50"
        >
          {moving ? "Moving..." : completing ? "Marking..." : "✓ Done"}
        </button>
        <button
          type="button"
          onClick={() => onTogglePinned(task.id, !task.pinned)}
          disabled={pinning}
          aria-label={task.pinned ? "Unpin task from Today" : "Pin task to Today"}
          className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${
            task.pinned
              ? "border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/20"
              : "border-stroke bg-panel-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          {pinning ? "..." : "Pin"}
        </button>
      </div>
    </article>
  );
}

function WeeklyBoardColumn({
  column,
  completingIds,
  pinningIds,
  movingIds,
  draggingTaskId,
  dropTargetKey,
  onOpenTask,
  onDoneTask,
  onTogglePinned,
  onDragStartTask,
  onDragEndTask,
  onDropTask,
  onDropTargetChange,
  onCreateTask,
}: {
  column: WeekBoardColumn;
  completingIds: Set<string>;
  pinningIds: Set<string>;
  movingIds: Set<string>;
  draggingTaskId: string | null;
  dropTargetKey: WeekColumnKey | null;
  onOpenTask: (taskId: string) => void;
  onDoneTask: (taskId: string) => void;
  onTogglePinned: (taskId: string, nextPinned: boolean) => void | Promise<void>;
  onDragStartTask: (taskId: string) => void;
  onDragEndTask: () => void;
  onDropTask: (taskId: string, dueDate: string) => void;
  onDropTargetChange: (key: WeekColumnKey | null) => void;
  onCreateTask?: (dueDate: string) => void;
}) {
  const isDropTarget = dropTargetKey === column.key;

  return (
    <section
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (dropTargetKey !== column.key) {
          onDropTargetChange(column.key);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onDropTargetChange(null);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        const taskId = event.dataTransfer.getData("text/plain");
        onDropTargetChange(null);
        if (taskId) {
          onDropTask(taskId, column.dueDate);
        }
      }}
      className={`min-w-0 rounded-card border p-3 transition-colors ${
        isDropTarget
          ? "border-accent bg-accent-soft/40"
          : column.isCurrentDay
            ? "border-accent/50 bg-accent-soft/30"
            : "border-stroke bg-background/50"
      }`}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {column.title}
            {column.isCurrentDay ? <span className="ml-2 text-[11px] font-bold text-red-200">Today</span> : null}
          </h3>
          <p className="text-xs text-muted-foreground">{column.subtitle}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="rounded-full border border-stroke bg-panel px-2 py-0.5 text-xs font-bold text-foreground">
            {column.tasks.length}
          </span>
          {onCreateTask ? (
            <button
              type="button"
              onClick={() => onCreateTask(column.dueDate)}
              aria-label={`Add task due ${column.title}, ${column.subtitle}`}
              title={`Add task due ${column.title}`}
              className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-stroke bg-panel text-sm font-bold text-muted-foreground transition hover:border-accent/50 hover:bg-accent-soft hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              +
            </button>
          ) : null}
        </div>
      </div>

      {column.tasks.length === 0 ? (
        <p className="rounded-lg border border-dashed border-stroke bg-panel/50 px-3 py-5 text-center text-xs text-muted-foreground">
          No tasks here.
        </p>
      ) : (
        <div className="space-y-3">
          {column.tasks.map((task) => (
            <WeeklyTaskCard
              key={task.id}
              task={task}
              completing={completingIds.has(task.id)}
              pinning={pinningIds.has(task.id)}
              moving={movingIds.has(task.id)}
              dragging={draggingTaskId === task.id}
              onOpen={() => onOpenTask(task.id)}
              onDone={() => onDoneTask(task.id)}
              onTogglePinned={onTogglePinned}
              onDragStart={onDragStartTask}
              onDragEnd={onDragEndTask}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function OverdueQueueSection({
  tasks,
  updatedAt,
  hasError,
  completingIds,
  pinningIds,
  movingIds,
  draggingTaskId,
  onOpenTask,
  onDoneTask,
  onTogglePinned,
  onDragStartTask,
  onDragEndTask,
  onHide,
  sectionRef,
}: {
  tasks: WeekBoardTaskData[];
  updatedAt: string;
  hasError: boolean;
  completingIds: Set<string>;
  pinningIds: Set<string>;
  movingIds: Set<string>;
  draggingTaskId: string | null;
  onOpenTask: (taskId: string) => void;
  onDoneTask: (taskId: string) => void;
  onTogglePinned: (taskId: string, nextPinned: boolean) => void | Promise<void>;
  onDragStartTask: (taskId: string) => void;
  onDragEndTask: () => void;
  onHide: () => void;
  sectionRef: { current: HTMLElement | null };
}) {
  return (
    <section
      id="overdue-queue"
      ref={sectionRef}
      className="rounded-card border border-red-500/30 bg-red-500/10 p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-red-100">Overdue Queue</h3>
          <p className="text-sm text-red-100/80">
            Older overdue work lives here so the weekday board stays focused on the current week.
          </p>
          <p className="mt-1 text-xs text-red-100/70">Updated {formatUpdatedTime(updatedAt, TIME_ZONE)}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-red-400/30 bg-red-500/10 px-2 py-0.5 text-xs font-bold text-red-100">
            {tasks.length}
          </span>
          <button
            type="button"
            onClick={onHide}
            className="rounded-md border border-red-400/30 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-100 transition hover:bg-red-500/20"
          >
            Hide
          </button>
        </div>
      </div>

      {hasError ? (
        <p className="mt-3 rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Overdue queue refresh failed. Showing available data.
        </p>
      ) : null}

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {tasks.map((task) => (
          <WeeklyTaskCard
            key={task.id}
            task={task}
            completing={completingIds.has(task.id)}
            pinning={pinningIds.has(task.id)}
            moving={movingIds.has(task.id)}
            dragging={draggingTaskId === task.id}
            onOpen={() => onOpenTask(task.id)}
            onDone={() => onDoneTask(task.id)}
            onTogglePinned={onTogglePinned}
            onDragStart={onDragStartTask}
            onDragEnd={onDragEndTask}
          />
        ))}
      </div>
    </section>
  );
}

function WaitingReviewColumn({
  waitingOn,
  needsReviewCount,
  updatedAt,
  hasError,
  onOpenTask,
}: {
  waitingOn: WaitingTask[];
  needsReviewCount: number;
  updatedAt: string;
  hasError: boolean;
  onOpenTask: (taskId: string) => void;
}) {
  const total = waitingOn.length + needsReviewCount;

  return (
    <section className="min-w-0 rounded-card border border-stroke bg-background/50 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Waiting / Review</h3>
          <p className="text-xs text-muted-foreground">Updated {formatUpdatedTime(updatedAt, TIME_ZONE)}</p>
        </div>
        <span className="rounded-full border border-stroke bg-panel px-2 py-0.5 text-xs font-bold text-foreground">{total}</span>
      </div>

      {hasError ? (
        <p className="mb-3 rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          Waiting list refresh failed. Showing available data.
        </p>
      ) : null}

      <div className="space-y-3">
        {waitingOn.slice(0, 5).map((item) => (
          <article key={item.id} className="rounded-card border border-l-4 border-stroke border-l-amber-400 bg-panel p-3 shadow-sm">
            <button
              type="button"
              onClick={() => onOpenTask(item.id)}
              className="block w-full text-left focus:outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              <h3 className="text-sm font-semibold leading-relaxed text-foreground">{item.title}</h3>
              <p className="mt-2 text-xs text-muted-foreground">
                Waiting on {item.waitingOn}
                {item.followUpAt ? ` · follow up ${formatDate(item.followUpAt)}` : ""}
              </p>
              <span className="mt-3 inline-flex rounded-md border border-stroke bg-panel-muted px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-panel">
                Open Task
              </span>
            </button>
          </article>
        ))}

        {needsReviewCount > 0 ? (
          <article className="rounded-card border border-l-4 border-stroke border-l-amber-400 bg-panel p-3 shadow-sm">
            <h3 className="text-sm font-semibold leading-relaxed text-foreground">
              {needsReviewCount} {needsReviewCount === 1 ? "task needs" : "tasks need"} review
            </h3>
            <p className="mt-2 text-xs text-muted-foreground">Review queue remains one click away from the board.</p>
            <Link
              href="/backlog?review=needs_review"
              className="mt-3 inline-flex rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
            >
              Open Review Queue
            </Link>
          </article>
        ) : null}

        {waitingOn.length === 0 && needsReviewCount === 0 ? (
          <p className="rounded-lg border border-dashed border-stroke bg-panel/50 px-3 py-5 text-center text-xs text-muted-foreground">
            Nothing blocked or waiting for review.
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function WeekBoard({
  weekBoardTasks,
  waitingTasks,
  needsReviewCount,
  syncedTaskIds,
  updatedAt,
  hasError,
}: WeekBoardProps) {
  const router = useRouter();
  const { openTask, registerTasks } = useTodayModal();
  const { sprints } = useSprints();

  const [tasks, setTasks] = useState<TaskWithImplementation[]>(weekBoardTasks);
  const [waiting, setWaiting] = useState<TaskWithImplementation[]>(waitingTasks);
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());
  const [pinningIds, setPinningIds] = useState<Set<string>>(new Set());
  const [movingIds, setMovingIds] = useState<Set<string>>(new Set());
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<WeekColumnKey | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [showOverdueQueue, setShowOverdueQueue] = useState(false);
  const [scrollToOverdueQueue, setScrollToOverdueQueue] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);
  const [weekLoading, setWeekLoading] = useState(false);
  const [createDueDate, setCreateDueDate] = useState<string | null>(null);
  const [implementations, setImplementations] = useState<ImplementationSummary[]>([]);
  const [implementationsLoading, setImplementationsLoading] = useState(false);
  const [implementationsLoadRequest, setImplementationsLoadRequest] = useState(0);
  const [implementationsError, setImplementationsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const overdueQueueRef = useRef<HTMLElement | null>(null);

  // Reconcile local optimistic state with freshly streamed server props.
  useEffect(() => {
    const currentWeekEnd = getDisplayedWeekRange(new Date(), TIME_ZONE).end;
    setTasks((current) => [
      ...current.filter((task) => {
        if (!task.due_at) {
          return false;
        }
        return getDateInTimeZone(new Date(task.due_at), TIME_ZONE) > currentWeekEnd;
      }),
      ...weekBoardTasks,
    ]);
  }, [weekBoardTasks]);

  useEffect(() => {
    setWaiting(waitingTasks);
  }, [waitingTasks]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    registerTasks([...tasks, ...waiting]);
  }, [tasks, waiting, registerTasks]);

  const syncedSet = useMemo(() => new Set(syncedTaskIds), [syncedTaskIds]);
  const now = new Date(nowMs);
  const currentWeekRange = getDisplayedWeekRange(now, TIME_ZONE);
  const selectedWeekStart = addDateOnlyDays(currentWeekRange.start, weekOffset * 7);
  const selectedWeekEnd = addDateOnlyDays(selectedWeekStart, 6);
  const todayDate = getDateInTimeZone(now, TIME_ZONE);
  const isCurrentWeek = weekOffset === 0;
  const selectedWeekLabel = `${formatDateOnlyLabel(selectedWeekStart)} – ${formatDateOnlyLabel(selectedWeekEnd, true)}`;

  const weekBoard = useMemo(
    () => tasks.map((task) => taskToWeekBoardData(task, getDueState(task.due_at, now, TIME_ZONE), syncedSet.has(task.id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, syncedSet, nowMs]
  );

  const waitingOn = useMemo(() => waiting.map(taskToWaitingTask), [waiting]);

  const overdueTasks = weekBoard.filter((task) => task.dueState === "Overdue");
  const scheduledWeekTasks = weekBoard.filter((task) =>
    isDueAtInWeekStarting(task.dueAt, selectedWeekStart, TIME_ZONE)
  );
  const weekColumns = buildWeekBoardColumns(scheduledWeekTasks, selectedWeekStart, todayDate);
  const weekdayColumns = weekColumns.filter((column) => column.key !== "weekend");
  const weekendColumn = weekColumns.find((column) => column.key === "weekend") ?? null;
  const boardTaskCount = scheduledWeekTasks.length;
  const overdueCount = overdueTasks.length;
  const todayDueCount = scheduledWeekTasks.filter((task) => task.dueState === "Due Today").length;
  const boardMinutes = scheduledWeekTasks.reduce((sum, task) => sum + task.estimatedMinutes, 0);

  useEffect(() => {
    if (isCurrentWeek) {
      setWeekLoading(false);
      return;
    }

    const controller = new AbortController();
    const params = new URLSearchParams({
      view: "weekly_board",
      week_start_date: selectedWeekStart,
      week_end_date: selectedWeekEnd,
      limit: "300",
    });

    setWeekLoading(true);
    setError(null);
    fetch(`/api/tasks?${params.toString()}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Failed to load the selected week");
        }
        return response.json() as Promise<TaskWithImplementation[]>;
      })
      .then((selectedTasks) => {
        setTasks((current) => [
          ...current.filter((task) => !isDueAtInWeekStarting(task.due_at, selectedWeekStart, TIME_ZONE)),
          ...selectedTasks,
        ]);
      })
      .catch((loadError: unknown) => {
        if ((loadError as { name?: string }).name !== "AbortError") {
          setError(loadError instanceof Error ? loadError.message : "Failed to load the selected week");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setWeekLoading(false);
        }
      });

    return () => controller.abort();
  }, [isCurrentWeek, selectedWeekEnd, selectedWeekStart]);

  useEffect(() => {
    if (!createDueDate || implementations.length > 0) {
      return;
    }

    const controller = new AbortController();
    setImplementationsLoading(true);
    setImplementationsError(null);
    fetch("/api/applications", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Failed to load applications");
        }
        return response.json() as Promise<ImplementationSummary[]>;
      })
      .then((rows) => {
        setImplementationsLoading(false);
        setImplementations(Array.isArray(rows) ? rows : []);
      })
      .catch((loadError: unknown) => {
        if ((loadError as { name?: string }).name !== "AbortError") {
          setImplementationsLoading(false);
          setImplementationsError(loadError instanceof Error ? loadError.message : "Failed to load applications");
        }
      });

    return () => controller.abort();
  }, [createDueDate, implementations.length, implementationsLoadRequest]);

  useEffect(() => {
    if (overdueCount === 0 && showOverdueQueue) {
      setShowOverdueQueue(false);
    }
  }, [overdueCount, showOverdueQueue]);

  useEffect(() => {
    if (!showOverdueQueue || !scrollToOverdueQueue) {
      return;
    }

    overdueQueueRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    setScrollToOverdueQueue(false);
  }, [showOverdueQueue, scrollToOverdueQueue]);

  const handleOpenTask = useCallback(
    (taskId: string) => {
      const raw = tasks.find((task) => task.id === taskId) ?? waiting.find((task) => task.id === taskId);
      if (raw) {
        openTask(raw);
      }
    },
    [tasks, waiting, openTask]
  );

  async function handleQuickComplete(taskId: string) {
    if (completingIds.has(taskId)) {
      return;
    }
    if (!window.confirm("Mark as done?")) {
      return;
    }

    setCompletingIds((prev) => new Set(prev).add(taskId));
    setError(null);
    // Optimistically drop the task from both lists.
    setTasks((prev) => prev.filter((task) => task.id !== taskId));
    setWaiting((prev) => prev.filter((task) => task.id !== taskId));

    try {
      await markTaskDone(taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to complete task");
    } finally {
      setCompletingIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
      router.refresh();
    }
  }

  async function handleTogglePinned(taskId: string, nextPinned: boolean) {
    if (pinningIds.has(taskId)) {
      return;
    }

    setPinningIds((prev) => new Set(prev).add(taskId));
    setError(null);
    setTasks((prev) => prev.map((task) => (task.id === taskId ? { ...task, pinned: nextPinned } : task)));

    try {
      await setTaskPinned(taskId, nextPinned);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update pin state");
    } finally {
      setPinningIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
      router.refresh();
    }
  }

  async function handleMoveTask(taskId: string, dateOnly: string) {
    if (movingIds.has(taskId)) {
      return;
    }

    const task = tasks.find((item) => item.id === taskId);
    if (!task) {
      return;
    }

    const nextDueAt = buildDateOnlyDueAt(dateOnly);
    if (task.due_at === nextDueAt) {
      return;
    }

    setMovingIds((prev) => new Set(prev).add(taskId));
    setError(null);
    setTasks((prev) => prev.map((item) => (item.id === taskId ? { ...item, due_at: nextDueAt } : item)));

    try {
      await setTaskDueAt(taskId, nextDueAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to move task");
    } finally {
      setMovingIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
      setDraggingTaskId(null);
      setDropTargetKey(null);
      router.refresh();
    }
  }

  function handleOpenOverdueQueue() {
    if (overdueCount === 0) {
      return;
    }
    setShowOverdueQueue(true);
    setScrollToOverdueQueue(true);
  }

  function handleTaskCreated(task: TaskWithImplementation) {
    setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
    setError(null);
    router.refresh();
  }

  return (
    <div className="space-y-8">
      {error && <ErrorBanner message={error} />}

      <section className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <article className="rounded-xl border border-stroke bg-panel px-3 py-2 shadow-sm">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
              {isCurrentWeek ? "This Week" : "Selected Week"}
            </p>
            <p className="mt-0.5 text-sm font-semibold text-foreground">
              {boardTaskCount} <span className="font-medium text-muted-foreground">tasks · {boardMinutes} min</span>
            </p>
          </article>
          <button
            type="button"
            onClick={handleOpenOverdueQueue}
            disabled={overdueCount === 0}
            aria-controls="overdue-queue"
            aria-expanded={showOverdueQueue}
            className={`rounded-xl border px-3 py-2 text-left shadow-sm transition ${
              overdueCount > 0
                ? "border-red-500/30 bg-red-500/10 hover:bg-red-500/15"
                : "cursor-default border-red-500/20 bg-red-500/5 opacity-70"
            }`}
          >
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-red-300">Overdue</p>
            <p className="mt-0.5 text-sm font-semibold text-red-200">
              {overdueCount} {overdueCount === 1 ? "task needs" : "tasks need"} attention
            </p>
            <p className="mt-1 text-[11px] font-medium text-red-100/80">
              {overdueCount > 0 ? "Open overdue queue" : "Nothing overdue"}
            </p>
          </button>
          <article className="rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 shadow-sm">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-red-200">
              {isCurrentWeek ? "Due Today" : "Viewing"}
            </p>
            <p className="mt-0.5 text-sm font-semibold text-foreground">
              {isCurrentWeek
                ? `${todayDueCount} ${todayDueCount === 1 ? "task" : "tasks"} due today`
                : selectedWeekLabel}
            </p>
          </article>
        </div>

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Weekly Board</h2>
            <p className="text-xs text-muted-foreground">
              {selectedWeekLabel} · Updated {formatUpdatedTime(updatedAt, TIME_ZONE)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setWeekOffset((current) => current - 1)}
              aria-label="View previous week"
              className="rounded-lg border border-stroke bg-panel px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
            >
              ← Previous
            </button>
            {!isCurrentWeek ? (
              <button
                type="button"
                onClick={() => setWeekOffset(0)}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
              >
                Current week
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setWeekOffset((current) => current + 1)}
              aria-label="View next week"
              className="rounded-lg border border-stroke bg-panel px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
            >
              Next →
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 text-[11px] font-semibold">
          <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-1 text-red-300">Red queue = overdue</span>
          <span className="rounded-full border border-accent/40 bg-accent-soft px-2 py-1 text-red-100">Accent = due today</span>
          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-200">Amber = blocked / waiting / review</span>
        </div>

        {hasError ? (
          <p className="rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            Weekly board refresh failed. Showing available data.
          </p>
        ) : null}

        {weekLoading ? (
          <p className="rounded-md border border-stroke bg-panel-muted px-3 py-2 text-xs text-muted-foreground" role="status">
            Loading {selectedWeekLabel}…
          </p>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {weekdayColumns.map((column) => (
            <WeeklyBoardColumn
              key={column.key}
              column={column}
              completingIds={completingIds}
              pinningIds={pinningIds}
              movingIds={movingIds}
              draggingTaskId={draggingTaskId}
              dropTargetKey={dropTargetKey}
              onOpenTask={handleOpenTask}
              onDoneTask={handleQuickComplete}
              onTogglePinned={handleTogglePinned}
              onDragStartTask={setDraggingTaskId}
              onDragEndTask={() => {
                setDraggingTaskId(null);
                setDropTargetKey(null);
              }}
              onDropTask={handleMoveTask}
              onDropTargetChange={setDropTargetKey}
              onCreateTask={setCreateDueDate}
            />
          ))}
        </div>

        {showOverdueQueue && overdueTasks.length > 0 ? (
          <OverdueQueueSection
            tasks={overdueTasks}
            updatedAt={updatedAt}
            hasError={hasError}
            completingIds={completingIds}
            pinningIds={pinningIds}
            movingIds={movingIds}
            draggingTaskId={draggingTaskId}
            onOpenTask={handleOpenTask}
            onDoneTask={handleQuickComplete}
            onTogglePinned={handleTogglePinned}
            onDragStartTask={setDraggingTaskId}
            onDragEndTask={() => {
              setDraggingTaskId(null);
              setDropTargetKey(null);
            }}
            onHide={() => setShowOverdueQueue(false)}
            sectionRef={overdueQueueRef}
          />
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
          {weekendColumn ? (
            <WeeklyBoardColumn
              column={weekendColumn}
              completingIds={completingIds}
              pinningIds={pinningIds}
              movingIds={movingIds}
              draggingTaskId={draggingTaskId}
              dropTargetKey={dropTargetKey}
              onOpenTask={handleOpenTask}
              onDoneTask={handleQuickComplete}
              onTogglePinned={handleTogglePinned}
              onDragStartTask={setDraggingTaskId}
              onDragEndTask={() => {
                setDraggingTaskId(null);
                setDropTargetKey(null);
              }}
              onDropTask={handleMoveTask}
              onDropTargetChange={setDropTargetKey}
            />
          ) : null}
          <WaitingReviewColumn
            waitingOn={waitingOn}
            needsReviewCount={needsReviewCount}
            updatedAt={updatedAt}
            hasError={hasError}
            onOpenTask={handleOpenTask}
          />
        </div>
      </section>

      <Modal
        open={createDueDate !== null}
        onClose={() => setCreateDueDate(null)}
        title={createDueDate ? `New Task · Due ${formatDateOnlyLabel(createDueDate, true)}` : "New Task"}
        size="wide"
      >
        {implementationsLoading ? (
          <p className="rounded-md border border-stroke bg-panel-muted px-3 py-4 text-sm text-muted-foreground" role="status">
            Loading task options…
          </p>
        ) : implementationsError ? (
          <div className="rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-3 text-sm text-amber-200">
            <p>{implementationsError}</p>
            <button
              type="button"
              onClick={() => setImplementationsLoadRequest((current) => current + 1)}
              className="mt-2 rounded-md border border-amber-400/30 bg-panel px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-panel-muted"
            >
              Retry
            </button>
          </div>
        ) : createDueDate ? (
          <TaskCreateForm
            key={createDueDate}
            implementations={implementations}
            sprints={sprints}
            defaultDueDate={createDueDate}
            initiallyOpen
            hideLauncher
            onTaskCreated={handleTaskCreated}
            onRequestClose={() => setCreateDueDate(null)}
          />
        ) : null}
      </Modal>
    </div>
  );
}
