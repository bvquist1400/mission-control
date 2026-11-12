"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CraftProjectOption, CraftView } from "@/lib/craft";
import { Button, buttonClasses } from "@/components/ui/Button";
import { CraftProjectSwitcher } from "@/components/craft/CraftProjectSwitcher";
import { CraftScreenMenu } from "@/components/craft/CraftScreenMenu";
import {
  BandCloseSheet, ChangeTotalSheet, FixCountSheet, LogSittingSheet, NewDaySheet, NoteSheet, TimerConflictSheet, TimerFixSheet, UndoRowsSheet,
  type BandCheck, type OtherTimer, type Send, type SendReply,
} from "@/components/craft/CraftSheets";
import { useWakeLock } from "@/components/craft/useWakeLock";
import {
  UNDO_TOAST_MS, VIEW_REFRESH_MS, clockOffsetMs, clockText, frogReason, minutesText, nextExistingRow, rowsText, savedSittingText, timerElapsedAt, toastUndo,
  writeFailureText,
} from "@/lib/craft/actions";
import "./craft.css";

type Screen = CraftView & { projects?: CraftProjectOption[] };
type SheetName = "log" | "log-then-start" | "undo" | "fix" | "total" | "note" | "timer" | "new-day";
interface Failure { text: string; retry: (() => void) | null }
type Act = (label: string, kind: Parameters<Send>[0], body: Record<string, unknown>, onOk?: (reply: SendReply) => void, onNotOk?: (reply: SendReply) => boolean, method?: "POST" | "DELETE") => Promise<SendReply>;

/**
 * The craft screen. Pattern first (Brent 11/11): the current row's instructions lead; the compact timer and the big
 * Row done sit under them. S2 (073): every button is one server write guarded by the count or timer version the
 * screen showed, and each reply carries the fresh view, so the count on screen is always the server's. A failed
 * write says "Not saved" with Retry; nothing is counted on the screen alone. Elapsed time is computed from the
 * server's timestamps plus a clock offset, re-read when the page shows again and every 30 s while visible, so the
 * timer survives a fold, a closed tab and a locked phone.
 */
export function CraftScreen({ view: initial }: { view: Screen }) {
  const [view, setView] = useState<Screen>(initial);
  const [offset, setOffset] = useState(0);
  const [tick, setTick] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [toast, setToast] = useState<{ row: number; partId: string; word: string; undo: ReturnType<typeof toastUndo>; id: number } | null>(null);
  const [undoTo, setUndoTo] = useState<number | undefined>(undefined);
  const [undoMode, setUndoMode] = useState<"undo" | "rip">("undo");
  // S3 F3: what the server actually saved (or ripped back), shown once the sheet closes.
  const [saved, setSaved] = useState<{ text: string; id: number } | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const [check, setCheck] = useState<BandCheck | null>(null);
  const [conflict, setConflict] = useState<OtherTimer | null>(null);
  const [leftOnOk, setLeftOnOk] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectId = view.project.id;

  const accept = useCallback((next: Screen | undefined | null) => {
    if (!next || next.project?.id !== projectId) return;
    setView((previous) => ({ ...next, projects: next.projects ?? previous.projects }));
    setOffset(clockOffsetMs(next.server_now, Date.now()));
  }, [projectId]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/craft/${projectId}`, { cache: "no-store" });
      if (res.ok) accept(await res.json());
    } catch { /* the next refresh tries again; the screen keeps the last server view */ }
  }, [projectId, accept]);

  // Re-read on show, every 30 s while visible, and once on mount (exact clock offset).
  useEffect(() => {
    const first = setTimeout(() => { void refresh(); }, 0);
    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!interval) interval = setInterval(() => { void refresh(); }, VIEW_REFRESH_MS); };
    const stop = () => { if (interval) { clearInterval(interval); interval = null; } };
    const onVisibility = () => { if (document.visibilityState === "visible") { void refresh(); start(); } else stop(); };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onVisibility);
    return () => { clearTimeout(first); stop(); document.removeEventListener("visibilitychange", onVisibility); window.removeEventListener("pageshow", onVisibility); };
  }, [refresh]);

  // The clock ticks once a second while a timer runs (the digits only; nothing is counted here).
  const running = Boolean(view.timer?.running);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  const send: Send = useCallback(async (kind, body, method = "POST") => {
    let reply: SendReply;
    try {
      const res = await fetch(`/api/craft/${projectId}/${kind}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => null) as Record<string, unknown> | null;
      if (json && typeof json === "object" && "view" in json) accept(json.view as Screen);
      reply = { ok: res.ok, status: res.status, body: json, error: res.ok ? null : writeFailureText(res.status, json as { error?: string } | null) };
    } catch {
      reply = { ok: false, status: null, body: null, error: writeFailureText(null, null) };
    }
    return reply;
  }, [projectId, accept]);

  /** A write from the screen itself (not a sheet): a failure stays on screen with Retry. */
  const actRef = useRef<Act | null>(null);
  const act: Act = useCallback(async (label: string, kind: Parameters<Send>[0], body: Record<string, unknown>, onOk?: (reply: SendReply) => void, onNotOk?: (reply: SendReply) => boolean, method: "POST" | "DELETE" = "POST") => {
    setBusy(label);
    setFailure(null);
    const reply = await send(kind, body, method);
    setBusy(null);
    if (reply.ok) { onOk?.(reply); return reply; }
    if (onNotOk?.(reply)) return reply;
    // A 409 means nothing was saved and the screen now shows the server's state: retrying the same body would be wrong.
    setFailure({ text: reply.error ?? "Not saved, retry.", retry: reply.status === 409 || (reply.status ?? 0) === 400 ? null : () => { void actRef.current?.(label, kind, body, onOk, onNotOk, method); } });
    return reply;
  }, [send]);
  useEffect(() => { actRef.current = act; }, [act]);

  const part = view.active_part;
  const allFinished = !part && view.parts.length > 0;
  const word = part?.row_word ?? "row";
  const Word = word === "round" ? "Round" : "Row";
  const nowRow = part && view.next_rows[0]?.row === part.current_row ? view.next_rows[0] : null;
  const upcoming = part ? view.next_rows.filter((row) => row.row > part.current_row).slice(0, 3) : [];
  const nextRow = part && !part.finished ? nextExistingRow(view.row_states, part.current_row, part.total_rows) : null;
  const timer = view.timer;
  const nowMs = tick === null ? Date.parse(view.server_now) : tick + offset;
  const elapsed = timer ? (tick === null ? timer.elapsed_seconds : timerElapsedAt(timer, nowMs)) : 0;
  const screenOn = useWakeLock(running);
  const rowNotes = part ? view.notes.filter((note) => note.part_id === part.id && note.row === part.current_row) : [];
  function confirm(text: string) {
    if (savedTimer.current) clearTimeout(savedTimer.current);
    const id = Date.now();
    setSaved({ text, id });
    savedTimer.current = setTimeout(() => setSaved((current) => (current?.id === id ? null : current)), 10_000);
  }
  function onSittingSaved(reply: SendReply) {
    const result = reply.body?.result as Parameters<typeof savedSittingText>[0] | undefined;
    if (part && result) confirm(savedSittingText(result, part.row_word === "round" ? "round" : "row", part.name, view.parts));
  }
  function onRipped(reply: SendReply) {
    const result = reply.body?.result as { from_row?: number; to_row?: number; excluded?: string[] } | undefined;
    if (!part || !result?.from_row || !result.to_row) return;
    const w = part.row_word === "round" ? "round" : "row";
    const n = result.excluded?.length ?? 0;
    confirm(`${frogReason(w, result.from_row, result.to_row).replace(/^ripped/, "Ripped")}. ${n ? `${n} ${n === 1 ? "sitting" : "sittings"} left out of speed.` : "No sitting left out of speed."}`);
  }
  const openUndo = (mode: "undo" | "rip", to?: number) => { setUndoTo(to); setUndoMode(mode); setSheet("undo"); };

  function rowDone() {
    if (!part || part.finished) return;
    const row = part.current_row, partId = part.id, before = view.row_states, total = part.total_rows;
    void act("row", "row", { part_id: partId, mode: "done", expected_row: row }, (reply) => {
      const result = reply.body?.result as { current_row: number; needs_check: BandCheck | null } | undefined;
      if (toastTimer.current) clearTimeout(toastTimer.current);
      setSaved(null);
      const id = Date.now();
      // FR1 (Fable F2): Undo unticks only the row it names; rows after it already ticked → "Undo rows…" instead.
      setToast({ row, partId, word, undo: toastUndo(before, total, row, result?.current_row ?? row + 1), id });
      toastTimer.current = setTimeout(() => setToast((t) => (t?.id === id ? null : t)), UNDO_TOAST_MS);
      if (result?.needs_check) setCheck(result.needs_check);
    });
  }
  function undoToast() {
    if (!toast) return;
    const t = toast;
    setToast(null);
    if (t.undo.kind === "sheet") { openUndo("undo", t.undo.to); return; }
    void act("undo", "row", { part_id: t.partId, ...t.undo.body });
  }
  const timerBody = (action: string, extra: Record<string, unknown> = {}) => ({ action, ...(part ? { part_id: part.id } : {}), ...(timer ? { expected_version: timer.version } : {}), ...extra });
  const onTimerRefusal = (reply: SendReply) => {
    const reason = reply.body?.reason;
    const result = reply.body?.result as { other?: OtherTimer } | undefined;
    if (reason === "conflict" && result?.other) { setConflict(result.other); return true; }
    if (reason === "new_day") { setSheet("new-day"); return true; }
    return false;
  };
  function timerButton() {
    if (!timer) void act("timer", "timer", timerBody("start"), undefined, onTimerRefusal);
    else void act("timer", "timer", timerBody(timer.running ? "pause" : "resume"), undefined, onTimerRefusal);
  }

  const timerState = !timer ? (view.other_timer ? `${view.other_timer.project_name}'s timer ${view.other_timer.running ? "is running" : "is paused"} (${minutesText(view.other_timer.elapsed_seconds / 60)} not saved)` : "Not timing")
    : timer.running ? `Since ${new Date(timer.sitting_started_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}`
    : `Paused${timer.paused_at ? ` · stopped ${minutesText(Math.max(0, (nowMs - Date.parse(timer.paused_at)) / 60000))} ago` : ""}`;
  const leftOn = timer && timer.long_run && leftOnOk !== timer.sitting_started_at;

  return (
    <main className="craft-screen">
      <header className="craft-header">
        <Link href={`/projects/${view.project.id}`} className={buttonClasses({ variant: "ghost", size: "icon" })} aria-label="Back to project">←</Link>
        <h1>Craft</h1>
        <span className="craft-awake" data-on={screenOn ? "true" : undefined}>{screenOn ? "screen on" : ""}</span>
        <CraftScreenMenu projectId={view.project.id} projectName={view.project.name} canRemove={view.can_remove} partCount={view.parts.length} blockers={view.remove_blockers}
          actions={part ? [
            { label: `Undo ${word}s…`, onSelect: () => openUndo("undo") }, { label: "Fix count…", onSelect: () => setSheet("fix") },
            { label: "Ripped back…", onSelect: () => openUndo("rip") },
            { label: `Change total ${word}s…`, onSelect: () => setSheet("total") }, { label: "Add a note…", onSelect: () => setSheet("note") },
          ] : undefined} />
      </header>
      <div className="craft-columns">
        <section className="craft-front" aria-label="Current progress">
          <div className="craft-project"><p className="craft-eyebrow">{view.craft === "knit" ? "Knitting" : view.craft === "crochet" ? "Crochet" : "Craft"}</p>{(view.projects?.length ?? 0) > 1 ? <CraftProjectSwitcher currentId={view.project.id} currentName={view.project.name} projects={view.projects ?? []} /> : <h2>{view.project.name}</h2>}{view.gear && <p>{view.gear}</p>}</div>
          <div className="craft-part"><span className="craft-eyebrow">{allFinished ? "Project progress" : "Active part"}</span><h3>{part?.name ?? (allFinished ? "All parts finished" : "No parts yet")}</h3>{part?.stitch_count !== null && part?.stitch_count !== undefined && <p>{part.stitch_count} stitches</p>}</div>
          {part ? (
            <section className="craft-pf" aria-label="Current row instructions" data-quarter={part.quarter > 0 ? part.quarter : undefined}>
              {part.finished ? (
                <>
                  <p className="craft-pf-lab">Part complete</p>
                  <p className="craft-finished">Finished</p>
                  <p className="craft-pf-band"><strong>All rows ticked</strong> · {part.done_rows} of {part.row_count} {part.row_word}s ticked</p>
                </>
              ) : (
                <>
                  <div className="craft-pf-hd"><span className="craft-pf-lab">{part.quarter > 0 ? "Finish" : "Now"} · {part.row_word}</span><span className="craft-pf-num">{part.current_row}</span><span className="craft-pf-of">of {part.total_rows}{part.ridge !== null && <span className="craft-pf-ridge"> · ridge {part.ridge}</span>}</span></div>
                  <p className="craft-pf-band"><strong>{view.current_segment?.name ?? "No band for this row"}</strong> · {part.done_rows} of {part.row_count} {part.row_word}s ticked</p>
                  {part.quarter > 0 && <p className="craft-quarter">{["", "¼", "½", "¾"][part.quarter]} of this {part.row_word} done</p>}
                  <p className="craft-pf-now">{nowRow?.text ?? part.row_label}</p>
                  {rowNotes.length > 0 && <ul className="craft-pf-notes" aria-label={`Notes on ${word} ${part.current_row}`}>{rowNotes.map((note) => <li key={note.id}>{note.text}</li>)}</ul>}
                  {upcoming.length > 0 && <ol className="craft-pf-then" aria-label={`Upcoming ${part.row_word}s`}>{upcoming.map((row) => <li key={row.id}><span>{part.row_word} {row.row}</span><p>{row.text}</p></li>)}</ol>}
                </>
              )}
            </section>
          ) : <p className="craft-empty">{allFinished ? "Every part is finished. All rows are ticked." : "This project has no craft parts yet."}</p>}
          {view.pending_checks.length > 0 && part && (
            <div className="craft-checks">{view.pending_checks.map((pending) => (
              <button key={pending.segment_id} type="button" className="craft-check" onClick={() => setCheck(pending)}>
                <strong>{pending.name} is finished</strong><span>{pending.count ? `Count is ${pending.count.toLocaleString("en-US")}? Confirm to close the band` : "Confirm the count to close the band"}</span>
              </button>
            ))}</div>
          )}
          <div className="craft-s2">
            {saved && (
              <div className="craft-toast craft-saved" role="status">
                <span>{saved.text}</span>
                <button type="button" onClick={() => setSaved(null)} aria-label="Dismiss">×</button>
              </div>
            )}
            {toast && (
              <div className="craft-toast" role="status">
                <span>{toast.word === "round" ? "Round" : "Row"} {toast.row} done</span>
                <button type="button" onClick={undoToast} aria-label={toast.undo.kind === "sheet" ? `Undo: choose which ${toast.word}s` : `Undo ${toast.word} ${toast.row}`}>{toast.undo.kind === "sheet" ? "Undo…" : "Undo"}</button>
              </div>
            )}
            <div className="craft-timer" data-state={timer ? (timer.running ? "running" : "paused") : "idle"}>
              <div className="craft-timer-main">
                <span className="craft-timer-clock" role="timer" aria-label={`Timer ${clockText(elapsed)}`}>{clockText(elapsed)}</span>
                <p className="craft-timer-state">{timer?.running && <span className="craft-dot" aria-hidden="true" />}{timerState}</p>
              </div>
              <div className="craft-timer-buttons">
                {timer && <Button variant="secondary" size="md" onClick={() => setSheet("timer")} disabled={busy !== null}>± time</Button>}
                <Button variant={timer?.running ? "secondary" : "primary"} size="lg" onClick={timerButton} disabled={busy !== null || !part} aria-busy={busy === "timer" || undefined}>
                  {timer ? (timer.running ? "Pause" : "Resume") : "Start"}
                </Button>
              </div>
              {leftOn && timer && (
                <div className="craft-leftover" role="status">
                  <p>{minutesText(elapsed / 60)} on the timer. Was it left on?</p>
                  <Button variant="secondary" size="sm" onClick={() => setSheet("timer")}>Stopped earlier…</Button>
                  <Button variant="ghost" size="sm" onClick={() => setLeftOnOk(timer.sitting_started_at)}>It&apos;s right</Button>
                </div>
              )}
              {timer?.running && !screenOn && <p className="craft-tip">Tip: set Auto-Lock to Never while you craft.</p>}
            </div>
            {failure && (
              <div className="craft-failure" role="alert">
                <p>{failure.text}</p>
                {failure.retry && <Button variant="secondary" size="sm" onClick={failure.retry}>Retry</Button>}
                <Button variant="ghost" size="sm" onClick={() => setFailure(null)} aria-label="Dismiss">×</Button>
              </div>
            )}
            {part && (
              <div className="craft-actions">
                <Button variant="secondary" size="lg" className="craft-log" onClick={() => setSheet("log")} disabled={busy !== null}>Log sitting</Button>
                <button type="button" className="craft-done" onClick={rowDone} disabled={busy !== null || part.finished} aria-busy={busy === "row" || undefined}>
                  <span>✓ {Word} done</span>
                  <small>{part.finished ? "all ticked" : `${word} ${part.current_row}${nextRow ? ` → ${nextRow}` : " (last)"}`}</small>
                </button>
              </div>
            )}
          </div>
          {part && (
            <div className="craft-actions-more">
              <button type="button" onClick={() => openUndo("undo")}>Undo {word}s…</button>
              <button type="button" onClick={() => setSheet("fix")}>Fix count…</button>
              <button type="button" onClick={() => openUndo("rip")}>Ripped back…</button>
              <button type="button" onClick={() => setSheet("note")}>Note</button>
            </div>
          )}
          <section className="craft-today" aria-label="Today"><h3>Today</h3><p><strong>{view.today.rows}</strong> rows ticked <span>·</span> <strong>{view.today.minutes}</strong> min</p></section>
        </section>
        <aside className="craft-inside" aria-label="Project details">
          <section><h2>Parts</h2><ul className="craft-parts">{view.parts.map((entry) => <li key={entry.id} aria-current={entry.id === part?.id ? "true" : undefined}><strong>{entry.name}</strong><span>{entry.row_label}</span></li>)}</ul>
            {view.frogs.length > 0 && (
              <div className="craft-frogs">
                <h3>Ripped back</h3>
                <ol aria-label="Ripped back history">{view.frogs.map((frog) => (
                  <li key={frog.id}>
                    <div><time dateTime={frog.created_at}>{new Date(frog.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}</time>
                      <strong>{view.parts.length > 1 ? `${frog.part_name} · ` : ""}{rowsText(frog.row_word === "round" ? "round" : "row", Array.from({ length: frog.to_row - frog.from_row + 1 }, (_, i) => frog.from_row + i))}</strong></div>
                    {frog.note && <p>{frog.note}</p>}
                    <p className="craft-meta">{frog.sittings_left_out ? `${frog.sittings_left_out} ${frog.sittings_left_out === 1 ? "sitting" : "sittings"} left out of speed` : "No sitting left out of speed"}</p>
                  </li>
                ))}</ol>
              </div>
            )}
          </section>
          <section><h2>Bands</h2>{view.segments.length ? <><div className="craft-strip" aria-label="Band progress">{view.segments.map((segment) => <span key={segment.id} data-state={segment.state} title={`${segment.name}: ${segment.from_row}–${segment.to_row}, ${segment.state}`} style={{ flexGrow: segment.to_row - segment.from_row + 1 }} />)}</div><ol className="craft-bands">{view.segments.map((segment) => <li key={segment.id} data-state={segment.state} aria-current={segment.state === "current" ? "step" : undefined}><span>{segment.state === "done" ? "✓ " : ""}{segment.name}</span><span>{part?.row_word}s {segment.from_row}–{segment.to_row}<small>{segment.state}</small></span></li>)}</ol></> : <p>No bands yet.</p>}
            {view.next_segment && <div className="craft-peek"><p className="craft-eyebrow">Coming up</p><h3>{view.next_segment.name}</h3><p>{part?.row_word}s {view.next_segment.from_row}–{view.next_segment.to_row}</p></div>}
          </section>
          <section><h2>Next rows</h2>{view.next_rows.length ? <ol className="craft-next">{view.next_rows.map((row) => <li key={row.id}>{row.text}</li>)}</ol> : <p>No unticked rows.</p>}</section>
          <section><h2>Recent sittings</h2>{view.recent_sittings.length ? <ol className="craft-sittings">{view.recent_sittings.map((sitting) => <li key={sitting.id}><div><time dateTime={sitting.date}>{sitting.date}</time><strong>{sitting.minutes} min</strong></div><p>{sittingRowsText(sitting)}</p>{sitting.note && <p>{sitting.note}</p>}{sitting.excluded_from_stats && <p className="craft-meta">{sitting.exclude_reason ? `Left out of speed: ${sitting.exclude_reason}` : "Excluded from pace stats"}</p>}</li>)}</ol> : <p>No sittings logged yet.</p>}</section>
          {view.notes.length > 0 && <section><h2>Notes</h2><ul className="craft-notes">{view.notes.map((note) => <li key={note.id}><small>{note.row ? `${view.parts.find((p) => p.id === note.part_id)?.row_word === "round" ? "Round" : "Row"} ${note.row}` : "Project"} · {note.created_at.slice(0, 10)}</small><p>{note.text}</p>
            <button type="button" aria-label={`Delete note: ${note.text.slice(0, 40)}`} onClick={() => { void act("note", "notes", { id: note.id }, undefined, undefined, "DELETE"); }}>Delete</button></li>)}</ul></section>}
        </aside>
      </div>
      {part && sheet === "log" && <LogSittingSheet open onClose={() => setSheet(null)} view={view} part={part} send={send} onSaved={(reply) => { setSheet(null); onSittingSaved(reply); }} />}
      {part && sheet === "log-then-start" && <LogSittingSheet open thenStart onClose={() => setSheet(null)} view={view} part={part} send={send}
        onSaved={(reply) => { setSheet(null); onSittingSaved(reply); void act("timer", "timer", { action: "start", part_id: part.id }, undefined, onTimerRefusal); }} />}
      {part && sheet === "undo" && <UndoRowsSheet open onClose={() => setSheet(null)} view={view} part={part} send={send} initialTo={undoTo} initialMode={undoMode} onRipped={onRipped} />}
      {part && sheet === "fix" && <FixCountSheet open onClose={() => setSheet(null)} view={view} part={part} send={send} />}
      {part && sheet === "total" && <ChangeTotalSheet open onClose={() => setSheet(null)} view={view} part={part} send={send} />}
      {sheet === "note" && <NoteSheet open onClose={() => setSheet(null)} part={part} send={send} />}
      {sheet === "timer" && <TimerFixSheet open onClose={() => setSheet(null)} view={view} send={send} />}
      {sheet === "new-day" && <NewDaySheet open onClose={() => setSheet(null)} view={view} onSaveFirst={() => setSheet("log-then-start")}
        onKeepGoing={async () => {
          const reply = await send("timer", timerBody("resume", { force: true }));
          if (reply.ok) { setSheet(null); return null; }
          return reply.error;
        }} />}
      {part && <BandCloseSheet key={check?.segment_id ?? "none"} check={check} onClose={() => setCheck(null)} part={part} send={send} />}
      <TimerConflictSheet other={conflict} onClose={() => setConflict(null)} onDiscardAndStart={async () => {
        if (!conflict) return null;
        try {
          const res = await fetch(`/api/craft/${conflict.project_id}/timer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "discard", expected_version: conflict.version }) });
          if (!res.ok) return writeFailureText(res.status, await res.json().catch(() => null));
        } catch { return writeFailureText(null, null); }
        setConflict(null);
        await act("timer", "timer", { action: "start", ...(part ? { part_id: part.id } : {}) }, undefined, onTimerRefusal);
        return null;
      }} />
    </main>
  );
}

/** A sitting's rows on the screen, as S2 wrote them ("Blanket: row 61 · Blanket: row 62"), plus S3's "Blanket: part of row 63". */
function sittingRowsText(sitting: CraftView["recent_sittings"][number]): string {
  const pieces = [...sitting.rows.map((row) => `${row.part_name}: ${row.row_word} ${row.row}`),
    ...sitting.in_progress_rows.map((row) => `${row.part_name}: part of ${row.row_word} ${row.row}`)];
  return pieces.length ? pieces.join(" · ") : "No linked rows";
}
