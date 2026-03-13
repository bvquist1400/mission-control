"use client";

import { useEffect, useState } from "react";
import { TaskTagChips } from "@/components/tasks/TaskTagChips";
import {
  dateOnlyToInputValue,
  formatDateOnly,
  localDateString,
  resolveDueDateInput,
  timestampToLocalDateInputValue,
} from "@/components/utils/dates";
import { useSprints } from "@/hooks/useSprints";
import { RECURRENCE_FREQUENCIES } from "@/lib/recurrence";
import { mergeTaskTags } from "@/lib/task-tags";
import type {
  TaskRecurrenceFrequency,
  TaskType,
  TaskUpdatePayload,
  TaskWithImplementation,
  ImplementationSummary,
} from "@/types/database";

interface ProjectOption {
  id: string;
  name: string;
}

export const TASK_TYPE_OPTIONS: Array<{ value: TaskType; label: string }> = [
  { value: "Task", label: "Task" },
  { value: "Admin", label: "Admin" },
  { value: "Ticket", label: "Ticket" },
  { value: "MeetingPrep", label: "Meeting Prep" },
  { value: "FollowUp", label: "Follow Up" },
  { value: "Build", label: "Build" },
];

const RECURRENCE_LABELS: Record<TaskRecurrenceFrequency, string> = {
  daily: "Daily",
  weekly: "Weekly",
  biweekly: "Every 2 Weeks",
  monthly: "Monthly",
};

const WEEKDAY_OPTIONS = [
  { value: "0", label: "Sunday" },
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
] as const;

interface TaskMetaEditorProps {
  task: TaskWithImplementation;
  isSaving: boolean;
  onUpdate: (taskId: string, updates: TaskUpdatePayload) => Promise<void>;
  onReplaceTask: (task: TaskWithImplementation) => void;
}

function isGeneratedRecurringInstance(task: TaskWithImplementation): boolean {
  const recurrence = task.recurrence;
  return recurrence !== null
    && !recurrence.enabled
    && recurrence.template_task_id !== null
    && recurrence.template_task_id !== task.id;
}

function getDefaultRecurrenceNextDue(task: TaskWithImplementation): string {
  if (task.recurrence?.next_due) {
    return dateOnlyToInputValue(task.recurrence.next_due);
  }

  const dueDate = timestampToLocalDateInputValue(task.due_at);
  return dueDate || localDateString();
}

function getDayOfWeekFromDate(value: string): number {
  const normalized = dateOnlyToInputValue(value);
  if (!normalized) {
    return new Date().getDay();
  }

  return new Date(`${normalized}T12:00:00`).getDay();
}

function getDayOfMonthFromDate(value: string): number {
  const normalized = dateOnlyToInputValue(value);
  if (!normalized) {
    return new Date().getDate();
  }

  return Number.parseInt(normalized.slice(-2), 10);
}

export function TaskMetaEditor({ task, isSaving, onUpdate, onReplaceTask }: TaskMetaEditorProps) {
  const { sprints, loading: sprintsLoading } = useSprints();
  const currentTags = task.tags ?? [];
  const generatedInstance = isGeneratedRecurringInstance(task);
  const editableRecurrence = generatedInstance ? null : task.recurrence;
  const defaultRecurrenceNextDue = getDefaultRecurrenceNextDue(task);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [descriptionDraft, setDescriptionDraft] = useState(task.description ?? "");
  const [taskTypeDraft, setTaskTypeDraft] = useState<TaskType>(task.task_type);
  const [waitingOnDraft, setWaitingOnDraft] = useState(task.waiting_on ?? "");
  const [implementationIdDraft, setImplementationIdDraft] = useState(task.implementation_id ?? "");
  const [projectIdDraft, setProjectIdDraft] = useState(task.project_id ?? "");
  const [sprintIdDraft, setSprintIdDraft] = useState(task.sprint_id ?? "");
  const [dueDateDraft, setDueDateDraft] = useState(timestampToLocalDateInputValue(task.due_at));
  const [tagsDraft, setTagsDraft] = useState(currentTags);
  const [tagInput, setTagInput] = useState("");
  const [recurrenceEnabledDraft, setRecurrenceEnabledDraft] = useState(Boolean(editableRecurrence));
  const [recurrenceFrequencyDraft, setRecurrenceFrequencyDraft] = useState<TaskRecurrenceFrequency>(
    editableRecurrence?.frequency ?? "weekly"
  );
  const [recurrenceNextDueDraft, setRecurrenceNextDueDraft] = useState(defaultRecurrenceNextDue);
  const [recurrenceDayOfWeekDraft, setRecurrenceDayOfWeekDraft] = useState(
    String(editableRecurrence?.day_of_week ?? getDayOfWeekFromDate(defaultRecurrenceNextDue))
  );
  const [recurrenceDayOfMonthDraft, setRecurrenceDayOfMonthDraft] = useState(
    String(editableRecurrence?.day_of_month ?? getDayOfMonthFromDate(defaultRecurrenceNextDue))
  );
  const [recurrenceError, setRecurrenceError] = useState<string | null>(null);
  const [isUpdatingRecurrence, setIsUpdatingRecurrence] = useState(false);
  const [implementations, setImplementations] = useState<ImplementationSummary[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);

  useEffect(() => {
    setTitleDraft(task.title);
    setDescriptionDraft(task.description ?? "");
    setTaskTypeDraft(task.task_type);
    setWaitingOnDraft(task.waiting_on ?? "");
    setImplementationIdDraft(task.implementation_id ?? "");
    setProjectIdDraft(task.project_id ?? "");
    setSprintIdDraft(task.sprint_id ?? "");
  }, [task]);

  useEffect(() => {
    let isMounted = true;

    async function loadAssignmentOptions() {
      setLoadingAssignments(true);

      try {
        const [implementationsResponse, projectsResponse] = await Promise.all([
          fetch("/api/applications", { cache: "no-store" }),
          fetch("/api/projects", { cache: "no-store" }),
        ]);

        if (!isMounted) {
          return;
        }

        if (!implementationsResponse.ok || !projectsResponse.ok) {
          return;
        }

        const [implementationsPayload, projectsPayload] = await Promise.all([
          implementationsResponse.json() as Promise<ImplementationSummary[]>,
          projectsResponse.json() as Promise<ProjectOption[]>,
        ]);

        if (!isMounted) {
          return;
        }

        setImplementations(implementationsPayload);
        setProjects(projectsPayload);
      } finally {
        if (isMounted) {
          setLoadingAssignments(false);
        }
      }
    }

    void loadAssignmentOptions();

    return () => {
      isMounted = false;
    };
  }, []);

  const normalizedTitle = titleDraft.trim();
  const normalizedDescription = descriptionDraft.trim();
  const normalizedWaitingOn = waitingOnDraft.trim();
  const nextWaitingOn = normalizedWaitingOn.length > 0 ? normalizedWaitingOn : null;
  const nextDescription = normalizedDescription.length > 0 ? normalizedDescription : null;
  const nextImplementationId = implementationIdDraft || null;
  const nextProjectId = projectIdDraft || null;
  const nextSprintId = sprintIdDraft || null;
  const currentDueDate = timestampToLocalDateInputValue(task.due_at);
  const dueDateResolution = resolveDueDateInput(dueDateDraft);
  const hasDueDateChange = dueDateResolution.error === null && dueDateResolution.dateOnly !== currentDueDate;
  const nextTags = mergeTaskTags(tagsDraft, tagInput);
  const hasTagChanges = nextTags.length !== currentTags.length || nextTags.some((tag, index) => tag !== currentTags[index]);
  const isMutating = isSaving || isUpdatingRecurrence;

  const normalizedRecurrenceNextDue = recurrenceNextDueDraft.trim();
  const recurrenceNextDueDate = dateOnlyToInputValue(normalizedRecurrenceNextDue);
  const recurrenceNextDueValid = normalizedRecurrenceNextDue.length === 0 || recurrenceNextDueDate === normalizedRecurrenceNextDue;
  const recurrenceDayOfWeek = Number.parseInt(recurrenceDayOfWeekDraft, 10);
  const recurrenceDayOfMonth = Number.parseInt(recurrenceDayOfMonthDraft, 10);
  const recurrenceNeedsDayOfWeek = recurrenceFrequencyDraft === "weekly" || recurrenceFrequencyDraft === "biweekly";
  const recurrenceNeedsDayOfMonth = recurrenceFrequencyDraft === "monthly";
  const recurrenceDayOfWeekValid = !recurrenceNeedsDayOfWeek
    || (Number.isInteger(recurrenceDayOfWeek) && recurrenceDayOfWeek >= 0 && recurrenceDayOfWeek <= 6);
  const recurrenceDayOfMonthValid = !recurrenceNeedsDayOfMonth
    || (Number.isInteger(recurrenceDayOfMonth) && recurrenceDayOfMonth >= 1 && recurrenceDayOfMonth <= 31);

  const hasChanges =
    normalizedTitle !== task.title
    || taskTypeDraft !== task.task_type
    || nextWaitingOn !== task.waiting_on
    || nextDescription !== task.description
    || nextImplementationId !== task.implementation_id
    || nextProjectId !== task.project_id
    || nextSprintId !== task.sprint_id
    || hasTagChanges
    || hasDueDateChange;
  const canSave = normalizedTitle.length > 0 && hasChanges && !isMutating && dueDateResolution.error === null;

  const recurrenceHasChanges = recurrenceEnabledDraft !== Boolean(editableRecurrence)
    || (recurrenceEnabledDraft && (
      editableRecurrence === null
      || recurrenceFrequencyDraft !== editableRecurrence.frequency
      || normalizedRecurrenceNextDue !== editableRecurrence.next_due
      || (recurrenceNeedsDayOfWeek && recurrenceDayOfWeek !== editableRecurrence.day_of_week)
      || (recurrenceNeedsDayOfMonth && recurrenceDayOfMonth !== editableRecurrence.day_of_month)
    ));
  const canSaveRecurrence = !generatedInstance
    && !isMutating
    && recurrenceHasChanges
    && recurrenceNextDueValid
    && recurrenceDayOfWeekValid
    && recurrenceDayOfMonthValid;

  function normalizeDueDateDraft() {
    if (dueDateResolution.error) {
      return;
    }

    const normalizedValue = dueDateResolution.dateOnly ?? "";
    if (normalizedValue !== dueDateDraft) {
      setDueDateDraft(normalizedValue);
    }
  }

  function saveEdits() {
    if (!canSave) {
      return;
    }

    const updates: TaskUpdatePayload = {};
    const normalizedTags = nextTags;
    if (normalizedTitle !== task.title) {
      updates.title = normalizedTitle;
    }
    if (taskTypeDraft !== task.task_type) {
      updates.task_type = taskTypeDraft;
    }
    if (nextWaitingOn !== task.waiting_on) {
      updates.waiting_on = nextWaitingOn;
    }
    if (nextDescription !== task.description) {
      updates.description = nextDescription;
    }
    if (nextImplementationId !== task.implementation_id) {
      updates.implementation_id = nextImplementationId;
    }
    if (nextProjectId !== task.project_id) {
      updates.project_id = nextProjectId;
    }
    if (nextSprintId !== task.sprint_id) {
      updates.sprint_id = nextSprintId;
    }
    if (hasDueDateChange) {
      updates.due_at = dueDateResolution.iso;
    }
    if (hasTagChanges) {
      updates.tags = normalizedTags;
      setTagsDraft(normalizedTags);
      setTagInput("");
    }

    if (Object.keys(updates).length > 0) {
      void onUpdate(task.id, updates);
    }
  }

  function commitTagInput() {
    if (!tagInput.trim()) {
      return;
    }

    setTagsDraft(nextTags);
    setTagInput("");
  }

  function removeTag(tag: string) {
    setTagsDraft((current) => current.filter((currentTag) => currentTag !== tag));
  }

  async function saveRecurrence() {
    if (!canSaveRecurrence) {
      return;
    }

    setRecurrenceError(null);
    setIsUpdatingRecurrence(true);

    try {
      let response: Response;

      if (!recurrenceEnabledDraft) {
        response = await fetch(`/api/tasks/${task.id}/recur`, { method: "DELETE" });
      } else {
        const payload: Record<string, unknown> = {
          frequency: recurrenceFrequencyDraft,
        };

        if (normalizedRecurrenceNextDue) {
          payload.next_due = normalizedRecurrenceNextDue;
        }

        if (recurrenceNeedsDayOfWeek) {
          payload.day_of_week = recurrenceDayOfWeek;
        }

        if (recurrenceNeedsDayOfMonth) {
          payload.day_of_month = recurrenceDayOfMonth;
        }

        response = await fetch(`/api/tasks/${task.id}/recur`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }

      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: "Failed to update recurrence" }));
        throw new Error(typeof payload.error === "string" ? payload.error : "Failed to update recurrence");
      }

      const updatedTask = await response.json() as TaskWithImplementation;
      onReplaceTask(updatedTask);
    } catch (error) {
      setRecurrenceError(error instanceof Error ? error.message : "Failed to update recurrence");
    } finally {
      setIsUpdatingRecurrence(false);
    }
  }

  return (
    <section className="rounded-lg border border-stroke bg-panel p-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Task Details</h4>
        <button
          type="button"
          onClick={saveEdits}
          disabled={!canSave}
          className="rounded border border-stroke bg-panel px-2.5 py-1 text-xs font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? "Saving..." : "Save edits"}
        </button>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-7">
        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Title</span>
          <input
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveEdits();
              }
            }}
            disabled={isMutating}
            className="w-full rounded border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>

        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Task Type</span>
          <select
            value={taskTypeDraft}
            onChange={(event) => setTaskTypeDraft(event.target.value as TaskType)}
            disabled={isMutating}
            className="w-full rounded border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {TASK_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Due Date</span>
          <input
            value={dueDateDraft}
            onChange={(event) => setDueDateDraft(event.target.value)}
            onBlur={normalizeDueDateDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                normalizeDueDateDraft();
                saveEdits();
              }

              if (event.key === "Escape") {
                setDueDateDraft(currentDueDate);
                event.currentTarget.blur();
              }
            }}
            disabled={isMutating}
            placeholder="YYYY-MM-DD or t+7"
            aria-invalid={dueDateResolution.error ? "true" : "false"}
            className={`w-full rounded border bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition disabled:cursor-not-allowed disabled:opacity-60 ${
              dueDateResolution.error
                ? "border-red-300 focus:border-red-400"
                : "border-stroke focus:border-accent"
            }`}
          />
          <p className={`text-[11px] ${dueDateResolution.error ? "text-red-600" : "text-muted-foreground"}`}>
            {dueDateResolution.error
              ?? (dueDateResolution.dateOnly
                ? `Resolves to ${formatDateOnly(dueDateResolution.dateOnly)}.`
                : "Leave blank to clear. Shortcuts: t+30, w+1, m+1, y+1.")}
          </p>
        </label>

        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Waiting On</span>
          <input
            value={waitingOnDraft}
            onChange={(event) => setWaitingOnDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveEdits();
              }
            }}
            disabled={isMutating}
            placeholder={task.status === "Blocked/Waiting" ? "Who or what is this waiting on?" : "Optional context"}
            className="w-full rounded border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>

        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Application</span>
          <select
            value={implementationIdDraft}
            onChange={(event) => setImplementationIdDraft(event.target.value)}
            disabled={isMutating || loadingAssignments}
            className="w-full rounded border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="">{loadingAssignments ? "Loading..." : "Unassigned"}</option>
            {implementations.map((implementation) => (
              <option key={implementation.id} value={implementation.id}>
                {implementation.name}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Project</span>
          <select
            value={projectIdDraft}
            onChange={(event) => setProjectIdDraft(event.target.value)}
            disabled={isMutating || loadingAssignments}
            className="w-full rounded border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="">{loadingAssignments ? "Loading..." : "Unassigned"}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sprint</span>
          <select
            value={sprintIdDraft}
            onChange={(event) => setSprintIdDraft(event.target.value)}
            disabled={isMutating}
            className="w-full rounded border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="">{sprintsLoading ? "Loading..." : "Unassigned"}</option>
            {sprints.map((sprint) => (
              <option key={sprint.id} value={sprint.id}>
                {sprint.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="mt-3 block space-y-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tags</span>
        <div className="rounded border border-stroke bg-panel p-2">
          {tagsDraft.length > 0 ? (
            <TaskTagChips tags={tagsDraft} onRemove={removeTag} className="mb-2" />
          ) : null}
          <input
            value={tagInput}
            onChange={(event) => setTagInput(event.target.value)}
            onBlur={commitTagInput}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                commitTagInput();
              }
            }}
            disabled={isMutating}
            placeholder="Add a tag and press Enter or comma"
            className="w-full border-0 bg-transparent px-0 py-0 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>
        <p className="text-[11px] text-muted-foreground">Tags are stored in lowercase. Click Save edits to persist tag changes.</p>
      </label>

      <label className="mt-3 block space-y-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Description</span>
        <textarea
          value={descriptionDraft}
          onChange={(event) => setDescriptionDraft(event.target.value)}
          disabled={isMutating}
          rows={4}
          placeholder="Add context, links, and detailed notes for this task..."
          className="w-full resize-y rounded border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
        />
      </label>

      <div className="mt-3 rounded-lg border border-stroke bg-panel-muted p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recurrence</h5>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Configure repeating tasks here. Templates are parked and removed from sprint assignment when recurrence is enabled.
            </p>
          </div>
          {!generatedInstance ? (
            <button
              type="button"
              onClick={() => void saveRecurrence()}
              disabled={!canSaveRecurrence}
              className="rounded border border-stroke bg-panel px-2.5 py-1 text-xs font-semibold text-muted-foreground transition hover:bg-panel hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isUpdatingRecurrence ? "Saving..." : "Save recurrence"}
            </button>
          ) : null}
        </div>

        {generatedInstance ? (
          <p className="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            This task was generated from a recurring template. Open the template task to change its recurrence pattern.
          </p>
        ) : (
          <>
            <label className="mt-3 flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={recurrenceEnabledDraft}
                onChange={(event) => {
                  const nextChecked = event.target.checked;
                  setRecurrenceEnabledDraft(nextChecked);
                  setRecurrenceError(null);
                  if (nextChecked && recurrenceNextDueDraft.trim().length === 0) {
                    const nextDate = defaultRecurrenceNextDue || localDateString();
                    setRecurrenceNextDueDraft(nextDate);
                    setRecurrenceDayOfWeekDraft(String(getDayOfWeekFromDate(nextDate)));
                    setRecurrenceDayOfMonthDraft(String(getDayOfMonthFromDate(nextDate)));
                  }
                }}
                disabled={isMutating}
                className="h-4 w-4 rounded border-stroke accent-accent"
              />
              This task repeats
            </label>

            {recurrenceEnabledDraft ? (
              <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <label className="space-y-1">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Frequency</span>
                  <select
                    value={recurrenceFrequencyDraft}
                    onChange={(event) => setRecurrenceFrequencyDraft(event.target.value as TaskRecurrenceFrequency)}
                    disabled={isMutating}
                    className="w-full rounded border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {RECURRENCE_FREQUENCIES.map((frequency) => (
                      <option key={frequency} value={frequency}>
                        {RECURRENCE_LABELS[frequency]}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Next Due</span>
                  <input
                    type="date"
                    value={recurrenceNextDueDraft}
                    onChange={(event) => setRecurrenceNextDueDraft(event.target.value)}
                    disabled={isMutating}
                    aria-invalid={!recurrenceNextDueValid ? "true" : "false"}
                    className={`w-full rounded border bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition disabled:cursor-not-allowed disabled:opacity-60 ${
                      recurrenceNextDueValid ? "border-stroke focus:border-accent" : "border-red-300 focus:border-red-400"
                    }`}
                  />
                  <p className={`text-[11px] ${recurrenceNextDueValid ? "text-muted-foreground" : "text-red-600"}`}>
                    {normalizedRecurrenceNextDue.length > 0 && recurrenceNextDueValid
                      ? `Template schedules from ${formatDateOnly(normalizedRecurrenceNextDue)}.`
                      : "Leave blank to infer from the task due date or today."}
                  </p>
                </label>

                {recurrenceNeedsDayOfWeek ? (
                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Weekday</span>
                    <select
                      value={recurrenceDayOfWeekDraft}
                      onChange={(event) => setRecurrenceDayOfWeekDraft(event.target.value)}
                      disabled={isMutating}
                      className="w-full rounded border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {WEEKDAY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {recurrenceNeedsDayOfMonth ? (
                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Day of Month</span>
                    <input
                      type="number"
                      min={1}
                      max={31}
                      value={recurrenceDayOfMonthDraft}
                      onChange={(event) => setRecurrenceDayOfMonthDraft(event.target.value)}
                      disabled={isMutating}
                      aria-invalid={!recurrenceDayOfMonthValid ? "true" : "false"}
                      className={`w-full rounded border bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition disabled:cursor-not-allowed disabled:opacity-60 ${
                        recurrenceDayOfMonthValid ? "border-stroke focus:border-accent" : "border-red-300 focus:border-red-400"
                      }`}
                    />
                  </label>
                ) : null}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                {editableRecurrence
                  ? "Turn recurrence off and save to stop generating future tasks."
                  : "Turn this on to make the task repeat on a schedule."}
              </p>
            )}
          </>
        )}

        {recurrenceError ? (
          <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
            {recurrenceError}
          </p>
        ) : null}
      </div>
    </section>
  );
}
