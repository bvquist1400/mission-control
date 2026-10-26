import type { ReactNode } from "react";
import type { TaskCardData } from "@/components/tasks/TaskCard";
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
import type { RangeCardView } from "@/lib/task-range-view";

export interface WeekBoardTaskData extends TaskCardData {
  priorityScore: number;
  projectName: string | null;
  waitingOn: string | null;
  followUpAt: string | null;
  needsReview: boolean;
  dependencyBlocked: boolean;
  isPersonal: boolean;
  /** Multi-day tasks S2: the range view (null = no range: the card is exactly as before). */
  range?: RangeCardView | null;
}

export function getBoardEdgeClass(task: WeekBoardTaskData): string {
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

/** The id that ties a board card's steps pill to its open steps. */
export function boardStepsId(context: string, taskId: string): string {
  return `board-steps-${context}-${taskId}`;
}

export interface WeeklyTaskCardProps {
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
  /** Multi-day lane cards aren't dragged (their dates change in the task window). */
  canDrag?: boolean;
  /** Where the card sits ("lane", "phone", "col"): keeps steps ids unique when a task shows twice. */
  context?: string;
  stepsOpen?: boolean;
  onToggleSteps?: () => void;
  steps?: ReactNode;
  /** Under the meta row: "continues to Sun →", the phone day strip. */
  footer?: ReactNode;
}

export function WeeklyTaskCard({
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
  canDrag = true,
  context = "col",
  stepsOpen = false,
  onToggleSteps,
  steps,
  footer,
}: WeeklyTaskCardProps) {
  const range = task.range ?? null;
  const state = getTaskVisualState({
    status: task.status,
    dependencyBlocked: task.dependencyBlocked,
    updatedAt: task.updatedAt,
  });

  if (!range) {
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
          {task.isPersonal ? <PersonalBadge className="mt-1" /> : null}
          {state ? <TaskStateBadge state={state} className="mt-1" /> : null}
        </button>

        <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
          <Button variant="success" size="sm"
            onClick={onDone}
            disabled={completing}
            aria-label="Mark task complete">
            {moving ? "Moving..." : completing ? "Marking..." : "✓ Done"}
          </Button>
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

  const draggable = canDrag && !completing && !pinning && !moving;
  return (
    <article
      data-range-card={range.kind}
      draggable={draggable}
      onDragStart={
        draggable
          ? (event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", task.id);
              onDragStart(task.id);
            }
          : undefined
      }
      onDragEnd={draggable ? onDragEnd : undefined}
      title={canDrag ? undefined : "Change a multi-day task's dates in the task window."}
      className={`relative overflow-hidden rounded-xl border border-l-4 border-stroke bg-panel p-2.5 shadow-sm transition-colors hover:border-foreground/20 ${
        draggable ? "cursor-grab active:cursor-grabbing" : ""
      } ${dragging ? "opacity-50" : ""} ${moving ? "opacity-60" : ""} ${rangeEdgeClass(range)}`}
    >
      <RangeFillLayers view={range} />
      <div className="relative">
        <button
          type="button"
          onClick={onOpen}
          className="block w-full text-left focus:outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <h3 className="text-sm font-semibold leading-snug text-foreground">{task.title}</h3>
          <RangeSrText view={range} />
        </button>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {task.isPersonal ? <PersonalBadge /> : null}
          <RangeChip view={range} />
          {state ? <TaskStateBadge state={state} /> : null}
          {onToggleSteps ? (
            <StepsPill
              view={range}
              expanded={stepsOpen}
              onToggle={onToggleSteps}
              controlsId={boardStepsId(context, task.id)}
            />
          ) : null}
        </div>
        {footer}

        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant={range.allStepsDone ? "ready" : "success"} size="sm" className="min-w-28"
            onClick={onDone}
            disabled={completing}
            aria-label={range.allStepsDone ? "Mark task complete (all steps done)" : "Mark task complete"}>
            {moving ? "Moving..." : completing ? "Marking..." : "✓ Done"}
          </Button>
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
        {stepsOpen && steps ? steps : null}
      </div>
    </article>
  );
}
