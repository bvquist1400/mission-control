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
import { RIP_CHOICES } from "@/lib/craft";
import {
  CRAFT_MAX_ROWS, SITTING_MAX_MINUTES, addedRowsText, clockText, fixCountPlan, frogBody, frogPlan, keepsText, logSittingBody, logSittingDefaults, minutesText,
  newIdempotencyKey, partwayDefault, partwayRow, quarterText, retakeLogForm, rowFromRidgesDone, rowsText, setTotalPlan, setTotalRefusalText, sheetChangeText,
  sheetFactsOf, sittingCountText, sittingPlan, sittingSummary, timerMinutes, undoChoices, wordTitle, type LogForm, type RowWord, type SheetFacts,
} from "@/lib/craft/actions";

export type Send = (kind: "row" | "timer" | "sittings" | "total" | "notes" | "frog", body: Record<string, unknown>, method?: "POST" | "DELETE") => Promise<SendReply>;
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
/**
 * The sheet's foot, sticky at the bottom of the sheet (FR1, Fable: at 360 px the "Saves…" line sat
 * out of view above Save): the changed-underneath line, what Save will do, a failure, then the buttons.
 */
function Foot({ changed, summary, summaryWarn, error, ...actions }: { changed: string | null; summary: ReactNode; summaryWarn?: boolean; error: string | null;
  busy: boolean; onCancel: () => void; saveLabel: string; disabled?: boolean }) {
  return (
    <div className="craft-sheet-foot">
      {changed && <p className="craft-sheet-warn craft-sheet-changed" role="status">{changed}</p>}
      {summary !== null && summary !== undefined && <p className={summaryWarn ? "craft-sheet-warn" : "craft-sheet-preview"}>{summary}</p>}
      <ErrorLine text={error} />
      <Actions {...actions} />
    </div>
  );
}

/**
 * FR1 (Astra 1): a sheet sends what it showed when it opened (part, expected row, total, timer
 * version), never what a later refresh brought. When those changed underneath, the sheet says so and
 * its button only takes the new count; a second tap saves. 073's guards refuse a stale body anyway.
 */
function useSheetSnapshot(view: CraftView, part: Part, use: { timer?: boolean; total?: boolean } = {}) {
  const [snap, setSnap] = useState(() => ({ view, part }));
  const [notice, setNotice] = useState<string | null>(null);
  const before = sheetFactsOf(snap.view) as SheetFacts;
  const changed = sheetChangeText(before, sheetFactsOf(view), use);
  return {
    snap, changed, notice: changed ?? notice,
    /** Takes the live count; true when the sheet had to (the tap must not save). */
    retake(): boolean {
      if (!changed) { setNotice(null); return false; }
      setSnap({ view, part });
      setNotice(changed);
      return true;
    },
  };
}
const CHANGED_LABEL = "Use the new count";
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
function logForm(view: CraftView, part: Part): LogForm {
  const d = logSittingDefaults(view.row_states, part.total_rows, view.timer);
  const partway = partwayDefault(view.row_states, part.total_rows, d, view.timer, view.server_now, view.timer_last_done_at);
  return { minutes: d.minutes, minutesTouched: false, from: d.from, to: d.to, quarter: 0, note: "", key: newIdempotencyKey(), partway, partwayTouched: false };
}
export function LogSittingSheet({ open, onClose, view: live, part: livePart, send, thenStart, onSaved }: {
  open: boolean; onClose: () => void; view: CraftView; part: Part; send: Send; thenStart?: boolean; onSaved: (reply: SendReply) => void;
}) {
  const { snap, changed, notice, retake } = useSheetSnapshot(live, livePart, { timer: true });
  const { view, part } = snap;
  const word = part.row_word as RowWord;
  const timer = view.timer;
  const [form, setForm] = useState(() => logForm(view, part));
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const plan = sittingPlan(view.row_states, part.total_rows, form.from, form.to);
  // The clock keeps moving while the sheet is open: show the live timer while it is the one captured.
  const shownTimer = timer && live.timer && live.timer.version === timer.version ? live.timer : timer;
  const timerMin = shownTimer ? Math.min(SITTING_MAX_MINUTES, timerMinutes(shownTimer.elapsed_seconds)) : null;
  const shownMinutes = form.minutesTouched || !timer ? form.minutes : timerMin;
  const nextRow = form.to + 1;
  const other = timer && !timer.on_active_part ? view.timer_rows : [];
  // S3: the row this sitting is partway through (the next row after "last full row"); a quarter is always partway.
  const partRow = partwayRow(view.row_states, part.total_rows, form.to);
  // Until it is tapped, the toggle follows the default for the rows now chosen.
  const partwayOn = form.partwayTouched ? form.partway
    : partwayDefault(view.row_states, part.total_rows, form, view.timer, view.server_now, view.timer_last_done_at);
  const partway = partRow !== null && (partwayOn || form.quarter > 0);
  async function submit(event: FormEvent) {
    event.preventDefault();
    // F6: the new count's rows, but the typed note and minutes stay.
    if (retake()) { setForm((f) => retakeLogForm(f, logForm(live, livePart))); setState({ busy: false, error: null }); return; }
    if (shownMinutes === null || shownMinutes < 1) { setState({ busy: false, error: "Type the minutes (at least 1)." }); return; }
    setState({ busy: true, error: null });
    // The captured part, expected row and timer version (never the refreshed ones).
    const reply = await send("sittings", logSittingBody(part, timer, { ...form, partway }, shownMinutes));
    if (!reply.ok) { setState({ busy: false, error: reply.error }); return; }
    setState({ busy: false, error: null });
    onSaved(reply);
  }
  return (
    <Sheet open={open} onClose={onClose} title="Log sitting">
      <form onSubmit={submit}>
        <p className="craft-sheet-sub">{view.project.name} · {part.name}{thenStart ? " · then a new timer for today" : ""}</p>
        <Stepper id="craft-log-minutes" label="Minutes" step={5} min={1} max={SITTING_MAX_MINUTES} value={shownMinutes}
          hint={shownTimer ? `from the timer (${clockText(shownTimer.elapsed_seconds)})` : "no timer: type them"}
          onChange={(value) => setForm((f) => ({ ...f, minutes: value, minutesTouched: true }))} />
        {timer?.over_cap && <p className="craft-sheet-warn">The timer shows {minutesText(timer.elapsed_seconds / 60)}. A sitting can be at most 24 hours (1,440 min): type the minutes you worked.</p>}
        {!timer && <Stepper id="craft-log-from" label={`Last full ${word} before this sitting`} min={0} max={form.to} value={form.from}
          hint={form.from === 0 ? "started at the beginning" : undefined} onChange={(value) => setForm((f) => ({ ...f, from: value ?? 0 }))} />}
        <Stepper id="craft-log-to" label={`Last full ${word} finished`} min={form.from} max={part.total_rows} value={form.to}
          hint={sittingCountText(word, form.from, form.to, other)} onChange={(value) => setForm((f) => ({ ...f, to: value ?? f.from, quarter: 0 }))} />
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
        {partRow !== null ? (
          <label className="craft-partway" data-on={partway ? "true" : undefined}>
            <input type="checkbox" checked={partway} disabled={form.quarter > 0}
              onChange={(e) => setForm((f) => ({ ...f, partway: e.target.checked, partwayTouched: true }))} />
            <span>Partway through {word} {partRow}</span>
            <small>{form.quarter > 0 ? `A part of ${word} ${nextRow} is partway.` : partway ? `Its minutes count with ${word} ${partRow}; it is ticked when you finish it.` : `Off: the minutes go with the ${word}s finished.`}</small>
          </label>
        ) : null}
        <div className="craft-field">
          <label htmlFor="craft-log-note">Note<span>optional</span></label>
          <textarea id="craft-log-note" rows={2} maxLength={2000} value={form.note} placeholder="e.g. tension felt tight" onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
        </div>
        <Foot changed={notice} summary={sittingSummary(word, part.name, plan, other, shownMinutes, partway ? partRow : null)} error={state.error}
          busy={state.busy} onCancel={onClose} saveLabel={changed ? CHANGED_LABEL : "Save sitting"} />
      </form>
    </Sheet>
  );
}

// ── Undo rows… and Ripped back ───────────────────────────────────────────────
/**
 * Two different fixes in one sheet (S3): "Wrong count" unticks rows that weren't done (a counting
 * slip: sittings and speed untouched, like Fix count); "Ripped back" is for rows pulled out (074's
 * craft_frog: rows unticked, their links removed from their sittings, sittings left out of speed).
 */
export function UndoRowsSheet({ open, onClose, view: live, part: livePart, send, initialTo, initialMode = "undo", onRipped }: {
  open: boolean; onClose: () => void; view: CraftView; part: Part; send: Send; initialTo?: number; initialMode?: "undo" | "rip"; onRipped?: (reply: SendReply) => void;
}) {
  const { snap, changed, notice, retake } = useSheetSnapshot(live, livePart);
  const { view, part } = snap;
  const word = part.row_word as RowWord;
  const [mode, setMode] = useState<"undo" | "rip">(initialMode);
  const choices = undoChoices(view.row_states, part.total_rows);
  const [to, setTo] = useState<number | null>(initialTo !== undefined && choices.includes(initialTo) ? initialTo : choices[0] ?? null);
  const ripChoices = undoChoices(view.row_states, part.total_rows, RIP_CHOICES);
  const [ripFrom, setRipFrom] = useState<number | null>(initialTo !== undefined && ripChoices.includes(initialTo) ? initialTo : ripChoices[0] ?? null);
  const [exclude, setExclude] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const plan = to === null ? null : fixCountPlan(view.row_states, part.total_rows, to);
  const ripMin = ripChoices.length ? Math.min(...ripChoices) : null;
  const ripMax = ripChoices.length ? Math.max(...ripChoices) : null;
  const frog = ripFrom === null ? null : frogPlan(view.row_states, part.total_rows, part.id, view.rip_sittings, ripFrom);
  const leftOut = frog ? frog.all.length + frog.partly.filter((s) => exclude.includes(s.id)).length : 0;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (retake()) {
      const next = undoChoices(live.row_states, livePart.total_rows);
      setTo(to !== null && next.includes(to) ? to : next[0] ?? null);
      const nextRip = undoChoices(live.row_states, livePart.total_rows, RIP_CHOICES);
      setRipFrom(ripFrom !== null && nextRip.includes(ripFrom) ? ripFrom : nextRip[0] ?? null);
      setExclude([]); setKey(newIdempotencyKey());
      setState({ busy: false, error: null });
      return;
    }
    if (mode === "rip") {
      if (!frog || !frog.ripped.length) return;
      setState({ busy: true, error: null });
      const reply = await send("frog", frogBody(part, frog, { note, key, exclude }));
      if (!reply.ok) { setState({ busy: false, error: reply.error }); return; }
      onRipped?.(reply);
      onClose();
      return;
    }
    if (to === null) return;
    setState({ busy: true, error: null });
    const reply = await send("row", { part_id: part.id, mode: "undo", expected_row: part.current_row, to_row: to });
    if (!reply.ok) { setState({ busy: false, error: reply.error }); return; }
    onClose();
  }
  const sittingLine = (s: { date: string; minutes: number }) => `${shortDate(s.date)} · ${minutesText(s.minutes)}`;
  const ripSummary = !frog || !frog.ripped.length ? null
    : `Unticks ${rowsText(word, frog.ripped)}${frog.partway !== null ? ` and takes the part of ${word} ${frog.partway} out of its sitting` : ""}. `
      + `${leftOut ? `${leftOut} ${leftOut === 1 ? "sitting" : "sittings"} left out of speed. ` : "Speed: no sitting left out. "}${wordTitle(word)} ${frog.from} next.`;
  return (
    <Sheet open={open} onClose={onClose} title={mode === "rip" ? "Ripped back" : `Undo ${word}s`}>
      <form onSubmit={submit}>
        <div className="craft-toggle craft-undo-kind" role="group" aria-label="What happened">
          <Button type="button" variant="toggle" size="sm" active={mode === "undo"} onClick={() => { setMode("undo"); setState({ busy: false, error: null }); }}>Wrong count</Button>
          <Button type="button" variant="toggle" size="sm" active={mode === "rip"} onClick={() => { setMode("rip"); setState({ busy: false, error: null }); }}>Ripped back</Button>
        </div>
        {mode === "undo" ? (
          <>
            <p className="craft-sheet-sub">Ticked by mistake? This unticks them. Sittings and speed stay as they are (like Fix count).</p>
            {choices.length ? (
              <fieldset className="craft-choices">
                <legend>Go back to</legend>
                {choices.map((row) => (
                  <label key={row} data-on={to === row ? "true" : undefined}>
                    <input type="radio" name="craft-undo" value={row} checked={to === row} onChange={() => setTo(row)} />
                    <span>{wordTitle(word)} {row}</span>
                    <small>unticks {rowsText(word, fixCountPlan(view.row_states, part.total_rows, row).untick)}</small>
                  </label>
                ))}
              </fieldset>
            ) : <p className="craft-sheet-hint">No ticked {word}s to undo.</p>}
            {plan && plan.linked.length > 0 && <p className="craft-sheet-hint">{rowsText(word, plan.linked)} {plan.linked.length === 1 ? "is" : "are"} in a saved sitting; the sitting stays as it is.</p>}
          </>
        ) : (
          <>
            <p className="craft-sheet-sub">Pulled these {word}s out? They are unticked and their time is left out of speed. The minutes stay in your daily time.</p>
            {ripMin !== null && ripMax !== null && ripFrom !== null ? (
              <Stepper id="craft-rip-from" label={`First ${word} pulled out`} min={ripMin} max={ripMax} value={ripFrom}
                hint={frog && frog.ripped.length ? `rips ${rowsText(word, frog.ripped)} (up to ${word} ${frog.to})` : undefined}
                onChange={(value) => { setRipFrom(value === null ? ripMax : value); setExclude([]); }} />
            ) : <p className="craft-sheet-hint">No ticked {word}s to rip back.</p>}
            {frog && frog.ripped.length > 0 && (
              <div className="craft-rip">
                {frog.all.length > 0 && (
                  <section aria-label="Left out of speed">
                    <h3>Left out of speed (every {word} in them ripped)</h3>
                    <ul>{frog.all.map((s) => <li key={s.id}>{sittingLine(s)}</li>)}</ul>
                  </section>
                )}
                {frog.partly.length > 0 && (
                  <fieldset className="craft-rip-partly">
                    <legend>Partly ripped: tick to leave out of speed too</legend>
                    {frog.partly.map((s) => (
                      <label key={s.id} data-on={exclude.includes(s.id) ? "true" : undefined}>
                        <input type="checkbox" checked={exclude.includes(s.id)}
                          onChange={(e) => setExclude((ids) => (e.target.checked ? [...ids, s.id] : ids.filter((id) => id !== s.id)))} />
                        <span>{sittingLine(s)}</span>
                        <small>{keepsText(word, part.id, s.keeps)}</small>
                      </label>
                    ))}
                  </fieldset>
                )}
                {frog.already.length > 0 && (
                  <section aria-label="Already left out">
                    <h3>Already left out of speed</h3>
                    <ul>{frog.already.map((s) => <li key={s.id}>{sittingLine(s)}{s.exclude_reason ? ` · ${s.exclude_reason}` : ""}</li>)}</ul>
                  </section>
                )}
                {!frog.all.length && !frog.partly.length && !frog.already.length && <p className="craft-sheet-hint">No saved sitting has these {word}s, so speed doesn&apos;t change.</p>}
              </div>
            )}
            <div className="craft-field">
              <label htmlFor="craft-rip-note">Note<span>optional</span></label>
              <textarea id="craft-rip-note" rows={2} maxLength={1000} value={note} placeholder="e.g. dropped a stitch at row 58" onChange={(e) => setNote(e.target.value)} />
            </div>
            <p className="craft-sheet-hint">There is no un-rip: to put {word}s back, use Fix count.</p>
          </>
        )}
        <Foot changed={notice} error={state.error}
          summary={mode === "rip" ? ripSummary : plan && plan.untick.length ? `Unticks ${rowsText(word, plan.untick)}. ${wordTitle(word)} ${plan.next} next.` : null}
          busy={state.busy} onCancel={onClose} saveLabel={changed ? CHANGED_LABEL : mode === "rip" ? "Rip back" : "Undo"}
          disabled={!changed && (mode === "rip" ? !frog || !frog.ripped.length : !plan || !plan.untick.length)} />
      </form>
    </Sheet>
  );
}
/** "Nov 12" from YYYY-MM-DD (an ET date, no clock). */
function shortDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// ── Fix count ───────────────────────────────────────────────────────────────
export function FixCountSheet({ open, onClose, view: live, part: livePart, send }: { open: boolean; onClose: () => void; view: CraftView; part: Part; send: Send }) {
  const { snap, changed, notice, retake } = useSheetSnapshot(live, livePart);
  const { view, part } = snap;
  const word = part.row_word as RowWord;
  const [byRidges, setByRidges] = useState(false);
  const [value, setValue] = useState<number | null>(part.current_row);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const to = value === null ? null : byRidges ? rowFromRidgesDone(value) : value;
  const valid = to !== null && to >= 1 && to <= part.total_rows + 1;
  const plan = valid ? fixCountPlan(view.row_states, part.total_rows, to) : null;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (retake()) { setByRidges(false); setValue(livePart.current_row); setState({ busy: false, error: null }); return; }
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
        <Foot changed={notice} error={state.error}
          summary={!plan ? `Pick a ${word} from 1 to ${part.total_rows + 1}.`
            : plan.tick.length ? `Ticks ${rowsText(word, plan.tick)}. ${wordTitle(word)} ${plan.next} next.`
            : plan.untick.length ? `Unticks ${rowsText(word, plan.untick)}. ${wordTitle(word)} ${plan.next} next.`
            : "Nothing to change."}
          busy={state.busy} onCancel={onClose} saveLabel={changed ? CHANGED_LABEL : "Save count"} disabled={!changed && (!plan || (!plan.tick.length && !plan.untick.length))} />
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
export function ChangeTotalSheet({ open, onClose, view: live, part: livePart, send }: { open: boolean; onClose: () => void; view: CraftView; part: Part; send: Send }) {
  const { snap, changed, notice, retake } = useSheetSnapshot(live, livePart, { total: true });
  const { view, part } = snap;
  const word = part.row_word as RowWord;
  const [value, setValue] = useState<number | null>(part.total_rows);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const plan = value === null ? null : setTotalPlan(view.row_states, part.total_rows, value);
  const adds = plan?.kind === "add" ? addedRowsText(word, view.row_states, part.stitch_count) : null;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (retake()) { setValue(livePart.total_rows); setState({ busy: false, error: null }); return; }
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
        <Foot changed={notice} error={state.error} summaryWarn={plan?.kind === "refused"}
          summary={!plan ? "Type a total." : plan.kind === "same" ? "Same as now." : plan.kind === "add" ? `Adds ${rowsText(word, plan.add)} at the end.${adds ? ` ${adds}` : ""}`
            : plan.kind === "remove" ? `Removes ${rowsText(word, plan.remove)} (not ticked, in no sitting).` : setTotalRefusalText(word, plan)}
          busy={state.busy} onCancel={onClose} saveLabel={changed ? CHANGED_LABEL : "Save total"} disabled={!changed && (!plan || (plan.kind !== "add" && plan.kind !== "remove"))} />
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
