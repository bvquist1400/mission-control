"use client";
/**
 * The craft screen's sheets (S2): Log sitting, Undo rows, Fix count, band close, Change total, a note, the timer's
 * fixes, the timer conflict and the new-day question. Each shows what it will change before saving, saves through
 * the screen's `send` (one 073 call; the reply carries the fresh view), and Enter saves (a form submit).
 */
import { useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { CraftView } from "@/lib/craft";
import {
  CRAFT_MAX_ROWS, SITTING_MAX_MINUTES, clockText, fixCountPlan, logSittingDefaults, minutesText, newIdempotencyKey, quarterText,
  rowFromRidgesDone, rowsText, setTotalPlan, setTotalRefusalText, sittingPlan, timerMinutes, undoChoices, type RowWord,
} from "@/lib/craft/actions";

export type Send = (kind: "row" | "timer" | "sittings" | "total" | "notes", body: Record<string, unknown>, method?: "POST" | "DELETE") => Promise<SendReply>;
export interface SendReply { ok: boolean; status: number | null; body: Record<string, unknown> | null; error: string | null }
type Part = NonNullable<CraftView["active_part"]>;

function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  return <Modal open={open} onClose={onClose} title={title}><div className="craft-sheet">{children}</div></Modal>;
}
function Actions({ busy, onCancel, saveLabel, disabled }: { busy: boolean; onCancel: () => void; saveLabel: string; disabled?: boolean }) {
  return (
    <div className="craft-sheet-actions">
      <Button type="button" variant="secondary" size="lg" onClick={onCancel} disabled={busy}>Cancel</Button>
      <Button type="submit" variant="primary" size="lg" disabled={busy || disabled} aria-busy={busy || undefined}>{busy ? "Saving…" : saveLabel}</Button>
    </div>
  );
}
function ErrorLine({ text }: { text: string | null }) {
  return text ? <p className="craft-sheet-error" role="alert">{text}</p> : null;
}
/** A number box with − and + beside it (big targets on the Duo, typing on a desk). */
function Stepper({ id, label, hint, value, onChange, min, max, step = 1 }: {
  id: string; label: string; hint?: ReactNode; value: number | null; onChange: (value: number | null) => void; min: number; max: number; step?: number;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <div className="craft-field">
      <label htmlFor={id}>{label}{hint && <span>{hint}</span>}</label>
      <div className="craft-stepper">
        <button type="button" aria-label={`${label}: ${step} less`} onClick={() => onChange(clamp((value ?? min) - step))}>−{step > 1 ? step : ""}</button>
        <input id={id} type="number" inputMode="numeric" min={min} max={max} value={value ?? ""} onChange={(e) => {
          const raw = e.target.value.trim();
          onChange(raw === "" ? null : clamp(Math.trunc(Number(raw))));
        }} />
        <button type="button" aria-label={`${label}: ${step} more`} onClick={() => onChange(clamp((value ?? min - step) + step))}>+{step > 1 ? step : ""}</button>
      </div>
    </div>
  );
}

// ── Log sitting ─────────────────────────────────────────────────────────────
export function LogSittingSheet({ open, onClose, view, part, send, thenStart, onSaved }: {
  open: boolean; onClose: () => void; view: CraftView; part: Part; send: Send; thenStart?: boolean; onSaved: (reply: SendReply) => void;
}) {
  const word = part.row_word as RowWord;
  const timer = view.timer;
  const defaults = logSittingDefaults(view.row_states, part.total_rows, timer);
  const [form, setForm] = useState(() => ({ minutes: defaults.minutes, minutesTouched: false, from: defaults.from, to: defaults.to, quarter: 0, note: "", key: newIdempotencyKey() }));
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const plan = sittingPlan(view.row_states, part.total_rows, form.from, form.to);
  const timerMin = timer ? Math.min(SITTING_MAX_MINUTES, timerMinutes(timer.elapsed_seconds)) : null;
  const shownMinutes = form.minutesTouched || !timer ? form.minutes : timerMin;
  const rowsDone = Math.max(0, form.to - form.from);
  const nextRow = form.to + 1;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (shownMinutes === null || shownMinutes < 1) { setState({ busy: false, error: "Type the minutes (at least 1)." }); return; }
    setState({ busy: true, error: null });
    const body: Record<string, unknown> = {
      part_id: part.id, use_timer: Boolean(timer), to_row: form.to, to_quarter: form.quarter, expected_row: part.current_row,
      note: form.note.trim() || null, idempotency_key: form.key,
      ...(timer ? { timer_version: timer.version } : { from_row: form.from }),
      // With the timer and untouched minutes the server takes the timer's own minutes at save time.
      ...(!timer || form.minutesTouched || timer.over_cap ? { minutes: shownMinutes } : {}),
    };
    const reply = await send("sittings", body);
    if (!reply.ok) { setState({ busy: false, error: reply.error }); return; }
    setState({ busy: false, error: null });
    onSaved(reply);
  }
  return (
    <Sheet open={open} onClose={onClose} title="Log sitting">
      <form onSubmit={submit}>
        <p className="craft-sheet-sub">{view.project.name} · {part.name}{thenStart ? " · then a new timer for today" : ""}</p>
        <Stepper id="craft-log-minutes" label="Minutes" step={5} min={1} max={SITTING_MAX_MINUTES} value={shownMinutes}
          hint={timer ? `from the timer (${clockText(timer.elapsed_seconds)})` : "no timer: type them"}
          onChange={(value) => setForm((f) => ({ ...f, minutes: value, minutesTouched: true }))} />
        {timer?.over_cap && <p className="craft-sheet-warn">The timer shows {minutesText(timer.elapsed_seconds / 60)}. A sitting can be at most 24 hours (1,440 min): type the minutes you worked.</p>}
        {!timer && <Stepper id="craft-log-from" label={`Last full ${word} before this sitting`} min={0} max={form.to} value={form.from}
          hint={form.from === 0 ? "started at the beginning" : undefined} onChange={(value) => setForm((f) => ({ ...f, from: value ?? 0 }))} />}
        <Stepper id="craft-log-to" label={`Last full ${word} finished`} min={form.from} max={part.total_rows} value={form.to}
          hint={rowsDone === 1 ? `1 ${word} this sitting` : `${rowsDone} ${word}s this sitting`} onChange={(value) => setForm((f) => ({ ...f, to: value ?? f.from, quarter: 0 }))} />
        {part.ridges && <p className="craft-sheet-hint">{word === "row" ? `Row ${form.to} = ridge ${Math.ceil(form.to / 2)}` : null}</p>}
        {part.quarters && nextRow <= part.total_rows && (
          <fieldset className="craft-quarters">
            <legend>Part of {word} {nextRow}</legend>
            {[0, 1, 2, 3].map((q) => (
              <label key={q} data-on={form.quarter === q ? "true" : undefined}>
                <input type="radio" name="craft-quarter" value={q} checked={form.quarter === q} onChange={() => setForm((f) => ({ ...f, quarter: q }))} />
                <span>{quarterText(q)}</span>
                {part.stitch_count ? <small>{Math.round((q * part.stitch_count) / 4)} sts</small> : null}
              </label>
            ))}
          </fieldset>
        )}
        <p className={form.quarter > 0 ? "craft-sheet-warn" : "craft-sheet-hint"}>
          {form.quarter > 0 ? `Stopping partway through ${word} ${nextRow}: its minutes count toward speed once the next update ships. Or keep the timer paused and save when the ${word} is done.`
            : timer ? `Stopped partway through a ${word}? Its minutes count toward speed once the next update ships. Or keep the timer paused and save when the ${word} is done.`
            : `Stopped partway through a ${word}? Its minutes count toward speed once the next update ships.`}
        </p>
        <div className="craft-field">
          <label htmlFor="craft-log-note">Note<span>optional</span></label>
          <textarea id="craft-log-note" rows={2} maxLength={2000} value={form.note} placeholder="e.g. tension felt tight" onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
        </div>
        <p className="craft-sheet-preview">
          {plan.rows.length ? `Saves ${rowsText(word, plan.rows)}` : `Saves the time only (no ${word}s)`}
          {plan.tick.length ? ` · ticks ${rowsText(word, plan.tick)}` : ""}
          {plan.untick.length ? ` · unticks ${rowsText(word, plan.untick)}` : ""}
          {plan.rows.length > plan.link.length ? ` · ${rowsText(word, plan.rows.filter((r) => !plan.link.includes(r)))} already in an earlier sitting` : ""}
        </p>
        <ErrorLine text={state.error} />
        <Actions busy={state.busy} onCancel={onClose} saveLabel="Save sitting" />
      </form>
    </Sheet>
  );
}

// ── Undo rows… ──────────────────────────────────────────────────────────────
export function UndoRowsSheet({ open, onClose, view, part, send }: { open: boolean; onClose: () => void; view: CraftView; part: Part; send: Send }) {
  const word = part.row_word as RowWord;
  const choices = undoChoices(view.row_states, part.total_rows);
  const [to, setTo] = useState<number | null>(choices[0] ?? null);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const plan = to === null ? null : fixCountPlan(view.row_states, part.total_rows, to);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (to === null) return;
    setState({ busy: true, error: null });
    const reply = await send("row", { part_id: part.id, mode: "undo", expected_row: part.current_row, to_row: to });
    if (!reply.ok) { setState({ busy: false, error: reply.error }); return; }
    onClose();
  }
  return (
    <Sheet open={open} onClose={onClose} title={`Undo ${word}s`}>
      <form onSubmit={submit}>
        {choices.length ? (
          <fieldset className="craft-choices">
            <legend>Go back to</legend>
            {choices.map((row) => (
              <label key={row} data-on={to === row ? "true" : undefined}>
                <input type="radio" name="craft-undo" value={row} checked={to === row} onChange={() => setTo(row)} />
                <span>{word === "round" ? "Round" : "Row"} {row}</span>
                <small>unticks {rowsText(word, fixCountPlan(view.row_states, part.total_rows, row).untick)}</small>
              </label>
            ))}
          </fieldset>
        ) : <p className="craft-sheet-hint">No ticked {word}s to undo.</p>}
        {plan && plan.linked.length > 0 && <p className="craft-sheet-hint">{rowsText(word, plan.linked)} {plan.linked.length === 1 ? "is" : "are"} in a saved sitting; the sitting stays as it is.</p>}
        <ErrorLine text={state.error} />
        <Actions busy={state.busy} onCancel={onClose} saveLabel="Undo" disabled={!plan || !plan.untick.length} />
      </form>
    </Sheet>
  );
}

// ── Fix count ───────────────────────────────────────────────────────────────
export function FixCountSheet({ open, onClose, view, part, send }: { open: boolean; onClose: () => void; view: CraftView; part: Part; send: Send }) {
  const word = part.row_word as RowWord;
  const [byRidges, setByRidges] = useState(false);
  const [value, setValue] = useState<number | null>(part.current_row);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const to = value === null ? null : byRidges ? rowFromRidgesDone(value) : value;
  const valid = to !== null && to >= 1 && to <= part.total_rows + 1;
  const plan = valid ? fixCountPlan(view.row_states, part.total_rows, to) : null;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!plan || (!plan.tick.length && !plan.untick.length)) return;
    setState({ busy: true, error: null });
    const reply = await send("row", { part_id: part.id, mode: "fix", expected_row: part.current_row, to_row: to });
    if (!reply.ok) { setState({ busy: false, error: reply.error }); return; }
    onClose();
  }
  return (
    <Sheet open={open} onClose={onClose} title="Fix count">
      <form onSubmit={submit}>
        <p className="craft-sheet-sub">A counting fix: nothing was ripped out, so speed is untouched. Now on {word} {part.current_row}.</p>
        {part.ridges && (
          <div className="craft-toggle" role="group" aria-label="Count by">
            <Button type="button" variant="toggle" size="sm" active={!byRidges} onClick={() => { setByRidges(false); setValue(part.current_row); }}>Row to work next</Button>
            <Button type="button" variant="toggle" size="sm" active={byRidges} onClick={() => { setByRidges(true); setValue(Math.floor((part.current_row - 1) / 2)); }}>Ridges done</Button>
          </div>
        )}
        <Stepper id="craft-fix-row" label={byRidges ? "Ridges done" : `${word === "round" ? "Round" : "Row"} to work next`} min={byRidges ? 0 : 1}
          max={byRidges ? Math.floor(part.total_rows / 2) : part.total_rows + 1} value={value} onChange={setValue}
          hint={byRidges && to !== null ? `= ${word} ${to} next` : undefined} />
        <p className="craft-sheet-preview">
          {!plan ? `Pick a ${word} from 1 to ${part.total_rows + 1}.`
            : plan.tick.length ? `Ticks ${rowsText(word, plan.tick)}. ${word === "round" ? "Round" : "Row"} ${plan.next} next.`
            : plan.untick.length ? `Unticks ${rowsText(word, plan.untick)}. ${word === "round" ? "Round" : "Row"} ${plan.next} next.`
            : "Nothing to change."}
        </p>
        <ErrorLine text={state.error} />
        <Actions busy={state.busy} onCancel={onClose} saveLabel="Save count" disabled={!plan || (!plan.tick.length && !plan.untick.length)} />
      </form>
    </Sheet>
  );
}

// ── Band close: "Count is 195?" ─────────────────────────────────────────────
export interface BandCheck { segment_id: string; name: string; count: number | null; count_source: "item" | "part" | null; item_text: string | null }
export function BandCloseSheet({ check, onClose, part, send }: { check: BandCheck | null; onClose: () => void; part: Part; send: Send }) {
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  if (!check) return null;
  async function confirm(event: FormEvent) {
    event.preventDefault();
    setState({ busy: true, error: null });
    const reply = await send("row", { part_id: part.id, mode: "close", segment_id: check!.segment_id });
    if (!reply.ok) { setState({ busy: false, error: reply.error }); return; }
    setState({ busy: false, error: null });
    onClose();
  }
  const count = check.count === null ? null : check.count.toLocaleString("en-US");
  return (
    <Sheet open title={`${check.name} is finished`} onClose={onClose}>
      <form onSubmit={confirm}>
        <p className="craft-check-q">{count ? `Count is ${count}?` : "Count the last row?"}</p>
        <p className="craft-sheet-hint">{check.count_source === "item" ? `From the band's step “${check.item_text}”.` : check.count_source === "part" ? `The part's stitch count (the band has no count step).` : "Neither the band nor the part has a stitch count."}</p>
        <p className="craft-sheet-sub">Confirm ticks the count step and marks {check.name} Done. Not now leaves the {part.row_word} ticked and the band open; the check stays on the screen.</p>
        <ErrorLine text={state.error} />
        <div className="craft-sheet-actions">
          <Button type="button" variant="secondary" size="lg" onClick={onClose} disabled={state.busy}>Not now</Button>
          <Button type="submit" variant="primary" size="lg" disabled={state.busy} aria-busy={state.busy || undefined}>{state.busy ? "Saving…" : count ? `${count} confirmed` : "Confirmed"}</Button>
        </div>
      </form>
    </Sheet>
  );
}

// ── Change total ───────────────────────────────────────────────────────────
export function ChangeTotalSheet({ open, onClose, view, part, send }: { open: boolean; onClose: () => void; view: CraftView; part: Part; send: Send }) {
  const word = part.row_word as RowWord;
  const [value, setValue] = useState<number | null>(part.total_rows);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const plan = value === null ? null : setTotalPlan(view.row_states, part.total_rows, value);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!plan || (plan.kind !== "add" && plan.kind !== "remove")) return;
    setState({ busy: true, error: null });
    const reply = await send("total", { part_id: part.id, total: value, expected_total: part.total_rows });
    if (!reply.ok) { setState({ busy: false, error: reply.error }); return; }
    onClose();
  }
  return (
    <Sheet open={open} onClose={onClose} title={`Change total ${word}s`}>
      <form onSubmit={submit}>
        <p className="craft-sheet-sub">{part.name}: {part.total_rows} {word}s now.</p>
        <Stepper id="craft-total" label={`Total ${word}s`} min={1} max={CRAFT_MAX_ROWS} value={value} onChange={setValue} />
        <p className={plan?.kind === "refused" ? "craft-sheet-warn" : "craft-sheet-preview"}>
          {!plan ? "Type a total." : plan.kind === "same" ? "Same as now." : plan.kind === "add" ? `Adds ${rowsText(word, plan.add)} at the end.`
            : plan.kind === "remove" ? `Removes ${rowsText(word, plan.remove)} (not ticked, in no sitting).` : setTotalRefusalText(word, plan)}
        </p>
        <ErrorLine text={state.error} />
        <Actions busy={state.busy} onCancel={onClose} saveLabel="Save total" disabled={!plan || (plan.kind !== "add" && plan.kind !== "remove")} />
      </form>
    </Sheet>
  );
}

// ── A note ──────────────────────────────────────────────────────────────────
export function NoteSheet({ open, onClose, part, send }: { open: boolean; onClose: () => void; part: Part | null; send: Send }) {
  const [text, setText] = useState("");
  const [onRow, setOnRow] = useState(Boolean(part && !part.finished));
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const rowLabel = part ? `${part.row_word === "round" ? "Round" : "Row"} ${part.current_row}` : null;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) { setState({ busy: false, error: "Type the note first." }); return; }
    setState({ busy: true, error: null });
    const reply = await send("notes", { text: text.trim(), ...(part ? { part_id: part.id } : {}), ...(part && onRow ? { row: part.current_row } : {}) });
    if (!reply.ok) { setState({ busy: false, error: reply.error }); return; }
    onClose();
  }
  return (
    <Sheet open={open} onClose={onClose} title="Add a note">
      <form onSubmit={submit}>
        {part && rowLabel && !part.finished && (
          <div className="craft-toggle" role="group" aria-label="Note on">
            <Button type="button" variant="toggle" size="sm" active={onRow} onClick={() => setOnRow(true)}>{rowLabel}</Button>
            <Button type="button" variant="toggle" size="sm" active={!onRow} onClick={() => setOnRow(false)}>{part.name}</Button>
          </div>
        )}
        <div className="craft-field">
          <label htmlFor="craft-note-text">Note<span>{text.length}/1000</span></label>
          <textarea id="craft-note-text" rows={3} maxLength={1000} value={text} placeholder="e.g. extra dc in the turning chain"
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(e as unknown as FormEvent); } }} />
        </div>
        <ErrorLine text={state.error} />
        <Actions busy={state.busy} onCancel={onClose} saveLabel="Save note" />
      </form>
    </Sheet>
  );
}

// ── The timer's fixes: ± minutes, stopped X min ago, discard ─────────────────
export function TimerFixSheet({ open, onClose, view, send }: { open: boolean; onClose: () => void; view: CraftView; send: Send }) {
  const timer = view.timer;
  const [ago, setAgo] = useState<number | null>(5);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  if (!timer) return null;
  const run = async (body: Record<string, unknown>, close = false) => {
    setState({ busy: true, error: null });
    const reply = await send("timer", { ...body, expected_version: timer.version });
    setState({ busy: false, error: reply.ok ? null : reply.error });
    if (reply.ok && close) onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="Fix the time">
      <form onSubmit={(event) => { event.preventDefault(); if (timer.running && ago) void run({ action: "stopped_ago", minutes: ago }, true); }}>
        <p className="craft-sheet-sub">The timer shows {clockText(timer.elapsed_seconds)}{timer.adjust_seconds ? ` (${timer.adjust_seconds > 0 ? "+" : "−"}${Math.abs(timer.adjust_seconds / 60)} min added by hand)` : ""}.</p>
        <div className="craft-adjust" role="group" aria-label="Add or take off minutes">
          {[-5, -1, 1, 5].map((m) => <Button key={m} type="button" variant="secondary" size="lg" disabled={state.busy} aria-label={m > 0 ? `Add ${m} min` : `Take off ${-m} min`} onClick={() => run({ action: "adjust", minutes: m })}>{m > 0 ? `+${m}` : `−${-m}`}</Button>)}
        </div>
        {timer.running ? (
          <>
            <Stepper id="craft-stopped-ago" label="Stopped how long ago?" hint="minutes" min={1} max={SITTING_MAX_MINUTES} value={ago} onChange={setAgo} />
            <div className="craft-sheet-actions craft-sheet-actions-one">
              <Button type="submit" variant="primary" size="lg" disabled={state.busy || !ago}>{`Stopped ${ago ?? "…"} min ago`}</Button>
            </div>
          </>
        ) : <p className="craft-sheet-hint">Paused{timer.paused_at ? ` at ${new Date(timer.paused_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}` : ""}. Use − to take off time you weren&apos;t crafting.</p>}
        <div className="craft-discard">
          {confirmDiscard ? (
            <>
              <p>Discard {clockText(timer.elapsed_seconds)}? It won&apos;t be saved anywhere.</p>
              <Button type="button" variant="secondary" size="md" onClick={() => setConfirmDiscard(false)} disabled={state.busy}>Keep it</Button>
              <Button type="button" variant="danger" size="md" onClick={() => run({ action: "discard" }, true)} disabled={state.busy}>Discard</Button>
            </>
          ) : <Button type="button" variant="ghost" size="md" onClick={() => setConfirmDiscard(true)}>Discard this timer…</Button>}
        </div>
        <ErrorLine text={state.error} />
      </form>
    </Sheet>
  );
}

// ── Another project's unsaved time ──────────────────────────────────────────
export interface OtherTimer { project_id: string; project_name: string; elapsed_seconds: number; version: number }
export function TimerConflictSheet({ other, onClose, onDiscardAndStart }: { other: OtherTimer | null; onClose: () => void; onDiscardAndStart: () => Promise<string | null> }) {
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  if (!other) return null;
  return (
    <Sheet open title="Another timer has time" onClose={onClose}>
      <p className="craft-check-q">{other.project_name}: {minutesText(other.elapsed_seconds / 60)} not saved</p>
      <p className="craft-sheet-sub">Save or discard it before starting here. One timer runs at a time.</p>
      <ErrorLine text={state.error} />
      <div className="craft-sheet-actions craft-sheet-actions-wrap">
        <Link href={`/craft/${other.project_id}`} className="craft-link-button">Open {other.project_name} to save it</Link>
        <Button type="button" variant="danger" size="lg" disabled={state.busy} onClick={async () => {
          setState({ busy: true, error: null });
          const error = await onDiscardAndStart();
          setState({ busy: false, error });
        }}>{state.busy ? "Working…" : `Discard its ${minutesText(other.elapsed_seconds / 60)} and start here`}</Button>
      </div>
    </Sheet>
  );
}

// ── Resuming on a later ET day ─────────────────────────────────────────────
export function NewDaySheet({ open, onClose, view, onSaveFirst, onKeepGoing }: {
  open: boolean; onClose: () => void; view: CraftView; onSaveFirst: () => void; onKeepGoing: () => Promise<string | null>;
}) {
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const timer = view.timer;
  if (!timer) return null;
  const day = new Date(timer.sitting_started_at).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "America/New_York" });
  return (
    <Sheet open={open} onClose={onClose} title="New day">
      <p className="craft-check-q">This sitting started {day}.</p>
      <p className="craft-sheet-sub">Save its {minutesText(timer.elapsed_seconds / 60)} as that day&apos;s sitting and start a new timer for today, so each day has its own time.</p>
      <ErrorLine text={state.error} />
      <div className="craft-sheet-actions craft-sheet-actions-wrap">
        <Button type="button" variant="secondary" size="lg" disabled={state.busy} onClick={async () => {
          setState({ busy: true, error: null });
          const error = await onKeepGoing();
          setState({ busy: false, error });
        }}>Keep it as one sitting</Button>
        <Button type="button" variant="primary" size="lg" disabled={state.busy} onClick={onSaveFirst}>Save it, then start today</Button>
      </div>
    </Sheet>
  );
}
