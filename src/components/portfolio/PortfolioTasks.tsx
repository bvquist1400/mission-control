"use client";

import { useCallback, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { TodayModalProvider, useTodayModal } from "@/components/today/TodayModalProvider";
import {
  HAND_BACK_EMPTY_DECISION_WARNING,
  HAND_BACK_NOTE_LABEL,
  HAND_BACK_NOTE_MAX_LENGTH,
  handBackNeedsAnswerWarning,
  handBackTask,
} from "@/lib/task-handoff";
import { formatShortDate, type AssignedTask, type LaterTask } from "@/lib/portfolio";
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
  /** A decision task with an empty answer: the first Send shows a warning, the second sends. */
  const [warned, setWarned] = useState(false);

  const ctx = [
    task.app,
    task.statusLine,
    task.due ? `${task.overdue ? "was due" : "due"} ${formatShortDate(task.due)}` : null,
  ].filter(Boolean);

  async function confirmHandBack() {
    if (handBackNeedsAnswerWarning(task.decision, note) && !warned) {
      setWarned(true);
      return;
    }
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
          <label htmlFor={noteId}>{HAND_BACK_NOTE_LABEL}</label>
          <textarea
            id={noteId}
            rows={2}
            value={note}
            maxLength={HAND_BACK_NOTE_MAX_LENGTH}
            onChange={(event) => {
              setNote(event.target.value);
              setWarned(false);
            }}
            disabled={busy}
            autoFocus
          />
          {warned ? (
            <p className="pf-warn" role="alert">
              {HAND_BACK_EMPTY_DECISION_WARNING} Add your answer above, or send it anyway.
            </p>
          ) : null}
          <div className="pf-handback-actions">
            <button type="button" className="btn sm solid" onClick={() => void confirmHandBack()} disabled={busy}>
              {busy ? "Handing back…" : warned ? "Send without an answer" : "Hand back to the PM"}
            </button>
            <button type="button" className="btn sm" onClick={() => { setHandingBack(false); setError(null); setWarned(false); }} disabled={busy}>
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

function laterContext(task: LaterTask): string[] {
  const waits: string[] = [];
  if (task.waitingOn) waits.push(`waiting on ${task.waitingOn}`);
  if (task.blockedBy.length > 0) {
    const [first, ...rest] = task.blockedBy;
    waits.push(`waits for “${first}”${rest.length ? ` and ${rest.length} more` : ""}`);
  }
  if (waits.length === 0) waits.push("blocked");
  return [
    task.app,
    ...waits,
    task.followUp ? `next look ${formatShortDate(task.followUp)}` : task.due ? `due ${formatShortDate(task.due)}` : null,
  ].filter((part): part is string => Boolean(part));
}

/**
 * "Coming to you later": Brent's tasks that are blocked for now (Blocked/Waiting
 * or an unfinished dependency). Not counted in the hero; each shows what it waits on.
 */
export function LaterList({ tasks }: { tasks: LaterTask[] }) {
  const { open, openingId, openError } = useOpenTaskById();
  if (tasks.length === 0) return null;
  return (
    <div className="pf-later" aria-labelledby="pf-later-h">
      <div className="pf-later-h">
        <h3 id="pf-later-h">Coming to you later</h3>
        <span className="mono">{tasks.length}</span>
      </div>
      <ul className="pf-later-list">
        {tasks.map((task) => (
          <li key={task.id}>
            <span className="pf-blocked">Blocked</span>
            <div className="pf-later-body">
              <button type="button" className="pf-what" onClick={() => void open(task.id)} disabled={openingId === task.id}>
                {task.title}
              </button>
              <span className="pf-ctx">{laterContext(task).join(" · ")}</span>
              {task.statusLine ? <span className="pf-ctx pf-later-line">{task.statusLine}</span> : null}
              {openError?.id === task.id ? (
                <span className="pf-err" role="alert">
                  {openError.message}
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
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
