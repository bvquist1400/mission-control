"use client";

import type { MouseEvent } from "react";
import { ProjectSquare } from "@/components/project-colors/ProjectSquare";
import { MoveToMenu } from "@/components/today/MoveToMenu";
import { NowUnblockedPill } from "@/components/tasks/task-state";
import { Button } from "@/components/ui/Button";
import { squareInputOf } from "@/lib/project-colors";
import { moveToChoices, type MoveChoice } from "@/lib/today/today-board";
import { STATUS_LABELS, TASK_STATUS_ORDER, ownerText, taskCardDue, type ListClock, type ListTaskStatus } from "@/lib/tasks-list";
import type { TaskWithImplementation } from "@/types/database";

/**
 * One task as a card row on the Tasks page (redesign S5, NOTES.md "Tasks rows
 * as cards"): the select box; the title, the project square + name · section ·
 * sprint · flags, what it waits on and where it stands; who has it, the due
 * words and the status. `data-task-open` ties it to the task panel (↑ / ↓).
 * Done and Move to… (S4's MoveToMenu and rules) show on hover / focus.
 */
export const STATUS_SLUG_IDS: Record<ListTaskStatus, string> = {
  "In Progress": "progress",
  "Blocked/Waiting": "waiting",
  Planned: "planned",
  Backlog: "backlog",
  Parked: "parked",
  Done: "done",
  Missed: "missed",
};

function waitingText(task: TaskWithImplementation): string | null {
  const open = (task.dependencies ?? []).filter((dependency) => dependency.unresolved);
  if (open.length > 0) return `Waiting on ${open[0].title}${open.length > 1 ? ` +${open.length - 1}` : ""}`;
  if (task.status === "Blocked/Waiting") return task.waiting_on ? `Waiting on ${task.waiting_on}` : "Waiting on: not set";
  return null;
}

export function TaskCardRow({
  task,
  clock,
  weekStart,
  open,
  selected,
  busy,
  onOpen,
  onSelect,
  onDone,
  onReopen,
  onMove,
}: {
  task: TaskWithImplementation;
  clock: ListClock;
  weekStart: string;
  open: boolean;
  selected: boolean;
  busy: boolean;
  onOpen: () => void;
  onSelect: (shift: boolean) => void;
  onDone: () => void;
  onReopen: () => void;
  onMove: (choice: MoveChoice) => void;
}) {
  const due = taskCardDue(task, clock);
  const owner = ownerText(task);
  const square = squareInputOf(task);
  const where = task.project?.name ?? task.implementation?.name ?? null;
  const waiting = waitingText(task);
  const closed = task.status === "Done" || task.status === "Missed";

  // The whole card opens the panel; its own controls (the box, Done, Move to…) don't.
  const onCardClick = (event: MouseEvent<HTMLLIElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, select, label, [role='dialog']")) return;
    onOpen();
  };

  return (
    <li
      className="tl-card"
      data-task-open={task.id}
      data-open={open || undefined}
      data-selected={selected || undefined}
      data-busy={busy || undefined}
      data-late={due.late || undefined}
      data-status={STATUS_SLUG_IDS[(TASK_STATUS_ORDER as readonly string[]).includes(task.status) ? (task.status as ListTaskStatus) : "Backlog"]}
      onClick={onCardClick}
    >
      <label className="tl-check" onClick={(event) => event.stopPropagation()}>
        <input
          type="checkbox"
          checked={selected}
          disabled={busy}
          aria-label={`Select “${task.title}”`}
          onChange={() => undefined}
          onClick={(event) => onSelect(event.shiftKey)}
        />
      </label>
      <div className="tl-main">
        <button type="button" className="tl-title" onClick={onOpen}>
          {task.title}
        </button>
        <p className="tl-meta">
          {where ? (
            <span className="tl-where">
              <ProjectSquare {...square} editable={false} />
              {where}
            </span>
          ) : (
            <span className="tl-where tl-none">No project</span>
          )}
          {task.section_name ? <span>{task.section_name}</span> : null}
          {task.sprint?.name ? <span>{task.sprint.name}</span> : null}
          {task.needs_review ? <span className="tl-flag">needs review</span> : null}
          {task.blocker ? <span className="tl-flag" data-tone="late">blocker</span> : null}
          <NowUnblockedPill task={task} />
        </p>
        {waiting ? <p className="tl-wait">{waiting}</p> : null}
        {task.status_line ? <p className="tl-gist">{task.status_line}</p> : null}
      </div>
      <div className="tl-side">
        {owner ? (
          <span className="tl-own" data-owner={task.owner}>
            {owner}
          </span>
        ) : null}
        <span className="tl-due" data-late={due.late || undefined}>
          {due.text}
        </span>
        <span className="tl-status">{STATUS_LABELS[task.status as ListTaskStatus] ?? task.status}</span>
      </div>
      <div className="tl-acts">
        {closed ? (
          <Button variant="secondary" size="xs" disabled={busy} onClick={onReopen}>
            Reopen
          </Button>
        ) : (
          <>
            <Button variant="secondary" size="xs" disabled={busy} onClick={onDone}>
              ✓ Done
            </Button>
            <MoveToMenu title={task.title} task={task} choices={moveToChoices(task, clock.today, weekStart)} onPick={onMove} disabled={busy} size="xs" />
          </>
        )}
      </div>
      {open ? (
        <span className="tl-openmark" aria-hidden="true">
          Open in panel
        </span>
      ) : null}
    </li>
  );
}

