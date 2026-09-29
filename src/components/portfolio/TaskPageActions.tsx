"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import {
  HAND_BACK_EMPTY_DECISION_WARNING,
  HAND_BACK_NOTE_LABEL,
  HAND_BACK_NOTE_MAX_LENGTH,
  handBackNeedsAnswerWarning,
  handBackTask,
} from "@/lib/task-handoff";
import { composePageComment } from "@/lib/task-page";

/**
 * The task page's hand-back box. When Brent owns the task it starts open: it's
 * where his answer goes. On a decision task an empty answer warns once first.
 */
export function TaskPageHandBack({ taskId, decision, startOpen }: { taskId: string; decision: boolean; startOpen: boolean }) {
  const router = useRouter();
  const noteId = useId();
  const [open, setOpen] = useState(startOpen);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [warned, setWarned] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (handBackNeedsAnswerWarning(decision, note) && !warned) {
      setWarned(true);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await handBackTask(taskId, note);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (result.commentError) setError(result.commentError);
    setNote("");
    setWarned(false);
    router.refresh();
  }

  if (!open) {
    return (
      <div className="pf-handoff">
        <button type="button" className="btn solid" onClick={() => setOpen(true)}>
          Hand back to the PM
        </button>
        <span>Handing back moves it off your list and tells the agent.</span>
      </div>
    );
  }

  return (
    <div className="pf-handback pf-task-handback">
      <label htmlFor={noteId}>{HAND_BACK_NOTE_LABEL}</label>
      <textarea
        id={noteId}
        rows={3}
        value={note}
        maxLength={HAND_BACK_NOTE_MAX_LENGTH}
        placeholder={decision ? "e.g. Keep both boards." : "e.g. Checked on my iPhone; Split View still fails."}
        onChange={(event) => {
          setNote(event.target.value);
          setWarned(false);
        }}
        disabled={busy}
      />
      {warned ? (
        <p className="pf-warn" role="alert">
          {HAND_BACK_EMPTY_DECISION_WARNING} Add your answer above, or send it anyway.
        </p>
      ) : null}
      <div className="pf-handback-actions">
        <button type="button" className="btn sm solid" onClick={() => void send()} disabled={busy}>
          {busy ? "Handing back…" : warned ? "Send without an answer" : "Hand back to the PM"}
        </button>
        <span className="pf-handback-hint">It leaves your list; your answer becomes a comment and the “where this stands” line.</span>
      </div>
      {error ? (
        <p className="pf-err" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** "Add a comment" on the task page: saved as "Brent: …", then the page re-reads. */
export function TaskPageCommentBox({ taskId }: { taskId: string }) {
  const router = useRouter();
  const fieldId = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const content = composePageComment(text);

  async function add() {
    if (!content) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body && typeof body.error === "string" ? body.error : "Couldn't add the comment.");
      }
      setText("");
      router.refresh();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Couldn't add the comment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pf-compose">
      <label htmlFor={fieldId} className="pf-sr">
        Add a comment
      </label>
      <textarea
        id={fieldId}
        rows={2}
        value={text}
        maxLength={4000}
        placeholder="Add a comment…"
        onChange={(event) => setText(event.target.value)}
        disabled={busy}
      />
      {text.trim() ? (
        <div className="pf-handback-actions">
          <button type="button" className="btn sm solid" onClick={() => void add()} disabled={busy || !content}>
            {busy ? "Adding…" : "Add comment"}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="pf-err" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
