"use client";
/**
 * Craft estimates (E2, mockup `baseline-plans/craft-estimates/mockup.html`): the front's Today box under the active
 * part, the Pace section (inside screen, and the same body in a sheet from the Today box) with This project /
 * All projects tabs, and the rows-left / finish-by line in the Parts list. Words and numbers come from the pure
 * `buildCraftEstimate` (via `GET /api/craft/pace`); nothing is counted here. The estimate is read after the screen
 * and again after a saved row or sitting (the `reload` key), never on a timer; if it fails the screen still works.
 * E4: All projects is the shared time across open craft projects with a due date (`buildSharedTime`, the reply's
 * `shared` when every project is read), read only while that tab is open, with the same `reload` key. E3: "Add rows…"
 * on the sittings with time but no rows opens the screen's Add rows sheet.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { CraftEstimate, EstimateChip } from "@/lib/craft/estimate";
import type { SharedTime } from "@/lib/craft/shared";

export type PaceTab = "this" | "all";

/** The project's estimate, re-read whenever `reload` changes (rows ticked, a sitting saved, another part). */
export function useCraftPace(projectId: string, reload: string): CraftEstimate | null {
  const [state, setState] = useState<{ key: string; estimate: CraftEstimate | null } | null>(null);
  useEffect(() => {
    let live = true;
    const key = `${projectId}|${reload}`;
    fetch(`/api/craft/pace?project_id=${encodeURIComponent(projectId)}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { projects?: Array<{ project_id: string; estimate: CraftEstimate | null }> } | null) => {
        if (!live) return;
        const entry = json?.projects?.find((project) => project.project_id === projectId);
        // A failed read keeps the last estimate (the screen never depends on it).
        if (entry?.estimate) setState({ key, estimate: entry.estimate });
      })
      .catch(() => { /* the next saved row or sitting tries again */ });
    return () => { live = false; };
  }, [projectId, reload]);
  return state?.estimate ?? null;
}

/** E4: the shared time across craft projects, read only while `enabled` (the All projects tab) and again when `reload` changes. */
export function useSharedTime(enabled: boolean, reload: string): SharedTime | "failed" | null {
  const [state, setState] = useState<{ key: string; shared: SharedTime | "failed" } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const key = reload;
    fetch("/api/craft/pace", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { shared?: SharedTime } | null) => {
        if (!live) return;
        // A failed read keeps the last shared time; with none yet the tab says it couldn't be read.
        if (json?.shared) setState({ key, shared: json.shared });
        else setState((previous) => previous ?? { key, shared: "failed" });
      })
      .catch(() => { if (live) setState((previous) => previous ?? { key, shared: "failed" }); });
    return () => { live = false; };
  }, [enabled, reload]);
  return enabled ? state?.shared ?? null : null;
}

function chipClass(chip: EstimateChip): string {
  return chip.kind === "ok" || chip.kind === "done" ? "cp-chip ok" : chip.kind === "behind" || chip.kind === "behind_so_far" ? "cp-chip behind" : "cp-chip";
}
export function PaceChip({ chip }: { chip: EstimateChip }) {
  return <span className={chipClass(chip)}>{chip.label}</span>;
}

/** The front's Today box: today's rows against today's target, a bar, one line, the chip; tapping opens Pace. */
export function CraftTodayBox({ estimate, onOpen, onAddRows }: { estimate: CraftEstimate; onOpen: () => void; onAddRows?: () => void }) {
  const { front, chip } = estimate;
  const short = chip.kind === "behind" || chip.kind === "behind_so_far";
  return (
    <div className="cp-strip">
      <button type="button" className="cp-open" onClick={onOpen} aria-label={`Today: ${front.head}. ${chip.label}. ${front.line}. Open Pace`}>
        <span className="cp-l1"><span><em>Today</em><strong>{front.head}</strong></span><PaceChip chip={chip} /></span>
        {front.bar !== null && <span className={`cp-meter${short ? " short" : ""}`} aria-hidden="true"><i style={{ width: `${Math.round(front.bar * 100)}%` }} /></span>}
        <span className="cp-cap">{front.line}</span>
      </button>
      {front.no_rows_line && <button type="button" className="cp-link" onClick={onAddRows ?? onOpen}>{front.no_rows_line}{onAddRows ? " Add rows" : ""}</button>}
    </div>
  );
}

/** Rows each day (after 3 days), with the rows needed now as a dashed line. */
function RowsChart({ chart }: { chart: NonNullable<CraftEstimate["sheet"]["chart"]> }) {
  const width = 280, height = 64, gap = 4;
  const top = Math.max(1, chart.needed ?? 0, ...chart.days.map((day) => day.rows)) * 1.15;
  const bar = Math.max(2, (width - gap * (chart.days.length - 1)) / chart.days.length);
  const y = (rows: number) => height - (rows / top) * height;
  const first = chart.days[0]?.date ?? "", last = chart.days[chart.days.length - 1]?.date ?? "";
  const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
  return (
    <div className="cp-chart">
      <div className="cp-ct"><strong>Rows each day</strong>{chart.needed !== null && <span><i aria-hidden="true" />{chart.needed} needed now</span>}</div>
      <svg viewBox={`0 0 ${width} ${height + 16}`} role="img" aria-label={`Rows each day from ${md(first)} to ${md(last)}: ${chart.days.map((day) => day.rows).join(", ")}${chart.needed !== null ? `. ${chart.needed} needed a day now.` : ""}`}>
        {chart.days.map((day, index) => (
          <rect key={day.date} x={index * (bar + gap)} y={y(day.rows)} width={bar} height={height - y(day.rows)} className="cp-bar" />
        ))}
        {chart.needed !== null && <line x1="0" x2={width} y1={y(chart.needed)} y2={y(chart.needed)} className="cp-need" />}
        <line x1="0" x2={width} y1={height} y2={height} className="cp-axis" />
        <text x="0" y={height + 13}>{md(first)}</text>
        <text x={width} y={height + 13} textAnchor="end">{md(last)}</text>
      </svg>
    </div>
  );
}

function Tiles({ tiles }: { tiles: CraftEstimate["sheet"]["tiles"] }) {
  return (
    <div className="cp-tiles">{tiles.map((tile) => (
      <div key={tile.label} className="cp-tile">
        <span className="craft-eyebrow">{tile.label}</span>
        <p className="cp-num"><strong>{tile.value}</strong> {tile.unit}</p>
        <p className="cp-sub">{tile.sub}</p>
      </div>
    ))}</div>
  );
}

/** E4: All projects: needed vs you in minutes, who gives way, each project soonest due first, the order and finish. */
export function SharedTimeBody({ shared }: { shared: SharedTime | "failed" | null }) {
  if (shared === null) return <p className="cp-sub cp-all-wait">Working out the shared time…</p>;
  if (shared === "failed") return <p className="cp-sub cp-all-wait">The shared time couldn&apos;t be read. It tries again after the next saved row or sitting.</p>;
  if (shared.empty) {
    return (
      <div className="cp-all">
        <p>{shared.empty}</p>
        {shared.left_out && <p className="cp-sub">{shared.left_out}</p>}
      </div>
    );
  }
  return (
    <>
      <Tiles tiles={shared.tiles} />
      {shared.warn && <p className="cp-warn"><strong>{shared.warn.strong}</strong>{shared.warn.rest}</p>}
      <ol className="cp-projects" aria-label="Projects, soonest due first">{shared.projects.map((project) => (
        <li key={project.project_id} data-state={project.state}>
          <div className="cp-p1"><strong>{project.name}</strong><span>{project.due_text}</span></div>
          <div className="cp-p2"><strong>{project.rows_text}</strong>{project.minutes_text && <span>{project.minutes_text}</span>}</div>
          {project.bar !== null && (
            <span className={`cp-meter${project.state === "fits" ? "" : " short"}`} role="img"
              aria-label={project.given !== null && project.needed !== null ? `Gets ${Math.round(project.given)} of ${Math.round(project.needed)} min a day` : undefined}>
              <i style={{ width: `${Math.round(project.bar * 100)}%` }} />
            </span>
          )}
          <p className="cp-pl">{project.line}</p>
        </li>
      ))}</ol>
      <dl className="cp-facts">{shared.facts.map((fact) => (
        <div key={fact.key}><dt>{fact.label}</dt><dd><strong>{fact.strong}</strong><small>{fact.small}</small></dd></div>
      ))}</dl>
      {shared.left_out && <p className="cp-sub">{shared.left_out}</p>}
    </>
  );
}

/** The Pace body: tabs, This project (tiles, warning, sittings with no rows, chart, facts) and All projects (E4). */
export function CraftPaceBody({ estimate, tab, onTab, shared = null, onAddRows }: {
  estimate: CraftEstimate; tab: PaceTab; onTab: (tab: PaceTab) => void; shared?: SharedTime | "failed" | null; onAddRows?: () => void;
}) {
  const { sheet } = estimate;
  return (
    <div className="craft-pace">
      <div className="cp-tabs" role="group" aria-label="Pace for">
        <Button variant="toggle" size="lg" active={tab === "this"} onClick={() => onTab("this")}>This project</Button>
        <Button variant="toggle" size="lg" active={tab === "all"} onClick={() => onTab("all")}>All projects</Button>
      </div>
      {tab === "this" ? (
        <>
          <Tiles tiles={sheet.tiles} />
          {sheet.warn && <p className="cp-warn"><strong>{sheet.warn.strong}</strong>{sheet.warn.rest}</p>}
          {sheet.fix && <div className="cp-fix"><p>{sheet.fix}</p>{onAddRows && <Button variant="secondary" size="md" className="cp-addrows" onClick={onAddRows}>Add rows…</Button>}</div>}
          {sheet.chart && <RowsChart chart={sheet.chart} />}
          <dl className="cp-facts">{sheet.facts.map((fact) => (
            <div key={fact.key}><dt>{fact.label}</dt><dd><strong>{fact.strong}</strong><small>{fact.small}</small></dd></div>
          ))}</dl>
        </>
      ) : <SharedTimeBody shared={shared} />}
    </div>
  );
}

/** The inside screen's Pace section. `reload` is the screen's estimate key (E4 re-reads the shared time with it). */
export function CraftPaceSection({ estimate, reload = "", onAddRows }: { estimate: CraftEstimate | null; reload?: string; onAddRows?: () => void }) {
  const [tab, setTab] = useState<PaceTab>("this");
  const shared = useSharedTime(tab === "all", reload);
  return (
    <section className="cp-section" aria-label="Pace">
      <div className="cp-hd"><h2>Pace</h2>{estimate && <PaceChip chip={estimate.chip} />}</div>
      {estimate ? <CraftPaceBody estimate={estimate} tab={tab} onTab={setTab} shared={shared} onAddRows={onAddRows} /> : <p className="cp-sub">Working out the pace…</p>}
    </section>
  );
}

/** The same Pace, as a sheet from the front's Today box. */
export function CraftPaceSheet({ estimate, onClose, reload = "", onAddRows }: { estimate: CraftEstimate; onClose: () => void; reload?: string; onAddRows?: () => void }) {
  const [tab, setTab] = useState<PaceTab>("this");
  const shared = useSharedTime(tab === "all", reload);
  return (
    <Modal open onClose={onClose} title="Pace">
      <div className="craft-sheet cp-sheet">
        <div className="cp-hd cp-hd-sheet"><PaceChip chip={estimate.chip} /></div>
        <CraftPaceBody estimate={estimate} tab={tab} onTab={setTab} shared={shared} onAddRows={onAddRows} />
      </div>
    </Modal>
  );
}

/** The Parts list's estimate line for a part ("268 rows left · finish by about Dec 4"). */
export function partEstimateText(estimate: CraftEstimate | null, partId: string): string | null {
  return estimate?.parts.find((part) => part.part_id === partId)?.text ?? null;
}
