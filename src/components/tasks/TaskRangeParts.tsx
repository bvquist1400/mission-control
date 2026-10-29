import type { RangeCardView, RangeTone } from "@/lib/task-range-view";
import { stepsPillText } from "@/lib/task-range-view";
import type { DayStripCell } from "@/lib/today/multi-day-board";

/**
 * Multi-day tasks S2, style A: the pieces a task card adds when the task has a
 * start date. Presentational only (no hooks); the Now panel and the week board
 * both use them. A card for a task without a range renders none of this.
 */

const EDGE_CLASSES: Record<RangeTone, string> = {
  range: "border-l-range",
  today: "border-l-accent",
  late: "border-l-red-400",
  quiet: "border-l-stroke",
};

const CHIP_CLASSES: Record<RangeTone, string> = {
  range: "bg-range-soft text-range-text",
  today: "bg-accent-soft text-red-100",
  late: "bg-red-500/15 text-red-300",
  quiet: "bg-panel text-muted-foreground",
};

/** The card's left edge: violet inside the range, accent on the due day, red once late. */
export function rangeEdgeClass(view: RangeCardView): string {
  return EDGE_CLASSES[view.tone];
}

/**
 * The green fill (progress, left → right) and the dashed "time gone by" mark
 * (amber when behind pace). Decorative: the same facts are in the chip, the
 * steps pill and `RangeSrText`. The card needs `relative overflow-hidden`, and
 * its content `relative` so it sits above the layers.
 */
export function RangeFillLayers({ view, elapsedPercent }: { view: RangeCardView; elapsedPercent?: number | null }) {
  const elapsed = elapsedPercent === undefined ? view.elapsedPercent : elapsedPercent;
  const full = view.fillPercent === 100;
  return (
    <>
      {view.fillPercent !== null ? (
        <div
          aria-hidden="true"
          data-range-fill={view.fillPercent}
          className={`pointer-events-none absolute inset-y-0 left-0 transition-[width] duration-500 ${
            full
              ? "bg-progress-fill-full"
              : view.fillPercent === 0
                ? "bg-progress-fill"
                : "border-r-2 border-progress-fill-edge bg-progress-fill"
          }`}
          style={{ width: `${view.fillPercent}%` }}
        />
      ) : null}
      {elapsed !== null && elapsed > 0 && elapsed < 100 ? (
        <div
          aria-hidden="true"
          data-range-elapsed={elapsed}
          title="Share of the date range gone by"
          className={`pointer-events-none absolute inset-y-0 w-0 border-l-[1.5px] border-dashed ${
            view.behindPace ? "border-amber-400/85" : "border-muted-foreground/40"
          }`}
          style={{ left: `${elapsed}%` }}
        />
      ) : null}
    </>
  );
}

/** "Mon–Fri · Day 4 of 5" (violet), "Due today · Day 5 of 5", "Overdue · Mon–Wed ended Wed", "Starts Wed 10/28". */
export function RangeChip({ view }: { view: RangeCardView }) {
  // An umbrella without a due date has no chip words.
  if (!view.chipText) return null;
  return (
    <span
      data-range-chip={view.tone}
      className={`inline-flex whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-semibold ${CHIP_CLASSES[view.tone]}`}
    >
      {view.chipText}
    </span>
  );
}

/** "3/5 steps" (amber "· behind pace", green "· all done"); a button that opens the steps for ticking. */
export function StepsPill({
  view,
  expanded,
  onToggle,
  controlsId,
  compact = false,
}: {
  view: RangeCardView;
  expanded: boolean;
  onToggle: () => void;
  controlsId: string;
  compact?: boolean;
}) {
  const text = stepsPillText(view, compact);
  if (!text || !view.steps) return null;
  const tone = view.allStepsDone
    ? "border-success-border text-success"
    : view.behindPace
      ? "border-warning-border text-amber-300"
      : "border-stroke text-foreground";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={controlsId}
      aria-label={`${view.steps.done} of ${view.steps.total} steps done, ${view.fillPercent ?? 0}%${
        view.behindPace ? ", behind pace" : ""
      }. ${expanded ? "Hide" : "Show"} steps`}
      className={`inline-flex items-center gap-1 rounded-full border bg-panel px-2 py-0.5 text-xs font-bold ${tone}`}
    >
      <span aria-hidden="true" className={`text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}>
        ▶
      </span>
      {text}
    </button>
  );
}

/** The sentence a screen reader gets for the card's range and progress. */
export function RangeSrText({ view }: { view: RangeCardView }) {
  return <span className="sr-only">{view.srText}</span>;
}

/** Phone: the M–S strip under a multi-day card (decorative; the chip says the same). */
export function DayStrip({ cells }: { cells: DayStripCell[] }) {
  return (
    <div aria-hidden="true" className="mt-2 flex gap-0.5">
      {cells.map((cell, index) => (
        <i
          key={index}
          title={cell.name}
          className={`flex-1 rounded border py-0.5 text-center text-xs font-bold not-italic ${
            cell.today ? "border-accent-text text-foreground" : "border-transparent"
          } ${
            cell.inRange
              ? cell.past
                ? "bg-violet-500/25 text-range-text"
                : "bg-range-soft text-range-text"
              : "text-muted-foreground"
          }`}
        >
          {cell.letter}
        </i>
      ))}
    </div>
  );
}
