"use client";

import { memo, useCallback, useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { Markdown } from "@/components/markdown/Markdown";
import { Button } from "@/components/ui/Button";
import { StatusSelector } from "@/components/ui/StatusSelector";
import { TaskMetaEditor } from "@/components/tasks/TaskMetaEditor";
import { TaskOwnerSection } from "@/components/tasks/TaskOwnerSection";
import { TaskNotesPanel } from "@/components/tasks/TaskNotesPanel";
import { ChecklistSection } from "@/components/tasks/ChecklistSection";
import { TaskComments } from "@/components/tasks/TaskComments";
import { TaskDependencies } from "@/components/tasks/TaskDependencies";
import { BreakIntoTasksDialog, TaskStepsPanel, useBreakIntoTasks, useTaskSteps } from "@/components/tasks/BreakIntoTasks";
import { NowUnblockedPill } from "@/components/tasks/task-state";
import { ProjectSquare } from "@/components/project-colors/ProjectSquare";
import { useTaskPanel } from "@/components/tasks/panel/TaskPanelProvider";
import { useTaskDetail } from "@/hooks/useTaskDetail";
import { canBreakIntoTasks } from "@/lib/break-into-tasks";
import { handBackTask } from "@/lib/task-handoff";
import { buildTaskPageView } from "@/lib/task-page";
import { formatShortDate } from "@/lib/portfolio";
import { localDateInputToEndOfDayIso, timestampToLocalDateInputValue } from "@/components/utils/dates";
import type { CommitmentSummary, TaskComment, TaskUpdatePayload, TaskWithImplementation } from "@/types/database";

function Section({ title, aside, children, id }: { title: string; aside?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="tp-sec" aria-label={title} id={id}>
      <h3>
        <span>{title}</span>
        {aside ? <span className="tp-sec-aside">{aside}</span> : null}
      </h3>
      {children}
    </section>
  );
}

/** The Due fact: a date box that saves on blur or Enter (Escape drops it), through the cascade like every date change. */
function DueFact({ task, disabled, onSave }: { task: TaskWithImplementation; disabled: boolean; onSave: (value: string) => void }) {
  const saved = timestampToLocalDateInputValue(task.due_at);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved;
  function commit() {
    if (draft === null) return;
    const next = draft;
    setDraft(null);
    if (next !== saved) onSave(next);
  }
  return (
    <input
      type="date"
      className="tp-date"
      aria-label="Due date"
      value={value}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          setDraft(null);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * What the task panel shows: the task record page's content (where it stands,
 * owner, checklist with progress, comment gists, links), built from the same
 * model (`buildTaskPageView`), with everything the old pop-up editor could
 * change: status, due, owner and hand-back, checklist, steps and Break into
 * tasks, comments, dependencies, notes, every field (Details), park, done and
 * delete.
 */
export const TaskPanelBody = memo(function TaskPanelBody({
  taskId,
  headingRef,
  onClose,
}: {
  taskId: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
}) {
  const panel = useTaskPanel();
  const { getSeed, getSeedList, loadCommitments, emitUpdated, emitDeleted, emitDatesChanged, markChanged, openTask } = panel;
  const [task, setTask] = useState<TaskWithImplementation | null>(() => getSeed(taskId));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [commitments, setCommitments] = useState<CommitmentSummary[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Always read the task fresh: a seed from the page may be a lighter row.
  useEffect(() => {
    let live = true;
    setLoadError(null);
    fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok || !body || typeof body.id !== "string") {
          throw new Error(response.status === 404 ? "This task wasn't found. It may have been deleted." : "Couldn't load the task.");
        }
        if (live) setTask(body as TaskWithImplementation);
      })
      .catch((error: unknown) => {
        if (live) setLoadError(error instanceof Error ? error.message : "Couldn't load the task.");
      });
    void loadCommitments().then((rows) => {
      if (live) setCommitments(rows);
    });
    return () => {
      live = false;
    };
  }, [taskId, loadCommitments]);

  const onTaskUpdated = useCallback(
    (id: string, updates: TaskUpdatePayload) => {
      setTask((current) => (current && current.id === id ? ({ ...current, ...updates } as TaskWithImplementation) : current));
      emitUpdated(id, updates);
    },
    [emitUpdated]
  );

  const detail = useTaskDetail({ taskId, onTaskUpdated, onDatesChanged: emitDatesChanged });
  const { steps, reload: reloadSteps } = useTaskSteps(taskId);
  const breakInto = useBreakIntoTasks({
    task,
    onChanged: () => {
      reloadSteps();
      markChanged();
    },
  });

  const view = useMemo(() => {
    if (!task) return null;
    return buildTaskPageView({
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        owner: task.owner,
        owner_label: task.owner_label,
        status_line: task.status_line,
        due_at: task.due_at,
        waiting_on: task.waiting_on,
        follow_up_at: task.follow_up_at,
        description: task.description,
        tags: task.tags,
        app: task.implementation?.name ?? null,
        project: task.project?.name ?? null,
        section: task.section_name ?? null,
        unblocked_at: task.unblocked_at ?? null,
      },
      checklist: detail.checklist,
      comments: detail.comments.map((comment) => ({ id: comment.id, content: comment.content, created_at: comment.created_at })),
      blockers: detail.dependencies.filter((dependency) => dependency.unresolved).map((dependency) => dependency.title),
    });
  }, [task, detail.checklist, detail.comments, detail.dependencies]);

  const busy = detail.isSaving || isDeleting;

  const save = useCallback(
    (updates: TaskUpdatePayload) => detail.updateTask(updates, { title: task?.title, previousDueAt: task?.due_at ?? null }),
    [detail, task?.title, task?.due_at]
  );

  async function handleMetaUpdate(_id: string, updates: TaskUpdatePayload): Promise<boolean | "cancelled"> {
    let cancelled = false;
    const saved = await detail.updateTask(updates, {
      title: task?.title,
      previousDueAt: task?.due_at ?? null,
      onCancelled: () => {
        cancelled = true;
      },
    });
    return cancelled ? "cancelled" : saved;
  }

  async function handleHandBack(note: string): Promise<boolean> {
    if (!task) return false;
    setActionError(null);
    const result = await handBackTask<TaskWithImplementation, TaskComment>(task.id, note);
    if (!result.ok) {
      setActionError(result.error);
      return false;
    }
    if (result.comment) detail.addComment(result.comment);
    onTaskUpdated(task.id, result.task as unknown as TaskUpdatePayload);
    if (result.commentError) setActionError(result.commentError);
    else onClose();
    return true;
  }

  async function handleDone() {
    const saved = await save({ status: "Done" });
    if (saved) onClose();
  }

  async function handleDelete() {
    if (!task || isDeleting) return;
    if (!window.confirm(`Delete task "${task.title}"? This cannot be undone.`)) return;
    setActionError(null);
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/tasks/${task.id}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: "Failed to delete task" }));
        throw new Error(typeof payload.error === "string" ? payload.error : "Failed to delete task");
      }
      emitDeleted(task.id);
      onClose();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to delete task");
      setIsDeleting(false);
    }
  }

  if (!task || !view) {
    return (
      <div className="tp-body" aria-busy={!loadError}>
        <h2 ref={headingRef} tabIndex={-1} className="tp-title">
          {loadError ? "Task not available" : "Opening the task…"}
        </h2>
        {loadError ? (
          <p className="tp-muted" role="alert">
            {loadError}
          </p>
        ) : (
          <div className="tp-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
    );
  }

  const mine = view.owner === "brent";
  const isUmbrella = steps.step_tasks.length > 0;
  const showBreak = !task.is_recurring_template && canBreakIntoTasks(detail.checklist, steps.step_tasks.length, task.status);
  const checklistPct = view.checklist.length ? Math.round((view.checklistDone / view.checklist.length) * 100) : 0;
  const crumb = [task.implementation?.name ?? task.project?.name ?? null, task.implementation && task.project ? task.project.name : null, task.section_name ?? null].filter(
    (part): part is string => Boolean(part)
  );
  const errorText = detail.error || actionError;

  return (
    <div className="tp-body @container">
      <div className="tp-crumb mono">
        {/* The project's colour square (S2), left of the breadcrumb; click it to edit colours. */}
        <span className="tp-square-slot" data-project-square-slot="">
          <ProjectSquare
            app={task.implementation ? { id: task.implementation.id, name: task.implementation.name } : null}
            project={task.project ? { id: task.project.id, name: task.project.name, tags: task.project.tags ?? null } : null}
          />
        </span>
        <span>{crumb.length ? crumb.join(" › ") : "No project"}</span>
      </div>
      <h2 ref={headingRef} tabIndex={-1} className="tp-title">
        {view.title}
      </h2>

      <div className="tp-facts">
        <div>
          <span>Status</span>
          <StatusSelector value={task.status} onChange={(status) => void save({ status })} />
        </div>
        <div>
          <span>Due</span>
          <DueFact
            task={task}
            disabled={busy}
            onSave={(value) => void save({ due_at: value ? localDateInputToEndOfDayIso(value) : null })}
          />
        </div>
        <div>
          <span>Owner</span>
          <b>{mine ? "You" : `Agent: ${view.ownerLabel}`}</b>
        </div>
        <div>
          <span>Project</span>
          <b>{task.project?.name ?? task.implementation?.name ?? "None"}</b>
        </div>
      </div>

      <div className="tp-pills">
        {view.blocked && view.status !== "Blocked/Waiting" ? <span className="tp-pill tone-wait">Blocked</span> : null}
        <NowUnblockedPill task={task} />
        {view.due && view.overdue ? <span className="tp-pill tone-late">Was due {formatShortDate(view.due)}</span> : null}
        {task.blocker ? <span className="tp-pill tone-late">Blocker</span> : null}
        {view.decision ? <span className="tp-pill">Decision</span> : null}
      </div>

      {errorText ? (
        <p role="alert" className="tp-alert">
          {errorText}
        </p>
      ) : null}

      <Section title="Where this stands">
        <p className="tp-stands">
          <span>{view.stand}</span>
        </p>
        {view.blocked && view.waits.length > 0 ? <p className="tp-waits">{view.waits.join(" · ")}</p> : null}
      </Section>

      {/* "Who has it": owner, agent, where it stands, and Brent's answer box (open when it's his). */}
      <TaskOwnerSection key={task.id} task={task} disabled={busy} onSave={save} onHandBack={handleHandBack} />

      {steps.part_of || isUmbrella ? (
        <Section title="Steps">
          <TaskStepsPanel steps={steps} onOpenTask={openTask} />
        </Section>
      ) : null}

      {/* The checklist, steps-style progress first (ChecklistSection draws its own heading and Break into tasks). */}
      <div className="tp-sec" aria-label="Checklist" role="group">
        {view.checklist.length ? (
          <div className="tp-prog-row">
            <div className="tp-prog" aria-hidden="true">
              <i style={{ width: `${checklistPct}%` }} />
            </div>
            <span className="mono">
              {view.checklistDone} of {view.checklist.length}
            </span>
          </div>
        ) : null}
        {detail.loading ? (
          <p className="tp-muted">Loading…</p>
        ) : (
          <ChecklistSection
            checklist={detail.checklist}
            onToggle={(item) => void detail.toggleChecklistItem(item).then(markChanged)}
            onAdd={(text) => void detail.addChecklistItem(text).then(markChanged)}
            onUpdate={(itemId, text) => void detail.updateChecklistItem(itemId, text).then(markChanged)}
            onDelete={(itemId) => void detail.deleteChecklistItem(itemId).then(markChanged)}
            note={isUmbrella ? "Kept for the record. This task's progress now counts its steps (above)." : null}
            headingAction={
              showBreak ? (
                <Button variant="secondary" size="xs" onClick={() => breakInto.setOpen(true)} disabled={busy}>
                  Break into tasks
                </Button>
              ) : null
            }
          />
        )}
      </div>

      {view.description ? (
        <details className="tp-desc" open={!view.descriptionFolded}>
          <summary>Description</summary>
          <Markdown source={view.description} />
        </details>
      ) : null}

      <Section title="Activity" aside={detail.comments.length ? <span className="mono">{detail.comments.length}</span> : null}>
        <TaskComments
          taskId={task.id}
          variant="gist"
          comments={detail.comments}
          onCommentAdded={(comment) => {
            detail.addComment(comment);
            markChanged();
          }}
          onCommentUpdated={(comment) => {
            detail.updateComment(comment);
            markChanged();
          }}
          onCommentDeleted={(commentId) => {
            detail.deleteComment(commentId);
            markChanged();
          }}
        />
      </Section>

      {/* Links: what it waits on and what waits on it (TaskDependencies draws its own headings). */}
      <div className="tp-sec">
        <TaskDependencies
          taskId={task.id}
          dependencies={detail.dependencies}
          blocks={detail.blocks}
          availableTasks={getSeedList()}
          availableCommitments={commitments}
          onDependencyAdded={(dependency) => {
            detail.addDependency(dependency);
            markChanged();
          }}
          onDependencyRemoved={(dependencyId) => {
            detail.removeDependency(dependencyId);
            markChanged();
          }}
        />
      </div>

      <details className="tp-details">
        <summary>Notes</summary>
        <TaskNotesPanel taskId={task.id} />
      </details>

      <details className="tp-details">
        <summary>All fields</summary>
        <TaskMetaEditor
          task={task}
          isSaving={busy}
          onUpdate={handleMetaUpdate}
          onReplaceTask={(updated) => onTaskUpdated(updated.id, updated as unknown as TaskUpdatePayload)}
          blocks={detail.blocks}
        />
        <div className="tp-danger">
          <span>Deleting a task can&apos;t be undone.</span>
          <Button variant="danger" size="sm" onClick={() => void handleDelete()} disabled={busy}>
            {isDeleting ? "Deleting..." : "Delete task"}
          </Button>
        </div>
      </details>

      <div className="tp-acts">
        <Button
          variant={steps.steps_progress?.all_done && task.status !== "Done" ? "ready" : "primary"}
          size="sm"
          onClick={() => void handleDone()}
          disabled={task.status === "Done" || busy}
        >
          {task.status === "Done" ? "Done" : "Mark done"}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void save({ status: "Parked" })} disabled={task.status === "Parked" || busy}>
          Park
        </Button>
        {task.status === "Done" || task.status === "Parked" ? (
          <Button variant="secondary" size="sm" onClick={() => void save({ status: "Planned" })} disabled={busy}>
            Reopen
          </Button>
        ) : null}
      </div>

      {breakInto.open ? (
        <BreakIntoTasksDialog
          open
          task={task}
          checklist={detail.checklist}
          onClose={() => breakInto.setOpen(false)}
          onCreated={breakInto.handleCreated}
        />
      ) : null}
    </div>
  );
});
