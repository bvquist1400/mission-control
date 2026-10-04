"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import {
  buildFitView,
  buildSourceLine,
  buildSpeedRows,
  buildTiles,
  paceChip,
  type FitView,
  type SessionRow,
  type SourceLabel,
} from "@/lib/pace-view";
import type { PaceForecast } from "@/lib/pace";
import "./pace-section.css";

/** What `GET /api/projects/[id]/pace` returns (the page's whole read model). */
export interface PacePanelData {
  project: { id: string; name: string; unit_label: string; target_date: string | null };
  forecast: PaceForecast;
  tasks: Array<{ id: string; title: string; status: string; lowest_undone_row: number | null }>;
  default_task_id: string | null;
  sessions: SessionRow[];
  session_total: number;
  unitless_note: string | null;
}

export interface LogSittingInput {
  /** "" = a sitting across several tasks (project level). */
  task_id: string;
  date: string;
  start: string;
  end: string;
  minutes: string;
  rows: string;
  note: string;
  exclude_from_stats: boolean;
  /** One per form open, so a retried save can't log the sitting twice. */
  idempotency_key: string;
}

export type ActionResult = { ok: true } | { ok: false; error: string };

export interface PacePanelActions {
  logSitting: (input: LogSittingInput) => Promise<ActionResult>;
  setExcluded: (sessionId: string, excluded: boolean) => Promise<ActionResult>;
  deleteSession: (sessionId: string) => Promise<ActionResult>;
}

const NO_TASK_LABEL = "Several tasks (no single task)";

function ChipView({ chip }: { chip: { kind: string; label: string } }) {
  return <span className={`pace-chip ${chip.kind}`}>{chip.label}</span>;
}

function FitTable({ fit, className }: { fit: FitView; className: string }) {
  return (
    <div className={`pace-fit ${className}`} data-testid="pace-fit">
      <h3 className="text-sm font-semibold text-foreground">{fit.title}</h3>
      {fit.window ? <p>{fit.window}</p> : null}
      <div className="pace-fit-grid" role="group" aria-label={fit.title}>
        {fit.rows.map((row, index) => {
          const third = fit.hasGauge && row.length !== null ? `≈ ${row.length} ${row.lengthUnit}${row.note === "the plan" ? " (the plan)" : ""}` : row.none ? row.note : "";
          return (
            <FitRowCells key={`${row.label}-${row.minutes_per_day}-${index}`} row={row} third={third} />
          );
        })}
      </div>
      {fit.gaugeNote ? <p className="pace-gauge-note">{fit.gaugeNote}</p> : null}
      <p>{fit.note}</p>
    </div>
  );
}

function FitRowCells({ row, third }: { row: FitView["rows"][number]; third: string }) {
  const minutes = `${Math.round(row.minutes_per_day)} min/day`;
  return (
    <div className="pace-fit-row">
      <span className="pace-fit-lab">
        {row.label ? (
          <>
            {row.label} <b>· {minutes}</b>
          </>
        ) : (
          <b>{minutes}</b>
        )}
      </span>
      <span className={`pace-fit-w${row.none ? " none" : ""}`}>{row.none ? "None" : `${row.width} stitches`}</span>
      <span className="pace-fit-dim">{third}</span>
    </div>
  );
}

function SourceCell({ source, onShow }: { source: SourceLabel; onShow: (why: string | null) => void }) {
  return (
    <span
      className={`pace-src ${source.tone}`}
      tabIndex={0}
      role="button"
      title={source.title}
      onMouseEnter={() => onShow(source.title)}
      onFocus={() => onShow(source.title)}
      onClick={() => onShow(source.title)}
      onMouseLeave={() => onShow(null)}
      onBlur={() => onShow(null)}
    >
      {source.text}
    </span>
  );
}

function SessionMenu({
  session,
  onSetExcluded,
  onDelete,
  disabled,
}: {
  session: SessionRow;
  onSetExcluded: (excluded: boolean) => void;
  onDelete: () => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) {
        setOpen(false);
        setConfirming(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setConfirming(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    root.current?.querySelector<HTMLElement>("[role^='menuitem'], .pace-menu-confirm button")?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, confirming]);

  const label = `Options for the ${session.when} sitting, ${session.what}`;
  return (
    <div className="pace-sm" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="pace-dots"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => {
          setOpen((value) => !value);
          setConfirming(false);
        }}
      >
        ⋯
      </button>
      {open ? (
        <div className="pace-menu" id={menuId} role="menu">
          {confirming ? (
            <div className="pace-menu-confirm" role="group" aria-label="Confirm delete">
              <span>Delete this {session.minutes}-minute sitting? The rows it ticked stay ticked.</span>
              <div className="row">
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    setOpen(false);
                    setConfirming(false);
                    onDelete();
                  }}
                >
                  Delete
                </button>
                <button type="button" onClick={() => setConfirming(false)}>
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={session.excluded}
                onClick={() => {
                  setOpen(false);
                  onSetExcluded(!session.excluded);
                }}
              >
                <span>Don&apos;t count toward speed</span>
                <span className="ck" aria-hidden="true">
                  ✓
                </span>
              </button>
              <button type="button" role="menuitem" className="danger" onClick={() => setConfirming(true)}>
                <span>Delete (rows stay ticked)</span>
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `form-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function emptyForm(data: PacePanelData): LogSittingInput {
  return {
    idempotency_key: newKey(),
    task_id: data.default_task_id ?? "",
    date: data.forecast.today,
    start: "",
    end: "",
    minutes: "",
    rows: "",
    note: "",
    exclude_from_stats: false,
  };
}

function LogForm({ data, actions, onDone, onCancel }: { data: PacePanelData; actions: PacePanelActions; onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<LogSittingInput>(() => emptyForm(data));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const set = <K extends keyof LogSittingInput>(key: K, value: LogSittingInput[K]) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const hasTimes = Boolean(form.start && form.end);
    if (!form.minutes.trim() && !hasTimes) {
      setError("Give the minutes, or both a start and an end time.");
      return;
    }
    if (form.minutes.trim() && !/^\d+$/.test(form.minutes.trim())) {
      setError("Minutes must be a whole number.");
      return;
    }
    if ((form.start && !form.end) || (!form.start && form.end)) {
      setError("A start time needs an end time (or give just the minutes).");
      return;
    }
    setSaving(true);
    const result = await actions.logSitting(form);
    setSaving(false);
    if (result.ok) onDone();
    else setError(result.error);
  }

  return (
    <form className="pace-form" onSubmit={submit} aria-label="Log a sitting" data-testid="pace-log-form">
      <div className="pace-fields">
        <div className="pace-field pace-span3 pace-f-task">
          <label htmlFor={`${ids}-task`}>Task</label>
          <Select id={`${ids}-task`} size="sm" value={form.task_id} onChange={(event) => set("task_id", event.target.value)}>
            {data.tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
            <option value="">{NO_TASK_LABEL}</option>
          </Select>
        </div>
        <div className="pace-field pace-span3 pace-f-date">
          <label htmlFor={`${ids}-date`}>Date</label>
          <Input id={`${ids}-date`} size="sm" type="date" value={form.date} onChange={(event) => set("date", event.target.value)} required />
        </div>
        <div className="pace-field pace-span3 pace-f-time">
          <span className="pace-lb">Start – end</span>
          <div className="pace-pair">
            <Input size="sm" type="time" aria-label="Start time" value={form.start} onChange={(event) => set("start", event.target.value)} />
            <span aria-hidden="true">–</span>
            <Input size="sm" type="time" aria-label="End time" value={form.end} onChange={(event) => set("end", event.target.value)} />
          </div>
        </div>
        <div className="pace-field pace-span3 pace-f-min">
          <label htmlFor={`${ids}-min`}>Or minutes</label>
          <Input id={`${ids}-min`} size="sm" type="number" min={1} max={1440} placeholder="e.g. 45" value={form.minutes} onChange={(event) => set("minutes", event.target.value)} />
        </div>
        <div className="pace-field pace-span2 pace-span-m pace-f-rows">
          <label htmlFor={`${ids}-rows`}>Rows</label>
          <Input id={`${ids}-rows`} size="sm" type="text" placeholder="20–22" value={form.rows} onChange={(event) => set("rows", event.target.value)} />
        </div>
        <div className="pace-field pace-span6">
          <label htmlFor={`${ids}-note`}>Note</label>
          <Input id={`${ids}-note`} size="sm" type="text" placeholder="Optional" value={form.note} onChange={(event) => set("note", event.target.value)} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-foreground" htmlFor={`${ids}-excl`}>
        <input
          id={`${ids}-excl`}
          type="checkbox"
          className="h-4 w-4 accent-violet-500"
          checked={form.exclude_from_stats}
          onChange={(event) => set("exclude_from_stats", event.target.checked)}
        />
        Don&apos;t count toward speed
      </label>
      {error ? (
        <p className="pace-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="pace-actions">
        <Button type="submit" variant="primary" size="sm" disabled={saving}>
          {saving ? "Saving…" : "Save sitting"}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <span className="pace-hint">Same service as the log_work_session tool. Times are Eastern.</span>
      </div>
    </form>
  );
}

/**
 * The project page's Pace section: header, four tiles, the width that fits, and (folded on a phone) the
 * speed table and the sittings. Presentational: the fetching and the writes are the caller's (`PaceSection`).
 */
export function PacePanel({ data, actions, busy = false }: { data: PacePanelData; actions: PacePanelActions; busy?: boolean }) {
  const { forecast } = data;
  const [showForm, setShowForm] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const [phone, setPhone] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const sync = () => setPhone(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const chip = paceChip(forecast);
  const tiles = buildTiles(forecast);
  const speedRows = buildSpeedRows(forecast, { unitlessNote: data.unitless_note });
  const fit = buildFitView(forecast);
  const defaultWhy = [
    forecast.size_fit && forecast.size_fit.perimeter_minutes_left > 0 ? "The border scales with the perimeter, not just the width." : null,
    "Hover or tap a source label to see what it means.",
  ]
    .filter(Boolean)
    .join(" ");
  const sentinel = data.session_total === 0;

  async function run(action: Promise<ActionResult>) {
    setActionError(null);
    const result = await action;
    if (!result.ok) setActionError(result.error);
  }

  return (
    <section className="pace-sec rounded-card border border-stroke bg-panel p-5 shadow-sm max-[760px]:p-3" aria-labelledby="pace-h" data-testid="pace-section">
      <div className="pace-head">
        <div className="pace-head-title">
          <div className="pace-head-line">
            <h2 id="pace-h" className="text-sm font-semibold text-foreground">
              Pace · {data.project.unit_label}
            </h2>
            <ChipView chip={chip} />
          </div>
          <span className="text-xs text-muted-foreground">{buildSourceLine(forecast, data.session_total)}</span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          aria-expanded={showForm}
          aria-controls="pace-log-form"
          onClick={() => {
            setShowForm((value) => !value);
            setFormKey((value) => value + 1);
          }}
        >
          Log a sitting
        </Button>
      </div>

      {showForm ? (
        <div id="pace-log-form">
          <LogForm
            key={formKey}
            data={data}
            actions={actions}
            onDone={() => setShowForm(false)}
            onCancel={() => setShowForm(false)}
          />
        </div>
      ) : null}

      {actionError ? (
        <p className="pace-error" role="alert">
          {actionError}
        </p>
      ) : null}

      <div className="pace-tiles" aria-busy={busy}>
        {tiles.map((tile) => (
          <div key={tile.key} className={`pace-tile ${tile.tone}`}>
            <span className="pace-tile-k">{tile.label}</span>
            <span className="pace-tile-v">{tile.value}</span>
            <span className="pace-tile-s">{tile.sub}</span>
          </div>
        ))}
      </div>

      {fit ? <FitTable fit={fit} className="pace-fit-phone" /> : null}

      <details className="pace-fold" open={phone ? undefined : true} data-testid="pace-details">
        <summary>
          Details <small>speed table and sittings</small>
        </summary>
        <div>
          <div className="pace-scroll">
            <table className="pace-table pace-stack">
              <thead>
                <tr>
                  <th>Work type</th>
                  <th className="num">{data.project.unit_label.charAt(0).toUpperCase() + data.project.unit_label.slice(1)}</th>
                  <th className="num">Done</th>
                  <th className="num">Left</th>
                  <th className="num">Speed</th>
                  <th>Source</th>
                  <th className="num">Hours left</th>
                </tr>
              </thead>
              <tbody>
                {speedRows.map((row) => (
                  <tr key={row.work_type ?? "no-units"}>
                    <td data-l="Work type">
                      <span className="pace-wt">
                        {row.color ? <span className="pace-sw" style={{ background: row.color }} aria-hidden="true" /> : null}
                        {row.label}
                        {row.note ? <small>{row.note}</small> : null}
                      </span>
                    </td>
                    <td className="num" data-l={data.project.unit_label}>
                      {row.units_total === null ? "—" : row.units_total.toLocaleString("en-US")}
                    </td>
                    <td className="num" data-l="Done">
                      {row.units_done === null ? "—" : row.units_done.toLocaleString("en-US")}
                    </td>
                    <td className="num" data-l="Left">
                      {row.units_left === null ? "—" : row.units_left.toLocaleString("en-US")}
                    </td>
                    <td className="num" data-l="Speed">
                      {row.speed}
                    </td>
                    <td data-l="Source">
                      <SourceCell source={row.source} onShow={setWhy} />
                    </td>
                    <td className="num" data-l="Hours left">
                      {row.hours_left}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pace-why" aria-live="polite">
            {why ?? defaultWhy}
          </p>
        </div>

        {fit ? <FitTable fit={fit} className="pace-fit-desk" /> : null}

        <div>
          <h3 className="mb-2 text-sm font-semibold text-foreground">Sittings</h3>
          {sentinel ? (
            <div className="pace-empty" data-testid="pace-empty">
              <span>Log your first sitting to measure speed.</span>
              <span>Until then the forecast uses the plan&apos;s own times.</span>
            </div>
          ) : (
            <div className="pace-sessions">
              {data.sessions.map((session) => (
                <div key={session.id} className={`pace-sess${session.excluded ? " excl" : ""}`}>
                  <span className="pace-sess-when">{session.when}</span>
                  <span className="pace-sess-what">
                    {session.what}
                    {session.rows ? ` · ${session.rows}` : ""}
                    {session.detail || session.note ? (
                      <small title={[session.detail, session.note].filter(Boolean).join(" · ")}>
                        {session.detail}
                        {session.detail && session.note ? " · " : ""}
                        {session.note ? `“${session.note}”` : ""}
                      </small>
                    ) : null}
                  </span>
                  <span className="pace-sess-min">{session.minutes} min</span>
                  <SessionMenu
                    session={session}
                    disabled={busy}
                    onSetExcluded={(excluded) => void run(actions.setExcluded(session.id, excluded))}
                    onDelete={() => void run(actions.deleteSession(session.id))}
                  />
                </div>
              ))}
              {data.session_total > data.sessions.length ? (
                <p className="pace-hint pt-2">Showing the newest {data.sessions.length} of {data.session_total}.</p>
              ) : null}
            </div>
          )}
        </div>
      </details>
    </section>
  );
}
