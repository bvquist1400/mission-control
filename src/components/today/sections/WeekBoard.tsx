"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Modal } from "@/components/ui/Modal";
import type { TaskCardData } from "@/components/tasks/TaskCard";
import { TaskCreateForm } from "@/components/tasks/TaskCreateForm";
import { useTodayModal } from "@/components/today/TodayModalProvider";
import { useTaskMutation } from "@/hooks/useTaskMutation";
import { useDateCascade } from "@/components/tasks/DateCascadeProvider";
import { useSprints } from "@/hooks/useSprints";
import type { ImplementationSummary, TaskWithImplementation } from "@/types/database";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";
import { isPersonalTaskOrProject, PERSONAL_TAG, type TaskScope } from "@/lib/personal-exclusion";
import { PersonalBadge } from "@/components/ui/PersonalBadge";
import {
  addDateOnlyDays,
  getDisplayedWeekRange,
  isDueAtInWeekStarting,
} from "@/lib/today/week-board";
import { Button } from "@/components/ui/Button";
import { isPastDue } from "@/lib/task-range";
import { buildRangeCardView, type RangeCardView } from "@/lib/task-range-view";
import { progressRowsFor } from "@/lib/break-into-tasks";
import {
  dayStrip,
  laneContinuesText,
  laneCountsByColumn,
  laneStartedText,
  mergeTasksById,
  placeWeekTasks,
  rangeOverlapsWeek,
  type LanePlacement,
} from "@/lib/today/multi-day-board";
import { boardStepsId, WeeklyTaskCard, type WeekBoardTaskData } from "@/components/today/cards/BoardTaskCard";
import { DayStrip } from "@/components/tasks/TaskRangeParts";
import { InlineSteps } from "@/components/tasks/InlineSteps";

const TIME_ZONE = DEFAULT_WORKDAY_CONFIG.timezone;

type WeekColumnKey = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "weekend";

type ChecklistRows = NonNullable<TaskWithImplementation["checklist_rows"]>;

interface WeekBoardColumn {
  key: WeekColumnKey;
  title: string;
  subtitle: string;
  tasks: WeekBoardTaskData[];
  dueDate: string;
  isCurrentDay: boolean;
  /** Multi-day tasks covering this day (shown in the lane above, counted here). */
  laneCount: number;
}

/** Extra props a ranged card gets (steps pill + open steps); empty for other tasks. */
type RangeCardProps = (
  task: WeekBoardTaskData,
  context: string
) => Pick<ComponentProps<typeof WeeklyTaskCard>, "stepsOpen" | "onToggleSteps" | "steps" | "canDrag" | "context">;

interface LaneCard {
  placement: LanePlacement<TaskWithImplementation>;
  data: WeekBoardTaskData;
}

interface WaitingTask {
  id: string;
  title: string;
  waitingOn: string;
  followUpAt: string | null;
  isPersonal: boolean;
}

interface WeekBoardProps {
  weekBoardTasks: TaskWithImplementation[];
  waitingTasks: TaskWithImplementation[];
  needsReviewCount: number;
  syncedTaskIds: string[];
  updatedAt: string;
  hasError: boolean;
  mode: TaskScope;
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
  syncedToday: boolean,
  range: RangeCardView | null = null
): WeekBoardTaskData {
  return {
    ...taskToCardData(task, dueState, syncedToday),
    range,
    priorityScore: task.priority_score,
    projectName: task.project?.name ?? null,
    waitingOn: task.waiting_on,
    followUpAt: task.follow_up_at,
    isPersonal: isPersonalTaskOrProject(task),
    needsReview: task.needs_review,
    dependencyBlocked: Boolean(task.dependency_blocked),
  };
}

function taskToWaitingTask(task: TaskWithImplementation): WaitingTask {
  return {
    id: task.id,
    title: task.title,
    waitingOn: task.waiting_on || "Unknown",
    followUpAt: task.follow_up_at,
    isPersonal: isPersonalTaskOrProject(task),
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
  if (isPastDue(dueAt, now)) {
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
  todayDate: string,
  weekendRanges: WeekBoardTaskData[] = [],
  laneCounts: number[] = [0, 0, 0, 0, 0]
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
  // Multi-day ranges that touch this week only on Sat/Sun.
  grouped.weekend.push(...weekendRanges);

  return [
    {
      key: "monday",
      title: "Monday",
      subtitle: formatDateOnlyLabel(monday),
      tasks: grouped.monday.sort(compareTasksByDueThenPriority),
      dueDate: monday,
      isCurrentDay: monday === todayDate,
      laneCount: laneCounts[0] ?? 0,
    },
    {
      key: "tuesday",
      title: "Tuesday",
      subtitle: formatDateOnlyLabel(tuesday),
      tasks: grouped.tuesday.sort(compareTasksByDueThenPriority),
      dueDate: tuesday,
      isCurrentDay: tuesday === todayDate,
      laneCount: laneCounts[1] ?? 0,
    },
    {
      key: "wednesday",
      title: "Wednesday",
      subtitle: formatDateOnlyLabel(wednesday),
      tasks: grouped.wednesday.sort(compareTasksByDueThenPriority),
      dueDate: wednesday,
      isCurrentDay: wednesday === todayDate,
      laneCount: laneCounts[2] ?? 0,
    },
    {
      key: "thursday",
      title: "Thursday",
      subtitle: formatDateOnlyLabel(thursday),
      tasks: grouped.thursday.sort(compareTasksByDueThenPriority),
      dueDate: thursday,
      isCurrentDay: thursday === todayDate,
      laneCount: laneCounts[3] ?? 0,
    },
    {
      key: "friday",
      title: "Friday",
      subtitle: formatDateOnlyLabel(friday),
      tasks: grouped.friday.sort(compareTasksByDueThenPriority),
      dueDate: friday,
      isCurrentDay: friday === todayDate,
      laneCount: laneCounts[4] ?? 0,
    },
    {
      key: "weekend",
      title: "Weekend",
      subtitle: `${formatDateOnlyLabel(saturday)} - ${formatDateOnlyLabel(sunday)}`,
      tasks: grouped.weekend.sort(compareTasksByDueThenPriority),
      dueDate: saturday,
      isCurrentDay: saturday === todayDate || sunday === todayDate,
      laneCount: 0,
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
  rangeCardProps,
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
  rangeCardProps: RangeCardProps;
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
            {column.isCurrentDay ? <span className="ml-2 text-xs font-bold text-red-200">Today</span> : null}
          </h3>
          <p className="text-xs text-muted-foreground">{column.subtitle}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="rounded-full border border-stroke bg-panel px-2 py-0.5 text-xs font-bold text-foreground">
            {column.tasks.length + column.laneCount}
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
          {column.laneCount > 0 ? "No single-day tasks." : "No tasks here."}
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
              {...rangeCardProps(task, `col-${column.key}`)}
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
  rangeCardProps,
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
  rangeCardProps: RangeCardProps;
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
          <Button variant="danger" size="sm"
            onClick={onHide}>
            Hide
          </Button>
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
            {...rangeCardProps(task, "overdue")}
            canDrag
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
              {item.isPersonal ? <PersonalBadge className="mt-1" /> : null}
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
  mode,
}: WeekBoardProps) {
  const router = useRouter();
  const { openTask, registerTasks } = useTodayModal();
  const { sprints } = useSprints();

  const { completeTask, updateTask } = useTaskMutation();
  const dateCascade = useDateCascade();
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
  const [openStepsKey, setOpenStepsKey] = useState<string | null>(null);
  const overdueQueueRef = useRef<HTMLElement | null>(null);

  // A tick in a card's open steps: move the fill at once (the refresh that
  // follows brings the same rows from the server).
  const applyChecklistRows = useCallback((taskId: string, rows: ChecklistRows) => {
    setTasks((current) => current.map((task) => (task.id === taskId ? { ...task, checklist_rows: rows } : task)));
  }, []);

  // Reconcile local optimistic state with freshly streamed server props.
  useEffect(() => {
    const currentWeek = getDisplayedWeekRange(new Date(), TIME_ZONE);
    // Keep tasks loaded for later weeks; the streamed props own this week. A
    // multi-day task overlapping this week comes back in the props, so it's
    // dropped from the kept set and the merge never shows it twice.
    setTasks((current) =>
      mergeTasksById(
        current.filter((task) => {
          if (!task.due_at) {
            return false;
          }
          return (
            getDateInTimeZone(new Date(task.due_at), TIME_ZONE) > currentWeek.end &&
            !rangeOverlapsWeek(task, currentWeek.start)
          );
        }),
        weekBoardTasks
      )
    );
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
    () =>
      tasks.map((task) =>
        taskToWeekBoardData(
          task,
          getDueState(task.due_at, now, TIME_ZONE),
          syncedSet.has(task.id),
          (() => {
            // An umbrella (Break into tasks) counts its step tasks; others their checklist.
            const progress = progressRowsFor(task);
            return buildRangeCardView(task, progress.rows, now, { stepsAreTasks: progress.source === "tasks" });
          })()
        )
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, syncedSet, nowMs]
  );
  const weekBoardById = useMemo(() => new Map(weekBoard.map((task) => [task.id, task])), [weekBoard]);

  const waitingOn = useMemo(() => waiting.map(taskToWaitingTask), [waiting]);

  const overdueTasks = weekBoard.filter((task) => task.dueState === "Overdue");
  // Multi-day tasks S2: ranges overlapping Mon–Fri go in the lane (each once),
  // weekend-only ranges in the Weekend column, other tasks by due date as before.
  const placement = placeWeekTasks(tasks, selectedWeekStart, (task) =>
    isDueAtInWeekStarting(task.due_at, selectedWeekStart, TIME_ZONE)
  );
  const toBoardData = (task: TaskWithImplementation) => weekBoardById.get(task.id);
  const scheduledWeekTasks = placement.single.map(toBoardData).filter((task): task is WeekBoardTaskData => Boolean(task));
  const weekendRangeTasks = placement.weekendRanges.map(toBoardData).filter((task): task is WeekBoardTaskData => Boolean(task));
  const laneCards: LaneCard[] = placement.lane.flatMap((item) => {
    const data = weekBoardById.get(item.task.id);
    return data ? [{ placement: item, data }] : [];
  });
  const weekColumns = buildWeekBoardColumns(
    scheduledWeekTasks,
    selectedWeekStart,
    todayDate,
    weekendRangeTasks,
    laneCountsByColumn(placement.lane)
  );
  const weekdayColumns = weekColumns.filter((column) => column.key !== "weekend");
  const weekendColumn = weekColumns.find((column) => column.key === "weekend") ?? null;
  const shownWeekTasks = [...scheduledWeekTasks, ...weekendRangeTasks, ...laneCards.map((card) => card.data)];
  const boardTaskCount = shownWeekTasks.length;
  const overdueCount = overdueTasks.length;
  const todayDueCount = shownWeekTasks.filter((task) => task.dueState === "Due Today").length;
  const boardMinutes = shownWeekTasks.reduce((sum, task) => sum + task.estimatedMinutes, 0);
  const multiDayInProgress = laneCards.filter(
    (card) => card.data.range?.kind === "in_range" || card.data.range?.kind === "due_today"
  );
  const multiDayBehind = multiDayInProgress.filter((card) => card.data.range?.behindPace).length;

  const rangeCardProps: RangeCardProps = (task, context) => {
    const view = task.range;
    if (!view) {
      return {};
    }
    const key = `${context}:${task.id}`;
    const open = openStepsKey === key;
    return {
      context,
      // A real range changes its dates in the task window; an umbrella card without one drags like any task.
      canDrag: !view.isRange,
      stepsOpen: open,
      onToggleSteps: view.steps ? () => setOpenStepsKey((current) => (current === key ? null : key)) : undefined,
      steps: open ? (
        <InlineSteps
          id={boardStepsId(context, task.id)}
          taskId={task.id}
          view={view}
          compact
          stepTasks={view.steps?.basis === "tasks" ? tasks.find((candidate) => candidate.id === task.id)?.step_tasks : undefined}
          onRowsChange={(rows) => applyChecklistRows(task.id, rows)}
          onSaved={() => router.refresh()}
          onDone={() => handleQuickComplete(task.id)}
          doneDisabled={completingIds.has(task.id)}
        />
      ) : undefined,
    };
  };

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
      scope: mode,
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
        setTasks((current) =>
          mergeTasksById(
            current.filter(
              (task) =>
                !isDueAtInWeekStarting(task.due_at, selectedWeekStart, TIME_ZONE) &&
                !rangeOverlapsWeek(task, selectedWeekStart)
            ),
            selectedTasks
          )
        );
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
  }, [isCurrentWeek, mode, selectedWeekEnd, selectedWeekStart]);

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

    const task =
      tasks.find((item) => item.id === taskId) ?? waiting.find((item) => item.id === taskId);
    if (!task) {
      return;
    }
    const wasWaiting = waiting.some((item) => item.id === taskId);

    // Put the row back exactly where it came from, for both a failed request
    // and an undo. Guarded against double-insert if the server refresh wins the race.
    const restore = () => {
      const insert = (prev: TaskWithImplementation[]) =>
        prev.some((item) => item.id === taskId) ? prev : [task, ...prev];
      if (wasWaiting) {
        setWaiting(insert);
      } else {
        setTasks(insert);
      }
    };

    setCompletingIds((prev) => new Set(prev).add(taskId));
    setError(null);

    await completeTask(task, {
      onOptimistic: () => {
        setTasks((prev) => prev.filter((item) => item.id !== taskId));
        setWaiting((prev) => prev.filter((item) => item.id !== taskId));
      },
      onRollback: restore,
      onUndo: restore,
    });

    setCompletingIds((prev) => {
      const next = new Set(prev);
      next.delete(taskId);
      return next;
    });
  }

  async function handleTogglePinned(taskId: string, nextPinned: boolean) {
    if (pinningIds.has(taskId)) {
      return;
    }

    setPinningIds((prev) => new Set(prev).add(taskId));
    setError(null);

    const applyPinned = (pinned: boolean) =>
      setTasks((prev) => prev.map((task) => (task.id === taskId ? { ...task, pinned } : task)));

    await updateTask(
      taskId,
      { pinned: nextPinned },
      {
        onOptimistic: () => applyPinned(nextPinned),
        onRollback: () => applyPinned(!nextPinned),
        failureMessage: "Couldn't update the pin state.",
      }
    );

    setPinningIds((prev) => {
      const next = new Set(prev);
      next.delete(taskId);
      return next;
    });
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

    const previousDueAt = task.due_at;

    setMovingIds((prev) => new Set(prev).add(taskId));
    setError(null);

    const applyDueAt = (dueAt: string | null) =>
      setTasks((prev) => prev.map((item) => (item.id === taskId ? { ...item, due_at: dueAt } : item)));

    if (dateCascade) {
      // Cascade S2: the date saves at once; the toast (bottom right) lists the
      // tasks that moved with it, with Undo, "how far", and "Show next week"
      // when they left this week's board.
      await dateCascade.changeDueDate({
        taskId,
        title: task.title,
        previousDueAt,
        updates: { due_at: nextDueAt },
        onOptimistic: () => applyDueAt(nextDueAt),
        onRollback: () => applyDueAt(previousDueAt),
        onDatesChanged: (changes) => {
          const byId = new Map(changes.map((change) => [change.task_id, change.due_at]));
          setTasks((prev) => prev.map((item) => (byId.has(item.id) ? { ...item, due_at: byId.get(item.id) ?? null } : item)));
        },
        week: { weekStart: selectedWeekStart, showNextWeek: () => setWeekOffset((current) => current + 1) },
      });
    } else {
      await updateTask(
        taskId,
        { due_at: nextDueAt },
        {
          onOptimistic: () => applyDueAt(nextDueAt),
          onRollback: () => applyDueAt(previousDueAt),
          failureMessage: "Couldn't move the task.",
        }
      );
    }

    setMovingIds((prev) => {
      const next = new Set(prev);
      next.delete(taskId);
      return next;
    });
    setDraggingTaskId(null);
    setDropTargetKey(null);
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
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">
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
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-red-300">Overdue</p>
            <p className="mt-0.5 text-sm font-semibold text-red-200">
              {overdueCount} {overdueCount === 1 ? "task needs" : "tasks need"} attention
            </p>
            <p className="mt-1 text-xs font-medium text-red-100/80">
              {overdueCount > 0 ? "Open overdue queue" : "Nothing overdue"}
            </p>
          </button>
          <article className="rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 shadow-sm">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-red-200">
              {isCurrentWeek ? "Due Today" : "Viewing"}
            </p>
            <p className="mt-0.5 text-sm font-semibold text-foreground">
              {isCurrentWeek
                ? `${todayDueCount} ${todayDueCount === 1 ? "task" : "tasks"} due today`
                : selectedWeekLabel}
            </p>
          </article>
          {laneCards.length > 0 ? (
            <article className="rounded-xl border border-range-border bg-range-soft px-3 py-2 shadow-sm">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-range-text">Multi-day</p>
              <p className="mt-0.5 text-sm font-semibold text-foreground">
                {multiDayInProgress.length} in progress{" "}
                <span className="font-medium text-muted-foreground">
                  · {multiDayBehind > 0 ? `${multiDayBehind} behind pace` : "all on pace"}
                </span>
              </p>
            </article>
          ) : null}
        </div>

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Weekly Board</h2>
            <p className="text-xs text-muted-foreground">
              {selectedWeekLabel} · Updated {formatUpdatedTime(updatedAt, TIME_ZONE)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setWeekOffset((current) => current - 1)}
              aria-label="View previous week"
            >
              ← Previous
            </Button>
            {!isCurrentWeek ? (
              <Button variant="primary" size="sm" onClick={() => setWeekOffset(0)}>
                Current week
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setWeekOffset((current) => current + 1)}
              aria-label="View next week"
            >
              Next →
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 text-xs font-semibold">
          <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-1 text-red-300">Red queue = overdue</span>
          <span className="rounded-full border border-accent/40 bg-accent-soft px-2 py-1 text-red-100">Accent = due today</span>
          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-200">Amber = blocked / waiting / review</span>
          {laneCards.length > 0 ? (
            <>
              <span className="rounded-full border border-range-border bg-range-soft px-2 py-1 text-range-text">Violet = multi-day, inside its dates</span>
              <span className="rounded-full border border-success-border bg-success-soft px-2 py-1 text-success">Green fill = steps done</span>
              <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-200">Dashed mark = time gone (amber = behind pace)</span>
            </>
          ) : null}
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

        {laneCards.length > 0 ? (
          <>
            {/* Desktop: each multi-day task spans the day columns it covers. */}
            <section aria-label="Multi-day tasks this week" className="hidden xl:block">
              <h3 className="mb-2 px-1 text-xs font-bold uppercase tracking-[0.12em] text-range-text">Multi-day</h3>
              <div className="grid grid-flow-row-dense grid-cols-5 gap-x-4 gap-y-2">
                {laneCards.map(({ placement: item, data }) => {
                  const continues = laneContinuesText(item, selectedWeekStart);
                  const started = laneStartedText(item);
                  return (
                    <div
                      key={data.id}
                      data-lane-span={`${item.startCol}-${item.endCol}`}
                      style={{ gridColumn: `${item.startCol + 1} / ${item.endCol + 2}` }}
                    >
                      <WeeklyTaskCard
                        task={data}
                        completing={completingIds.has(data.id)}
                        pinning={pinningIds.has(data.id)}
                        moving={movingIds.has(data.id)}
                        dragging={draggingTaskId === data.id}
                        onOpen={() => handleOpenTask(data.id)}
                        onDone={() => handleQuickComplete(data.id)}
                        onTogglePinned={handleTogglePinned}
                        onDragStart={setDraggingTaskId}
                        onDragEnd={() => {
                          setDraggingTaskId(null);
                          setDropTargetKey(null);
                        }}
                        footer={
                          continues || started ? (
                            <p className="mt-1 text-xs font-bold text-range-text">
                              {[started, continues].filter(Boolean).join(" · ")}
                            </p>
                          ) : null
                        }
                        {...rangeCardProps(data, "lane")}
                      />
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Phone and tablet: the multi-day tasks stacked, each with an M–S strip. */}
            <section
              aria-label="Multi-day tasks this week"
              className="rounded-card border border-range-border bg-violet-500/5 p-3 xl:hidden"
            >
              <h3 className="mb-3 flex items-center justify-between text-sm font-semibold text-foreground">
                Multi-day this week
                <span className="rounded-full border border-stroke bg-panel px-2 py-0.5 text-xs font-bold text-foreground">
                  {laneCards.length}
                </span>
              </h3>
              <div className="space-y-3">
                {laneCards.map(({ placement: item, data }) => (
                  <WeeklyTaskCard
                    key={data.id}
                    task={data}
                    completing={completingIds.has(data.id)}
                    pinning={pinningIds.has(data.id)}
                    moving={movingIds.has(data.id)}
                    dragging={draggingTaskId === data.id}
                    onOpen={() => handleOpenTask(data.id)}
                    onDone={() => handleQuickComplete(data.id)}
                    onTogglePinned={handleTogglePinned}
                    onDragStart={setDraggingTaskId}
                    onDragEnd={() => {
                      setDraggingTaskId(null);
                      setDropTargetKey(null);
                    }}
                    footer={<DayStrip cells={dayStrip(item.startDate, item.dueDate, selectedWeekStart, todayDate)} />}
                    {...rangeCardProps(data, "phone")}
                  />
                ))}
              </div>
            </section>
          </>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
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
              rangeCardProps={rangeCardProps}
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
            rangeCardProps={rangeCardProps}
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
              rangeCardProps={rangeCardProps}
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
            defaultTags={mode === "personal" ? [PERSONAL_TAG] : []}
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
