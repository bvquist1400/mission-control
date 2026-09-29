"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Field";
import {
  AGENT_LABEL_SUGGESTIONS,
  HAND_BACK_EMPTY_DECISION_WARNING,
  HAND_BACK_NOTE_LABEL,
  HAND_BACK_NOTE_MAX_LENGTH,
  buildOwnerUpdate,
  handBackNeedsAnswerWarning,
  isDecisionTask,
  toOneLine,
} from "@/lib/task-handoff";
import { OWNER_LABEL_MAX_LENGTH, STATUS_LINE_MAX_LENGTH } from "@/lib/task-owner";
import type { TaskOwner, TaskUpdatePayload, TaskWithImplementation } from "@/types/database";

interface TaskOwnerSectionProps {
  task: TaskWithImplementation;
  disabled: boolean;
  /** Saves through PATCH /api/tasks/[id]; resolves true on success. */
  onSave: (updates: TaskUpdatePayload) => Promise<boolean>;
  /** Hands the task back to the PM with an optional note; resolves true once the owner changed. */
  onHandBack: (note: string) => Promise<boolean>;
}

/**
 * "Who has it" for a task: Brent or an agent, which agent, and one line on
 * where it stands, plus the hand-back button that takes it off Brent's list.
 * Drafts start from the saved task; the caller keys this on the task's id and
 * updated_at, so a save (or another task) starts fresh drafts. When the task
 * is Brent's, the hand-back box starts open: it's where his answer goes.
 */
export function TaskOwnerSection({ task, disabled, onSave, onHandBack }: TaskOwnerSectionProps) {
  const labelListId = useId();
  const [owner, setOwner] = useState<TaskOwner>(task.owner);
  const [ownerLabel, setOwnerLabel] = useState(task.owner_label ?? "");
  const [statusLine, setStatusLine] = useState(task.status_line ?? "");
  const [handingBack, setHandingBack] = useState(task.owner === "brent");
  /** Opened by a tap (focus the box), not by default (don't steal focus on open). */
  const [openedByTap, setOpenedByTap] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  /** A decision task with an empty answer: the first Send shows a warning, the second sends. */
  const [warned, setWarned] = useState(false);
  const decision = isDecisionTask(task);

  const update = buildOwnerUpdate(task, { owner, ownerLabel, statusLine });
  const lineLength = toOneLine(statusLine).length;
  const locked = disabled || busy;

  async function save() {
    if (!update.ok || !update.changed) return;
    setBusy(true);
    await onSave(update.changes);
    setBusy(false);
  }

  async function confirmHandBack() {
    if (handBackNeedsAnswerWarning(decision, note) && !warned) {
      setWarned(true);
      return;
    }
    setBusy(true);
    const done = await onHandBack(note);
    setBusy(false);
    if (done) {
      setHandingBack(false);
      setNote("");
      setWarned(false);
    }
  }

  return (
    <section className="rounded-lg border border-stroke bg-panel-muted p-3" aria-labelledby={`${labelListId}-h`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={`${labelListId}-h`} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Who has it
        </h4>
        {task.owner === "brent" && !handingBack ? (
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setHandingBack(true);
              setOpenedByTap(true);
            }}
            disabled={locked}
          >
            Hand back to agent
          </Button>
        ) : null}
      </div>

      {handingBack ? (
        <div className="mt-3 space-y-2">
          <label className="block space-y-1">
            <span className="text-sm font-medium text-foreground">{HAND_BACK_NOTE_LABEL}</span>
            <Textarea
              size="sm"
              rows={3}
              value={note}
              maxLength={HAND_BACK_NOTE_MAX_LENGTH}
              onChange={(event) => {
                setNote(event.target.value);
                setWarned(false);
              }}
              disabled={locked}
              placeholder={decision ? "e.g. Keep both boards." : "e.g. Checked on my iPhone; Split View still fails."}
              autoFocus={openedByTap}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Hand back sends it to the PM. Your answer is saved as a comment and becomes the task&apos;s &ldquo;where it stands&rdquo; line.
          </p>
          {warned ? (
            <p role="alert" className="rounded border border-warning-border bg-warning-soft px-3 py-2 text-xs text-warning">
              {HAND_BACK_EMPTY_DECISION_WARNING} Add your answer above, or send it anyway.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" onClick={() => void confirmHandBack()} disabled={locked}>
              {busy ? "Handing back…" : warned ? "Send without an answer" : "Hand back"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setHandingBack(false);
                setWarned(false);
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Owner</span>
          <div className="flex gap-2" role="group" aria-label="Who has it">
            <Button variant="toggle" size="sm" active={owner === "brent"} onClick={() => setOwner("brent")} disabled={locked}>
              You
            </Button>
            <Button variant="toggle" size="sm" active={owner === "agent"} onClick={() => setOwner("agent")} disabled={locked}>
              Agent
            </Button>
          </div>
        </div>
        {owner === "agent" ? (
          <label className="space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Which agent</span>
            <Input
              size="sm"
              list={labelListId}
              value={ownerLabel}
              maxLength={OWNER_LABEL_MAX_LENGTH}
              onChange={(event) => setOwnerLabel(event.target.value)}
              disabled={locked}
              placeholder="PM, Builder, Codex, Fable…"
            />
            <datalist id={labelListId}>
              {AGENT_LABEL_SUGGESTIONS.map((label) => (
                <option key={label} value={label} />
              ))}
            </datalist>
          </label>
        ) : null}
      </div>

      <label className="mt-3 block space-y-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Where it stands</span>
          <span className={`text-xs tabular-nums ${lineLength > STATUS_LINE_MAX_LENGTH ? "text-danger" : "text-muted-foreground"}`}>
            {lineLength}/{STATUS_LINE_MAX_LENGTH}
          </span>
        </span>
        <Textarea
          size="sm"
          rows={2}
          value={statusLine}
          onChange={(event) => setStatusLine(event.target.value)}
          disabled={locked}
          placeholder="One plain sentence, e.g. 8 of 11 checks passed; Split View left."
        />
      </label>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className={`text-xs ${update.ok ? "text-muted-foreground" : "text-danger"}`}>
          {update.ok ? "Shown on the Portfolio and at the top of the task." : update.error}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void save()} disabled={locked || !update.ok || !update.changed}>
          {busy && !handingBack ? "Saving…" : "Save"}
        </Button>
      </div>
    </section>
  );
}
