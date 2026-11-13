"use client";
/**
 * The craft screen's sheets (S2): Log sitting, Undo rows, Fix count, band close, Change total, a note, the timer's
 * fixes, the timer conflict and the new-day question. Each shows what it will change before saving, saves through
 * the screen's `send` (one 073 call; the reply carries the fresh view), and Enter saves (a form submit).
 */
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Input, Select } from "@/components/ui/Field";
import type { CraftView } from "@/lib/craft";
import { RIP_CHOICES, checkBeforeText, earlierStepsText, partRowsOf, trailingStepsOf } from "@/lib/craft";
import {
  CRAFT_MAX_ROWS, SITTING_MAX_MINUTES, clockText, fixCountPlan, frogBody, frogPlan, keepsText, logSittingBody, logSittingDefaults, minutesText,
  newIdempotencyKey, partwayDefault, partwayRow, quarterText, retakeLogForm, rowFromRidgesDone, rowsText, setTotalPlan, setTotalRefusalText, sheetChangeText,
  sheetFactsOf, sittingCountText, sittingPlan, sittingSummary, timerMinutes, undoChoices, wordTitle, type LogForm, type RowWord, type SheetFacts,
  estRange, raiseDefaults, raiseSummary, renumberText, rowLabelOf, runsText, takeBackPlan, takeBackRowsText, totalForLastEst,
} from "@/lib/craft/actions";

export type Send = (kind: "row" | "timer" | "sittings" | "total" | "notes" | "frog" | "check" | "part", body: Record<string, unknown>, method?: "POST" | "DELETE") => Promise<SendReply>;
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
function Foot({ changed, hint, summary, summaryWarn, error, ...actions }: { changed: string | null; hint?: string | null; summary: ReactNode; summaryWarn?: boolean; error: string | null;
  busy: boolean; onCancel: () => void; saveLabel: string; disabled?: boolean }) {
  return (
    <div className="craft-sheet-foot">
      {changed && <p className="craft-sheet-warn craft-sheet-changed" role="status">{changed}</p>}
      {hint && <p className="craft-sheet-hint craft-rip-after">{hint}</p>}
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
                hint={frog && frog.ripped.length ? `rips ${rowsText(word, frog.ripped)}` : undefined}
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
          </>
        )}
        <Foot changed={notice} error={state.error}
          hint={mode === "rip" ? `Fix count puts the ${word}s back; the sittings stay left out of speed.` : null}
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
/**
 * Change total rows/rounds for any part, finished ones too (FR3: from the Parts list as well as the menu). Lowering
 * drops only unticked "(est.)" (or blank) rows and renumbers the rows after them; with "(est.)" rows the sheet can
 * set "Last (est.) round needed" and the total follows. FR4: it always opens on the part's own total (no change; Save
 * waits for one). Raising never prefills: the text starts empty and Save waits for text or a deliberate "Same as
 * round N"; the work type starts on the last non-(est.) row's; with a step right after the last row it asks whether
 * the new rows go before or after it. Lowering can take back the last rows whatever their text (rows a raise added by
 * mistake) only after naming them and asking a second time.
 */
export function ChangeTotalSheet({ open, onClose, view: live, part: livePart, send, initial }: { open: boolean; onClose: () => void; view: CraftView; part: CraftView["parts"][number]; send: Send;
  /** A starting state (screenshots and tests): total, text, work type, where raised rows go, the take-back question open, the mode. */
  initial?: { total?: number; text?: string; type?: string; place?: "after_row" | "after_steps"; takeBack?: boolean; mode?: "est" | "total"; lastEst?: number } }) {
  const [snap, setSnap] = useState(() => ({ view: live, part: livePart }));
  const { view, part } = snap;
  const word = part.row_word as RowWord;
  const nowPart = live.parts.find((entry) => entry.id === part.id) ?? null;
  const changed = !nowPart ? "This part changed on another screen. Close this and check the count."
    : nowPart.total_rows !== part.total_rows ? `Your total changed on another screen (now ${nowPart.total_rows} ${word}s). Check and save again.` : null;
  const rows = useMemo(() => partRowsOf(view, part.id), [view, part.id]);
  const label = rowLabelOf(rows, word);
  const last = rows.length ? rows[rows.length - 1] : null;
  const est = estRange(rows, part.total_rows);
  const defaults = raiseDefaults(rows);
  const steps = useMemo(() => trailingStepsOf(view, part.id), [view, part.id]);
  const [mode, setMode] = useState<"est" | "total">(est && initial?.mode === "est" ? "est" : "total");
  const [value, setValue] = useState<number | null>(initial?.total ?? part.total_rows);
  const [lastEst, setLastEst] = useState<{ value: number | null; touched: boolean }>({ value: initial?.lastEst ?? est?.max ?? null, touched: initial?.lastEst !== undefined });
  const [text, setText] = useState<{ value: string; same: boolean }>({ value: initial?.text ?? "", same: false });
  const [type, setType] = useState(initial?.type ?? defaults.type ?? "");
  const [place, setPlace] = useState<"after_row" | "after_steps" | null>(initial?.place ?? null);
  const [asked, setAsked] = useState<number | null>(initial?.takeBack ? initial.total ?? null : null);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  // FR4 (Fable 4): no change until something is changed (the "(est.)" stepper counts once it is used).
  const target = mode === "est" && est ? (lastEst.touched && lastEst.value !== null ? totalForLastEst(rows, part.total_rows, lastEst.value) : part.total_rows) : value;
  const plan = target === null ? null : setTotalPlan(rows, part.total_rows, target);
  const takeBack = target === null ? null : takeBackPlan(rows, part.total_rows, target);
  const asking = asked !== null && asked === target && takeBack?.kind === "remove";
  const types = [...new Set([...(view.work_types ?? []), ...(defaults.type ? [defaults.type] : [])])].sort();
  const onScreen = view.active_part?.id === part.id;
  const typed = text.value.trim();
  const textOk = typed !== "" || text.same;
  const placeOk = !steps.length || place !== null;
  async function save(how: "take_back" | null) {
    if (changed) {
      if (!nowPart) { onClose(); return; }
      setSnap({ view: live, part: nowPart }); setValue(nowPart.total_rows); setAsked(null); setState({ busy: false, error: null }); return;
    }
    if (!plan) return;
    if (how === "take_back") { if (takeBack?.kind !== "remove") return; }
    else if (plan.kind === "add") { if (!textOk || !placeOk) return; }
    else if (plan.kind !== "remove") return;
    setState({ busy: true, error: null });
    const reply = await send("total", { part_id: part.id, total: target, expected_total: part.total_rows,
      ...(plan.kind === "add" ? { text: typed || null, work_type: type || null, ...(steps.length && place ? { how: place } : {}) } : {}),
      ...(how ? { how } : {}) });
    if (!reply.ok) { setState({ busy: false, error: reply.error }); return; }
    onClose();
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void save(asking ? "take_back" : null);
  }
  // 074: added rows get the part's stitch count, else the last row's units.
  const units = part.stitch_count ?? last?.units ?? null;
  const addLine = plan?.kind !== "add" ? null
    : !textOk ? `Type the pattern text for the new ${word}s${defaults.same ? `, or pick “Same as ${word} ${defaults.same.row}”` : ""}.`
    : !placeOk ? `Pick where the new ${word}s go: before or after ${steps.length === 1 ? "the step" : "the steps"} after ${label} ${last?.row}.`
    : raiseSummary({ label, add: plan.add, lastRow: last?.row ?? null, text: typed, type, units, onScreen, steps, place });
  const canSave = Boolean(plan && (plan.kind === "remove" || (plan.kind === "add" && textOk && placeOk)));
  return (
    <Sheet open={open} onClose={onClose} title={`Change total ${word}s`}>
      <form onSubmit={submit} className="craft-total-form">
        <p className="craft-sheet-sub">{part.name}: {part.total_rows} {word}s now{part.finished ? ", all ticked" : `, on ${word} ${part.current_row}`}. Only unticked (est.) {word}s can be dropped; the {word}s after them move up to close the gap.</p>
        {est && (
          <div className="craft-toggle craft-total-mode" role="group" aria-label="Set by">
            <Button type="button" variant="toggle" size="sm" active={mode === "total"} onClick={() => setMode("total")}>Total {word}s</Button>
            <Button type="button" variant="toggle" size="sm" active={mode === "est"} onClick={() => setMode("est")}>Last (est.) {word} needed</Button>
          </div>
        )}
        {mode === "est" && est
          ? <Stepper id="craft-total-est" label={`Last (est.) ${word} needed`} hint={target !== null ? `total ${target}` : undefined} min={est.min} max={est.max} value={lastEst.value} onChange={(v) => setLastEst({ value: v, touched: true })} />
          : <Stepper id="craft-total" label={`Total ${word}s`} min={1} max={CRAFT_MAX_ROWS} value={value} onChange={setValue} />}
        {plan?.kind === "add" && (
          <>
            <div className="craft-field">
              <label htmlFor="craft-total-text">Pattern text for the new {word}s</label>
              <Input id="craft-total-text" value={text.value} maxLength={200} placeholder="e.g. knit (US 7)" onChange={(e) => setText({ value: e.target.value, same: false })} />
              {defaults.same && (
                <div className="craft-toggle craft-total-same">
                  <Button type="button" variant="toggle" size="sm" active={text.same}
                    onClick={() => setText({ value: defaults.same?.text ?? "", same: true })}>Same as {word} {defaults.same.row}: {defaults.same.text || "just the label"}</Button>
                </div>
              )}
            </div>
            <div className="craft-field">
              <label htmlFor="craft-total-type">Work type</label>
              <Select id="craft-total-type" value={type} onChange={(e) => setType(e.target.value)}>
                {!types.includes(type) && <option value={type}>{type || "none"}</option>}
                {types.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
              </Select>
            </div>
            {steps.length > 0 && (
              <div className="craft-field craft-total-place">
                <p className="craft-total-step">After {label} {last?.row} comes {steps.length === 1 ? "the step" : "the steps"} {steps.map((step) => `“${step.text}”`).join(" and ")}.</p>
                <div className="craft-toggle" role="group" aria-label={`Where the new ${word}s go`}>
                  <Button type="button" variant="toggle" size="sm" active={place === "after_row"} onClick={() => setPlace("after_row")}>New {word}s before it</Button>
                  <Button type="button" variant="toggle" size="sm" active={place === "after_steps"} onClick={() => setPlace("after_steps")}>New {word}s after it</Button>
                </div>
              </div>
            )}
          </>
        )}
        {asking && takeBack?.kind === "remove" ? (
          <div className="craft-sheet-foot craft-take-back" role="group" aria-label="Take back">
            {changed && <p className="craft-sheet-warn craft-sheet-changed" role="status">{changed}</p>}
            <p className="craft-check-q">Also remove {takeBackRowsText(word, rows, takeBack.remove)}?</p>
            <p className="craft-sheet-sub">They are unticked and in no sitting, but they are not (est.) {word}s: their text goes with them. New total {takeBack.total}.</p>
            <ErrorLine text={state.error} />
            <div className="craft-sheet-actions">
              <Button type="button" variant="secondary" size="lg" onClick={() => setAsked(null)} disabled={state.busy}>Keep them</Button>
              <Button type="submit" variant="danger" size="lg" disabled={state.busy} aria-busy={state.busy || undefined}>{state.busy ? "Saving…" : changed ? CHANGED_LABEL : "Yes, remove them"}</Button>
            </div>
          </div>
        ) : (
          <>
            {takeBack?.kind === "remove" && (
              <p className="craft-take-back-offer">
                <Button type="button" variant="ghost" size="sm" onClick={() => setAsked(target)}>Remove the last {takeBack.remove.length === 1 ? word : `${takeBack.remove.length} ${word}s`} instead ({label} {runsText(takeBack.remove)})…</Button>
              </p>
            )}
            <Foot changed={changed} error={state.error} summaryWarn={plan?.kind === "refused"}
              summary={!plan ? "Type a number." : plan.kind === "same" ? "Same as now." : plan.kind === "add" ? addLine
                : plan.kind === "remove" ? renumberText(word, rows, plan) : setTotalRefusalText(word, plan)}
              busy={state.busy} onCancel={onClose} saveLabel={changed ? CHANGED_LABEL : "Save total"} disabled={!changed && !canSave} />
          </>
        )}
      </form>
    </Sheet>
  );
}

// ── Parts (FR3): work on another part, change any part's total ──────────────
export function PartsSheet({ open, onClose, view, send, onChangeTotal }: { open: boolean; onClose: () => void; view: CraftView; send: Send; onChangeTotal: (partId: string) => void }) {
  const [state, setState] = useState<{ busy: string | null; error: string | null }>({ busy: null, error: null });
  async function pick(partId: string) {
    setState({ busy: partId, error: null });
    const reply = await send("part", { part_id: partId, expected_part_id: view.active_part?.id ?? null });
    if (!reply.ok) { setState({ busy: null, error: reply.error }); return; }
    setState({ busy: null, error: null });
    onClose();
  }
  return (
    <Sheet open={open} onClose={onClose} title="Parts">
      <PartsList view={view} busy={state.busy} onPick={pick} onChangeTotal={onChangeTotal} />
      <ErrorLine text={state.error} />
      <div className="craft-sheet-actions craft-sheet-actions-one"><Button type="button" variant="secondary" size="lg" onClick={onClose}>Close</Button></div>
    </Sheet>
  );
}
/** The parts with "Work on this part" and "Change total…" (the Parts sheet and the inside screen's Parts list). */
export function PartsList({ view, busy, onPick, onChangeTotal }: { view: CraftView; busy: string | null; onPick: (partId: string) => void; onChangeTotal: (partId: string) => void }) {
  return (
    <ul className="craft-parts craft-parts-act">{view.parts.map((entry) => {
      const here = entry.id === view.active_part?.id;
      return (
        <li key={entry.id} aria-current={here ? "true" : undefined}><strong>{entry.name}</strong><span>{entry.row_label}{here ? " · on the screen" : ""}</span>
          <div className="craft-part-buttons">
            {!here && !entry.finished && <Button type="button" variant="secondary" size="sm" disabled={busy !== null} aria-busy={busy === entry.id || undefined}
              aria-label={`Work on this part: ${entry.name}`} onClick={() => onPick(entry.id)}>{busy === entry.id ? "Saving…" : "Work on this part"}</Button>}
            <Button type="button" variant="ghost" size="sm" disabled={busy !== null} aria-label={`Change total: ${entry.name}`} onClick={() => onChangeTotal(entry.id)}>Change total…</Button>
          </div>
        </li>
      );
    })}</ul>
  );
}

// ── Row done with a check showing (FR3) ─────────────────────────────────────
/**
 * Row done while a check at the current row shows (FR3, FR4): Yes ticks the check(s), then the row; Not yet ticks
 * only the row (Brent can carry on) and the check stays, listed under "earlier steps not ticked"; × closes with
 * nothing saved.
 */
export function CheckFirstSheet({ checks, onClose, onYes, onNotYet }: { checks: CraftView["due_checks"]; onClose: () => void; onYes: () => Promise<string | null>; onNotYet: () => void }) {
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  if (!checks.length) return null;
  async function yes(event: FormEvent) {
    event.preventDefault();
    setState({ busy: true, error: null });
    const error = await onYes();
    setState({ busy: false, error });
  }
  const rowWord = checks[0].row_word, row = checks[0].row;
  return (
    <Sheet open title="Not done yet" onClose={onClose}>
      <form onSubmit={yes}>
        <ul className="craft-check-list">{checks.map((check) => <li key={check.id}><small>{checkBeforeText(check)}</small><p>{check.text}</p></li>)}</ul>
        <p className="craft-check-q">Done {checks.length === 1 ? "it" : "them"}?</p>
        <p className="craft-sheet-sub">Yes ticks {checks.length === 1 ? "the step" : "the steps"}, then {rowWord} {row}. Not yet ticks {rowWord} {row} only; {checks.length === 1 ? "the step stays" : "the steps stay"} on the list of earlier steps not ticked.</p>
        <ErrorLine text={state.error} />
        <div className="craft-sheet-actions">
          <Button type="button" variant="secondary" size="lg" onClick={onNotYet} disabled={state.busy}>Not yet</Button>
          <Button type="submit" variant="primary" size="lg" disabled={state.busy} aria-busy={state.busy || undefined}>{state.busy ? "Saving…" : `Yes, done`}</Button>
        </div>
      </form>
    </Sheet>
  );
}

// ── Earlier steps not ticked (FR4) ──────────────────────────────────────────
/**
 * FR4 (Fable 3): steps (checks) passed unticked, on rows before the current one, as one quiet line ("2 earlier steps
 * not ticked") that opens their list, each with Done, and "Mark all done". They never hold up Row done.
 */
export function EarlierSteps({ checks, busy, onDone, defaultOpen = false }: { checks: CraftView["earlier_checks"]; busy: string | null; onDone: (label: string, ids: string[]) => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!checks.length) return null;
  return (
    <div className="craft-earlier">
      <button type="button" className="craft-earlier-line" aria-expanded={open} aria-controls="craft-earlier-list" onClick={() => setOpen(!open)}>
        <span>{earlierStepsText(checks.length)}</span><span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div id="craft-earlier-list">
          <ul className="craft-earlier-list">{checks.map((check) => (
            <li key={check.id}>
              <div><small>{checkBeforeText(check)}</small><p>{check.text}</p></div>
              <Button variant="secondary" size="sm" disabled={busy !== null} aria-busy={busy === `check-${check.id}` || undefined} aria-label={`Done: ${check.text}`}
                onClick={() => onDone(`check-${check.id}`, [check.id])}>Done</Button>
            </li>
          ))}</ul>
          {checks.length > 1 && <Button variant="ghost" size="sm" disabled={busy !== null} aria-busy={busy === "check-earlier" || undefined}
            onClick={() => onDone("check-earlier", checks.map((check) => check.id))}>Mark all done</Button>}
        </div>
      )}
    </div>
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
