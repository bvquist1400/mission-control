import { formatCount, formatDay } from "@/lib/launch-metrics/format";

export interface ChartSeries {
  label: string;
  /** Tailwind fill class, e.g. "fill-accent". */
  fillClass: string;
  /** Legend swatch background class, e.g. "bg-accent". */
  swatchClass: string;
}

export interface ChartLine {
  label: string;
  values: Array<number | null>;
  strokeClass: string;
  swatchClass: string;
}

export interface ChartMarker {
  date: string;
  label: string;
}

const WIDTH = 600;
const HEIGHT = 160;
const TOP = 8;

/**
 * Small hand-rolled daily bar chart (stacked series) with an optional line on
 * its own scale and milestone ticks. The SVG stretches to its box; every label
 * is HTML so text stays readable at phone width. Server component, no JS.
 */
export function DailyChart({
  title,
  dates,
  series,
  values,
  line,
  markers = [],
  zoneNote,
}: {
  title: string;
  dates: string[];
  series: ChartSeries[];
  /** values[seriesIndex][dayIndex] */
  values: number[][];
  line?: ChartLine;
  markers?: ChartMarker[];
  zoneNote: string;
}) {
  const count = dates.length;
  const stackTotals = dates.map((_, day) => series.reduce((sum, _s, index) => sum + (values[index]?.[day] ?? 0), 0));
  const peak = Math.max(0, ...stackTotals);
  const barMax = Math.max(1, peak);
  const lineValues = line?.values ?? [];
  const lineMax = Math.max(1, ...lineValues.map((value) => value ?? 0));
  const slot = count > 0 ? WIDTH / count : WIDTH;
  const barWidth = Math.max(1, slot * 0.7);
  const plotHeight = HEIGHT - TOP;
  const y = (value: number, max: number) => HEIGHT - (value / max) * plotHeight;

  const linePoints = lineValues
    .map((value, index) => (value === null ? null : `${(index + 0.5) * slot},${y(value, lineMax)}`))
    .filter(Boolean)
    .join(" ");

  const summary = `${title}: ${dates.length} days from ${dates[0] ? formatDay(dates[0]) : "–"} to ${
    dates.length ? formatDay(dates[dates.length - 1]) : "–"
  }, highest day ${formatCount(peak)}.`;

  return (
    <figure className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{formatCount(peak)} max per day</span>
        {line ? <span>{line.label}: {formatCount(Math.max(0, ...lineValues.map((v) => v ?? 0)))} max</span> : null}
      </div>
      <svg
        role="img"
        aria-label={summary}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-40 w-full rounded-lg bg-panel-muted"
      >
        {dates.map((date, day) => {
          let base = HEIGHT;
          return series.map((s, index) => {
            const value = values[index]?.[day] ?? 0;
            if (value <= 0) return null;
            const height = (value / barMax) * plotHeight;
            base -= height;
            return (
              <rect key={`${date}-${s.label}`} x={day * slot + (slot - barWidth) / 2} y={base} width={barWidth} height={height} className={s.fillClass}>
                <title>{`${formatDay(date)}: ${formatCount(value)} ${s.label.toLowerCase()}`}</title>
              </rect>
            );
          });
        })}
        {markers.map((marker) => {
          const index = dates.indexOf(marker.date);
          if (index < 0) return null;
          const x = (index + 0.5) * slot;
          return (
            <line key={`${marker.date}-${marker.label}`} x1={x} x2={x} y1={0} y2={HEIGHT} className="stroke-muted-foreground" strokeDasharray="3 4" strokeWidth={1} vectorEffect="non-scaling-stroke">
              <title>{`${formatDay(marker.date)}: ${marker.label}`}</title>
            </line>
          );
        })}
        {line && linePoints ? (
          <polyline points={linePoints} fill="none" className={line.strokeClass} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        ) : null}
      </svg>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{dates[0] ? formatDay(dates[0]) : ""}</span>
        <span>{zoneNote}</span>
        <span>{dates.length ? formatDay(dates[dates.length - 1]) : ""}</span>
      </div>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {series.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-sm ${s.swatchClass}`} />
            {s.label}
          </span>
        ))}
        {line ? (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={`inline-block h-0.5 w-3 ${line.swatchClass}`} />
            {line.label} (own scale)
          </span>
        ) : null}
        {markers.length > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-3 w-0 border-l border-dashed border-muted-foreground" />
            Launch timeline events
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}
