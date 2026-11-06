"use client";

import type { DragEvent, ReactNode } from "react";
import { ProjectSquare, ProjectTag } from "@/components/project-colors/ProjectSquare";
import type { TaskCardData } from "@/components/tasks/TaskCard";
import { getTaskVisualState, NowUnblockedPill, TaskStateBadge } from "@/components/tasks/task-state";
import { PersonalBadge } from "@/components/ui/PersonalBadge";
import { Button } from "@/components/ui/Button";
import { RangeFillLayers, RangeSrText, StepsPill } from "@/components/tasks/TaskRangeParts";
import { MoveToMenu } from "@/components/today/MoveToMenu";
import { stepsPillText, type RangeCardView } from "@/lib/task-range-view";
import type { MoveChoice, MoveTaskInput } from "@/lib/today/today-board";

/**
 * Today's cards (redesign S4, mockup d3-olive.html "card", "bar", "dn"): a
 * sheet with the title, the project square + name, the due words, who has it,
 * the status line, then Done and Move to… (no drag needed). One card is "open"
 * while the task panel shows it: outline, "Open in panel" tag and a notch.
 */

export interface WeekBoardTaskData extends TaskCardData {
  priorityScore: number;
  projectName: string | null;
  waitingOn: string | null;
  followUpAt: string | null;
  needsReview: boolean;
  dependencyBlocked: boolean;
  isPersonal: boolean;
  /** Multi-day tasks S2: the range view (null = no range). */
  range?: RangeCardView | null;
  /** Who has it (056): "brent" shows "You", an agent with a label shows "Agent: PM". */
  owner?: "brent" | "agent" | null;
  ownerLabel?: string | null;
  /** One plain sentence on where it stands (056). */
  statusLine?: string | null;
}

/** The id that ties a board card's steps pill to its open steps. */
export function boardStepsId(context: string, taskId: string): string {
  return `board-steps-${context}-${taskId}`;
}

export interface CardMove {
  choices: MoveChoice[];
  input: MoveTaskInput;
  onPick: (choice: MoveChoice) => void;
}

export function OwnerChip({ owner, label }: { owner?: "brent" | "agent" | null; label?: string | null }) {
  if (owner === "brent") {
    return (
      <span className="tb-own" data-owner="brent">
        You
      </span>
    );
  }
  if (owner === "agent" && label) {
    return (
      <span className="tb-own" data-owner="agent">
        Agent: {label}
      </span>
    );
  }
  return null;
}

export interface WeeklyTaskCardProps {
  task: WeekBoardTaskData;
  completing: boolean;
  moving: boolean;
  dragging?: boolean;
  /** The task panel shows this task. */
  open?: boolean;
  /** "today" outlines the card in ink; "overdue" draws it late. */
  tense?: "past" | "today" | "future" | "overdue";
  /** "due today 5 PM", "was due Tue". */
  dueText?: string | null;
  dueLate?: boolean;
  onOpen: () => void;
  onDone: () => void;
  move?: CardMove;
  /** Desktop drag between days still works; Move to… is the way on every screen. */
  canDrag?: boolean;
  onDragStart?: (taskId: string) => void;
  onDragEnd?: () => void;
  /** Where the card sits ("col-thursday", "overdue"): keeps steps ids unique. */
  context?: string;
  stepsOpen?: boolean;
  onToggleSteps?: () => void;
  steps?: ReactNode;
  footer?: ReactNode;
}

export function WeeklyTaskCard({
  task,
  completing,
  moving,
  dragging = false,
  open = false,
  tense = "future",
  dueText = null,
  dueLate = false,
  onOpen,
  onDone,
  move,
  canDrag = false,
  onDragStart,
  onDragEnd,
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
  const draggable = canDrag && !completing && !moving && Boolean(onDragStart);
  const dragProps = draggable
    ? {
        draggable: true,
        onDragStart: (event: DragEvent<HTMLElement>) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", task.id);
          onDragStart?.(task.id);
        },
        onDragEnd: () => onDragEnd?.(),
      }
    : { draggable: false };

  const body = (
    <>
      {open ? <span className="tb-openmark">Open in panel</span> : null}
      <NowUnblockedPill task={{ status: task.status, unblocked_at: task.unblockedAt }} className="self-start" />
      <h3 className="tb-t">
        <button type="button" onClick={onOpen} className="tb-open-btn">
          {task.title}
          {range ? <RangeSrText view={range} /> : null}
        </button>
      </h3>
      <div className="tb-meta">
        {/* A plain mark here: the strip's colour key edits colours (a 10px button is a mis-tap on a phone card). */}
        {task.squareInput ? <ProjectTag {...task.squareInput} editable={false} className="max-w-full" /> : null}
        {!task.squareInput && task.isPersonal ? <PersonalBadge /> : null}
        {dueText ? (
          <span className="tb-due" data-late={dueLate || tense === "overdue" ? "" : undefined}>
            {dueText}
          </span>
        ) : null}
        <OwnerChip owner={task.owner} label={task.ownerLabel} />
        {state ? <TaskStateBadge state={state} /> : null}
        {range && range.chipText ? (
          <span className="tb-chip" data-tone={range.tone === "late" ? "late" : range.tone === "quiet" ? "quiet" : undefined}>
            {range.chipText}
          </span>
        ) : null}
        {range && onToggleSteps ? (
          <StepsPill view={range} expanded={stepsOpen} onToggle={onToggleSteps} controlsId={boardStepsId(context, task.id)} />
        ) : null}
      </div>
      {task.statusLine ? <p className="tb-st">{task.statusLine}</p> : null}
      {footer}
      <div className="tb-acts">
        <Button
          variant={range?.allStepsDone ? "ready" : "primary"}
          size="sm"
          onClick={onDone}
          disabled={completing || moving}
          aria-label={range?.allStepsDone ? "Mark task complete (all steps done)" : "Mark task complete"}
        >
          {moving ? "Moving…" : completing ? "Marking…" : "✓ Done"}
        </Button>
        {move ? (
          <MoveToMenu title={task.title} task={move.input} choices={move.choices} onPick={move.onPick} disabled={completing || moving} />
        ) : null}
      </div>
      {stepsOpen && steps ? steps : null}
    </>
  );

  return (
    <article
      data-task-open={task.id}
      data-tense={tense === "overdue" ? undefined : tense}
      data-late={tense === "overdue" || task.dueState === "Overdue" ? "" : undefined}
      data-open={open ? "" : undefined}
      data-range={range ? range.kind : undefined}
      data-range-card={range ? range.kind : undefined}
      data-dragging={dragging ? "" : undefined}
      data-moving={moving ? "" : undefined}
      data-draggable={draggable ? "" : undefined}
      className="tb-card"
      {...dragProps}
    >
      {range ? (
        <>
          <RangeFillLayers view={range} />
          <div className="tb-card-body">{body}</div>
        </>
      ) : (
        body
      )}
    </article>
  );
}

/**
 * A multi-day task in the lane: one bar across the days it covers (desktop),
 * or a full-width bar with an M–S strip (phone). The fill is steps done, the
 * dashed mark time gone (amber when behind pace); the words say the same.
 */
export function LaneBar({
  task,
  view,
  open,
  late,
  startCol,
  endCol,
  startedText,
  continuesText,
  completing,
  moving,
  onOpen,
  onDone,
  move,
  stepsOpen,
  onToggleSteps,
  steps,
  dayStrip,
}: {
  task: WeekBoardTaskData;
  view: RangeCardView;
  open: boolean;
  late: boolean;
  startCol: number;
  endCol: number;
  startedText: string | null;
  continuesText: string | null;
  completing: boolean;
  moving: boolean;
  onOpen: () => void;
  onDone: () => void;
  move?: CardMove;
  stepsOpen: boolean;
  onToggleSteps?: () => void;
  steps?: ReactNode;
  dayStrip?: ReactNode;
}) {
  const stepsText = stepsPillText(view, true);
  return (
    <div
      className="tb-bar"
      data-task-open={task.id}
      data-range-card={view.kind}
      data-lane-span={`${startCol}-${endCol}`}
      data-open={open ? "" : undefined}
      data-late={late ? "" : undefined}
      style={{ ["--ls" as string]: String(startCol + 1), ["--le" as string]: String(endCol + 2) }}
    >
      <RangeFillLayers view={view} />
      <div className="tb-bar-body">
        {startedText ? <span className="tb-s">{startedText}</span> : null}
        {task.squareInput ? <ProjectSquare {...task.squareInput} editable={false} /> : null}
        <button type="button" className="tb-bt" onClick={onOpen}>
          {task.title}
          <RangeSrText view={view} />
        </button>
        <span className="tb-chip" data-tone={view.tone === "late" ? "late" : view.tone === "quiet" ? "quiet" : undefined}>
          {view.day ? `Day ${view.day.day} of ${view.day.of}` : view.chipText}
        </span>
        {onToggleSteps && stepsText ? (
          <StepsPill view={view} expanded={stepsOpen} onToggle={onToggleSteps} controlsId={boardStepsId("lane", task.id)} compact />
        ) : view.behindPace ? (
          <span className="tb-s" data-behind="">
            behind
          </span>
        ) : null}
        {continuesText ? <span className="tb-cont">{continuesText}</span> : null}
        <span className="tb-bar-acts" style={continuesText ? undefined : { marginLeft: "auto" }}>
          <Button
            variant={view.allStepsDone ? "ready" : "primary"}
            size="xs"
            onClick={onDone}
            disabled={completing || moving}
            aria-label={view.allStepsDone ? `Mark “${task.title}” complete (all steps done)` : `Mark “${task.title}” complete`}
          >
            ✓ Done
          </Button>
          {move ? (
            <MoveToMenu title={task.title} task={move.input} choices={move.choices} onPick={move.onPick} disabled={completing || moving} size="xs" compact />
          ) : null}
        </span>
        {dayStrip ? <div className="tb-strip-days">{dayStrip}</div> : null}
      </div>
      {stepsOpen && steps ? <div className="relative px-2 pb-2">{steps}</div> : null}
    </div>
  );
}

/** A done task on its day: one struck-through line that still opens the task. */
/**
 * A faded "late" copy of an Overdue task on the day it was due (the week grid
 * only; Brent 11/6). The real card is in the Overdue queue and is the one you
 * act on, so this line only opens the task: no Done, no Move to…, no drag. A
 * dashed, muted line with a "Late" tag; its name says it lives in Overdue.
 */
export function LateCopy({ task, label, onOpen }: { task: WeekBoardTaskData; label: string; onOpen: () => void }) {
  return (
    <button type="button" className="tb-lc" data-task-open={task.id} onClick={onOpen} aria-label={label} title="Late · the task is in Overdue">
      <span className="tb-lc-tag" aria-hidden="true">
        Late
      </span>
      <span className="tb-lc-t">{task.title}</span>
      {task.squareInput ? (
        <span className="tb-sq-end">
          <ProjectSquare {...task.squareInput} editable={false} />
        </span>
      ) : null}
    </button>
  );
}

export function DoneRow({ task, onOpen }: { task: WeekBoardTaskData; onOpen: () => void }) {
  return (
    <button type="button" className="tb-dn" data-task-open={task.id} onClick={onOpen} aria-label={`${task.title} (done)`}>
      <span className="tb-ck" aria-hidden="true">
        ✓
      </span>
      <span className="tb-t2">{task.title}</span>
      {task.squareInput ? (
        <span className="tb-sq-end">
          <ProjectSquare {...task.squareInput} editable={false} />
        </span>
      ) : null}
    </button>
  );
}
