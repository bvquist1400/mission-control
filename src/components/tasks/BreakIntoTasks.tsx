"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { badgeClasses } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import {
  breakSummary,
  defaultDestinationName,
  defaultOwner,
  finishedStepDate,
  proposedDatesHint,
  proposeStepDates,
  shortDay,
  startsAsLabel,
  type BreakDestinationKind,
  type BreakOwner,
} from "@/lib/break-into-tasks";
import { etDate } from "@/lib/task-range";
import type { TaskChecklistItem, TaskWithImplementation } from "@/types/database";

/**
 * Break into tasks (Baseline task d1f7e622, mockup 3a320c1c): the window that
 * turns a task's checklist into real tasks, and the umbrella's steps panel in
 * the task window. Rules and words are pure in `src/lib/break-into-tasks.ts`;
 * the write is one call (`POST /api/tasks/{id}/break`, migration 066).
 */

export interface TaskStepsData {
  part_of: { id: string; title: string; status: string } | null;
  step_tasks: Array<{ id: string; title: string; status: string; due_at: string | null; owner: string | null; project_id: string | null; section_id: string | null }>;
  steps_progress: { done: number; total: number; all_done: boolean; text: string } | null;
}

const EMPTY_STEPS: TaskStepsData = { part_of: null, step_tasks: [], steps_progress: null };

/** The umbrella links of the open task; `reload` after a break or an Undo. */
export function useTaskSteps(taskId: string | null): { steps: TaskStepsData; reload: () => void } {
  // Keyed by task, so another task's steps never show while the new ones load.
  const [loaded, setLoaded] = useState<{ taskId: string; data: TaskStepsData } | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!taskId) return;
    const controller = new AbortController();
    fetch(`/api/tasks/${taskId}/steps`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => (response.ok ? ((await response.json()) as TaskStepsData) : EMPTY_STEPS))
      .then((data) => setLoaded({ taskId, data: { ...EMPTY_STEPS, ...data } }))
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") setLoaded({ taskId, data: EMPTY_STEPS });
      });
    return () => controller.abort();
  }, [taskId, version]);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return { steps: taskId && loaded?.taskId === taskId ? loaded.data : EMPTY_STEPS, reload };
}

function statusTone(status: string): "success" | "accent" | "warning" | "neutral" {
  if (status === "Done") return "success";
  if (status === "In Progress") return "accent";
  if (status === "Blocked/Waiting") return "warning";
  return "neutral";
}

/** "Part of <umbrella>" on a step, and the steps list on an umbrella. */
export function TaskStepsPanel({ steps }: { steps: TaskStepsData }) {
  if (!steps.part_of && steps.step_tasks.length === 0) return null;
  return (
    <div className="space-y-2">
      {steps.part_of ? (
        <p className="text-sm text-muted-foreground">
          Part of{" "}
          <Link href={`/r/task/${steps.part_of.id}`} className="font-semibold text-accent-text hover:underline">
            {steps.part_of.title}
          </Link>
          {steps.part_of.status === "Done" ? " (done)" : ""}
        </p>
      ) : null}
      {steps.step_tasks.length > 0 && steps.steps_progress ? (
        <div className="rounded-lg border border-range-border bg-range-soft px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Steps</h4>
            <span className={badgeClasses({ tone: steps.steps_progress.all_done ? "success" : "accent", size: "sm" })}>
              {steps.steps_progress.done}/{steps.steps_progress.total} tasks
            </span>
            <span className="text-xs text-muted-foreground">
              {steps.steps_progress.all_done
                ? "All steps done. Mark this task Done when you're ready; it doesn't close on its own."
                : "Its steps are now their own tasks. This task's progress is counted from them."}
            </span>
          </div>
          <ul className="mt-2 space-y-1">
            {steps.step_tasks.map((step) => (
              <li key={step.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Link
                  href={`/r/task/${step.id}`}
                  className={`min-w-0 break-words hover:underline ${step.status === "Done" ? "text-muted-foreground line-through" : "text-foreground"}`}
                >
                  {step.title}
                </Link>
                <span className={badgeClasses({ tone: statusTone(step.status), size: "sm" })}>{step.status}</span>
                {step.due_at ? <span className="text-xs text-muted-foreground">{shortDay(etDate(step.due_at) ?? "")}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The project page's heading line for a section made by a break: "4 of 6 done",
 * a bar and a link to the original task. Counts come from the umbrella's steps
 * (the section list hides Done tasks by default, so it can't count them itself).
 */
export function SectionUmbrellaSummary({ umbrellaId }: { umbrellaId: string }) {
  const { steps } = useTaskSteps(umbrellaId);
  const progress = steps.steps_progress;
  if (!progress) return null;
  const percent = Math.round((progress.done / progress.total) * 100);
  return (
    <div className="mt-1.5 space-y-1">
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className={badgeClasses({ tone: progress.all_done ? "success" : "accent", size: "sm" })}>
          {progress.done} of {progress.total} done
        </span>
        <span>Broken out of a task.</span>
        <Link href={`/r/task/${umbrellaId}`} className="font-semibold text-accent-text hover:underline">
          See the original task
        </Link>
      </p>
      <div className="h-1.5 w-56 max-w-full overflow-hidden rounded-full bg-panel-muted" role="img" aria-label={`${progress.done} of ${progress.total} steps done`}>
        <div className="h-full rounded-full bg-success" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

// ── The dialog ──────────────────────────────────────────────────────────────

interface StepDraft {
  item: TaskChecklistItem;
  include: boolean;
  due: string;
  owner: BreakOwner;
  waits: boolean;
}

interface SectionOption {
  id: string;
  name: string;
}

interface ProjectOption {
  id: string;
  name: string;
}

export interface BreakCreated {
  task_ids: string[];
  section_id: string | null;
  section_created: boolean;
  project_id: string | null;
  project_created: boolean;
  umbrella_comment_id: string | null;
}

function draftsFor(task: TaskWithImplementation, checklist: TaskChecklistItem[], now: Date, waits: boolean): StepDraft[] {
  const openCount = checklist.filter((item) => !item.is_done).length;
  const proposed = proposeStepDates(task, openCount, now);
  let openIndex = 0;
  const owner = defaultOwner(task);
  return checklist.map((item) => {
    if (item.is_done) return { item, include: true, due: finishedStepDate(item) ?? "", owner, waits: false };
    const due = proposed.dates[openIndex] ?? "";
    openIndex += 1;
    return { item, include: true, due, owner, waits };
  });
}

export function BreakIntoTasksDialog({
  open,
  task,
  checklist,
  onClose,
  onCreated,
}: {
  open: boolean;
  task: TaskWithImplementation;
  checklist: TaskChecklistItem[];
  onClose: () => void;
  onCreated: (created: BreakCreated, summary: string) => void;
}) {
  const hasProject = Boolean(task.project_id);
  const projectName = task.project?.name ?? null;
  const [now] = useState(() => new Date());
  const [kind, setKind] = useState<BreakDestinationKind>(hasProject ? "new_section" : "new_project");
  const [name, setName] = useState(() => defaultDestinationName(task.title));
  const [sectionId, setSectionId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [sections, setSections] = useState<SectionOption[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [chain, setChain] = useState(false);
  const [drafts, setDrafts] = useState<StepDraft[]>(() => draftsFor(task, checklist, now, false));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Escape closes only this window, not the task window under it.
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (!saving) onClose();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose, saving]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    if (task.project_id) {
      fetch(`/api/projects/${task.project_id}/sections`, { cache: "no-store", signal: controller.signal })
        .then(async (response) => (response.ok ? ((await response.json()) as SectionOption[]) : []))
        .then((rows) => setSections(Array.isArray(rows) ? rows.map((row) => ({ id: row.id, name: row.name })) : []))
        .catch(() => undefined);
    } else {
      fetch(`/api/projects`, { cache: "no-store", signal: controller.signal })
        .then(async (response) => (response.ok ? ((await response.json()) as ProjectOption[]) : []))
        .then((rows) => {
          const list = Array.isArray(rows) ? rows.map((row) => ({ id: row.id, name: row.name })) : [];
          setProjects(list);
          setProjectId((current) => current || list[0]?.id || "");
        })
        .catch(() => undefined);
    }
    return () => controller.abort();
  }, [open, task.project_id]);

  const included = drafts.filter((draft) => draft.include);
  const openIncluded = included.filter((draft) => !draft.item.is_done);
  const doneIncluded = included.filter((draft) => draft.item.is_done);
  const proposed = useMemo(() => proposeStepDates(task, openIncluded.length, now), [task, openIncluded.length, now]);
  const dueDate = etDate(task.due_at);

  const sectionName = sections.find((section) => section.id === sectionId)?.name ?? null;
  const targetProjectName = kind === "existing_project" ? projects.find((project) => project.id === projectId)?.name ?? null : projectName;
  const summary = breakSummary({
    kind,
    name: name.trim() || task.title,
    projectName: targetProjectName,
    sectionName,
    openCount: openIncluded.length,
    doneCount: doneIncluded.length,
  });
  const needsName = kind !== "existing_section";
  const canSubmit = summary.ready && !saving && (!needsName || name.trim().length > 0) && (kind !== "existing_project" || Boolean(projectId));

  function update(index: number, patch: Partial<StepDraft>) {
    setDrafts((current) => current.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  }

  function toggleChain(next: boolean) {
    setChain(next);
    setDrafts((current) => current.map((draft) => (draft.item.is_done ? draft : { ...draft, waits: next })));
  }

  function resetDates() {
    let openIndex = 0;
    setDrafts((current) =>
      current.map((draft) => {
        if (draft.item.is_done || !draft.include) return draft;
        const due = proposed.dates[openIndex] ?? draft.due;
        openIndex += 1;
        return { ...draft, due };
      })
    );
  }

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${task.id}/break`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          destination: {
            kind,
            name: needsName ? name.trim() : null,
            section_id: kind === "existing_section" ? sectionId || null : null,
            project_id: kind === "existing_project" ? projectId : null,
          },
          steps: included.map((draft) => ({
            checklist_item_id: draft.item.id,
            due_date: draft.item.is_done ? null : draft.due || null,
            owner: draft.owner,
            waits_on_previous: draft.item.is_done ? false : draft.waits,
          })),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        setError(typeof payload.error === "string" ? payload.error : "Could not break the task into tasks.");
        return;
      }
      onCreated(payload as unknown as BreakCreated, summary.line);
    } catch {
      setError("Could not reach Baseline. Nothing was changed.");
    } finally {
      setSaving(false);
    }
  }

  // Open steps in order, for "Starts as" and the "earlier than the step it waits on" warning.
  let openIndex = -1;
  let previousOpenDue: string | null = null;

  return (
    <Modal open={open} onClose={() => (saving ? undefined : onClose())} title="Break into tasks">
      <div className="space-y-5 px-5 py-4">
        <p className="text-sm text-muted-foreground">
          {hasProject
            ? `Turn the ${checklist.length} checklist steps of this task into their own tasks, each with a due date, a status and its own comments.`
            : `This task has no project. Turn its ${checklist.length} checklist steps into their own tasks, in a project of their own.`}
        </p>

        {/* 1. Where */}
        <fieldset className="space-y-2">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">1 · Where should they go?</legend>
          {hasProject ? (
            <>
              <Choice
                checked={kind === "new_section"}
                onSelect={() => setKind("new_section")}
                title={`New section in ${projectName ?? "this project"}`}
                recommended
                text="The section is named after this task. Your other sections stay as they are."
              >
                <label className="mt-2 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Section name
                  <Input size="sm" className="mt-1 w-full" value={name} maxLength={200} onChange={(event) => setName(event.target.value)} disabled={kind !== "new_section"} />
                </label>
              </Choice>
              <Choice
                checked={kind === "existing_section"}
                onSelect={() => setKind("existing_section")}
                title="Add to a section that already exists"
                text="Pick this if the steps belong with other work. There is no new heading."
              >
                <Select size="sm" className="mt-2 w-full" value={sectionId} onChange={(event) => setSectionId(event.target.value)} disabled={kind !== "existing_section"} aria-label="Section">
                  <option value="">Unsectioned</option>
                  {sections.map((section) => (
                    <option key={section.id} value={section.id}>
                      {section.name}
                    </option>
                  ))}
                </Select>
              </Choice>
            </>
          ) : (
            <>
              <Choice
                checked={kind === "new_project"}
                onSelect={() => setKind("new_project")}
                title="New project"
                recommended
                text="This task has no project yet, so the steps become a project of their own, named after the task."
              >
                <label className="mt-2 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Project name
                  <Input size="sm" className="mt-1 w-full" value={name} maxLength={200} onChange={(event) => setName(event.target.value)} disabled={kind !== "new_project"} />
                </label>
              </Choice>
              <Choice
                checked={kind === "existing_project"}
                onSelect={() => setKind("existing_project")}
                title="Add to a project that already exists"
                text="The steps go into that project as a new section named after the task."
              >
                <Select size="sm" className="mt-2 w-full" value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={kind !== "existing_project"} aria-label="Project">
                  {projects.length === 0 ? <option value="">No projects yet</option> : null}
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </Select>
              </Choice>
            </>
          )}
        </fieldset>

        {/* 2. The steps */}
        <section className="space-y-2" aria-labelledby="bit-steps">
          <h3 id="bit-steps" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">2 · The steps</h3>
          <label className="flex items-start justify-between gap-3 rounded-lg border border-stroke bg-panel-muted/60 px-3 py-2.5">
            <span>
              <span className="block text-sm font-semibold text-foreground">Each step waits on the one before</span>
              <span className="block text-xs text-muted-foreground">
                Only the open steps are chained, in checklist order. A step shows &ldquo;Blocked by dependency&rdquo; until the one before it is Done, and its date follows if the earlier one slips.
              </span>
            </span>
            <input type="checkbox" role="switch" aria-checked={chain} checked={chain} onChange={(event) => toggleChain(event.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-accent" />
          </label>

          <div className="hidden grid-cols-[1.5rem_minmax(0,1fr)_9.5rem_7rem_9rem] gap-2 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:grid">
            <span />
            <span>Step</span>
            <span>Due</span>
            <span>Who has it</span>
            <span>Starts as</span>
          </div>
          <ul className="divide-y divide-stroke rounded-lg border border-stroke">
            {drafts.map((draft, index) => {
              const isDone = draft.item.is_done;
              let startsAs = "Done";
              let warning: string | null = null;
              if (!isDone && draft.include) {
                openIndex += 1;
                startsAs = startsAsLabel(task.status, openIndex, draft.waits);
                if (openIndex > 0 && draft.waits && draft.due && previousOpenDue && draft.due < previousOpenDue) {
                  warning = "Earlier than the step it waits on";
                } else if (draft.due && dueDate && draft.due > dueDate) {
                  warning = "After this task's due date";
                }
                previousOpenDue = draft.due || previousOpenDue;
              }
              const myOpenIndex = openIndex;
              return (
                <li
                  key={draft.item.id}
                  className={`grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 px-2 py-2.5 sm:grid-cols-[1.5rem_minmax(0,1fr)_9.5rem_7rem_9rem] sm:items-start ${draft.include ? "" : "opacity-50"}`}
                >
                  <input
                    type="checkbox"
                    checked={draft.include}
                    onChange={(event) => update(index, { include: event.target.checked })}
                    aria-label={`Include “${draft.item.text}”`}
                    className="mt-0.5 h-4 w-4 accent-accent"
                  />
                  <span className={`text-sm break-words ${isDone ? "text-muted-foreground" : "text-foreground"}`}>{draft.item.text}</span>
                  <span className="col-start-2 sm:col-start-auto">
                    {isDone ? (
                      <span className="text-xs text-muted-foreground">
                        <span className="sm:hidden">Finished </span>
                        {draft.due ? shortDay(draft.due) : "Ticked earlier"}
                      </span>
                    ) : (
                      <>
                        <Input
                          size="xs"
                          type="date"
                          className="w-full"
                          value={draft.due}
                          disabled={!draft.include}
                          onChange={(event) => update(index, { due: event.target.value })}
                          aria-label={`Due date for “${draft.item.text}”`}
                        />
                        {warning && draft.include ? <span className="mt-1 block text-xs text-warning">{warning}</span> : null}
                      </>
                    )}
                  </span>
                  <span className="col-start-2 sm:col-start-auto">
                    {isDone ? (
                      <span className="text-xs text-muted-foreground">{draft.owner === "brent" ? "Brent" : "Agent"}</span>
                    ) : (
                      <Select
                        size="xs"
                        className="w-full"
                        value={draft.owner}
                        disabled={!draft.include}
                        onChange={(event) => update(index, { owner: event.target.value as BreakOwner })}
                        aria-label={`Who has “${draft.item.text}”`}
                      >
                        <option value="brent">Brent</option>
                        <option value="agent">Agent</option>
                      </Select>
                    )}
                  </span>
                  <span className="col-start-2 flex flex-wrap items-center gap-1.5 sm:col-start-auto">
                    {draft.include ? (
                      <span className={badgeClasses({ tone: isDone ? "success" : startsAs === "Blocked by dependency" ? "warning" : startsAs === "In Progress" ? "accent" : "neutral", size: "sm" })}>
                        {startsAs}
                      </span>
                    ) : null}
                    {!isDone && draft.include && myOpenIndex > 0 ? (
                      <Button variant="toggle" size="xs" active={draft.waits} onClick={() => update(index, { waits: !draft.waits })}>
                        {draft.waits ? "Waits on previous" : "Doesn’t wait"}
                      </Button>
                    ) : null}
                    {!isDone && draft.include && myOpenIndex === 0 ? (
                      <span className="text-xs text-muted-foreground">First step, nothing to wait on</span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted-foreground">
            {proposedDatesHint(proposed, openIncluded.length)}{" "}
            {openIncluded.length > 0 ? (
              <button type="button" onClick={resetDates} className="font-semibold text-accent-text hover:underline">
                Reset dates
              </button>
            ) : null}
          </p>
        </section>

        {/* 3. Brent's picks, stated */}
        <section className="space-y-1.5 rounded-lg border border-stroke bg-panel-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
          <p>
            <span className="font-semibold text-foreground">Finished steps</span> become Done tasks, dated the day you ticked them, so the new tasks show real progress.
          </p>
          <p>
            <span className="font-semibold text-foreground">This task</span> stays open as their umbrella. Its progress (here and on Today) counts the new tasks; when they are all Done, its Done button lights up and you close it.
          </p>
        </section>

        <div className="rounded-lg border border-range-border bg-range-soft px-3 py-2.5" aria-live="polite">
          <p className="text-sm text-foreground">{summary.line}</p>
          <p className="mt-1 text-xs text-muted-foreground">{summary.umbrellaLine}</p>
        </div>

        {error ? (
          <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-xs text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-stroke pt-3">
          <Button variant="secondary" size="md" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" size="md" onClick={() => void submit()} disabled={!canSubmit}>
            {saving ? "Creating…" : summary.button}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Choice({
  checked,
  onSelect,
  title,
  text,
  recommended = false,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  text: string;
  recommended?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${checked ? "border-accent/60 bg-accent/10" : "border-stroke"}`}>
      <label className="flex cursor-pointer items-start gap-2">
        <input type="radio" checked={checked} onChange={onSelect} className="mt-1 h-4 w-4 shrink-0 accent-accent" />
        <span>
          <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
            {title}
            {recommended ? <span className={badgeClasses({ tone: "success", size: "sm" })}>Recommended</span> : null}
          </span>
          <span className="block text-xs text-muted-foreground">{text}</span>
        </span>
      </label>
      <div className="pl-6">{children}</div>
    </div>
  );
}

/** The heading button ("Break into tasks"), the dialog and the Undo toast, for the task window. */
export function useBreakIntoTasks({
  task,
  onChanged,
}: {
  task: TaskWithImplementation | null;
  /** After a break or an Undo: reload the steps panel and the page around it. */
  onChanged: () => void;
}) {
  // Open for one task only: opening another task closes it.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = Boolean(task && openFor === task.id);
  const setOpen = useCallback((next: boolean) => setOpenFor(next && task ? task.id : null), [task]);
  const { toast } = useToast();

  const handleCreated = useCallback(
    (created: BreakCreated, summaryLine: string) => {
      setOpenFor(null);
      onChanged();
      if (!task) return;
      const taskId = task.id;
      toast({
        message: `${summaryLine.replace(/^Creates/, "Created").replace(/\.$/, "")}. This task stays open as their umbrella.`,
        tone: "success",
        duration: 15000,
        action: {
          label: "Undo",
          onClick: async () => {
            try {
              const response = await fetch(`/api/tasks/${taskId}/break`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  action: "undo",
                  task_ids: created.task_ids,
                  section_id: created.section_created ? created.section_id : null,
                  project_id: created.project_created ? created.project_id : null,
                  umbrella_comment_id: created.umbrella_comment_id,
                }),
              });
              const payload = (await response.json().catch(() => ({}))) as { error?: string };
              if (!response.ok) {
                toast({ message: payload.error ?? "Undo didn’t work. The new tasks are still there.", tone: "danger" });
                return;
              }
              onChanged();
              toast({ message: "Undone: the new tasks are gone and the checklist is as it was.", tone: "info" });
            } catch {
              toast({ message: "Could not reach Baseline. The new tasks are still there.", tone: "danger" });
            }
          },
        },
      });
    },
    [onChanged, task, toast]
  );

  return { open, setOpen, handleCreated };
}
