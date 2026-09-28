"use client";

import { useCallback, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { TodayModalProvider, useTodayModal } from "@/components/today/TodayModalProvider";
import { HAND_BACK_NOTE_MAX_LENGTH, handBackTask } from "@/lib/task-handoff";
import { formatShortDate, type AssignedTask } from "@/lib/portfolio";
import type { TaskWithImplementation } from "@/types/database";

/**
 * Lets v5 pages (Portfolio, record pages) open the app's task editor in place.
 * It reuses the Today page's provider: one shared TaskDetailModal, and every
 * save calls router.refresh() so the server-rendered page re-reads its data.
 */
export function TaskEditorLayer({ children }: { children: ReactNode }) {
  return <TodayModalProvider>{children}</TodayModalProvider>;
}

/** Loads a task through GET /api/tasks/[id] and opens it in the shared editor. */
function useOpenTaskById() {
  const { openTask } = useTodayModal();
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<{ id: string; message: string } | null>(null);

  const open = useCallback(
    async (taskId: string) => {
      setOpeningId(taskId);
      setOpenError(null);
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { cache: "no-store" });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body || typeof body.id !== "string") {
          throw new Error(body && typeof body.error === "string" ? body.error : "Couldn't load the task.");
        }
        openTask(body as TaskWithImplementation);
      } catch (error) {
        setOpenError({ id: taskId, message: error instanceof Error ? error.message : "Couldn't load the task." });
      } finally {
        setOpeningId(null);
      }
    },
    [openTask]
  );

  return { open, openingId, openError };
}

function AssignedRow({
  task,
  opening,
  openError,
  onOpen,
  onHandedBack,
}: {
  task: AssignedTask;
  opening: boolean;
  openError: string | null;
  onOpen: () => void;
  onHandedBack: () => void;
}) {
  const [handingBack, setHandingBack] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Handed back, but the note comment failed: keep the row until Brent has read why. */
  const [partial, setPartial] = useState(false);

  const ctx = [
    task.app,
    task.statusLine,
    task.due ? `${task.overdue ? "was due" : "due"} ${formatShortDate(task.due)}` : null,
  ].filter(Boolean);

  async function confirmHandBack() {
    setBusy(true);
    setError(null);
    const result = await handBackTask(task.id, note);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (result.commentError) {
      setHandingBack(false);
      setPartial(true);
      setError(result.commentError);
      return;
    }
    onHandedBack();
  }

  const noteId = `pf-note-${task.id}`;
  return (
    <li>
      <button type="button" className="pf-what" onClick={onOpen} disabled={opening}>
        {task.title}
      </button>
      <span className={`pf-ctx${task.overdue ? " late" : ""}`}>{ctx.length ? ctx.join(" · ") : task.status}</span>
      <div className="pf-row-actions">
        <button type="button" className="btn sm" onClick={onOpen} disabled={opening}>
          {opening ? "Opening…" : "Open"}
        </button>
        {!handingBack && !partial ? (
          <button type="button" className="btn sm" onClick={() => setHandingBack(true)} disabled={busy}>
            Hand back
          </button>
        ) : null}
      </div>
      {handingBack ? (
        <div className="pf-handback">
          <label htmlFor={noteId}>Anything the agent should know? (optional)</label>
          <textarea
            id={noteId}
            rows={2}
            value={note}
            maxLength={HAND_BACK_NOTE_MAX_LENGTH}
            onChange={(event) => setNote(event.target.value)}
            disabled={busy}
            autoFocus
          />
          <div className="pf-handback-actions">
            <button type="button" className="btn sm solid" onClick={() => void confirmHandBack()} disabled={busy}>
              {busy ? "Handing back…" : "Hand back to the PM"}
            </button>
            <button type="button" className="btn sm" onClick={() => { setHandingBack(false); setError(null); }} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {error || openError ? (
        <p className="pf-err" role="alert">
          {error ?? openError}
          {partial ? (
            <button type="button" className="btn sm" onClick={onHandedBack}>
              OK
            </button>
          ) : null}
        </p>
      ) : null}
    </li>
  );
}

/** "Assigned to you": the title and Open open the editor; Hand back returns the task to the PM. */
export function AssignedList({ tasks }: { tasks: AssignedTask[] }) {
  const router = useRouter();
  const { open, openingId, openError } = useOpenTaskById();
  const [handedBack, setHandedBack] = useState<ReadonlySet<string>>(() => new Set());
  const visible = tasks.filter((task) => !handedBack.has(task.id));

  if (visible.length === 0) {
    return <p className="tile-p">Nothing is waiting on you. When an agent needs you, the task lands here.</p>;
  }

  return (
    <ul className="pf-you">
      {visible.map((task) => (
        <AssignedRow
          key={task.id}
          task={task}
          opening={openingId === task.id}
          openError={openError?.id === task.id ? openError.message : null}
          onOpen={() => void open(task.id)}
          onHandedBack={() => {
            setHandedBack((current) => new Set(current).add(task.id));
            router.refresh();
          }}
        />
      ))}
    </ul>
  );
}

function EditButtonInner({ taskId }: { taskId: string }) {
  const { open, openingId, openError } = useOpenTaskById();
  return (
    <span className="pf-edit">
      <button type="button" className="btn sm" onClick={() => void open(taskId)} disabled={openingId === taskId}>
        {openingId === taskId ? "Opening…" : "Edit"}
      </button>
      {openError ? (
        <span className="pf-err" role="alert">
          {openError.message}
        </span>
      ) : null}
    </span>
  );
}

/** The record page's Edit button: the same editor, over the readable record. */
export function TaskEditButton({ taskId }: { taskId: string }) {
  return (
    <TaskEditorLayer>
      <EditButtonInner taskId={taskId} />
    </TaskEditorLayer>
  );
}
