"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { axisScale, columnWidth, formatTick, isAllEmpty, labelWidth, markerRows, runningTotal, xLabels, type MarkerDay } from "@/lib/launch-metrics/chart-model";
import { formatCount, formatWeekdayDay } from "@/lib/launch-metrics/format";

/**
 * The Launch page charts (Option A, Brent 10/28). Hand-drawn SVG drawn at the
 * box's real width (no stretched viewBox, so text and marks keep their size):
 * a y-axis with clean gridlines, a date under every day (thinned when the slot
 * gets narrow), value labels on the columns, numbered event markers in a lane
 * above the plot (the key is `EventKey`), and one tooltip that follows the
 * pointer, a tap, or the arrow keys once the chart has focus. One scale per
 * chart: a second measure gets its own chart (`TotalChart`), never a second axis.
 */

export interface ColumnSeries {
  label: string;
  /** A CSS colour, e.g. "var(--chart-1)". */
  color: string;
  /** One value per day; null = not known (drawn as nothing, "–" in the tooltip). */
  values: Array<number | null>;
  /** Counted series add up to the number on top of the column. Default true. */
  counted?: boolean;
}

export interface LegendItem {
  label: string;
  color?: string;
  kind: "box" | "line" | "hatch" | "marker";
}

const MARGIN_LEFT = 36;
const MARGIN_RIGHT = 8;
const MARGIN_BOTTOM = 26;
const CAP_ROOM = 20;
const MARKER_R = 10;
const MARKER_ROW = 24;
const TOOLTIP_WIDTH = 216;

function useBoxWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // A momentary 0 (hidden, mid-layout) keeps the last real width instead of blanking the chart.
    const measure = () => {
      const next = Math.round(node.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/** The day under the pointer, a tap (outside tap clears it) or the arrow keys. */
function useActiveDay(count: number, plotLeft: number, slot: number, boxRef: RefObject<HTMLDivElement | null>) {
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    if (active === null) return;
    const onDown = (event: globalThis.PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setActive(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [active, boxRef]);
  const dayAt = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const index = Math.floor((event.clientX - rect.left - plotLeft) / slot);
    return index >= 0 && index < count ? index : null;
  };
  return {
    active,
    svgHandlers: {
      onPointerMove: (event: PointerEvent<SVGSVGElement>) => setActive(dayAt(event)),
      onPointerDown: (event: PointerEvent<SVGSVGElement>) => setActive(dayAt(event)),
      onPointerLeave: (event: PointerEvent<SVGSVGElement>) => {
        if (event.pointerType === "mouse") setActive(null);
      },
    },
    groupHandlers: {
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        const keys: Record<string, (current: number) => number> = {
          ArrowRight: (current) => Math.min(count - 1, current + 1),
          ArrowLeft: (current) => Math.max(0, current - 1),
          Home: () => 0,
          End: () => count - 1,
        };
        if (event.key === "Escape") {
          setActive(null);
          return;
        }
        const move = keys[event.key];
        if (!move) return;
        event.preventDefault();
        setActive((current) => move(current ?? count - 1));
      },
      onFocus: () => setActive((current) => current ?? count - 1),
      onBlur: () => setActive(null),
    },
  };
}

function Tooltip({ children, cx, slot, width, top }: { children: ReactNode; cx: number; slot: number; width: number; top: number }) {
  const tipWidth = Math.min(TOOLTIP_WIDTH, width);
  // Beside the active day (right of it on the left half, left of it on the right half), never off the box.
  const preferred = cx < width / 2 ? cx + slot / 2 + 6 : cx - slot / 2 - 6 - tipWidth;
  const left = Math.max(0, Math.min(width - tipWidth, preferred));
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute z-10 rounded-lg border border-stroke bg-panel px-3 py-2 text-xs text-[color:var(--chart-text-2)] shadow-lg shadow-black/40"
      style={{ left, top, width: tipWidth }}
    >
      {children}
    </div>
  );
}

function TipRow({ color, value, label }: { color: string; value: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden="true" className="inline-block h-0.5 w-3 shrink-0 rounded-full" style={{ background: color }} />
      <b className="min-w-[1.25rem] font-semibold tabular-nums text-foreground">{value}</b>
      <span className="min-w-0">{label}</span>
    </div>
  );
}

function MarkerBadge({ number }: { number: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-grid h-5 w-5 shrink-0 place-items-center rounded-full border-[1.5px] border-[color:var(--chart-text-2)] bg-panel text-xs font-semibold tabular-nums text-foreground"
    >
      {number}
    </span>
  );
}

function TipEvents({ marker }: { marker: MarkerDay }) {
  const shown = marker.events.slice(0, 5);
  return (
    <div className="mt-2 space-y-0.5 border-t border-stroke pt-2">
      <div className="flex items-center gap-1.5 font-semibold text-foreground">
        <MarkerBadge number={marker.number} />
        {marker.events.length === 1 ? "1 event" : `${marker.events.length} events`}
      </div>
      {shown.map((event, index) => (
        <div key={index}>
          {event.timeLabel ? <span className="text-muted-foreground">{event.timeLabel} </span> : null}
          {event.label}
        </div>
      ))}
      {marker.events.length > shown.length ? <div className="text-muted-foreground">+ {marker.events.length - shown.length} more in the key below</div> : null}
    </div>
  );
}

/** Rounded top (4px), square base: the column shape from the mockup. */
function columnPath(x: number, top: number, width: number, height: number, rounded: boolean): string {
  if (height <= 0) return "";
  const r = rounded ? Math.min(4, width / 2, height) : 0;
  const bottom = top + height;
  return r
    ? `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${bottom}Z`
    : `M${x},${bottom}V${top}H${x + width}V${bottom}Z`;
}

interface Frame {
  width: number;
  height: number;
  top: number;
  plotHeight: number;
  slot: number;
  y: (value: number) => number;
  cx: (index: number) => number;
}

function makeFrame(width: number, height: number, count: number, top: number, max: number): Frame {
  const plotWidth = Math.max(1, width - MARGIN_LEFT - MARGIN_RIGHT);
  const plotHeight = Math.max(1, height - top - MARGIN_BOTTOM);
  const slot = count > 0 ? plotWidth / count : plotWidth;
  return {
    width,
    height,
    top,
    plotHeight,
    slot,
    y: (value: number) => top + plotHeight - (value / max) * plotHeight,
    cx: (index: number) => MARGIN_LEFT + slot * (index + 0.5),
  };
}

/** Gridlines, y labels and the date labels under the days. */
function Axes({ frame, ticks, dates }: { frame: Frame; ticks: number[]; dates: string[] }) {
  return (
    <g aria-hidden="true">
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={MARGIN_LEFT}
            x2={frame.width - MARGIN_RIGHT}
            y1={frame.y(tick)}
            y2={frame.y(tick)}
            stroke={tick === 0 ? "var(--chart-axis)" : "var(--chart-grid)"}
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
          <text x={MARGIN_LEFT - 8} y={frame.y(tick) + 4} textAnchor="end" fontSize={12} fill="var(--muted-foreground)" className="tabular-nums">
            {formatTick(tick)}
          </text>
        </g>
      ))}
      {xLabels(dates, frame.slot).map((label) => (
        <text key={label.index} x={frame.cx(label.index)} y={frame.height - 8} textAnchor="middle" fontSize={12} fill="var(--muted-foreground)">
          {label.text}
        </text>
      ))}
    </g>
  );
}

function HoverBand({ frame, index, fromY = frame.top }: { frame: Frame; index: number | null; fromY?: number }) {
  if (index === null) return null;
  return (
    <rect
      aria-hidden="true"
      x={MARGIN_LEFT + frame.slot * index + 1}
      y={fromY}
      width={Math.max(1, frame.slot - 2)}
      height={frame.top + frame.plotHeight - fromY}
      rx={6}
      fill="var(--chart-hover)"
    />
  );
}

/**
 * Daily columns on one count axis: stacked (sign-ups: real users, not
 * confirmed, family) or grouped side by side (website: visitors and page
 * views). Optional numbered event markers and a hatched "not tracked yet" span.
 */
export function ColumnChart({
  title,
  summary,
  dates,
  series,
  layout = "stacked",
  height = 220,
  markers = [],
  notTracked = null,
  notTrackedNote,
  uncountedCapLabel,
  emptyNote,
}: {
  title: string;
  /** One sentence for screen readers: the range and the headline numbers. */
  summary: string;
  dates: string[];
  series: ColumnSeries[];
  layout?: "stacked" | "grouped";
  height?: number;
  markers?: MarkerDay[];
  notTracked?: { from: number; to: number } | null;
  /** Tooltip text for a day in the not-tracked span. */
  notTrackedNote?: string;
  /** Text after the number when a column holds only uncounted values, e.g. "family". */
  uncountedCapLabel?: string;
  /** Shown over the plot when every day is zero. */
  emptyNote?: string;
}) {
  const { ref, width: measured } = useBoxWidth();
  const width = measured;
  const rawId = useId();
  const patternId = `hatch-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const count = dates.length;

  const stackTotal = (day: number) => series.reduce((sum, s) => sum + (s.values[day] ?? 0), 0);
  const peak =
    layout === "stacked" ? Math.max(0, ...dates.map((_, day) => stackTotal(day))) : Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const scale = axisScale(peak);

  const plotWidth = Math.max(1, width - MARGIN_LEFT - MARGIN_RIGHT);
  const slotGuess = count > 0 ? plotWidth / count : plotWidth;
  const markerX = markers.map((marker) => MARGIN_LEFT + slotGuess * (marker.index + 0.5));
  const rows = markerRows(markerX, MARKER_R * 2 + 4);
  const laneRows = markers.length ? Math.max(...rows) + 1 : 0;
  const laneHeight = laneRows * MARKER_ROW;
  const frame = makeFrame(width, height + laneHeight, count, laneHeight + CAP_ROOM, scale.max);

  const { active, svgHandlers, groupHandlers } = useActiveDay(count, MARGIN_LEFT, frame.slot, ref);
  const markerByIndex = new Map(markers.map((marker) => [marker.index, marker]));
  const inNotTracked = (day: number) => notTracked !== null && day >= notTracked.from && day <= notTracked.to;
  const empty = isAllEmpty(series.map((s) => s.values));

  const barWidth = columnWidth(frame.slot, layout === "grouped" ? series.length : 1);
  const showCaps = frame.slot >= 18;

  const columns: ReactNode[] = [];
  dates.forEach((date, day) => {
    if (inNotTracked(day)) return;
    if (layout === "stacked") {
      const x = frame.cx(day) - barWidth / 2;
      const parts = series.map((s) => ({ s, value: s.values[day] ?? 0 })).filter((part) => part.value > 0);
      let base = frame.y(0);
      parts.forEach((part, index) => {
        const full = frame.y(0) - frame.y(part.value);
        const gap = index > 0 ? 2 : 0;
        const top = base - full;
        columns.push(<path key={`${date}-${part.s.label}`} d={columnPath(x, top + gap, barWidth, full - gap, index === parts.length - 1)} fill={part.s.color} />);
        base = top;
      });
      if (parts.length && showCaps) {
        const counted = parts.filter((part) => part.s.counted !== false).reduce((sum, part) => sum + part.value, 0);
        const uncounted = parts.filter((part) => part.s.counted === false).reduce((sum, part) => sum + part.value, 0);
        const text = counted > 0 ? formatCount(counted) : uncountedCapLabel ? `${formatCount(uncounted)} ${uncountedCapLabel}` : formatCount(uncounted);
        if (labelWidth(text) <= frame.slot * 1.9 || counted > 0) {
          columns.push(
            <text key={`${date}-cap`} x={frame.cx(day)} y={base - 6} textAnchor="middle" fontSize={12} fontWeight={counted > 0 ? 600 : 400} fill={counted > 0 ? "var(--foreground)" : "var(--muted-foreground)"} className="tabular-nums">
              {text}
            </text>
          );
        }
      }
    } else {
      const groupWidth = barWidth * series.length + 2 * (series.length - 1);
      series.forEach((s, index) => {
        const value = s.values[day];
        if (value === null || value === undefined) return;
        const x = frame.cx(day) - groupWidth / 2 + index * (barWidth + 2);
        const full = frame.y(0) - frame.y(value);
        if (full > 0) columns.push(<path key={`${date}-${s.label}`} d={columnPath(x, frame.y(value), barWidth, full, true)} fill={s.color} />);
        if (showCaps && barWidth >= 9 && value > 0) {
          columns.push(
            <text key={`${date}-${s.label}-cap`} x={x + barWidth / 2} y={frame.y(value) - 6} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--foreground)" className="tabular-nums">
              {formatCount(value)}
            </text>
          );
        }
      });
    }
  });

  const activeMarker = active !== null ? markerByIndex.get(active) : undefined;
  const bandX = notTracked ? MARGIN_LEFT + frame.slot * notTracked.from : 0;
  const bandWidth = notTracked ? frame.slot * (notTracked.to - notTracked.from + 1) : 0;
  const bandLabel = bandWidth >= 110 ? "Not tracked yet" : bandWidth >= 84 ? "Not tracked" : null;

  return (
    <div
      ref={ref}
      role="group"
      aria-label={`${title}. Use the left and right arrow keys to read each day.`}
      tabIndex={0}
      className="relative w-full min-w-0 rounded-lg [contain:inline-size]"
      {...groupHandlers}
    >
      {width === 0 ? (
        <div role="img" aria-label={summary} style={{ height: frame.height }} />
      ) : (
      <svg role="img" aria-label={summary} width={width} height={frame.height} viewBox={`0 0 ${width} ${frame.height}`} className="block touch-pan-y select-none overflow-visible" {...svgHandlers}>
        <defs>
          <pattern id={patternId} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width={2} height={6} fill="var(--chart-hatch)" />
          </pattern>
        </defs>
        {notTracked ? (
          <g aria-hidden="true">
            <rect x={bandX} y={frame.top} width={bandWidth} height={frame.plotHeight} fill={`url(#${patternId})`} />
            {bandLabel ? (
              <text x={bandX + bandWidth / 2} y={frame.top + frame.plotHeight / 2 + 4} textAnchor="middle" fontSize={12} fill="var(--muted-foreground)" stroke="var(--panel)" strokeWidth={4} paintOrder="stroke">
                {bandLabel}
              </text>
            ) : null}
          </g>
        ) : null}
        <Axes frame={frame} ticks={scale.ticks} dates={dates} />
        <HoverBand frame={frame} index={active} fromY={laneHeight ? 0 : frame.top} />
        <g aria-hidden="true">{columns}</g>
        {empty && emptyNote ? (
          <text x={MARGIN_LEFT + plotWidth / 2} y={frame.top + frame.plotHeight / 2} textAnchor="middle" fontSize={12} fill="var(--muted-foreground)">
            {emptyNote}
          </text>
        ) : null}
        {markers.length ? (
          <g aria-hidden="true">
            {markers.map((marker, index) => {
              const cy = rows[index] * MARKER_ROW + MARKER_R + 2;
              const cx = frame.cx(marker.index);
              return (
                <g key={marker.date}>
                  <circle cx={cx} cy={cy} r={MARKER_R} fill="var(--panel)" stroke="var(--chart-text-2)" strokeWidth={1.5} />
                  <text x={cx} y={cy + 4} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--foreground)" className="tabular-nums">
                    {marker.number}
                  </text>
                </g>
              );
            })}
          </g>
        ) : null}
      </svg>
      )}
      {active !== null && width > 0 ? (
        <Tooltip cx={frame.cx(active)} slot={frame.slot} width={width} top={frame.top}>
          <div className="mb-1 font-semibold text-foreground">{formatWeekdayDay(dates[active])}</div>
          {inNotTracked(active) ? (
            <div className="text-muted-foreground">{notTrackedNote ?? "Not tracked yet."}</div>
          ) : (
            series.map((s) => {
              const value = s.values[active];
              return <TipRow key={s.label} color={s.color} value={value === null || value === undefined ? "–" : formatCount(value)} label={s.label} />;
            })
          )}
          {activeMarker ? <TipEvents marker={activeMarker} /> : null}
        </Tooltip>
      ) : null}
    </div>
  );
}

/**
 * The running total as a small step chart on the same days as the columns
 * above it (same left margin, so the days line up). Values come from the
 * stored as-of totals (`runningTotal` carries a value over days with no
 * stored total; nothing is drawn before the first or after the last one).
 */
export function TotalChart({
  title,
  summary,
  dates,
  totals,
  dailyNew,
  color = "var(--chart-1)",
  height = 130,
  emptyNote = "No total stored yet.",
}: {
  title: string;
  summary: string;
  dates: string[];
  /** Stored totals per day (null = none stored that day). */
  totals: Array<number | null>;
  /** That day's new counted users, for the tooltip. */
  dailyNew?: number[];
  color?: string;
  height?: number;
  emptyNote?: string;
}) {
  const { ref, width: measured } = useBoxWidth();
  const width = measured;
  const values = runningTotal(totals);
  const known = values.filter((value): value is number => value !== null);
  const scale = axisScale(Math.max(0, ...known));
  const frame = makeFrame(width, height, dates.length, CAP_ROOM, scale.max);
  const { active, svgHandlers, groupHandlers } = useActiveDay(dates.length, MARGIN_LEFT, frame.slot, ref);

  // Step-after path per run of known values; the level changes at the middle of the day it changed.
  const segments: string[] = [];
  const areas: string[] = [];
  let start = -1;
  let lastKnown = -1;
  values.forEach((value, index) => {
    if (value !== null) lastKnown = index;
    const runEnds = value === null || index === values.length - 1;
    if (value !== null && start < 0) start = index;
    if (runEnds && start >= 0) {
      const end = value === null ? index - 1 : index;
      const left = MARGIN_LEFT + frame.slot * start + 2;
      const right = MARGIN_LEFT + frame.slot * (end + 1) - 2;
      let d = `M${left},${frame.y(values[start] as number)}`;
      for (let day = start + 1; day <= end; day += 1) {
        d += `H${frame.cx(day)}V${frame.y(values[day] as number)}`;
      }
      d += `H${right}`;
      segments.push(d);
      areas.push(`${d}V${frame.y(0)}H${left}Z`);
      start = -1;
    }
  });

  const activeValue = active !== null ? values[active] : null;

  return (
    <div ref={ref} role="group" aria-label={`${title}. Use the left and right arrow keys to read each day.`} tabIndex={0} className="relative w-full min-w-0 rounded-lg [contain:inline-size]" {...groupHandlers}>
      {width === 0 ? (
        <div role="img" aria-label={summary} style={{ height: frame.height }} />
      ) : (
      <svg role="img" aria-label={summary} width={width} height={frame.height} viewBox={`0 0 ${width} ${frame.height}`} className="block touch-pan-y select-none overflow-visible" {...svgHandlers}>
        <Axes frame={frame} ticks={scale.ticks} dates={dates} />
        <HoverBand frame={frame} index={active} />
        <g aria-hidden="true">
          {areas.map((d, index) => (
            <path key={`a${index}`} d={d} fill="var(--chart-1-wash)" />
          ))}
          {segments.map((d, index) => (
            <path key={`l${index}`} d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {active !== null && activeValue !== null ? <circle cx={frame.cx(active)} cy={frame.y(activeValue)} r={5} fill={color} stroke="var(--panel)" strokeWidth={2} /> : null}
          {lastKnown >= 0 ? (
            <>
              <circle cx={frame.cx(lastKnown)} cy={frame.y(values[lastKnown] as number)} r={4} fill={color} stroke="var(--panel)" strokeWidth={2} />
              <text x={frame.cx(lastKnown)} y={frame.y(values[lastKnown] as number) - 9} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--foreground)" className="tabular-nums">
                {formatCount(values[lastKnown] as number)}
              </text>
            </>
          ) : (
            <text x={MARGIN_LEFT + (width - MARGIN_LEFT - MARGIN_RIGHT) / 2} y={frame.top + frame.plotHeight / 2} textAnchor="middle" fontSize={12} fill="var(--muted-foreground)">
              {emptyNote}
            </text>
          )}
        </g>
      </svg>
      )}
      {active !== null && width > 0 ? (
        <Tooltip cx={frame.cx(active)} slot={frame.slot} width={width} top={4}>
          <div className="mb-1 font-semibold text-foreground">{formatWeekdayDay(dates[active])}</div>
          <TipRow color={color} value={activeValue === null ? "–" : formatCount(activeValue)} label={title} />
          {dailyNew && activeValue !== null ? <div className="mt-1 text-muted-foreground">{dailyNew[active] ? `+${formatCount(dailyNew[active])} that day` : "No new ones that day"}</div> : null}
          {activeValue === null ? <div className="mt-1 text-muted-foreground">No total stored for this day.</div> : null}
        </Tooltip>
      ) : null}
    </div>
  );
}

/** Legend under a chart: a swatch that mirrors the mark (box for columns, line for lines, hatch, numbered marker). */
export function ChartLegend({ items }: { items: LegendItem[] }) {
  return (
    <ul aria-label="Legend" className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-[color:var(--chart-text-2)]">
      {items.map((item) => (
        <li key={item.label} className="inline-flex items-center gap-1.5">
          {item.kind === "box" ? <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: item.color }} /> : null}
          {item.kind === "line" ? <span aria-hidden="true" className="inline-block h-0.5 w-4 shrink-0 rounded-full" style={{ background: item.color }} /> : null}
          {item.kind === "hatch" ? (
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-3 shrink-0 rounded-sm border border-[color:var(--chart-axis)]"
              style={{ background: "repeating-linear-gradient(45deg, var(--chart-hatch) 0 2px, transparent 2px 5px)" }}
            />
          ) : null}
          {item.kind === "marker" ? <MarkerBadge number={1} /> : null}
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/** The numbered key for the event markers (New York times), open by default. */
export function EventKey({ markers }: { markers: MarkerDay[] }) {
  if (markers.length === 0) return null;
  const eventCount = markers.reduce((sum, marker) => sum + marker.events.length, 0);
  return (
    <details open className="mt-4 rounded-xl bg-panel-muted px-3 py-2.5 text-sm">
      <summary className="cursor-pointer font-semibold text-[color:var(--chart-text-2)]">
        Launch events: {markers.length === 1 ? "1 day" : `${markers.length} days`}, {eventCount === 1 ? "1 event" : `${eventCount} events`} (New York time)
      </summary>
      <ol className="mt-2 space-y-2">
        {markers.map((marker) => (
          <li key={marker.date} className="flex items-start gap-2 text-[color:var(--chart-text-2)]">
            <MarkerBadge number={marker.number} />
            <div className="min-w-0">
              <span className="font-semibold text-foreground">{formatWeekdayDay(marker.date)}</span>
              <ul className="mt-0.5 space-y-0.5">
                {marker.events.map((event, index) => (
                  <li key={index} className="[overflow-wrap:anywhere]">
                    {event.timeLabel ? <span className="mr-1.5 tabular-nums text-muted-foreground">{event.timeLabel}</span> : null}
                    {event.label} <span className="text-muted-foreground">· {event.kind}</span>
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}
