import type { ReactNode } from "react";
import { getTaskVisualState, TaskStateBadge } from "@/components/tasks/task-state";
import { PersonalBadge } from "@/components/ui/PersonalBadge";
import { Button } from "@/components/ui/Button";
import {
  RangeChip,
  RangeFillLayers,
  RangeSrText,
  StepsPill,
  rangeEdgeClass,
} from "@/components/tasks/TaskRangeParts";
import { isPersonalTaskOrProject } from "@/lib/personal-exclusion";
import { isPastDue } from "@/lib/task-range";
import type { RangeCardView } from "@/lib/task-range-view";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";
import type { TaskWithImplementation } from "@/types/database";

const TIME_ZONE = DEFAULT_WORKDAY_CONFIG.timezone;

/** The Now panel's due chip for a task without a range (unchanged by S2; late = `isPastDue`). */
export function getDueLabel(dueAt: string | null, nowMs: number): string | null {
  if (!dueAt) {
    return null;
  }
  const dueMs = Date.parse(dueAt);
  if (!Number.isFinite(dueMs)) {
    return null;
  }
  if (isPastDue(dueAt, new Date(nowMs))) {
    return "Overdue";
  }
  const dueDay = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date(dueMs));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date(nowMs));
  if (dueDay === today) {
    return "Due today";
  }
  return "Due soon";
}

export interface NowTaskCardProps {
  task: TaskWithImplementation;
  nowMs: number;
  completing: boolean;
  onOpen: () => void;
  onDone: () => void;
  /** Multi-day tasks S2: the range view (null = a task without a range, rendered exactly as before). */
  range?: RangeCardView | null;
  stepsOpen?: boolean;
  onToggleSteps?: () => void;
  /** The open steps (InlineSteps), rendered under the card's content. */
  steps?: ReactNode;
}

/** The id that ties a card's steps pill to its open steps. */
export function nowStepsId(taskId: string): string {
  return `now-steps-${taskId}`;
}

/** One "Top priorities" row in the Now panel. */
export function NowTaskCard({
  task,
  nowMs,
  completing,
  onOpen,
  onDone,
  range = null,
  stepsOpen = false,
  onToggleSteps,
  steps,
}: NowTaskCardProps) {
  const state = getTaskVisualState({
    status: task.status,
    dependencyBlocked: Boolean(task.dependency_blocked),
    updatedAt: task.updated_at ?? null,
  });

  if (!range) {
    const dueLabel = getDueLabel(task.due_at, nowMs);
    return (
      <li className="rounded-xl border border-l-4 border-stroke border-l-accent bg-panel-muted/40 p-3">
        <div className="flex items-start justify-between gap-3">
          <button
            type="button"
            onClick={onOpen}
            className="min-w-0 flex-1 text-left focus:outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <p className="text-base font-semibold leading-snug text-foreground">{task.title}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {isPersonalTaskOrProject(task) ? <PersonalBadge /> : null}
              {dueLabel ? (
                <span
                  className={`inline-flex rounded px-1.5 py-0.5 text-xs font-semibold ${
                    dueLabel === "Overdue"
                      ? "bg-red-500/15 text-red-300"
                      : dueLabel === "Due today"
                        ? "bg-accent-soft text-red-100"
                        : "bg-panel text-muted-foreground"
                  }`}
                >
                  {dueLabel}
                </span>
              ) : null}
              {state ? <TaskStateBadge state={state} /> : null}
              {task.implementation?.name ? (
                <span className="text-xs text-muted-foreground">{task.implementation.name}</span>
              ) : null}
            </div>
          </button>
          <Button variant="success" size="sm" className="shrink-0"
            onClick={onDone}
            disabled={completing}
            aria-label="Mark task complete">
            {completing ? "Marking..." : "✓ Done"}
          </Button>
        </div>
      </li>
    );
  }

  const stepsId = nowStepsId(task.id);
  return (
    <li
      data-range-card={range.kind}
      className={`relative overflow-hidden rounded-xl border border-l-4 border-stroke ${rangeEdgeClass(range)} bg-panel-muted/40 p-3`}
    >
      <RangeFillLayers view={range} />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onOpen}
            className="block w-full text-left focus:outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <p className="text-base font-semibold leading-snug text-foreground">{task.title}</p>
            <RangeSrText view={range} />
          </button>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {isPersonalTaskOrProject(task) ? <PersonalBadge /> : null}
            <RangeChip view={range} />
            {state ? <TaskStateBadge state={state} /> : null}
            {onToggleSteps ? (
              <StepsPill view={range} expanded={stepsOpen} onToggle={onToggleSteps} controlsId={stepsId} />
            ) : null}
            {task.implementation?.name ? (
              <span className="text-xs text-muted-foreground">{task.implementation.name}</span>
            ) : null}
          </div>
        </div>
        <Button variant={range.allStepsDone ? "ready" : "success"} size="sm" className="shrink-0"
          onClick={onDone}
          disabled={completing}
          aria-label={range.allStepsDone ? "Mark task complete (all steps done)" : "Mark task complete"}>
          {completing ? "Marking..." : "✓ Done"}
        </Button>
      </div>
      {stepsOpen && steps ? <div className="relative">{steps}</div> : null}
    </li>
  );
}
