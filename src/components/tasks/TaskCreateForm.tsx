"use client";

import { useState, useCallback, useEffect } from "react";
import { EstimateButtons } from "@/components/ui/EstimateButtons";
import type { ImplementationSummary, TaskStatus, TaskType, TaskWithImplementation } from "@/types/database";

interface TaskCreateFormProps {
  implementations: ImplementationSummary[];
  onTaskCreated?: (task: TaskWithImplementation) => void;
  defaultNeedsReview?: boolean;
}

interface TaskDraft {
  title: string;
  implementationId: string;
  estimatedMinutes: number;
  dueDate: string;
  status: TaskStatus;
  taskType: TaskType;
  blocker: boolean;
  sendToTriage: boolean;
  waitingOn: string;
}

const NEW_TASK_STATUSES: TaskStatus[] = ["Next", "Scheduled", "Waiting"];
const TASK_TYPES: { value: TaskType; label: string }[] = [
  { value: "Task", label: "Task" },
  { value: "Admin", label: "Admin" },
  { value: "Ticket", label: "Ticket" },
  { value: "MeetingPrep", label: "Meeting Prep" },
  { value: "FollowUp", label: "Follow Up" },
  { value: "Build", label: "Build" },
];

function createInitialDraft(defaultNeedsReview: boolean): TaskDraft {
  return {
    title: "",
    implementationId: "",
    estimatedMinutes: 30,
    dueDate: "",
    status: "Next",
    taskType: "Admin",
    blocker: false,
    sendToTriage: defaultNeedsReview,
    waitingOn: "",
  };
}

function dateToIso(dateString: string): string {
  const date = new Date(`${dateString}T23:59:59`);
  return date.toISOString();
}

export function TaskCreateForm({ implementations, onTaskCreated, defaultNeedsReview = false }: TaskCreateFormProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<TaskDraft>(() => createInitialDraft(defaultNeedsReview));

  const handleSubmit = useCallback(async () => {
    const title = draft.title.trim();
    if (!title) {
      setError("Task title is required");
      return;
    }

    if (draft.status === "Waiting" && !draft.waitingOn.trim()) {
      setError("Please specify what this task is waiting on");
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          implementation_id: draft.implementationId || null,
          estimated_minutes: draft.estimatedMinutes,
          estimate_source: "manual",
          due_at: draft.dueDate ? dateToIso(draft.dueDate) : null,
          status: draft.status,
          blocker: draft.blocker,
          needs_review: draft.sendToTriage,
          task_type: draft.taskType,
          waiting_on: draft.status === "Waiting" ? draft.waitingOn.trim() : null,
          source_type: "Manual",
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Create failed" }));
        throw new Error(typeof data.error === "string" ? data.error : "Create failed");
      }

      const createdTask = (await response.json()) as TaskWithImplementation;
      onTaskCreated?.(createdTask);
      setDraft(createInitialDraft(defaultNeedsReview));
      setIsOpen(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Failed to create task");
    } finally {
      setIsCreating(false);
    }
  }, [draft, defaultNeedsReview, onTaskCreated]);

  async function createTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await handleSubmit();
  }

  // Keyboard shortcut: Cmd+Enter or Ctrl+Enter to submit
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        handleSubmit();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleSubmit]);

  return (
    <section className="rounded-card border border-stroke bg-panel p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Add Task</h2>
          <p className="text-xs text-muted-foreground">Create a manual task and keep it ready-to-work by default.</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setIsOpen((open) => !open);
          }}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
        >
          {isOpen ? "Close" : "+ New Task"}
        </button>
      </div>

      {isOpen ? (
        <form onSubmit={createTask} className="mt-4 space-y-4 border-t border-stroke pt-4">
          <label className="block space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Title</span>
            <input
              value={draft.title}
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              placeholder="What needs to get done?"
              disabled={isCreating}
              className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Implementation</span>
              <select
                value={draft.implementationId}
                onChange={(event) => setDraft((current) => ({ ...current, implementationId: event.target.value }))}
                disabled={isCreating}
                className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="">Unassigned</option>
                {implementations.map((implementation) => (
                  <option key={implementation.id} value={implementation.id}>
                    {implementation.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Task Type</span>
              <select
                value={draft.taskType}
                onChange={(event) => setDraft((current) => ({ ...current, taskType: event.target.value as TaskType }))}
                disabled={isCreating}
                className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {TASK_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Due Date</span>
              <input
                type="date"
                value={draft.dueDate}
                onChange={(event) => setDraft((current) => ({ ...current, dueDate: event.target.value }))}
                disabled={isCreating}
                className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <label className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</span>
              <select
                value={draft.status}
                onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as TaskStatus }))}
                disabled={isCreating}
                className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {NEW_TASK_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {draft.status === "Waiting" && (
            <label className="block space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Waiting On</span>
              <input
                value={draft.waitingOn}
                onChange={(event) => setDraft((current) => ({ ...current, waitingOn: event.target.value }))}
                placeholder="Who or what is this task waiting on?"
                disabled={isCreating}
                className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
          )}

          <div className="space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Estimate (min)</span>
            <EstimateButtons
              value={draft.estimatedMinutes}
              onChange={(minutes) => setDraft((current) => ({ ...current, estimatedMinutes: minutes }))}
            />
          </div>

          <div className="flex flex-wrap gap-3">
            <label className="flex items-center gap-2 rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={draft.blocker}
                onChange={(event) => setDraft((current) => ({ ...current, blocker: event.target.checked }))}
                disabled={isCreating}
                className="h-4 w-4 accent-red-500"
              />
              Blocker
            </label>

            <label className="flex items-center gap-2 rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={draft.sendToTriage}
                onChange={(event) => setDraft((current) => ({ ...current, sendToTriage: event.target.checked }))}
                disabled={isCreating}
                className="h-4 w-4 accent-accent"
              />
              Send to triage (needs review)
            </label>
          </div>

          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400" role="alert">
              {error}
            </p>
          )}

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              Press <kbd className="rounded border border-stroke bg-panel-muted px-1.5 py-0.5 font-mono text-xs">⌘</kbd>+<kbd className="rounded border border-stroke bg-panel-muted px-1.5 py-0.5 font-mono text-xs">Enter</kbd> to submit
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setDraft(createInitialDraft(defaultNeedsReview));
                  setIsOpen(false);
                }}
                disabled={isCreating}
                className="rounded-lg border border-stroke bg-panel px-3 py-2 text-sm font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isCreating}
                className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isCreating ? "Creating..." : "Create Task"}
              </button>
            </div>
          </div>
        </form>
      ) : null}
    </section>
  );
}
