"use client";

import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { STATUS_SLUG_IDS, TaskCardRow } from "@/components/backlog/TaskCardRow";
import { useTaskPanel, useTaskPanelEvents } from "@/components/tasks/panel/TaskPanelProvider";
import { useDateCascade } from "@/components/tasks/DateCascadeProvider";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { useTaskMutation } from "@/hooks/useTaskMutation";
import { patchTaskWithReply } from "@/lib/tasks-client";
import { withUnblockPillRule } from "@/lib/task-unblocks";
import { moveToastText, moveUpdates, dueAtForBoardDay, type MoveChoice } from "@/lib/today/today-board";
import { addDateOnlyDays } from "@/lib/today/week-board";
import {
  STATUS_LABELS,
  TASK_STATUS_ORDER,
  activeFilterCount,
  bulkEditPlan,
  groupTaskList,
  pruneSelection,
  selectRange,
  taskListOrder,
  toggleSelection,
  type BulkChange,
  type BulkPlan,
  type ListClock,
  type ListTaskStatus,
  type TaskListFilters,
} from "@/lib/tasks-list";
import type { ImplementationSummary, SprintWithImplementation, TaskUpdatePayload, TaskWithImplementation } from "@/types/database";
import type { ListProject } from "@/components/backlog/BacklogList";

export function TaskCardListSkeleton() {
  return (
    <div className="tl-list" aria-busy="true" aria-label="Loading tasks">
      {[1, 2, 3, 4, 5].map((item) => (
        <div key={item} className="tl-card tl-card-skel">
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}

/** Bulk PATCHes in flight at once (the old grid sent them all together). */
const BULK_WAVE = 6;

interface TaskCardListProps {
  /** Every loaded row (bulk plans and panel events look tasks up here). */
  tasks: TaskWithImplementation[];
  /** The rows the filters and scope match, before grouping. */
  matchingTasks: TaskWithImplementation[];
  setTasks: Dispatch<SetStateAction<TaskWithImplementation[]>>;
  filters: TaskListFilters;
  clock: ListClock;
  openTaskId: string | null;
  implementations: ImplementationSummary[];
  projects: ListProject[];
  sprints: SprintWithImplementation[];
  ownerLabels: string[];
  emptyAction?: ReactNode;
}

/**
 * The task list as card rows (Brent 11/5: "the tasks on the task page need a
 * "card like" outline like how they do on the today page rather than floating
 * text"): grouped by status, each card a sheet with the project square, title,
 * project · section, who has it, due words and the status line. Clicking a card
 * opens the S3 task panel (↑ / ↓ follow `taskListOrder`, the drawn order). The
 * box on the left selects it for bulk edit; Done and Move to… sit on the card
 * (pointer devices; on a touch screen the panel has them).
 */
export function TaskCardList({
  tasks,
  matchingTasks,
  setTasks,
  filters,
  clock,
  openTaskId,
  implementations,
  projects,
  sprints,
  ownerLabels,
  emptyAction,
}: TaskCardListProps) {
  const { openTask, seedTasks } = useTaskPanel();
  const dateCascade = useDateCascade();
  const { completeTask, updateTaskWithUndo } = useTaskMutation();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const groups = useMemo(() => groupTaskList(matchingTasks, filters.sort, expanded), [matchingTasks, filters.sort, expanded]);
  const order = useMemo(() => taskListOrder(groups), [groups]);
  const matchingIds = useMemo(() => new Set(matchingTasks.map((task) => task.id)), [matchingTasks]);
  const weekStart = useMemo(() => addDateOnlyDays(clock.weekEnd, -6), [clock.weekEnd]);

  // A filter change (or a row leaving the list) never leaves a hidden task selected.
  useEffect(() => {
    setSelected((current) => pruneSelection(current, matchingIds));
  }, [matchingIds]);

  // The panel starts from the rows the list shows (no blank frame on ↑ / ↓).
  useEffect(() => {
    seedTasks(matchingTasks);
  }, [matchingTasks, seedTasks]);

  // Saves made in the panel update these rows.
  useTaskPanelEvents({
    onTaskUpdated: (taskId, updates) =>
      setTasks((current) => current.map((item) => (item.id === taskId ? { ...item, ...updates } as TaskWithImplementation : item))),
    onTaskDeleted: (taskId) => setTasks((current) => current.filter((item) => item.id !== taskId)),
    onDatesChanged: (changes) => applyDates(changes),
  });

  function applyDates(changes: Array<{ task_id: string; due_at: string | null }>) {
    const byId = new Map(changes.map((change) => [change.task_id, change.due_at]));
    setTasks((current) => current.map((task) => (byId.has(task.id) ? { ...task, due_at: byId.get(task.id) ?? null } : task)));
  }

  function markBusy(id: string, on: boolean) {
    setBusyIds((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function patchLocal(taskId: string, updates: Partial<TaskWithImplementation>) {
    setTasks((current) => current.map((task) => (task.id === taskId ? { ...withUnblockPillRule(task, updates), ...updates } : task)));
  }

  /** A saved row from the server, keeping what the list read alongside it (dependencies). */
  function takeSaved(saved: TaskWithImplementation) {
    setTasks((current) =>
      current.map((task) =>
        task.id === saved.id ? { ...task, ...saved, dependencies: task.dependencies ?? [], dependency_blocked: task.dependency_blocked ?? false } : task
      )
    );
  }

  // ── One card: Done, Reopen, Move to… (the same paths as Today) ──────────
  async function handleDone(task: TaskWithImplementation) {
    if (busyIds.has(task.id)) return;
    markBusy(task.id, true);
    setError(null);
    await completeTask(task, {
      onOptimistic: () => patchLocal(task.id, { status: "Done" }),
      onRollback: () => patchLocal(task.id, { status: task.status }),
      onUndo: () => patchLocal(task.id, { status: task.status }),
    });
    markBusy(task.id, false);
  }

  async function handleReopen(task: TaskWithImplementation) {
    if (busyIds.has(task.id)) return;
    markBusy(task.id, true);
    await updateTaskWithUndo(task.id, { status: "Backlog" }, { status: task.status }, {
      message: `Reopened “${task.title.length > 48 ? `${task.title.slice(0, 47)}…` : task.title}” in the Backlog`,
      onOptimistic: () => patchLocal(task.id, { status: "Backlog" }),
      onRollback: () => patchLocal(task.id, { status: task.status }),
      onUndo: () => patchLocal(task.id, { status: task.status }),
    });
    markBusy(task.id, false);
  }

  async function handleMove(task: TaskWithImplementation, choice: MoveChoice) {
    if (busyIds.has(task.id)) return;
    markBusy(task.id, true);
    setError(null);
    if (choice.kind === "day" && choice.date) {
      const nextDueAt = dueAtForBoardDay(choice.date);
      const previousDueAt = task.due_at;
      if (dateCascade) {
        // The panel's path: the date saves at once, the toast lists what moved with it (Undo, how far, >25 confirm).
        await dateCascade.changeDueDate({
          taskId: task.id,
          title: task.title,
          previousDueAt,
          updates: { due_at: nextDueAt },
          onOptimistic: () => patchLocal(task.id, { due_at: nextDueAt }),
          onRollback: () => patchLocal(task.id, { due_at: previousDueAt }),
          onSaved: (saved) => takeSaved(saved),
          onDatesChanged: applyDates,
        });
      }
    } else {
      const plan = moveUpdates(choice);
      if (plan.kind === "status") {
        const undo = choice.kind === "backlog" ? { status: task.status, due_at: task.due_at } : { status: task.status };
        await updateTaskWithUndo(task.id, plan.updates, undo, {
          message: moveToastText(choice, task.title),
          onOptimistic: () => patchLocal(task.id, plan.updates as Partial<TaskWithImplementation>),
          onRollback: () => patchLocal(task.id, { status: task.status, due_at: task.due_at }),
          onUndo: () => patchLocal(task.id, { status: task.status, due_at: task.due_at }),
          failureMessage: "Couldn't move the task.",
        });
      }
    }
    markBusy(task.id, false);
  }

  // ── Selection ───────────────────────────────────────────────────────────
  function onSelect(taskId: string, shift: boolean) {
    setSelected((current) => (shift ? selectRange(order, current, anchorRef.current, taskId) : toggleSelection(current, taskId)));
    anchorRef.current = taskId;
  }

  const selectedCount = selected.size;
  const allSelected = matchingTasks.length > 0 && selectedCount === matchingTasks.length;

  // ── Bulk edit (PATCH /api/tasks/[id] per task, Undo in the toast) ─────
  async function runSteps(plan: BulkPlan, kind: "apply" | "undo"): Promise<{ failed: Array<{ taskId: string; error: string }> }> {
    const failed: Array<{ taskId: string; error: string }> = [];
    const steps = plan.steps;
    for (let index = 0; index < steps.length; index += BULK_WAVE) {
      const wave = steps.slice(index, index + BULK_WAVE);
      await Promise.all(
        wave.map(async (step) => {
          const body = (kind === "apply" ? step.updates : step.undo) as TaskUpdatePayload;
          const result = await patchTaskWithReply(step.taskId, body, plan.requestOptions);
          if (result.ok) takeSaved(result.task);
          else failed.push({ taskId: step.taskId, error: result.error });
        })
      );
    }
    return { failed };
  }

  function optimistic(plan: BulkPlan, kind: "apply" | "undo") {
    const byId = new Map(plan.steps.map((step) => [step.taskId, kind === "apply" ? step.updates : step.undo]));
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const sprintById = new Map(sprints.map((sprint) => [sprint.id, sprint]));
    setTasks((current) =>
      current.map((task) => {
        const updates = byId.get(task.id);
        if (!updates) return task;
        const next = { ...withUnblockPillRule(task, updates as Partial<TaskWithImplementation>), ...updates } as TaskWithImplementation;
        if ("project_id" in updates) {
          const project = updates.project_id ? projectById.get(String(updates.project_id)) : null;
          next.project = project ? { id: project.id, name: project.name, tags: project.tags ?? undefined } : null;
          next.section_name = null;
        }
        if ("sprint_id" in updates) {
          const sprint = updates.sprint_id ? sprintById.get(String(updates.sprint_id)) : null;
          next.sprint = sprint ? { id: sprint.id, name: sprint.name, start_date: sprint.start_date, end_date: sprint.end_date } : null;
        }
        return next;
      })
    );
  }

  async function applyBulk(change: BulkChange) {
    if (bulkBusy || selected.size === 0) return;
    const plan = bulkEditPlan(tasks, selected, change);
    if (plan.steps.length === 0) {
      setError(plan.skipped.length ? `Nothing to change: ${plan.skipped[0].reason}${plan.skipped.length > 1 ? ` (and ${plan.skipped.length - 1} more)` : ""}.` : null);
      return;
    }
    setBulkBusy(true);
    setError(null);
    const before = new Map(tasks.map((task) => [task.id, task]));
    optimistic(plan, "apply");
    const { failed } = await runSteps(plan, "apply");
    if (failed.length) {
      // Put the failed rows back as they were.
      const failedIds = new Set(failed.map((item) => item.taskId));
      setTasks((current) => current.map((task) => (failedIds.has(task.id) ? before.get(task.id) ?? task : task)));
      setError(`Couldn't change ${failed.length} of ${plan.steps.length}: ${failed[0].error}`);
    }
    const failedSet = new Set(failed.map((item) => item.taskId));
    const done = plan.steps.length - failed.length;
    const skippedNote = plan.skipped.length ? ` · ${plan.skipped.length} left as they were` : "";
    if (done > 0) {
      const applied: BulkPlan = { ...plan, steps: plan.steps.filter((step) => !failedSet.has(step.taskId)) };
      toast({
        tone: "success",
        message: `${failed.length ? plan.message.replace(/^(\w+) \d+ tasks?/, `$1 ${done} task${done === 1 ? "" : "s"}`) : plan.message}${skippedNote}`,
        action: {
          label: "Undo",
          onClick: async () => {
            optimistic(applied, "undo");
            const undone = await runSteps(applied, "undo");
            if (undone.failed.length) {
              toast({ tone: "danger", message: `Couldn't undo ${undone.failed.length}: ${undone.failed[0].error}` });
            }
          },
        },
      });
    }
    setBulkBusy(false);
  }

  async function deleteSelected() {
    const ids = [...selected];
    setConfirmDelete(false);
    if (ids.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    setError(null);
    const failedTitles: string[] = [];
    for (let index = 0; index < ids.length; index += BULK_WAVE) {
      await Promise.all(
        ids.slice(index, index + BULK_WAVE).map(async (taskId) => {
          const task = tasks.find((item) => item.id === taskId);
          try {
            const response = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
            if (!response.ok) throw new Error("Delete failed");
            setTasks((current) => current.filter((item) => item.id !== taskId));
          } catch {
            failedTitles.push(task?.title ?? taskId);
          }
        })
      );
    }
    setBulkBusy(false);
    if (failedTitles.length) setError(`Couldn't delete ${failedTitles.length} task${failedTitles.length === 1 ? "" : "s"}.`);
    else toast({ tone: "success", message: `Deleted ${ids.length} task${ids.length === 1 ? "" : "s"}` });
  }

  const hasFilters = activeFilterCount(filters) > 0 || Boolean(filters.q);

  if (matchingTasks.length === 0) {
    return (
      <div className="tl-list">
        {error ? <p className="tl-error" role="alert">{error}</p> : null}
        <div className="tl-empty">
          <p className="tl-empty-title">{hasFilters ? "No tasks match these filters" : "No open tasks"}</p>
          <p>{hasFilters ? "Change or clear a filter to see more." : "Add one with + New task."}</p>
          {hasFilters && emptyAction ? <div className="tl-empty-act">{emptyAction}</div> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="tl-list" data-selecting={selectedCount > 0 || undefined}>
      {error ? <p className="tl-error" role="alert">{error}</p> : null}
      <div className="tl-listhead">
        <label className="tl-check tl-all">
          <input
            type="checkbox"
            checked={allSelected}
            ref={(input) => {
              if (input) input.indeterminate = selectedCount > 0 && !allSelected;
            }}
            onChange={() => setSelected(allSelected ? new Set() : new Set(matchingTasks.map((task) => task.id)))}
          />
          <span>{allSelected ? "Clear selection" : `Select all ${matchingTasks.length}`}</span>
        </label>
        <span className="tl-hint">Shift-click a box to select a run of cards.</span>
      </div>

      <div data-task-list="tasks" className="tl-groups">
        {groups.map((group) => (
          <section key={group.status} className="tl-group" aria-labelledby={`tl-g-${STATUS_SLUG_IDS[group.status]}`}>
            <h2 className="tl-gh" id={`tl-g-${STATUS_SLUG_IDS[group.status]}`}>
              {group.label} <span>{group.hidden ? `${group.shown.length} of ${group.tasks.length} shown` : group.tasks.length}</span>
            </h2>
            <ol className="tl-cards">
              {group.shown.map((task) => (
                <TaskCardRow
                  key={task.id}
                  task={task}
                  clock={clock}
                  weekStart={weekStart}
                  open={task.id === openTaskId}
                  selected={selected.has(task.id)}
                  busy={busyIds.has(task.id) || (bulkBusy && selected.has(task.id))}
                  onOpen={() => openTask(task)}
                  onSelect={(shift) => onSelect(task.id, shift)}
                  onDone={() => void handleDone(task)}
                  onReopen={() => void handleReopen(task)}
                  onMove={(choice) => void handleMove(task, choice)}
                  showEstimate={filters.sort === "estimate"}
                />
              ))}
            </ol>
            {group.hidden ? (
              <button
                type="button"
                className="tl-more"
                onClick={() => setExpanded((current) => new Set(current).add(group.status))}
              >
                Show {group.hidden} more {group.label.toLowerCase()}
              </button>
            ) : null}
          </section>
        ))}
      </div>

      {selectedCount > 0 ? (
        <BulkBar
          count={selectedCount}
          busy={bulkBusy}
          onClear={() => setSelected(new Set())}
          onApply={(change) => void applyBulk(change)}
          onDelete={() => setConfirmDelete(true)}
          implementations={implementations}
          projects={projects}
          sprints={sprints}
          ownerLabels={ownerLabels}
          today={clock.today}
        />
      ) : null}

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete ${selectedCount} task${selectedCount === 1 ? "" : "s"}?`}>
        <p className="text-sm text-muted-foreground">This can&rsquo;t be undone. Their comments and checklists go with them.</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={() => void deleteSelected()}>
            Delete {selectedCount}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/**
 * The bar for the selected cards: Status, Owner, Due, Project, Sprint (each
 * applies when picked, with Undo in the toast), Delete (asks first), Clear.
 * Sticky at the bottom of the list; on a phone it sits above the tab bar and
 * its menus open from an "Edit" button.
 */
function BulkBar({
  count,
  busy,
  onClear,
  onApply,
  onDelete,
  implementations,
  projects,
  sprints,
  ownerLabels,
  today,
}: {
  count: number;
  busy: boolean;
  onClear: () => void;
  onApply: (change: BulkChange) => void;
  onDelete: () => void;
  implementations: ImplementationSummary[];
  projects: ListProject[];
  sprints: SprintWithImplementation[];
  ownerLabels: string[];
  today: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pickDate, setPickDate] = useState(false);
  const [date, setDate] = useState("");
  const appName = (id: string | null | undefined) => implementations.find((item) => item.id === id)?.name ?? null;
  const sortedProjects = useMemo(() => [...projects].sort((a, b) => a.name.localeCompare(b.name)), [projects]);

  const pick = (handler: (value: string) => void) => (event: { target: HTMLSelectElement }) => {
    const value = event.target.value;
    event.target.value = "";
    if (value) handler(value);
  };

  const dayAfter = (n: number) => addDateOnlyDays(today, n);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const nextMonday = addDateOnlyDays(today, ((8 - weekday) % 7) || 7);

  return (
    <section className="tl-bulk" aria-label={`Edit ${count} selected task${count === 1 ? "" : "s"}`} data-expanded={expanded || undefined}>
      <p className="tl-bulk-n">
        <b>{count}</b> selected
      </p>
      <Button variant="ghost" size="xs" onClick={onClear}>
        Clear
      </Button>
      <button type="button" className="tl-bulk-edit" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
        Edit…
      </button>
      <div className="tl-bulk-menus">
        <label className="tl-bf">
          <span>Status</span>
          <select disabled={busy} defaultValue="" onChange={pick((value) => onApply({ kind: "status", status: value as ListTaskStatus }))}>
            <option value="">Set status…</option>
            {TASK_STATUS_ORDER.filter((status) => status !== "Missed").map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <label className="tl-bf">
          <span>Owner</span>
          <select
            disabled={busy}
            defaultValue=""
            onChange={pick((value) =>
              onApply(value === "brent" ? { kind: "owner", owner: "brent" } : { kind: "owner", owner: "agent", label: value.startsWith("agent:") ? value.slice(6) : null })
            )}
          >
            <option value="">Give to…</option>
            <option value="brent">You</option>
            <option value="agent">An agent (keep its name)</option>
            {ownerLabels.map((label) => (
              <option key={label} value={`agent:${label}`}>
                Agent: {label}
              </option>
            ))}
          </select>
        </label>
        <label className="tl-bf">
          <span>Due</span>
          <select
            disabled={busy}
            defaultValue=""
            onChange={pick((value) => {
              if (value === "pick") {
                setPickDate(true);
                return;
              }
              onApply({ kind: "due", date: value === "none" ? null : value });
            })}
          >
            <option value="">Move to…</option>
            <option value={today}>Today</option>
            <option value={dayAfter(1)}>Tomorrow</option>
            <option value={nextMonday}>Next Monday</option>
            <option value="pick">Pick a date…</option>
            <option value="none">No date</option>
          </select>
        </label>
        {pickDate ? (
          <span className="tl-bf tl-bdate">
            <label>
              <span className="sr-only">Due date for the selected tasks</span>
              <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </label>
            <Button
              variant="primary"
              size="xs"
              disabled={busy || !/^\d{4}-\d{2}-\d{2}$/.test(date)}
              onClick={() => {
                onApply({ kind: "due", date });
                setPickDate(false);
                setDate("");
              }}
            >
              Set
            </Button>
          </span>
        ) : null}
        <label className="tl-bf">
          <span>Project</span>
          <select
            disabled={busy}
            defaultValue=""
            onChange={pick((value) => {
              const project = sortedProjects.find((item) => item.id === value);
              onApply({ kind: "project", projectId: value === "none" ? null : value, projectName: project?.name ?? null });
            })}
          >
            <option value="">Move to project…</option>
            <option value="none">No project</option>
            {sortedProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
                {appName(project.implementation_id) ? ` · ${appName(project.implementation_id)}` : ""}
              </option>
            ))}
          </select>
        </label>
        {sprints.length > 0 ? (
          <label className="tl-bf">
            <span>Sprint</span>
            <select
              disabled={busy}
              defaultValue=""
              onChange={pick((value) => {
                const sprint = sprints.find((item) => item.id === value);
                onApply({ kind: "sprint", sprintId: value === "none" ? null : value, sprintName: sprint?.name ?? null });
              })}
            >
              <option value="">Sprint…</option>
              <option value="none">No sprint</option>
              {sprints.map((sprint) => (
                <option key={sprint.id} value={sprint.id}>
                  {sprint.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <p className="tl-bulk-note">Dates set here don&rsquo;t move linked tasks.</p>
        <Button variant="danger" size="xs" disabled={busy} onClick={onDelete}>
          Delete…
        </Button>
      </div>
    </section>
  );
}
