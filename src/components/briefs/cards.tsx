"use client";

import type { ReactNode } from "react";
import {
  DISMISS_NOTE_MAX,
  DISMISS_REASONS,
  type BriefAction,
  type BriefItemKind,
  type BriefItemRow,
  type BriefMeetingRef,
  type BriefTaskSummary,
  type DismissReason,
} from "@/lib/briefs/types";
import {
  ACCEPT_DUE_PRESETS,
  defaultAcceptDueChoice,
  isAcceptDuePreset,
  isDatePassed,
  isDateOnlyString,
  resolveAcceptDueDate,
  type AcceptDueChoice,
  type AcceptDuePreset,
} from "@/lib/briefs/due";
import { etClock, etDay, etTime, notesDueParts, shortId, weekdayDate } from "@/components/briefs/format";

export interface ActRequest {
  n: number;
  action: BriefAction;
  reason?: DismissReason | null;
  note?: string | null;
  choice?: string | null;
  /** accept only; the page always sends the card's pick. */
  due?: AcceptDueChoice;
}

export interface DismissDraft {
  reason: DismissReason | null;
  note: string;
}

export interface BriefCardContext {
  tasks: Record<string, BriefTaskSummary>;
  /** The brief's date (YYYY-MM-DD, ET); "Tomorrow" counts from it. */
  briefDate: string;
  /** The due choice Accept will send for this card. */
  dueChoice: AcceptDueChoice;
  setDueChoice: (choice: AcceptDueChoice) => void;
  meetingColor: (meetingId: string) => string;
  meetingLabel: (meeting: BriefMeetingRef) => string;
  pending: boolean;
  focused: boolean;
  draft: DismissDraft | null;
  showSource: boolean;
  act: (request: ActRequest) => void;
  startDismiss: () => void;
  cancelDismiss: () => void;
  setDraft: (draft: DismissDraft) => void;
  toggleSource: () => void;
  focus: () => void;
  openSheet: (key: string) => void;
}

type CardProps = { item: BriefItemRow; ctx: BriefCardContext };

export type BriefSection = "meetings" | "calls";

/** Section headings come from the kind, never from the edition. */
export const BRIEF_SECTIONS: Record<BriefSection, { title: string; hint?: string }> = {
  meetings: { title: "From meetings", hint: "Nothing becomes a task until you accept it." },
  calls: { title: "Needs a call" },
};

export const ACCEPT_DUE_LABELS: Record<AcceptDuePreset, string> = {
  today: "Today",
  tomorrow: "Tomorrow",
  this_week: "This week",
  none: "No date",
};

/** A proposal's due date from its notes, if it carries a real one. */
export function suggestedDue(item: BriefItemRow): string | null {
  return isDateOnlyString(item.payload.suggested_due) ? item.payload.suggested_due : null;
}

/**
 * Where a card's due choice starts: the notes' date when it is today or later,
 * else Tomorrow (also when the notes' date has already passed, ET).
 */
export function defaultAcceptDue(item: BriefItemRow, now: Date = new Date()): AcceptDueChoice {
  return defaultAcceptDueChoice(suggestedDue(item), now);
}

export const DISMISS_REASON_LABELS: Record<DismissReason, string> = {
  already_tracked: "Already tracked",
  not_mine: "Not mine",
  not_worth_it: "Not worth it",
};

const CheckIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M2.5 6.2 5 8.5l4.5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const CrossIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="M2 2l6 6M8 2 2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);
const ArrowIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M2.5 6h7M6.5 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function TaskLink({ id }: { id: string }) {
  return (
    <a className="idlink" href={`/r/task/${id}`}>
      {shortId(id)}
    </a>
  );
}

function StateIcon({ ok }: { ok: boolean }) {
  return <span className={`ic ${ok ? "ok" : "no"}`}>{ok ? <CheckIcon /> : <CrossIcon />}</span>;
}

function dueLabel(dueAt: string | null | undefined): string {
  if (!dueAt) return "tomorrow";
  const date = new Date(dueAt);
  return date.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric" });
}

function uniqueMeetings(item: BriefItemRow): BriefMeetingRef[] {
  const seen = new Set<string>();
  return item.source.meetings.filter((meeting) => (seen.has(meeting.id) ? false : (seen.add(meeting.id), true)));
}

function cardClass(base: string, ctx: BriefCardContext): string {
  return [base, ctx.focused ? "kfocus" : "", ctx.pending ? "pending" : ""].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// proposed_task — a meeting action item: Accept / Dismiss
// ---------------------------------------------------------------------------

function SourceRow({ item, ctx }: CardProps) {
  return (
    <div className="src-row">
      {uniqueMeetings(item).map((meeting) => (
        <span key={meeting.id} className="m" style={{ ["--mc" as string]: ctx.meetingColor(meeting.id) }}>
          <span className="dot" />
          {ctx.meetingLabel(meeting)} <span className="t">{etClock(meeting.start)}</span>
        </span>
      ))}
      <span className="n">#{item.n}</span>
    </div>
  );
}

/** "yours · due Wed 9/30" / "yours · no date" for an accepted proposal's task, once it's loaded. */
function acceptedWhere(task: BriefTaskSummary | undefined): string | null {
  if (!task) return null;
  return [task.owner === "brent" ? "yours" : null, task.due_at ? `due ${etDay(task.due_at)}` : "no date"].filter(Boolean).join(" · ");
}

/** Today / Tomorrow / This week / No date, plus the notes' date when there is one. */
function DuePicker({ item, ctx }: CardProps) {
  const suggested = suggestedDue(item);
  const selected = ctx.dueChoice;
  // "Passed" is judged in ET at render time, so a stale page can't offer yesterday as the default.
  const notesParts = suggested ? notesDueParts(suggested, isDatePassed(suggested)) : null;
  // Show which day a relative choice lands on (the notes' date already says it).
  const lands = isAcceptDuePreset(selected) && selected !== "none" ? resolveAcceptDueDate(selected, ctx.briefDate) : null;
  return (
    <div className="seg due" role="group" aria-label={`Due date if you accept #${item.n}`}>
      <span>Due</span>
      {suggested ? (
        <button
          type="button"
          aria-pressed={selected === suggested}
          suppressHydrationWarning
          disabled={ctx.pending}
          onClick={() => ctx.setDueChoice(suggested as AcceptDueChoice)}
        >
          {notesParts?.day} <span className="from" suppressHydrationWarning>
            {notesParts?.note}
          </span>
        </button>
      ) : null}
      {ACCEPT_DUE_PRESETS.map((preset) => (
        <button key={preset} type="button" aria-pressed={selected === preset} disabled={ctx.pending} onClick={() => ctx.setDueChoice(preset)}>
          {ACCEPT_DUE_LABELS[preset]}
        </button>
      ))}
      {lands ? (
        <span className="when" suppressHydrationWarning>
          {weekdayDate(lands)}
        </span>
      ) : null}
    </div>
  );
}

function ProposedTaskCard({ item, ctx }: CardProps) {
  const title = item.payload.title;

  if (item.state === "accepted") {
    const where = acceptedWhere(item.created_task_id ? ctx.tasks[item.created_task_id] : undefined);
    return (
      <div className={cardClass("slim", ctx)} data-n={item.n}>
        <StateIcon ok />
        <span className="tx">
          <span className="n">#{item.n}</span>
          {title}
        </span>
        <span className="st">
          {where ? `Accepted · ${where}` : `Accepted ${etTime(item.acted_at)}`}
          {item.created_task_id ? (
            <>
              <ArrowIcon /> <TaskLink id={item.created_task_id} />
            </>
          ) : null}
        </span>
      </div>
    );
  }

  if (item.state === "dismissed" || item.state === "expired") {
    return (
      <div className={cardClass("slim", ctx)} data-n={item.n}>
        <StateIcon ok={false} />
        <span className="tx">
          <span className="n">#{item.n}</span>
          {title}
        </span>
        <span className="st">
          {item.state === "expired"
            ? "Expired"
            : item.dismissed_reason
              ? DISMISS_REASON_LABELS[item.dismissed_reason]
              : "Dismissed"}
          {item.dismissed_note ? <span className="dn">“{item.dismissed_note}”</span> : null}
          {item.state === "dismissed" ? (
            <button type="button" className="linkbtn" disabled={ctx.pending} onClick={() => ctx.act({ n: item.n, action: "undo" })}>
              Undo
            </button>
          ) : null}
        </span>
      </div>
    );
  }

  const maybe = item.payload.maybe_tracked;
  const maybeTask = maybe ? ctx.tasks[maybe.task_id] : undefined;
  const lineCount = item.source.meetings.reduce((sum, meeting) => sum + meeting.lines.length, 0);

  const body = (
    <div className="body">
      <SourceRow item={item} ctx={ctx} />
      <h3>{title}</h3>
      {item.payload.detail ? <p className="detail">{item.payload.detail}</p> : null}
      {maybe ? (
        <div className="maybe">
          <span className="dot" />
          <span>
            Maybe already tracked: <TaskLink id={maybe.task_id} /> {maybeTask?.title ?? ""}
            {maybe.text ? `; ${maybe.text}` : ""}
          </span>
        </div>
      ) : null}
      {ctx.showSource ? (
        <div className="quotes">
          {item.source.meetings.map((meeting) => {
            const from = (
              <span className="from">
                {meeting.title}
                {meeting.start ? ` · ${etClock(meeting.start)}` : ""}
                {meeting.url ? " · open in Granola ↗" : ""}
              </span>
            );
            return (
              <div key={meeting.id} className="quote" style={{ ["--mc" as string]: ctx.meetingColor(meeting.id) }}>
                {meeting.lines.length ? meeting.lines.map((line) => <div key={line}>“{line}”</div>) : null}
                {meeting.url ? (
                  <a href={meeting.url} target="_blank" rel="noopener noreferrer">
                    {from}
                  </a>
                ) : (
                  from
                )}
              </div>
            );
          })}
        </div>
      ) : null}
      {!ctx.draft ? (
        <button type="button" className="srcbtn" onClick={ctx.toggleSource}>
          {ctx.showSource ? "Hide" : "Show"} note line{lineCount === 1 ? "" : "s"}
        </button>
      ) : null}
    </div>
  );

  if (ctx.draft) {
    const draft = ctx.draft;
    const ready = Boolean(draft.reason || draft.note.trim());
    return (
      <article className={cardClass("card", ctx)} tabIndex={0} data-n={item.n} id={`item-${item.n}`} onFocus={ctx.focus}>
        {body}
        <form
          className="dbox"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) ctx.act({ n: item.n, action: "dismiss", reason: draft.reason, note: draft.note.trim() || null });
          }}
        >
          <div className="seg" role="group" aria-label="Why dismiss?">
            <span>Why?</span>
            {DISMISS_REASONS.map((reason) => (
              <button
                key={reason}
                type="button"
                aria-pressed={draft.reason === reason}
                onClick={() => ctx.setDraft({ ...draft, reason: draft.reason === reason ? null : reason })}
              >
                {DISMISS_REASON_LABELS[reason]}
              </button>
            ))}
          </div>
          <label htmlFor={`note-${item.n}`} hidden>
            Note
          </label>
          <input
            id={`note-${item.n}`}
            className="note-in"
            placeholder="Add a note (optional)"
            maxLength={DISMISS_NOTE_MAX}
            value={draft.note}
            autoFocus
            onChange={(event) => ctx.setDraft({ ...draft, note: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Escape") ctx.cancelDismiss();
            }}
          />
          <div className="row-end">
            {draft.note.length > DISMISS_NOTE_MAX - 100 ? (
              <span className="left">
                {draft.note.length}/{DISMISS_NOTE_MAX}
              </span>
            ) : null}
            <button type="button" className="btn sm" onClick={ctx.cancelDismiss}>
              Cancel
            </button>
            <button type="submit" className="btn sm solid" disabled={!ready || ctx.pending}>
              Dismiss
            </button>
          </div>
        </form>
      </article>
    );
  }

  return (
    <article className={cardClass("card", ctx)} tabIndex={0} data-n={item.n} id={`item-${item.n}`} onFocus={ctx.focus}>
      {body}
      <DuePicker item={item} ctx={ctx} />
      <div className="side">
        <button
          type="button"
          className="btn solid"
          disabled={ctx.pending}
          onClick={() => ctx.act({ n: item.n, action: "accept", due: ctx.dueChoice })}
        >
          Accept <kbd>A</kbd>
        </button>
        <button type="button" className="btn" disabled={ctx.pending} onClick={ctx.startDismiss}>
          Dismiss <kbd>D</kbd>
        </button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Tiles for items that need a call
// ---------------------------------------------------------------------------

function HandledTile({ item, ctx, label, text, ok, children }: CardProps & { label: string; text: string; ok: boolean; children?: ReactNode }) {
  return (
    <article className={cardClass("tile call span-2 handled", ctx)} data-n={item.n} id={`item-${item.n}`}>
      <div className="tile-k">
        #{item.n} · {label}
      </div>
      <div className="handled-row">
        <StateIcon ok={ok} />
        <span>{text}</span>
      </div>
      <p className="tile-p">{item.payload.title}</p>
      <div className="tile-foot">{children}</div>
    </article>
  );
}

function CarryOverCard({ item, ctx }: CardProps) {
  const taskId = item.task_ids[0];
  const task = taskId ? ctx.tasks[taskId] : undefined;
  const label = item.payload.label ?? "Carry-over";

  if (item.state !== "open") {
    const text =
      item.state === "done" ? "Done" : item.state === "deferred" ? `Due ${dueLabel(task?.due_at)}` : item.state === "parked" ? "Parked" : "Expired";
    return (
      <HandledTile item={item} ctx={ctx} label={label} text={text} ok={item.state === "done"}>
        {taskId ? <TaskLink id={taskId} /> : null}
      </HandledTile>
    );
  }

  return (
    <article className={cardClass("tile call span-2", ctx)} tabIndex={0} data-n={item.n} id={`item-${item.n}`} onFocus={ctx.focus}>
      <div className="tile-k">
        #{item.n} · {label}
        {taskId ? <> · <TaskLink id={taskId} /></> : null}
      </div>
      <h3>{item.payload.title}</h3>
      {item.payload.why ? <p className="why">{item.payload.why}</p> : null}
      <div className="call-actions">
        <button type="button" className="btn solid grow" disabled={ctx.pending} onClick={() => ctx.act({ n: item.n, action: "done" })}>
          Done
        </button>
        <button type="button" className="btn" disabled={ctx.pending} onClick={() => ctx.act({ n: item.n, action: "tomorrow" })}>
          Tomorrow
        </button>
        <button type="button" className="btn" disabled={ctx.pending} onClick={() => ctx.act({ n: item.n, action: "park" })}>
          Park
        </button>
      </div>
    </article>
  );
}

function CarryGroupCard({ item, ctx }: CardProps) {
  const count = item.task_ids.length;
  const label = item.payload.label ?? `${count} tasks`;

  if (item.state !== "open") {
    const firstDue = ctx.tasks[item.task_ids[0]]?.due_at;
    const text =
      item.state === "deferred" ? `All ${count} due ${dueLabel(firstDue)}` : item.state === "parked" ? `All ${count} parked` : "Expired";
    return (
      <HandledTile item={item} ctx={ctx} label={label} text={text} ok={false}>
        <button type="button" className="linkbtn lift" onClick={() => ctx.openSheet(`item:${item.n}`)}>
          See the {count}
        </button>
      </HandledTile>
    );
  }

  return (
    <article className={cardClass("tile call span-2", ctx)} tabIndex={0} data-n={item.n} id={`item-${item.n}`} onFocus={ctx.focus}>
      <div className="tile-k">
        #{item.n} · {label}
      </div>
      <h3>{item.payload.title}</h3>
      <p className="why">
        {item.payload.why ? `${item.payload.why} ` : ""}
        <button type="button" className="linkbtn" onClick={() => ctx.openSheet(`item:${item.n}`)}>
          See the {count}
        </button>
      </p>
      <div className="call-actions">
        <button type="button" className="btn solid grow" disabled={ctx.pending} onClick={() => ctx.act({ n: item.n, action: "tomorrow" })}>
          All tomorrow
        </button>
        <button type="button" className="btn" disabled={ctx.pending} onClick={() => ctx.act({ n: item.n, action: "park" })}>
          Park all
        </button>
      </div>
    </article>
  );
}

function ChoiceCard({ item, ctx }: CardProps) {
  const options = item.payload.options ?? [];
  const label = item.payload.label ?? "Choice";

  if (item.state === "decided") {
    const picked = options.find((option) => option.key === item.choice);
    return (
      <HandledTile item={item} ctx={ctx} label={label} text={picked?.label ?? item.choice ?? ""} ok>
        <button type="button" className="linkbtn lift" disabled={ctx.pending} onClick={() => ctx.act({ n: item.n, action: "undo" })}>
          Undo
        </button>
      </HandledTile>
    );
  }
  if (item.state !== "open") {
    return <HandledTile item={item} ctx={ctx} label={label} text="Expired" ok={false} />;
  }

  return (
    <article className={cardClass("tile call span-2", ctx)} tabIndex={0} data-n={item.n} id={`item-${item.n}`} onFocus={ctx.focus}>
      <div className="tile-k">
        #{item.n} · {label}
      </div>
      <h3>{item.payload.title}</h3>
      {item.payload.why ? <p className="why">{item.payload.why}</p> : null}
      <div className="call-actions stack">
        {options.map((option) => (
          <button
            key={option.key}
            type="button"
            className={`btn ${option.recommended ? "solid" : ""}`}
            disabled={ctx.pending}
            onClick={() => ctx.act({ n: item.n, action: "pick", choice: option.key })}
          >
            <span>{option.label}</span>
            {option.recommended ? <span className="badge">my pick</span> : null}
          </button>
        ))}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Registry: every item kind maps to a section and one card component. Adding a
// kind means adding it here (and to the migration's kind check); nothing in the
// page switches on kind.
// ---------------------------------------------------------------------------

export const CARD_REGISTRY: Record<
  BriefItemKind,
  { section: BriefSection; Card: (props: CardProps) => ReactNode; keyboard: "decide" | "call" }
> = {
  proposed_task: { section: "meetings", Card: ProposedTaskCard, keyboard: "decide" },
  carry_over: { section: "calls", Card: CarryOverCard, keyboard: "call" },
  carry_group: { section: "calls", Card: CarryGroupCard, keyboard: "call" },
  choice: { section: "calls", Card: ChoiceCard, keyboard: "call" },
};
