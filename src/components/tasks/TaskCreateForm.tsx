"use client";

import { useState, useCallback, useEffect } from "react";
import { EstimateButtons } from "@/components/ui/EstimateButtons";
import { localDateString } from "@/components/utils/dates";
import type { ImplementationSummary, LlmExtraction, TaskStatus, TaskType, TaskWithImplementation } from "@/types/database";

interface TaskCreateFormProps {
  implementations: ImplementationSummary[];
  onTaskCreated?: (task: TaskWithImplementation) => void;
  defaultNeedsReview?: boolean;
}

interface TaskDraft {
  title: string;
  description: string;
  implementationId: string;
  estimatedMinutes: number;
  dueDate: string;
  status: TaskStatus;
  taskType: TaskType;
  blocker: boolean;
  sendToTriage: boolean;
  waitingOn: string;
}

type ActiveTab = "manual" | "quick_capture";
type ParseState = "idle" | "parsing" | "parsed" | "error";

interface QuickCaptureDraft {
  rawText: string;
  title: string;
  description: string;
  implementationId: string;
  estimatedMinutes: number;
  dueDate: string;
  status: TaskStatus;
  taskType: TaskType;
  blocker: boolean;
  sendToTriage: boolean;
  waitingOn: string;
  suggestedTasks: string[];
  suggestedChecklist: string[];
  createAsSeparateTasks: boolean;
  needsReview: boolean;
  pinnedExcerpt: string;
}

const NEW_TASK_STATUSES: TaskStatus[] = ["Backlog", "Planned", "In Progress", "Blocked/Waiting"];
const TASK_TYPES: { value: TaskType; label: string }[] = [
  { value: "Task", label: "Task" },
  { value: "Admin", label: "Admin" },
  { value: "Ticket", label: "Ticket" },
  { value: "MeetingPrep", label: "Meeting Prep" },
  { value: "FollowUp", label: "Follow Up" },
  { value: "Build", label: "Build" },
];

function findAdminImplId(implementations: ImplementationSummary[]): string {
  const match = implementations.find((impl) => impl.name.toLowerCase() === "admin");
  return match?.id ?? "";
}

function createInitialDraft(defaultNeedsReview: boolean, implementations: ImplementationSummary[]): TaskDraft {
  return {
    title: "",
    description: "",
    implementationId: findAdminImplId(implementations),
    estimatedMinutes: 30,
    dueDate: "",
    status: "Backlog",
    taskType: "Task",
    blocker: false,
    sendToTriage: defaultNeedsReview,
    waitingOn: "",
  };
}

function createInitialQcDraft(): QuickCaptureDraft {
  return {
    rawText: "",
    title: "",
    description: "",
    implementationId: "",
    estimatedMinutes: 30,
    dueDate: "",
    status: "Backlog",
    taskType: "Admin",
    blocker: false,
    sendToTriage: true,
    waitingOn: "",
    suggestedTasks: [],
    suggestedChecklist: [],
    createAsSeparateTasks: false,
    needsReview: true,
    pinnedExcerpt: "",
  };
}

function dateToIso(dateString: string): string {
  const date = new Date(`${dateString}T23:59:59`);
  return `${localDateString(date)}T23:59:59.000Z`;
}

function normalizeTaskTitles(items: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const item of items) {
    const cleaned = item.trim().replace(/\s+/g, " ");
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(cleaned);
  }

  return normalized.slice(0, 20);
}

function extractBulletedTaskCandidates(rawText: string): string[] {
  const candidates = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.match(/^(?:[-*•]|\d+[.)]|\[(?: |x|X)\])\s+(.+)$/)?.[1] ?? "")
    .filter(Boolean);

  return normalizeTaskTitles(candidates);
}

const inputClass = "w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60";
const selectClass = "w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60";
const labelClass = "text-xs font-semibold uppercase tracking-wide text-muted-foreground";

export function TaskCreateForm({ implementations, onTaskCreated, defaultNeedsReview = false }: TaskCreateFormProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<TaskDraft>(() => createInitialDraft(defaultNeedsReview, implementations));

  // Quick Capture state
  const [activeTab, setActiveTab] = useState<ActiveTab>("manual");
  const [parseState, setParseState] = useState<ParseState>("idle");
  const [parseError, setParseError] = useState<string | null>(null);
  const [qcDraft, setQcDraft] = useState<QuickCaptureDraft>(createInitialQcDraft);

  const handleSubmit = useCallback(async () => {
    const title = draft.title.trim();
    if (!title) {
      setError("Task title is required");
      return;
    }

    if (draft.status === "Blocked/Waiting" && !draft.waitingOn.trim()) {
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
          description: draft.description.trim() || null,
          implementation_id: draft.implementationId || null,
          estimated_minutes: draft.estimatedMinutes,
          estimate_source: "manual",
          due_at: draft.dueDate ? dateToIso(draft.dueDate) : null,
          status: draft.status,
          blocker: draft.blocker,
          needs_review: draft.sendToTriage,
          task_type: draft.taskType,
          waiting_on: draft.status === "Blocked/Waiting" ? draft.waitingOn.trim() : null,
          source_type: "Manual",
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Create failed" }));
        throw new Error(typeof data.error === "string" ? data.error : "Create failed");
      }

      const createdTask = (await response.json()) as TaskWithImplementation;
      onTaskCreated?.(createdTask);
      setDraft(createInitialDraft(defaultNeedsReview, implementations));
      setIsOpen(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Failed to create task");
    } finally {
      setIsCreating(false);
    }
  }, [draft, defaultNeedsReview, implementations, onTaskCreated]);

  async function createTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await handleSubmit();
  }

  // Quick Capture: parse handler
  async function handleParse() {
    if (!qcDraft.rawText.trim()) return;
    setParseState("parsing");
    setParseError(null);

    try {
      const response = await fetch("/api/tasks/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw_text: qcDraft.rawText }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Parse failed" }));
        throw new Error(typeof data.error === "string" ? data.error : "Parse failed");
      }

      const { extraction } = (await response.json()) as { extraction: LlmExtraction };

      // Try to match implementation_guess to an ID
      let matchedImplId = "";
      if (extraction.implementation_guess && extraction.implementation_confidence >= 0.7) {
        const guess = extraction.implementation_guess.toLowerCase();
        const match = implementations.find(
          (impl) => impl.name.toLowerCase() === guess || impl.name.toLowerCase().includes(guess)
        );
        if (match) matchedImplId = match.id;
      }

      const suggestedTasks = normalizeTaskTitles(
        extraction.suggested_tasks.length > 0
          ? extraction.suggested_tasks
          : extractBulletedTaskCandidates(qcDraft.rawText)
      );
      const createAsSeparateTasks = suggestedTasks.length > 1;

      setQcDraft((current) => ({
        ...current,
        title: extraction.title,
        description: current.rawText.trim().slice(0, 8000),
        taskType: extraction.task_type,
        estimatedMinutes: extraction.estimated_minutes,
        dueDate: extraction.due_guess_iso ?? "",
        blocker: extraction.blocker,
        sendToTriage: extraction.needs_review,
        needsReview: extraction.needs_review,
        waitingOn: extraction.waiting_on ?? "",
        suggestedTasks,
        suggestedChecklist: createAsSeparateTasks ? [] : extraction.suggested_checklist,
        createAsSeparateTasks,
        pinnedExcerpt: current.rawText.slice(0, 500),
        implementationId: matchedImplId,
      }));

      setParseState("parsed");
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Failed to parse");
      setParseState("error");
    }
  }

  // Quick Capture: submit handler
  const handleQcSubmit = useCallback(async () => {
    const splitTaskTitles = qcDraft.createAsSeparateTasks
      ? normalizeTaskTitles(qcDraft.suggestedTasks)
      : [];
    const title = qcDraft.title.trim();
    if (!qcDraft.createAsSeparateTasks && !title) {
      setError("Task title is required");
      return;
    }
    if (qcDraft.createAsSeparateTasks && splitTaskTitles.length === 0) {
      setError("Add at least one task to create");
      return;
    }
    if (qcDraft.status === "Blocked/Waiting" && !qcDraft.waitingOn.trim()) {
      setError("Please specify what this task is waiting on");
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const basePayload = {
        description: qcDraft.description.trim() || null,
        implementation_id: qcDraft.implementationId || null,
        estimated_minutes: qcDraft.estimatedMinutes,
        estimate_source: "llm",
        due_at: qcDraft.dueDate ? dateToIso(qcDraft.dueDate) : null,
        status: qcDraft.status,
        blocker: qcDraft.blocker,
        needs_review: qcDraft.sendToTriage,
        task_type: qcDraft.taskType,
        waiting_on: qcDraft.status === "Blocked/Waiting" ? qcDraft.waitingOn.trim() : null,
        source_type: "Manual",
        pinned_excerpt: qcDraft.pinnedExcerpt || null,
      };

      if (qcDraft.createAsSeparateTasks) {
        for (const taskTitle of splitTaskTitles) {
          const response = await fetch("/api/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...basePayload,
              title: taskTitle,
            }),
          });

          if (!response.ok) {
            const data = await response.json().catch(() => ({ error: "Create failed" }));
            const message = typeof data.error === "string" ? data.error : "Create failed";
            throw new Error(`Failed to create "${taskTitle}": ${message}`);
          }

          const createdTask = (await response.json()) as TaskWithImplementation;
          onTaskCreated?.(createdTask);
        }
      } else {
        const response = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...basePayload,
            title,
            initial_checklist: qcDraft.suggestedChecklist,
          }),
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({ error: "Create failed" }));
          throw new Error(typeof data.error === "string" ? data.error : "Create failed");
        }

        const createdTask = (await response.json()) as TaskWithImplementation;
        onTaskCreated?.(createdTask);
      }

      setQcDraft(createInitialQcDraft());
      setParseState("idle");
      setIsOpen(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Failed to create task(s)");
    } finally {
      setIsCreating(false);
    }
  }, [qcDraft, onTaskCreated]);

  // Keyboard shortcut: Cmd+Enter or Ctrl+Enter to submit
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (activeTab === "quick_capture" && parseState === "parsed") {
          handleQcSubmit();
        } else if (activeTab === "manual") {
          handleSubmit();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleSubmit, handleQcSubmit, activeTab, parseState]);

  const splitTaskCount = normalizeTaskTitles(qcDraft.suggestedTasks).length;

  return (
    <section className="rounded-card border border-stroke bg-panel p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Add Task</h2>
          <p className="text-xs text-muted-foreground">Create a manual task or paste text for AI-assisted extraction.</p>
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
        <div className="mt-4 border-t border-stroke pt-4">
          {/* Tab bar */}
          <div className="mb-4 flex gap-1 rounded-lg border border-stroke bg-panel-muted p-1">
            <button
              type="button"
              onClick={() => { setActiveTab("manual"); setError(null); }}
              className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === "manual"
                  ? "bg-panel text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Manual
            </button>
            <button
              type="button"
              onClick={() => { setActiveTab("quick_capture"); setError(null); }}
              className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === "quick_capture"
                  ? "bg-panel text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Quick Capture
            </button>
          </div>

          {/* ── Manual tab ── */}
          {activeTab === "manual" && (
            <form onSubmit={createTask} className="space-y-4">
              <label className="block space-y-1">
                <span className={labelClass}>Title</span>
                <input
                  value={draft.title}
                  onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                  placeholder="What needs to get done?"
                  disabled={isCreating}
                  className={inputClass}
                />
              </label>

              <label className="block space-y-1">
                <span className={labelClass}>Description</span>
                <textarea
                  value={draft.description}
                  onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                  placeholder="Optional context, notes, links, and details..."
                  rows={4}
                  disabled={isCreating}
                  className={`${inputClass} resize-y`}
                />
              </label>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <label className="space-y-1">
                  <span className={labelClass}>Application</span>
                  <select
                    value={draft.implementationId}
                    onChange={(event) => setDraft((current) => ({ ...current, implementationId: event.target.value }))}
                    disabled={isCreating}
                    className={selectClass}
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
                  <span className={labelClass}>Task Type</span>
                  <select
                    value={draft.taskType}
                    onChange={(event) => setDraft((current) => ({ ...current, taskType: event.target.value as TaskType }))}
                    disabled={isCreating}
                    className={selectClass}
                  >
                    {TASK_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1">
                  <span className={labelClass}>Due Date</span>
                  <input
                    type={draft.dueDate ? "date" : "text"}
                    value={draft.dueDate}
                    placeholder="mm/dd/yyyy"
                    onFocus={(e) => { e.currentTarget.type = "date"; }}
                    onBlur={(e) => { if (!e.currentTarget.value) e.currentTarget.type = "text"; }}
                    onChange={(event) => setDraft((current) => ({ ...current, dueDate: event.target.value }))}
                    disabled={isCreating}
                    className={selectClass}
                  />
                </label>

                <label className="space-y-1">
                  <span className={labelClass}>Status</span>
                  <select
                    value={draft.status}
                    onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as TaskStatus }))}
                    disabled={isCreating}
                    className={selectClass}
                  >
                    {NEW_TASK_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {draft.status === "Blocked/Waiting" && (
                <label className="block space-y-1">
                  <span className={labelClass}>Waiting On</span>
                  <input
                    value={draft.waitingOn}
                    onChange={(event) => setDraft((current) => ({ ...current, waitingOn: event.target.value }))}
                    placeholder="Who or what is this task waiting on?"
                    disabled={isCreating}
                    className={inputClass}
                  />
                </label>
              )}

              <div className="space-y-1">
                <span className={labelClass}>Estimate (min)</span>
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
                      setDraft(createInitialDraft(defaultNeedsReview, implementations));
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
          )}

          {/* ── Quick Capture tab ── */}
          {activeTab === "quick_capture" && (
            <div className="space-y-4">
              {/* Step 1: Paste area + Parse button */}
              <label className="block space-y-1">
                <span className={labelClass}>Paste text to parse</span>
                <textarea
                  value={qcDraft.rawText}
                  onChange={(e) => setQcDraft((c) => ({ ...c, rawText: e.target.value }))}
                  placeholder="Paste an IT ticket, email body, Slack message, or any work description..."
                  rows={5}
                  disabled={parseState === "parsing" || isCreating}
                  className={`${inputClass} resize-y`}
                />
              </label>

              <button
                type="button"
                onClick={handleParse}
                disabled={!qcDraft.rawText.trim() || parseState === "parsing" || isCreating}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {parseState === "parsing" ? "Parsing..." : parseState === "parsed" ? "Re-parse" : "Parse"}
              </button>

              {parseError && (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400" role="alert">
                  {parseError}
                </p>
              )}

              {/* Step 2: Pre-filled review fields — visible only after parse */}
              {parseState === "parsed" && (
                <>
                  {qcDraft.needsReview && (
                    <div className="flex items-center gap-2 rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-300">
                      Review suggested — LLM confidence is low. Check all fields before creating.
                    </div>
                  )}

                  <label className="block space-y-1">
                    <span className={labelClass}>Title</span>
                    <input
                      value={qcDraft.title}
                      onChange={(e) => setQcDraft((c) => ({ ...c, title: e.target.value }))}
                      disabled={isCreating}
                      className={inputClass}
                    />
                  </label>

                  <label className="block space-y-1">
                    <span className={labelClass}>Description</span>
                    <textarea
                      value={qcDraft.description}
                      onChange={(e) => setQcDraft((c) => ({ ...c, description: e.target.value }))}
                      placeholder="Context for this task (auto-filled from pasted text)."
                      rows={4}
                      disabled={isCreating}
                      className={`${inputClass} resize-y`}
                    />
                  </label>

                  {qcDraft.suggestedTasks.length > 1 && (
                    <label className="flex items-center gap-2 rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground">
                      <input
                        type="checkbox"
                        checked={qcDraft.createAsSeparateTasks}
                        onChange={(e) => setQcDraft((c) => ({ ...c, createAsSeparateTasks: e.target.checked }))}
                        disabled={isCreating}
                        className="h-4 w-4 accent-accent"
                      />
                      Create each action item as a separate task ({splitTaskCount})
                    </label>
                  )}

                  {qcDraft.createAsSeparateTasks && qcDraft.suggestedTasks.length > 0 && (
                    <div className="space-y-1">
                      <span className={labelClass}>Suggested Tasks</span>
                      <ul className="space-y-1">
                        {qcDraft.suggestedTasks.map((item, idx) => (
                          <li key={idx} className="flex items-center gap-2">
                            <input
                              value={item}
                              onChange={(e) => {
                                const updated = [...qcDraft.suggestedTasks];
                                updated[idx] = e.target.value;
                                setQcDraft((c) => ({ ...c, suggestedTasks: updated }));
                              }}
                              disabled={isCreating}
                              className={`flex-1 ${inputClass} !py-1.5`}
                            />
                            <button
                              type="button"
                              onClick={() => {
                                setQcDraft((c) => ({
                                  ...c,
                                  suggestedTasks: c.suggestedTasks.filter((_, i) => i !== idx),
                                }));
                              }}
                              disabled={isCreating}
                              className="text-xs text-muted-foreground hover:text-red-400 disabled:opacity-60"
                              aria-label="Remove task item"
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Suggested Checklist — editable list for single-task captures */}
                  {!qcDraft.createAsSeparateTasks && qcDraft.suggestedChecklist.length > 0 && (
                    <div className="space-y-1">
                      <span className={labelClass}>Suggested Subtasks</span>
                      <ul className="space-y-1">
                        {qcDraft.suggestedChecklist.map((item, idx) => (
                          <li key={idx} className="flex items-center gap-2">
                            <input
                              value={item}
                              onChange={(e) => {
                                const updated = [...qcDraft.suggestedChecklist];
                                updated[idx] = e.target.value;
                                setQcDraft((c) => ({ ...c, suggestedChecklist: updated }));
                              }}
                              disabled={isCreating}
                              className={`flex-1 ${inputClass} !py-1.5`}
                            />
                            <button
                              type="button"
                              onClick={() => {
                                setQcDraft((c) => ({
                                  ...c,
                                  suggestedChecklist: c.suggestedChecklist.filter((_, i) => i !== idx),
                                }));
                              }}
                              disabled={isCreating}
                              className="text-xs text-muted-foreground hover:text-red-400 disabled:opacity-60"
                              aria-label="Remove checklist item"
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <label className="space-y-1">
                      <span className={labelClass}>Application</span>
                      <select
                        value={qcDraft.implementationId}
                        onChange={(e) => setQcDraft((c) => ({ ...c, implementationId: e.target.value }))}
                        disabled={isCreating}
                        className={selectClass}
                      >
                        <option value="">Unassigned</option>
                        {implementations.map((impl) => (
                          <option key={impl.id} value={impl.id}>{impl.name}</option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-1">
                      <span className={labelClass}>Task Type</span>
                      <select
                        value={qcDraft.taskType}
                        onChange={(e) => setQcDraft((c) => ({ ...c, taskType: e.target.value as TaskType }))}
                        disabled={isCreating}
                        className={selectClass}
                      >
                        {TASK_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-1">
                      <span className={labelClass}>Due Date</span>
                      <input
                        type={qcDraft.dueDate ? "date" : "text"}
                        value={qcDraft.dueDate}
                        placeholder="mm/dd/yyyy"
                        onFocus={(e) => { e.currentTarget.type = "date"; }}
                        onBlur={(e) => { if (!e.currentTarget.value) e.currentTarget.type = "text"; }}
                        onChange={(e) => setQcDraft((c) => ({ ...c, dueDate: e.target.value }))}
                        disabled={isCreating}
                        className={selectClass}
                      />
                    </label>

                    <label className="space-y-1">
                      <span className={labelClass}>Status</span>
                      <select
                        value={qcDraft.status}
                        onChange={(e) => setQcDraft((c) => ({ ...c, status: e.target.value as TaskStatus }))}
                        disabled={isCreating}
                        className={selectClass}
                      >
                        {NEW_TASK_STATUSES.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </label>
                  </div>

                  {qcDraft.status === "Blocked/Waiting" && (
                    <label className="block space-y-1">
                      <span className={labelClass}>Waiting On</span>
                      <input
                        value={qcDraft.waitingOn}
                        onChange={(e) => setQcDraft((c) => ({ ...c, waitingOn: e.target.value }))}
                        placeholder="Who or what is this task waiting on?"
                        disabled={isCreating}
                        className={inputClass}
                      />
                    </label>
                  )}

                  <div className="space-y-1">
                    <span className={labelClass}>Estimate (min)</span>
                    <EstimateButtons
                      value={qcDraft.estimatedMinutes}
                      onChange={(minutes) => setQcDraft((c) => ({ ...c, estimatedMinutes: minutes }))}
                    />
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <label className="flex items-center gap-2 rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground">
                      <input
                        type="checkbox"
                        checked={qcDraft.blocker}
                        onChange={(e) => setQcDraft((c) => ({ ...c, blocker: e.target.checked }))}
                        disabled={isCreating}
                        className="h-4 w-4 accent-red-500"
                      />
                      Blocker
                    </label>
                    <label className="flex items-center gap-2 rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground">
                      <input
                        type="checkbox"
                        checked={qcDraft.sendToTriage}
                        onChange={(e) => setQcDraft((c) => ({ ...c, sendToTriage: e.target.checked }))}
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
                          setQcDraft(createInitialQcDraft());
                          setParseState("idle");
                          setIsOpen(false);
                        }}
                        disabled={isCreating}
                        className="rounded-lg border border-stroke bg-panel px-3 py-2 text-sm font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleQcSubmit}
                        disabled={isCreating}
                        className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isCreating
                          ? "Creating..."
                          : qcDraft.createAsSeparateTasks
                            ? `Create ${splitTaskCount} Tasks`
                            : "Create Task"}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
