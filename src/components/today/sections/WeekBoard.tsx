"use client";

import { squareInputOf } from "@/lib/project-colors";
import { ProjectSquare, ProjectTag } from "@/components/project-colors/ProjectSquare";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import type { TaskCardData } from "@/components/tasks/TaskCard";
import { TaskCreateForm } from "@/components/tasks/TaskCreateForm";
import { useTaskPanel } from "@/components/tasks/panel/TaskPanelProvider";
import { useTaskMutation } from "@/hooks/useTaskMutation";
import { useDateCascade } from "@/components/tasks/DateCascadeProvider";
import { useSprints } from "@/hooks/useSprints";
import type { ImplementationSummary, TaskWithImplementation } from "@/types/database";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";
import { isPersonalTaskOrProject, PERSONAL_TAG, type TaskScope } from "@/lib/personal-exclusion";
import { addDateOnlyDays, getDisplayedWeekRange, isDueAtInWeekStarting } from "@/lib/today/week-board";
import { etDate, isPastDue } from "@/lib/task-range";
import { buildRangeCardView, type RangeCardView } from "@/lib/task-range-view";
import { progressRowsFor } from "@/lib/break-into-tasks";
import { isTypingTarget, taskIdFromParams } from "@/lib/task-panel";
import type { TaskStatus } from "@/types/database";
import {
  dayStrip,
  laneContinuesText,
  laneStartedText,
  mergeTasksById,
  placeWeekTasks,
  rangeOverlapsWeek,
  type LanePlacement,
} from "@/lib/today/multi-day-board";
import {
  cardDueText,
  dayColumns,
  dueAtForBoardDay,
  earlierDoneCount,
  foldedDayText,
  hidesDone,
  gridTracks,
  isoWeekNumber,
  moveToChoices,
  moveToastText,
  moveUpdates,
  overdueLabel,
  railQueue,
  shortDayLabel,
  splitTodayBoard,
  weekRangeLabel,
  type MoveChoice,
} from "@/lib/today/today-board";
import {
  DAY_PARAM,
  dayKeyAction,
  dayMonthLabel,
  dayRowDue,
  dayTabs,
  groupDayList,
  hrefWithDay,
  longDayName,
  mondayOf,
  nextRowIndex,
  parseDayParam,
  rangeDayOn,
  rowSteps,
  statusChange,
  statusOptions,
  statusToastText,
  stepDay,
  viewedDay,
  weekOffsetOf,
  type DayGroupKind,
} from "@/lib/today/today-day";
import { DayList, type DayRowModel } from "@/components/today/sections/DayList";
import {
  boardStepsId,
  DoneRow,
  LaneBar,
  WeeklyTaskCard,
  type CardMove,
  type WeekBoardTaskData,
} from "@/components/today/cards/BoardTaskCard";
import { DayStrip } from "@/components/tasks/TaskRangeParts";
import { InlineSteps } from "@/components/tasks/InlineSteps";
import { TodayStrip, type StripEvent } from "@/components/today/sections/TodayStrip";
import "@/components/today/today-board.css";
import "@/components/today/move-to-menu.css";
import "@/components/today/today-day.css";

const TIME_ZONE = DEFAULT_WORKDAY_CONFIG.timezone;
const WAITING_RAIL_LIMIT = 8;
const PHONE_QUERY = "(max-width: 767px)";

/** Any layer that owns its own Esc / arrows (same set as the task panel's anyDialogOpen). */
function anyOverlayOpen(): boolean {
  return Boolean(document.querySelector('[role="dialog"][aria-modal="true"], [role="dialog"][aria-modal="false"], header [aria-expanded="true"]'));
}

function subscribePhone(onChange: () => void): () => void {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

type ChecklistRows = NonNullable<TaskWithImplementation["checklist_rows"]>;

const BLOCKED_REASON_WORDS: Record<string, string> = {
  prerequisite: "waits on another task",
  need_info: "needs info",
  decision: "needs a decision",
  approval: "needs approval",
  external: "external",
  other: "waiting",
};

interface WeekBoardProps {
  weekBoardTasks: TaskWithImplementation[];
  waitingTasks: TaskWithImplementation[];
  /** Done tasks due this week (Mon–Sun): the struck-through lines and the "n done" counts. */
  doneTasks: TaskWithImplementation[];
  needsReviewCount: number;
  syncedTaskIds: string[];
  updatedAt: string;
  hasError: boolean;
  mode: TaskScope;
  meetings: StripEvent[];
  meetingsFailed: boolean;
  /** Server-rendered chips for the strip (Artifact Inbox, sprint). */
  chips?: ReactNode;
  /** The server saw a phone's browser: Today opens straight into today's list (Today v2), no flash of the week. */
  phoneHint?: boolean;
}

function getDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function getDueState(dueAt: string | null, now: Date): TaskCardData["dueState"] {
  if (!dueAt) return null;
  if (isPastDue(dueAt, now)) return "Overdue";
  return getDateInTimeZone(new Date(dueAt), TIME_ZONE) === getDateInTimeZone(now, TIME_ZONE) ? "Due Today" : "Due Soon";
}

function formatDateOnlyLabel(dateOnly: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${dateOnly}T12:00:00Z`)
  );
}

function taskToWeekBoardData(
  task: TaskWithImplementation,
  now: Date,
  syncedToday: boolean,
  range: RangeCardView | null = null
): WeekBoardTaskData {
  return {
    id: task.id,
    title: task.title,
    tags: task.tags ?? [],
    estimatedMinutes: task.estimated_minutes,
    dueAt: task.due_at,
    dueState: getDueState(task.due_at, now),
    status: task.status,
    blocker: task.blocker,
    pinned: Boolean(task.pinned),
    syncedToday,
    implementationName: task.implementation?.name ?? null,
    squareInput: squareInputOf(task),
    dependencyBlocked: Boolean(task.dependency_blocked),
    updatedAt: task.updated_at ?? null,
    unblockedAt: task.unblocked_at ?? null,
    range,
    priorityScore: task.priority_score,
    projectName: task.project?.name ?? null,
    waitingOn: task.waiting_on,
    followUpAt: task.follow_up_at,
    isPersonal: isPersonalTaskOrProject(task),
    needsReview: task.needs_review,
    owner: task.owner ?? null,
    ownerLabel: task.owner_label ?? null,
    statusLine: task.status_line ?? null,
  };
}

function compareDueThenPriority(a: WeekBoardTaskData, b: WeekBoardTaskData): number {
  const aDue = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
  const bDue = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
  if (aDue !== bDue) return aDue - bDue;
  if (a.priorityScore !== b.priorityScore) return b.priorityScore - a.priorityScore;
  return a.title.localeCompare(b.title);
}

function waitingLine(task: TaskWithImplementation): string {
  const parts: string[] = [];
  if (task.waiting_on) parts.push(`on ${task.waiting_on}`);
  else if (task.blocked_reason) parts.push(BLOCKED_REASON_WORDS[task.blocked_reason] ?? "waiting");
  else if (task.dependency_blocked) parts.push("waits on another task");
  else parts.push("waiting");
  const followUp = etDate(task.follow_up_at ?? null);
  if (followUp) parts.push(`nudge ${shortDayLabel(followUp)}`);
  return parts.join(" · ");
}

/**
 * Today, board first (redesign S4). The one-line strip (date, next meeting,
 * colour key), then the week: a side rail with Overdue (a short queue) and
 * Waiting (each waiting task once), Mon–Fri with the multi-day lane, done lines
 * and cards with Done + Move to…, and the weekend strip. While the task panel
 * shows a task the board narrows beside it: the rail folds into two side tabs,
 * past days into one "n done" line, and the open card is outlined.
 */
export function WeekBoard({
  weekBoardTasks,
  waitingTasks,
  doneTasks,
  needsReviewCount,
  syncedTaskIds,
  updatedAt,
  hasError,
  mode,
  meetings,
  meetingsFailed,
  chips,
  phoneHint = false,
}: WeekBoardProps) {
  const router = useRouter();
  const params = useSearchParams();
  const openTaskId = taskIdFromParams(params, "/");
  // Today v2: `?day=YYYY-MM-DD` shows that day as a list (a bad date shows the week).
  const dayParam = parseDayParam(params.get(DAY_PARAM));
  const isPhone = useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => phoneHint
  );
  const { openTask, seedTasks: registerTasks } = useTaskPanel();
  const { sprints } = useSprints();
  const { completeTask, updateTaskWithUndo } = useTaskMutation();
  const dateCascade = useDateCascade();

  const [tasks, setTasks] = useState<TaskWithImplementation[]>(weekBoardTasks);
  const [waiting, setWaiting] = useState<TaskWithImplementation[]>(waitingTasks);
  const [done, setDone] = useState<TaskWithImplementation[]>(doneTasks);
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());
  const [movingIds, setMovingIds] = useState<Set<string>>(new Set());
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [weekOffset, setWeekOffset] = useState(0);
  const [loadedWeek, setLoadedWeek] = useState<string | null>(null);
  // Done tasks from earlier days start hidden on every visit (Brent 11/6: "Always start hidden"; never remembered).
  const [showDone, setShowDone] = useState(false);
  // Phone: "← Week" from today's list shows the week until the next visit.
  const [phoneWeek, setPhoneWeek] = useState(false);
  const [motion, setMotion] = useState<"in" | "prev" | "next" | "back" | null>(null);
  const [motionKey, setMotionKey] = useState(0);
  const pushedDayRef = useRef(false);
  const [createDueDate, setCreateDueDate] = useState<string | null>(null);
  const [implementations, setImplementations] = useState<ImplementationSummary[]>([]);
  const [implementationsLoading, setImplementationsLoading] = useState(false);
  const [implementationsLoadRequest, setImplementationsLoadRequest] = useState(0);
  const [implementationsError, setImplementationsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openStepsKey, setOpenStepsKey] = useState<string | null>(null);
  const [overdueExpanded, setOverdueExpanded] = useState(false);
  const [waitingExpanded, setWaitingExpanded] = useState(false);
  const [flyout, setFlyout] = useState<"overdue" | "waiting" | null>(null);
  const railRef = useRef<HTMLElement | null>(null);

  const applyChecklistRows = useCallback((taskId: string, rows: ChecklistRows) => {
    setTasks((current) => current.map((task) => (task.id === taskId ? { ...task, checklist_rows: rows } : task)));
  }, []);

  // Reconcile local optimistic state with freshly streamed server props (during
  // render, React's pattern for state that follows a prop). Tasks loaded for later
  // weeks stay; the streamed props own this week.
  const [seen, setSeen] = useState({ weekBoardTasks, waitingTasks, doneTasks });
  if (seen.weekBoardTasks !== weekBoardTasks || seen.waitingTasks !== waitingTasks || seen.doneTasks !== doneTasks) {
    if (seen.weekBoardTasks !== weekBoardTasks) {
      const currentWeek = getDisplayedWeekRange(new Date(), TIME_ZONE);
      setTasks((current) =>
        mergeTasksById(
          current.filter((task) => {
            if (!task.due_at) return false;
            return getDateInTimeZone(new Date(task.due_at), TIME_ZONE) > currentWeek.end && !rangeOverlapsWeek(task, currentWeek.start);
          }),
          weekBoardTasks
        )
      );
    }
    if (seen.waitingTasks !== waitingTasks) setWaiting(waitingTasks);
    if (seen.doneTasks !== doneTasks) setDone(doneTasks);
    setSeen({ weekBoardTasks, waitingTasks, doneTasks });
  }

  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    registerTasks([...tasks, ...waiting, ...done]);
  }, [tasks, waiting, done, registerTasks]);

  const now = new Date(nowMs);
  const currentWeekRange = getDisplayedWeekRange(now, TIME_ZONE);
  const todayDate = getDateInTimeZone(now, TIME_ZONE);
  const viewDay = viewedDay({ dayParam, phone: isPhone, phoneWeek, todayDate });

  // The fly-out lives while the rail is folded into tabs (panel open, or a day list); Esc or a click elsewhere closes it.
  const activeFlyout = openTaskId || viewDay ? flyout : null;
  useEffect(() => {
    if (!activeFlyout) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // A Move to… menu opened from the fly-out takes this Esc itself (S4 review F1).
      if (document.querySelector(".tb-move")) return;
      event.preventDefault();
      event.stopPropagation();
      const which = activeFlyout;
      setFlyout(null);
      document.querySelector<HTMLElement>(`[data-rail-tab="${which}"]`)?.focus({ preventScroll: true });
    }
    function onPointer(event: PointerEvent) {
      const target = event.target as Element | null;
      if (!target || railRef.current?.contains(target) || target.closest("[data-rail-tab]") || target.closest(".tb-move")) return;
      setFlyout(null);
    }
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [activeFlyout]);

  const syncedSet = useMemo(() => new Set(syncedTaskIds), [syncedTaskIds]);
  // A day list shows the week that day is in; otherwise the week the pager picked.
  const selectedWeekStart = viewDay ? mondayOf(viewDay) : addDateOnlyDays(currentWeekRange.start, weekOffset * 7);
  const selectedWeekEnd = addDateOnlyDays(selectedWeekStart, 6);
  const isCurrentWeek = selectedWeekStart === currentWeekRange.start;
  const weekLoading = !isCurrentWeek && loadedWeek !== selectedWeekStart;

  const toData = useCallback(
    (task: TaskWithImplementation): WeekBoardTaskData => {
      // An umbrella (Break into tasks) counts its step tasks; others their checklist.
      const progress = progressRowsFor(task);
      const range = buildRangeCardView(task, progress.rows, new Date(nowMs), { stepsAreTasks: progress.source === "tasks" });
      return taskToWeekBoardData(task, new Date(nowMs), syncedSet.has(task.id), range);
    },
    [nowMs, syncedSet]
  );

  // Each task has one home: Waiting, the Overdue queue, or the board.
  const split = splitTodayBoard({ tasks, waiting, todayDate, now });
  const dataById = new Map<string, WeekBoardTaskData>();
  for (const task of [...split.board, ...split.overdue]) dataById.set(task.id, toData(task));
  const rawById = new Map([...tasks, ...waiting, ...done].map((task) => [task.id, task]));

  const placement = placeWeekTasks(split.board, selectedWeekStart, (task) => isDueAtInWeekStarting(task.due_at, selectedWeekStart, TIME_ZONE));
  const laneCards = placement.lane.flatMap((item) => {
    const data = dataById.get(item.task.id);
    return data && data.range ? [{ placement: item, data, view: data.range }] : [];
  });

  const weekDates = Array.from({ length: 7 }, (_, index) => addDateOnlyDays(selectedWeekStart, index));
  const singlesByDate = new Map<string, WeekBoardTaskData[]>(weekDates.map((date) => [date, []]));
  for (const task of placement.single) {
    const date = etDate(task.due_at);
    const data = dataById.get(task.id);
    if (date && data && singlesByDate.has(date)) singlesByDate.get(date)!.push(data);
  }
  for (const list of singlesByDate.values()) list.sort(compareDueThenPriority);
  const doneByDate = new Map<string, WeekBoardTaskData[]>(weekDates.map((date) => [date, []]));
  for (const task of done) {
    const date = etDate(task.due_at);
    if (date && doneByDate.has(date)) doneByDate.get(date)!.push(toData(task));
  }

  const columnDone = weekDates.slice(0, 5).map((date) => doneByDate.get(date)?.length ?? 0);
  const columns = dayColumns(
    selectedWeekStart,
    todayDate,
    weekDates.slice(0, 5).map((date) => singlesByDate.get(date)?.length ?? 0),
    columnDone,
    { doneHidden: !showDone }
  );
  const hiddenDoneCount = earlierDoneCount(columns, columnDone);
  const saturday = weekDates[5];
  const sunday = weekDates[6];
  const weekendRanges = placement.weekendRanges.map((task) => dataById.get(task.id)).filter((task): task is WeekBoardTaskData => Boolean(task));

  const overdueData = split.overdue.flatMap((task) => {
    const data = dataById.get(task.id);
    return data ? [data] : [];
  });
  const overdueQueue = railQueue(overdueData, overdueExpanded);
  const waitingQueue = railQueue(split.waiting, waitingExpanded, WAITING_RAIL_LIMIT);

  const legendInputs = [...split.board, ...split.overdue, ...split.waiting].map((task) => squareInputOf(task));

  const panelOpen = Boolean(openTaskId);

  const rangeStepsProps = (task: WeekBoardTaskData, context: string) => {
    const view = task.range;
    if (!view || !view.steps) return {};
    const key = `${context}:${task.id}`;
    const open = openStepsKey === key;
    return {
      stepsOpen: open,
      onToggleSteps: () => setOpenStepsKey((current) => (current === key ? null : key)),
      steps: open ? (
        <InlineSteps
          id={boardStepsId(context, task.id)}
          taskId={task.id}
          view={view}
          compact
          stepTasks={view.steps.basis === "tasks" ? rawById.get(task.id)?.step_tasks : undefined}
          onRowsChange={(rows) => applyChecklistRows(task.id, rows)}
          onSaved={() => router.refresh()}
          onDone={() => handleQuickComplete(task.id)}
          doneDisabled={completingIds.has(task.id)}
        />
      ) : undefined,
    };
  };

  // Other weeks load on demand (the streamed props hold this week).
  useEffect(() => {
    if (isCurrentWeek) return;
    const controller = new AbortController();
    const query = new URLSearchParams({
      view: "weekly_board",
      week_start_date: selectedWeekStart,
      week_end_date: selectedWeekEnd,
      limit: "300",
      scope: mode,
    });
    fetch(`/api/tasks?${query.toString()}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Failed to load the selected week");
        return response.json() as Promise<TaskWithImplementation[]>;
      })
      .then((selectedTasks) => {
        setLoadedWeek(selectedWeekStart);
        setTasks((current) =>
          mergeTasksById(
            current.filter(
              (task) => !isDueAtInWeekStarting(task.due_at, selectedWeekStart, TIME_ZONE) && !rangeOverlapsWeek(task, selectedWeekStart)
            ),
            selectedTasks
          )
        );
      })
      .catch((loadError: unknown) => {
        if ((loadError as { name?: string }).name !== "AbortError") {
          setLoadedWeek(selectedWeekStart);
          setError(loadError instanceof Error ? loadError.message : "Failed to load the selected week");
        }
      });
    return () => controller.abort();
  }, [isCurrentWeek, mode, selectedWeekEnd, selectedWeekStart]);

  useEffect(() => {
    if (!createDueDate || implementations.length > 0) return;
    const controller = new AbortController();
    fetch("/api/applications", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Failed to load applications");
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

  const handleOpenTask = (taskId: string) => {
    const raw = rawById.get(taskId);
    if (raw) openTask(raw);
    else openTask(taskId);
  };

  /** Another week: its tasks load on demand (the streamed props hold this week). */
  function goToWeek(offset: number) {
    setWeekOffset(offset);
    setError(null);
  }

  // ── Today v2: a day as a list ────────────────────────────────────────────

  /** Open a day: from the week a new history entry (Back returns to the week); between days the same entry. */
  function goToDay(date: string, direction: "prev" | "next" | null) {
    const here = window.location;
    const href = hrefWithDay(here.pathname, here.search, date, here.hash);
    if (!viewDay) {
      window.history.pushState(null, "", href);
      pushedDayRef.current = true;
      setMotion("in");
    } else {
      window.history.replaceState(null, "", href);
      setMotion(direction);
    }
    setMotionKey((key) => key + 1);
    setFlyout(null);
    setError(null);
  }

  /** Back to the week the day is in (← Week, Esc): steps back when the day was opened from the week here. */
  function backToWeek(offset?: number) {
    if (viewDay) setWeekOffset(offset ?? weekOffsetOf(viewDay, currentWeekRange.start));
    if (isPhone) setPhoneWeek(true);
    setFlyout(null);
    setMotion("back");
    setMotionKey((key) => key + 1);
    if (!dayParam) return;
    const here = window.location;
    const panelShowing = new URLSearchParams(here.search).has("task");
    if (pushedDayRef.current && !panelShowing && offset === undefined) {
      pushedDayRef.current = false;
      window.history.back();
    } else {
      pushedDayRef.current = false;
      window.history.replaceState(null, "", hrefWithDay(here.pathname, here.search, null, here.hash));
    }
  }

  const goToDayRef = useRef(goToDay);
  const backToWeekRef = useRef(() => backToWeek());
  useEffect(() => {
    goToDayRef.current = goToDay;
    backToWeekRef.current = () => backToWeek();
  });

  /** "Show next week" in the cascade toast: the week view of that week. */
  function showWeekAfter() {
    const offset = weekOffsetOf(selectedWeekStart, currentWeekRange.start) + 1;
    if (viewDay) backToWeek(offset);
    else goToWeek(offset);
  }

  function openCreate(date: string) {
    setCreateDueDate(date);
    if (implementations.length === 0) {
      setImplementationsLoading(true);
      setImplementationsError(null);
    }
  }

  function markBusy(setter: typeof setMovingIds, taskId: string, busy: boolean) {
    setter((prev) => {
      const next = new Set(prev);
      if (busy) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  }

  async function handleQuickComplete(taskId: string) {
    if (completingIds.has(taskId)) return;
    const task = tasks.find((item) => item.id === taskId) ?? waiting.find((item) => item.id === taskId);
    if (!task) return;
    const wasWaiting = waiting.some((item) => item.id === taskId);

    // Put the row back exactly where it came from, for a failed request and an undo.
    const restore = () => {
      const insert = (prev: TaskWithImplementation[]) => (prev.some((item) => item.id === taskId) ? prev : [task, ...prev]);
      if (wasWaiting) setWaiting(insert);
      else setTasks(insert);
      setDone((prev) => prev.filter((item) => item.id !== taskId));
    };

    markBusy(setCompletingIds, taskId, true);
    setError(null);
    await completeTask(task, {
      onOptimistic: () => {
        setTasks((prev) => prev.filter((item) => item.id !== taskId));
        setWaiting((prev) => prev.filter((item) => item.id !== taskId));
        // Shown struck through on its day at once (the refresh brings the same row).
        setDone((prev) => (prev.some((item) => item.id === taskId) ? prev : [...prev, { ...task, status: "Done" }]));
      },
      onRollback: restore,
      onUndo: restore,
    });
    markBusy(setCompletingIds, taskId, false);
  }

  /** A day on the board (Move to… or a drag): the date cascade, like the panel's Due box. */
  async function handleMoveToDay(taskId: string, dateOnly: string) {
    if (movingIds.has(taskId)) return;
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return;
    const nextDueAt = dueAtForBoardDay(dateOnly);
    if (task.due_at === nextDueAt) return;
    const previousDueAt = task.due_at;

    markBusy(setMovingIds, taskId, true);
    setError(null);
    const applyDueAt = (dueAt: string | null) =>
      setTasks((prev) => prev.map((item) => (item.id === taskId ? { ...item, due_at: dueAt } : item)));

    if (dateCascade) {
      // Cascade S2: the date saves at once; the toast lists the tasks that moved with
      // it, with Undo, "how far", and "Show next week" when they left this week's board.
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
        week: { weekStart: selectedWeekStart, showNextWeek: showWeekAfter },
      });
    }

    markBusy(setMovingIds, taskId, false);
    setDraggingTaskId(null);
    setDropTarget(null);
  }

  /** Backlog (no date) or Park (someday): a status change with Undo in its toast. */
  async function handleMoveUndated(task: TaskWithImplementation, choice: MoveChoice) {
    if (movingIds.has(task.id)) return;
    const plan = moveUpdates(choice);
    if (plan.kind !== "status") return;
    const undo = choice.kind === "backlog" ? { status: task.status, due_at: task.due_at } : { status: task.status };
    const restore = () => setTasks((prev) => (prev.some((item) => item.id === task.id) ? prev : [task, ...prev]));
    markBusy(setMovingIds, task.id, true);
    setError(null);
    await updateTaskWithUndo(task.id, plan.updates, undo, {
      message: moveToastText(choice, task.title),
      onOptimistic: () => setTasks((prev) => prev.filter((item) => item.id !== task.id)),
      onRollback: restore,
      onUndo: restore,
      failureMessage: "Couldn't move the task.",
    });
    markBusy(setMovingIds, task.id, false);
  }

  function moveFor(taskId: string): CardMove | undefined {
    const raw = tasks.find((item) => item.id === taskId);
    if (!raw) return undefined;
    return {
      input: raw,
      choices: moveToChoices(raw, todayDate, selectedWeekStart),
      onPick: (choice) => {
        if (choice.kind === "day" && choice.date) void handleMoveToDay(raw.id, choice.date);
        else void handleMoveUndated(raw, choice);
      },
    };
  }

  /** The day list's status drop-down: a status PATCH with Undo, or Backlog / Park exactly as Move to… does them. */
  async function handleStatus(taskId: string, value: string) {
    if (movingIds.has(taskId)) return;
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return;
    const change = statusChange(task, value);
    if (change.kind === "none") return;
    if (change.kind === "move") {
      await handleMoveUndated(task, change.choice);
      return;
    }
    const before = task.status;
    const apply = (status: TaskStatus) => setTasks((prev) => prev.map((item) => (item.id === taskId ? { ...item, status } : item)));
    markBusy(setMovingIds, taskId, true);
    setError(null);
    await updateTaskWithUndo(taskId, { status: change.updates.status as TaskStatus }, { status: change.undo.status as TaskStatus }, {
      message: statusToastText(task.title, value),
      onOptimistic: () => apply(change.updates.status as TaskStatus),
      onRollback: () => apply(before),
      onUndo: () => apply(before),
      failureMessage: "Couldn't change the status.",
    });
    markBusy(setMovingIds, taskId, false);
  }

  // Day list keys: ← / → the day before / after, Esc back to the week (after the panel), ↑ / ↓ between rows.
  useEffect(() => {
    if (!viewDay) return;
    const day = viewDay;
    function onKey(event: KeyboardEvent) {
      const action = dayKeyAction(event, { typing: isTypingTarget(event.target), dialogOpen: anyOverlayOpen(), panelOpen: Boolean(openTaskId) });
      if (!action) return;
      if (action === "prev" || action === "next") {
        event.preventDefault();
        goToDayRef.current(stepDay(day, action), action);
        return;
      }
      if (action === "week") {
        event.preventDefault();
        backToWeekRef.current();
        return;
      }
      const titles = Array.from(document.querySelectorAll<HTMLElement>(".td-list [data-day-row] .td-title")).filter((el) => el.getClientRects().length > 0);
      const current = titles.findIndex((el) => el.closest("[data-day-row]")?.contains(document.activeElement));
      const index = nextRowIndex(titles.length, current, action);
      if (index === null) return;
      event.preventDefault();
      titles[index].focus();
      titles[index].scrollIntoView({ block: "nearest" });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewDay, openTaskId]);

  function handleTaskCreated(task: TaskWithImplementation) {
    setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
    setError(null);
    router.refresh();
  }

  const dropProps = (date: string, enabled: boolean) =>
    enabled
      ? {
          "data-drop": dropTarget === date ? "" : undefined,
          onDragOver: (event: DragEvent) => {
            if (!draggingTaskId) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            if (dropTarget !== date) setDropTarget(date);
          },
          onDragLeave: (event: DragEvent<HTMLElement>) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
          },
          onDrop: (event: DragEvent) => {
            event.preventDefault();
            const taskId = event.dataTransfer.getData("text/plain");
            setDropTarget(null);
            if (taskId) void handleMoveToDay(taskId, date);
          },
        }
      : {};

  const endDrag = () => {
    setDraggingTaskId(null);
    setDropTarget(null);
  };

  const renderCard = (data: WeekBoardTaskData, context: string, tense: "past" | "today" | "future" | "overdue", dueText: { text: string | null; late: boolean }) => (
    <WeeklyTaskCard
      key={data.id}
      task={data}
      tense={tense}
      dueText={dueText.text}
      dueLate={dueText.late || tense === "overdue"}
      open={openTaskId === data.id}
      completing={completingIds.has(data.id)}
      moving={movingIds.has(data.id)}
      dragging={draggingTaskId === data.id}
      onOpen={() => handleOpenTask(data.id)}
      onDone={() => void handleQuickComplete(data.id)}
      move={moveFor(data.id)}
      canDrag={!data.range?.isRange || tense === "overdue"}
      onDragStart={setDraggingTaskId}
      onDragEnd={endDrag}
      context={context}
      {...rangeStepsProps(data, context)}
    />
  );

  const weekendItems = (date: string) => {
    const singles = singlesByDate.get(date) ?? [];
    const ranges = weekendRanges.filter((task) => {
      const raw = rawById.get(task.id);
      const start = etDate(raw?.start_at ?? null);
      const due = etDate(raw?.due_at ?? null);
      return Boolean(start && due && start <= date && due >= date);
    });
    const continuing = laneCards.filter(({ placement: item }) => item.endsAfterFriday && item.dueDate >= date);
    return { singles, ranges, continuing, done: doneByDate.get(date) ?? [] };
  };

  const renderWeekendDay = (date: string, name: string) => {
    const items = weekendItems(date);
    const doneShown = hidesDone(date < todayDate ? "past" : date === todayDate ? "today" : "future", showDone) ? [] : items.done;
    return (
      <div {...dropProps(date, date >= todayDate)}>
        <h3>
          <button
            type="button"
            className="tb-wk-h"
            onClick={() => goToDay(date, null)}
            aria-label={`Open ${longDayName(date)} ${dayMonthLabel(date)} as a list`}
            title={`See ${name} as a list`}
          >
            {name} {Number(date.slice(8, 10))}
          </button>
        </h3>
        {items.continuing.map(({ data }) => (
          <button key={`cont-${data.id}`} type="button" className="tb-wk-it" data-range="" data-task-open={data.id} data-open={openTaskId === data.id ? "" : undefined} onClick={() => handleOpenTask(data.id)}>
            {data.squareInput ? <ProjectSquare {...data.squareInput} editable={false} /> : null}
            <span>{data.title}, cont.</span>
          </button>
        ))}
        {[...items.ranges, ...items.singles].map((data) => (
          <button
            key={data.id}
            type="button"
            className="tb-wk-it"
            data-range={data.range?.isRange ? "" : undefined}
            data-task-open={data.id}
            data-open={openTaskId === data.id ? "" : undefined}
            onClick={() => handleOpenTask(data.id)}
          >
            {data.squareInput ? <ProjectSquare {...data.squareInput} editable={false} /> : null}
            <span>{data.title}</span>
          </button>
        ))}
        {doneShown.map((data) => (
          <button key={`done-${data.id}`} type="button" className="tb-wk-it" data-task-open={data.id} onClick={() => handleOpenTask(data.id)} aria-label={`${data.title} (done)`}>
            <span className="tb-ck" aria-hidden="true">
              ✓
            </span>
            <span className="line-through">{data.title}</span>
          </button>
        ))}
        {doneShown.length < items.done.length ? (
          <button type="button" className="tb-fold-show" onClick={() => goToDay(date, null)}>
            ✓ {foldedDayText(items.done.length)} · show
          </button>
        ) : null}
        {date >= todayDate ? (
          <button type="button" className="tb-wk-add" onClick={() => openCreate(date)} aria-label={`Add a task due ${name} ${formatDateOnlyLabel(date)}`}>
            + add
          </button>
        ) : null}
      </div>
    );
  };

  const overdueCount = split.overdue.length;
  const waitingCount = split.waiting.length;

  // ── The rail: one copy, used by the week and the day list ───────────────
  const railTabs = (
    <nav className="tb-tabs" aria-label="Overdue and Waiting">
      <button
        type="button"
        className="tb-tab"
        data-rail-tab="overdue"
        data-late={overdueCount > 0 ? "" : undefined}
        aria-expanded={activeFlyout === "overdue"}
        aria-controls="today-rail"
        onClick={() => setFlyout((current) => (current === "overdue" ? null : "overdue"))}
      >
        <b>{overdueCount}</b>
        <span>Overdue</span>
      </button>
      <button
        type="button"
        className="tb-tab"
        data-rail-tab="waiting"
        aria-expanded={activeFlyout === "waiting"}
        aria-controls="today-rail"
        onClick={() => setFlyout((current) => (current === "waiting" ? null : "waiting"))}
      >
        <b>{waitingCount}</b>
        <span>Waiting</span>
      </button>
    </nav>
  );

  const rail = (
    <aside
      id="today-rail"
      ref={railRef}
      className="tb-rail"
      data-flyout={activeFlyout ?? undefined}
      role={activeFlyout ? "dialog" : undefined}
      aria-modal={activeFlyout ? "false" : undefined}
      aria-label={activeFlyout ? (activeFlyout === "overdue" ? "Overdue" : "Waiting") : "Overdue and Waiting"}
    >
      {activeFlyout ? (
        <button
          type="button"
          className="tb-rail-close"
          onClick={() => {
            const which = activeFlyout;
            setFlyout(null);
            document.querySelector<HTMLElement>(`[data-rail-tab="${which}"]`)?.focus({ preventScroll: true });
          }}
        >
          Close
        </button>
      ) : null}
      <section data-rail="overdue" data-task-list="overdue" aria-labelledby="today-overdue-h">
        <div className="tb-rh">
          <h3 id="today-overdue-h">Overdue</h3>
          <span className="tb-n" data-late={overdueCount > 0 ? "" : undefined}>
            {overdueCount}
          </span>
          <em>oldest first</em>
        </div>
        {overdueCount === 0 ? <p className="tb-empty">Nothing overdue.</p> : null}
        {overdueQueue.shown.map((data) =>
          renderCard(data, "overdue", "overdue", { text: overdueLabel(data.dueAt, todayDate), late: true })
        )}
        {overdueQueue.hidden > 0 || overdueExpanded ? (
          <button type="button" className="tb-linkbtn" aria-expanded={overdueExpanded} onClick={() => setOverdueExpanded((value) => !value)}>
            {overdueExpanded ? "Show fewer" : `Show ${overdueQueue.hidden} more`}
          </button>
        ) : null}
      </section>

      <section data-rail="waiting" data-task-list="waiting" aria-labelledby="today-waiting-h">
        <div className="tb-rh">
          <h3 id="today-waiting-h">Waiting</h3>
          <span className="tb-n">{waitingCount}</span>
          <em>on someone else</em>
        </div>
        {waitingCount === 0 && needsReviewCount === 0 ? <p className="tb-empty">Nothing waiting.</p> : null}
        {waitingQueue.shown.map((task) => (
          <button
            key={task.id}
            type="button"
            className="tb-wrow"
            data-task-open={task.id}
            aria-current={openTaskId === task.id ? "true" : undefined}
            onClick={() => openTask(task)}
          >
            <b>{task.title}</b>
            <span>
              {/* Inside the row's button, so the square is a plain mark here. */}
              <ProjectTag {...squareInputOf(task)} editable={false} />
              {waitingLine(task)}
            </span>
          </button>
        ))}
        {waitingQueue.hidden > 0 || waitingExpanded ? (
          <button type="button" className="tb-linkbtn" aria-expanded={waitingExpanded} onClick={() => setWaitingExpanded((value) => !value)}>
            {waitingExpanded ? "Show fewer" : `Show ${waitingQueue.hidden} more`}
          </button>
        ) : null}
        {needsReviewCount > 0 ? (
          <Link href="/backlog?review=needs_review" className="tb-linkbtn">
            {needsReviewCount} {needsReviewCount === 1 ? "task needs" : "tasks need"} review →
          </Link>
        ) : null}
      </section>
    </aside>
  );

  // ── The day list's rows ─────────────────────────────────────────────────
  const dayRowsFor = (day: string) => groupDayList({ board: split.board, overdue: split.overdue, done, day });
  const dayView = viewDay
    ? (() => {
        const groups = dayRowsFor(viewDay);
        const model = (task: TaskWithImplementation, group: DayGroupKind): DayRowModel => ({
          group,
          data: dataById.get(task.id) ?? toData(task),
          due: dayRowDue(task, group, viewDay, todayDate, now),
          rangeDay: group === "running" ? rangeDayOn(task, viewDay) : null,
          steps: rowSteps(progressRowsFor(task).rows),
          statusOptions: statusOptions(task),
          move: group === "done" ? undefined : moveFor(task.id),
        });
        const tabs = dayTabs(
          selectedWeekStart,
          todayDate,
          (date) => dayRowsFor(date).due.length,
          (date) => (doneByDate.get(date) ?? []).length
        );
        return (
          <DayList
            day={viewDay}
            todayDate={todayDate}
            rows={{
              due: groups.due.map((task) => model(task, "due")),
              running: groups.running.map((task) => model(task, "running")),
              done: groups.done.map((task) => model(task, "done")),
            }}
            tabs={tabs}
            openTaskId={openTaskId}
            completingIds={completingIds}
            movingIds={movingIds}
            loading={weekLoading}
            motion={motion === "back" ? null : motion}
            motionKey={motionKey}
            railTabs={railTabs}
            rail={rail}
            onWeek={() => backToWeek()}
            onDay={goToDay}
            onOpen={handleOpenTask}
            onDone={(taskId) => void handleQuickComplete(taskId)}
            onStatus={(taskId, value) => void handleStatus(taskId, value)}
            onAdd={viewDay >= todayDate ? () => openCreate(viewDay) : undefined}
          />
        );
      })()
    : null;

  return (
    <div
      className="tb"
      data-panel={panelOpen ? "open" : "closed"}
      data-view={viewDay ? "day" : "week"}
      data-done={showDone ? "shown" : "hidden"}
      style={{
        ["--tb-days" as string]: gridTracks(columns.map((column) => column.weight)),
        ["--tb-days-open" as string]: gridTracks(columns.map((column) => column.weightOpen)),
      }}
    >
      <TodayStrip
        todayDate={todayDate}
        events={meetings}
        meetingsFailed={meetingsFailed}
        workCalendarNote={mode === "personal"}
        chips={chips}
        legendInputs={legendInputs}
      />

      <h1 className="sr-only">Today</h1>

      {error ? (
        <p className="tb-note" data-tone="warn" role="alert">
          {error}
        </p>
      ) : null}
      {hasError ? (
        <p className="tb-note" data-tone="warn">
          Part of the board didn&apos;t refresh (updated {new Date(updatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TIME_ZONE })}). Showing what loaded.
        </p>
      ) : null}

      {dayView ?? (
      <div className="tb-week" data-motion={motion === "back" ? "back" : undefined} key={`week-${motion === "back" ? motionKey : 0}`}>
      <div className="tb-head">
        <h2>Week {isoWeekNumber(selectedWeekStart)}</h2>
        <span className="tb-wk">{weekRangeLabel(selectedWeekStart)}</span>
        <div className="tb-pager" role="group" aria-label="Week">
          <button type="button" onClick={() => goToWeek(weekOffset - 1)} aria-label="Previous week">
            ‹
          </button>
          <button type="button" onClick={() => goToWeek(0)} aria-pressed={isCurrentWeek}>
            This week
          </button>
          <button type="button" onClick={() => goToWeek(weekOffset + 1)} aria-label="Next week">
            ›
          </button>
        </div>
        {hiddenDoneCount > 0 ? (
          <button type="button" className="tb-showdone" aria-pressed={showDone} onClick={() => setShowDone((value) => !value)}>
            <span className="tb-showdone-box" aria-hidden="true">
              {showDone ? "✓" : ""}
            </span>
            Show done <span className="tb-showdone-n">{hiddenDoneCount}</span>
          </button>
        ) : null}
        {laneCards.length > 0 ? (
          <div className="tb-rangelegend" aria-hidden="true">
            <span>
              <i className="tb-sw" />
              steps
            </span>
            <span>
              <i className="tb-dm" />
              time gone
            </span>
          </div>
        ) : null}
      </div>

      {weekLoading ? (
        <p className="tb-note" role="status">
          Loading {weekRangeLabel(selectedWeekStart)}…
        </p>
      ) : null}

      <div className="tb-board">
        {/* Panel open (desktop): the rail folds into two side tabs with counts. */}
        {railTabs}
        {rail}

        <div className="tb-boardlist" data-task-list="board">
          {laneCards.length > 0 ? (
            <section className="tb-lane" aria-label="Multi-day tasks this week">
              <h3 className="tb-lt">Runs several days</h3>
              {laneCards.map(({ placement: item, data, view }: { placement: LanePlacement<TaskWithImplementation>; data: WeekBoardTaskData; view: RangeCardView }) => (
                <LaneBar
                  key={data.id}
                  task={data}
                  view={view}
                  open={openTaskId === data.id}
                  late={view.tone === "late"}
                  startCol={item.startCol}
                  endCol={item.endCol}
                  startedText={laneStartedText(item)}
                  continuesText={laneContinuesText(item, selectedWeekStart)?.replace(/^continues /, "") ?? null}
                  completing={completingIds.has(data.id)}
                  moving={movingIds.has(data.id)}
                  onOpen={() => handleOpenTask(data.id)}
                  onDone={() => void handleQuickComplete(data.id)}
                  move={moveFor(data.id)}
                  {...(() => {
                    const props = rangeStepsProps(data, "lane");
                    return { stepsOpen: Boolean(props.stepsOpen), onToggleSteps: props.onToggleSteps, steps: props.steps };
                  })()}
                  dayStrip={<DayStrip cells={dayStrip(item.startDate, item.dueDate, selectedWeekStart, todayDate)} />}
                />
              ))}
            </section>
          ) : null}

          {columns.map((column, index) => {
            const singles = singlesByDate.get(column.date) ?? [];
            const doneRows = doneByDate.get(column.date) ?? [];
            const canAdd = column.tense !== "past";
            const doneHidden = hidesDone(column.tense, showDone);
            return (
              <div key={column.date} className="tb-day" data-tense={column.tense} style={{ ["--c" as string]: String(index + 2) }}>
                <div className="tb-dh">
                  {/* Today v2: every day header opens that day as a list. */}
                  <h3>
                    <button
                      type="button"
                      className="tb-dh-btn"
                      onClick={() => goToDay(column.date, null)}
                      aria-label={`Open ${longDayName(column.date)} ${dayMonthLabel(column.date)} as a list${column.count ? ` (${column.count})` : ""}`}
                      title={`See ${column.name} as a list`}
                    >
                      <span className="tb-dh-name">{column.name}</span>
                      <span className="tb-dn-num">{column.day}</span>
                      {column.tense === "today" ? <span className="tb-tdy">TODAY</span> : null}
                      {column.count ? <em>{column.count}</em> : null}
                      <span className="tb-dh-go" aria-hidden="true">
                        open day →
                      </span>
                    </button>
                  </h3>
                </div>
                <div className="tb-col" {...dropProps(column.date, column.tense !== "past")}>
                  {/* Folded (earlier done hidden, panel open, or a phone): one "n done · show" line with the project squares. */}
                  <div className="tb-fold">
                    {doneRows.length > 0 ? (
                      <span className="tb-ck" aria-hidden="true">
                        ✓
                      </span>
                    ) : null}
                    <span>{foldedDayText(doneRows.length)}</span>
                    <span className="tb-sqs" aria-hidden="true">
                      {doneRows.slice(0, 6).map((data) =>
                        data.squareInput ? <ProjectSquare key={data.id} {...data.squareInput} editable={false} /> : null
                      )}
                    </span>
                    {doneRows.length > 0 ? (
                      <button
                        type="button"
                        className="tb-fold-show"
                        onClick={() => goToDay(column.date, null)}
                        aria-label={`Show ${column.name}'s ${doneRows.length} done ${doneRows.length === 1 ? "task" : "tasks"} (opens ${column.name} as a list)`}
                      >
                        show
                      </button>
                    ) : null}
                  </div>
                  <div className="tb-full" data-done-hidden={doneHidden ? "" : undefined}>
                    {doneRows.map((data) => (
                      <DoneRow key={data.id} task={data} onOpen={() => handleOpenTask(data.id)} />
                    ))}
                    {singles.map((data) => renderCard(data, `col-${column.date}`, column.tense, cardDueText(data.dueAt, todayDate, now)))}
                    {singles.length === 0 && doneRows.length === 0 && column.tense !== "past" ? (
                      <p className="tb-empty">Nothing due.</p>
                    ) : null}
                    {canAdd ? (
                      <button
                        type="button"
                        className="tb-addrow"
                        onClick={() => openCreate(column.date)}
                        aria-label={`Add a task due ${column.name} ${formatDateOnlyLabel(column.date)}`}
                      >
                        + add to {column.name}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}

          <section className="tb-wknd" aria-label="Weekend">
            {renderWeekendDay(saturday, "Sat")}
            {renderWeekendDay(sunday, "Sun")}
          </section>
        </div>
      </div>
      </div>
      )}
      <Modal
        open={createDueDate !== null}
        onClose={() => setCreateDueDate(null)}
        title={createDueDate ? `New Task · Due ${formatDateOnlyLabel(createDueDate)}` : "New Task"}
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
              onClick={() => {
                setImplementationsLoading(true);
                setImplementationsError(null);
                setImplementationsLoadRequest((current) => current + 1);
              }}
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
