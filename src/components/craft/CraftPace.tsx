"use client";
/**
 * Craft estimates (E2, mockup `baseline-plans/craft-estimates/mockup.html`): the front's Today box under the active
 * part, the Pace section (inside screen, and the same body in a sheet from the Today box) with This project /
 * All projects tabs, and the rows-left / finish-by line in the Parts list. Words and numbers come from the pure
 * `buildCraftEstimate` (via `GET /api/craft/pace`); nothing is counted here. The estimate is read after the screen
 * and again after a saved row or sitting (the `reload` key), never on a timer; if it fails the screen still works.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { CraftEstimate, EstimateChip } from "@/lib/craft/estimate";

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

function chipClass(chip: EstimateChip): string {
  return chip.kind === "ok" || chip.kind === "done" ? "cp-chip ok" : chip.kind === "behind" || chip.kind === "behind_so_far" ? "cp-chip behind" : "cp-chip";
}
export function PaceChip({ chip }: { chip: EstimateChip }) {
  return <span className={chipClass(chip)}>{chip.label}</span>;
}

/** The front's Today box: today's rows against today's target, a bar, one line, the chip; tapping opens Pace. */
export function CraftTodayBox({ estimate, onOpen }: { estimate: CraftEstimate; onOpen: () => void }) {
  const { front, chip } = estimate;
  const short = chip.kind === "behind" || chip.kind === "behind_so_far";
  return (
    <div className="cp-strip">
      <button type="button" className="cp-open" onClick={onOpen} aria-label={`Today: ${front.head}. ${chip.label}. ${front.line}. Open Pace`}>
        <span className="cp-l1"><span><em>Today</em><strong>{front.head}</strong></span><PaceChip chip={chip} /></span>
        {front.bar !== null && <span className={`cp-meter${short ? " short" : ""}`} aria-hidden="true"><i style={{ width: `${Math.round(front.bar * 100)}%` }} /></span>}
        <span className="cp-cap">{front.line}</span>
      </button>
      {front.no_rows_line && <button type="button" className="cp-link" onClick={onOpen}>{front.no_rows_line}</button>}
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

/** The Pace body: tabs, This project (tiles, warning, sittings with no rows, chart, facts) and All projects. */
export function CraftPaceBody({ estimate, tab, onTab }: { estimate: CraftEstimate; tab: PaceTab; onTab: (tab: PaceTab) => void }) {
  const { sheet } = estimate;
  return (
    <div className="craft-pace">
      <div className="cp-tabs" role="group" aria-label="Pace for">
        <Button variant="toggle" size="lg" active={tab === "this"} onClick={() => onTab("this")}>This project</Button>
        <Button variant="toggle" size="lg" active={tab === "all"} onClick={() => onTab("all")}>All projects</Button>
      </div>
      {tab === "this" ? (
        <>
          <div className="cp-tiles">{sheet.tiles.map((tile) => (
            <div key={tile.label} className="cp-tile">
              <span className="craft-eyebrow">{tile.label}</span>
              <p className="cp-num"><strong>{tile.value}</strong> {tile.unit}</p>
              <p className="cp-sub">{tile.sub}</p>
            </div>
          ))}</div>
          {sheet.warn && <p className="cp-warn"><strong>{sheet.warn.strong}</strong>{sheet.warn.rest}</p>}
          {sheet.fix && <div className="cp-fix"><p>{sheet.fix}</p></div>}
          {sheet.chart && <RowsChart chart={sheet.chart} />}
          <dl className="cp-facts">{sheet.facts.map((fact) => (
            <div key={fact.key}><dt>{fact.label}</dt><dd><strong>{fact.strong}</strong><small>{fact.small}</small></dd></div>
          ))}</dl>
        </>
      ) : (
        <div className="cp-all">
          <p>Shared time across your craft projects (soonest due first) comes in the next update.</p>
          <p className="cp-sub">For now, each project&apos;s own Pace is under This project.</p>
        </div>
      )}
    </div>
  );
}

/** The inside screen's Pace section. */
export function CraftPaceSection({ estimate }: { estimate: CraftEstimate | null }) {
  const [tab, setTab] = useState<PaceTab>("this");
  return (
    <section className="cp-section" aria-label="Pace">
      <div className="cp-hd"><h2>Pace</h2>{estimate && <PaceChip chip={estimate.chip} />}</div>
      {estimate ? <CraftPaceBody estimate={estimate} tab={tab} onTab={setTab} /> : <p className="cp-sub">Working out the pace…</p>}
    </section>
  );
}

/** The same Pace, as a sheet from the front's Today box. */
export function CraftPaceSheet({ estimate, onClose }: { estimate: CraftEstimate; onClose: () => void }) {
  const [tab, setTab] = useState<PaceTab>("this");
  return (
    <Modal open onClose={onClose} title="Pace">
      <div className="craft-sheet cp-sheet">
        <div className="cp-hd cp-hd-sheet"><PaceChip chip={estimate.chip} /></div>
        <CraftPaceBody estimate={estimate} tab={tab} onTab={setTab} />
      </div>
    </Modal>
  );
}

/** The Parts list's estimate line for a part ("268 rows left · finish by about Dec 4"). */
export function partEstimateText(estimate: CraftEstimate | null, partId: string): string | null {
  return estimate?.parts.find((part) => part.part_id === partId)?.text ?? null;
}
