/**
 * Pure layout maths for the Launch page charts (DailyChart.tsx). No React, no
 * DOM: the component measures its width and asks this module for the y-axis,
 * which days get a date label, how the event markers are numbered and placed,
 * the running total and the "not tracked yet" span. Kept pure so the offline
 * tests can pin every rule.
 */

import { formatCount, formatDay } from './format';

// ─── y-axis ───────────────────────────────────────────────────────────────

export interface AxisScale {
  /** Top of the axis (a clean number at or above the peak). */
  max: number;
  /** Gridline values from 0 to max, evenly spaced, 2 to 6 of them. */
  ticks: number[];
}

/**
 * A clean y-axis for a peak value: small counts get one gridline per whole
 * number (at least 0, 1, 2 so a single sign-up doesn't fill the chart), larger
 * ones a 1/2/5 step that gives 3 to 5 intervals. A chart with nothing in it
 * still gets a 0 and a 1, so it reads as "zero" rather than a broken frame.
 */
export function axisScale(peak: number): AxisScale {
  const value = Number.isFinite(peak) ? Math.max(0, peak) : 0;
  if (value <= 0) {
    return { max: 1, ticks: [0, 1] };
  }
  if (value <= 5) {
    const max = Math.max(2, Math.ceil(value));
    return { max, ticks: Array.from({ length: max + 1 }, (_, index) => index) };
  }
  const raw = value / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  const factor = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 && magnitude >= 10 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = Math.max(1, factor * magnitude);
  const max = Math.ceil(value / step) * step;
  const ticks: number[] = [];
  for (let tick = 0; tick <= max + 1e-9; tick += step) {
    ticks.push(Math.round(tick));
  }
  return { max, ticks };
}

/** Axis numbers: 0, 25, 1,000 → "1K", 1,500 → "1.5K", 2,000,000 → "2M". */
export function formatTick(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `${trimDecimal(value / 1_000_000)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${trimDecimal(value / 1_000)}K`;
  }
  return formatCount(value);
}

function trimDecimal(value: number): string {
  return String(Math.round(value * 10) / 10);
}

// ─── x-axis ───────────────────────────────────────────────────────────────

export interface XLabel {
  index: number;
  text: string;
}

/** Day slot width from which every day gets its full "Oct 21" label. */
export const FULL_LABEL_SLOT = 50;
/** Smallest gap between two day-number labels ("21", "22"). */
const MIN_LABEL_GAP = 26;
const LABEL_STEPS = [1, 2, 3, 4, 7, 14, 28];

/** Rough rendered width of a 12px label: about 6.8px a character plus a little air. */
export function labelWidth(text: string): number {
  return text.length * 6.8 + 6;
}

function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

function dayNumber(isoDate: string): string {
  return String(Number(isoDate.slice(8, 10)));
}

/**
 * Which days get a date under them, given the width of one day's slot in
 * pixels. Wide slots: every day, "Oct 21". Narrower: every day (or every 2nd,
 * 3rd, 7th… day when crowded) with the month only on the first label and where
 * the month changes ("Oct 30", "31", "Nov 1"). The first and last days are
 * always labelled; an inner label that would collide with a neighbour is
 * dropped.
 */
export function xLabels(dates: string[], slot: number): XLabel[] {
  if (dates.length === 0) {
    return [];
  }
  if (slot >= FULL_LABEL_SLOT) {
    return dates.map((date, index) => ({ index, text: formatDay(date) }));
  }
  const step = LABEL_STEPS.find((candidate) => candidate * slot >= MIN_LABEL_GAP) ?? LABEL_STEPS[LABEL_STEPS.length - 1];
  const picked: number[] = [];
  for (let index = 0; index < dates.length; index += step) {
    picked.push(index);
  }
  const last = dates.length - 1;
  if (picked[picked.length - 1] !== last) {
    picked.push(last);
  }
  const withText = (indexes: number[]): XLabel[] => {
    let previousMonth = '';
    return indexes.map((index) => {
      const month = monthOf(dates[index]);
      const text = month !== previousMonth ? formatDay(dates[index]) : dayNumber(dates[index]);
      previousMonth = month;
      return { index, text };
    });
  };
  const collides = (left: XLabel, right: XLabel) => (right.index - left.index) * slot < (labelWidth(left.text) + labelWidth(right.text)) / 2;
  // Keep the first and last day; drop inner labels that would touch a neighbour,
  // then re-letter (a dropped label can move the month onto the next one) until stable.
  let indexes = picked;
  for (let round = 0; round < 6; round += 1) {
    const labels = withText(indexes);
    const kept: XLabel[] = [labels[0]];
    for (let position = 1; position < labels.length; position += 1) {
      const label = labels[position];
      if (position === labels.length - 1) {
        while (kept.length > 1 && collides(kept[kept.length - 1], label)) kept.pop();
        if (kept.length === 1 && collides(kept[0], label) && labels.length > 1) {
          // Only two labels and they touch: the last day wins.
          kept.pop();
        }
        kept.push(label);
      } else if (!collides(kept[kept.length - 1], label)) {
        kept.push(label);
      }
    }
    const next = kept.map((label) => label.index);
    if (next.length === indexes.length) {
      return withText(next);
    }
    indexes = next;
  }
  return withText(indexes);
}

// ─── event markers ────────────────────────────────────────────────────────

export interface MarkerInput {
  date: string;
  label: string;
  kind: string;
  /** "3:19 PM" New York, when known. */
  timeLabel?: string | null;
}

export interface MarkerDay {
  date: string;
  /** Index into the chart's dates. */
  index: number;
  /** 1-based number shown in the marker and the key, in date order. */
  number: number;
  events: Array<{ label: string; kind: string; timeLabel: string | null }>;
}

/**
 * One numbered marker per day that has events, numbered 1, 2, 3… in date order.
 * Events outside the chart's days are left out (they stay in the timeline list).
 * Within a day the events keep the order they came in (the page reads them
 * oldest first).
 */
export function markerDays(dates: string[], markers: MarkerInput[]): MarkerDay[] {
  const position = new Map(dates.map((date, index) => [date, index] as const));
  const byDate = new Map<string, MarkerDay['events']>();
  for (const marker of markers) {
    if (!position.has(marker.date)) {
      continue;
    }
    const list = byDate.get(marker.date) ?? [];
    list.push({ label: marker.label, kind: marker.kind, timeLabel: marker.timeLabel ?? null });
    byDate.set(marker.date, list);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, events], order) => ({ date, index: position.get(date) as number, number: order + 1, events }));
}

/**
 * Rows for the marker lane so numbered circles never overlap: each marker goes
 * in the first row where it clears the previous one by `minGap` pixels, up to
 * `maxRows`; past that it takes the row whose last marker is furthest away.
 */
export function markerRows(xs: number[], minGap: number, maxRows = 3): number[] {
  const lastX: number[] = [];
  return xs.map((x) => {
    for (let row = 0; row < maxRows; row += 1) {
      if (lastX[row] === undefined || x - lastX[row] >= minGap) {
        lastX[row] = x;
        return row;
      }
    }
    let best = 0;
    for (let row = 1; row < maxRows; row += 1) {
      if (lastX[row] < lastX[best]) best = row;
    }
    lastX[best] = x;
    return best;
  });
}

// ─── series helpers ───────────────────────────────────────────────────────

/**
 * The running total line from the stored as-of totals: a known value carries
 * forward over days with no stored total until the next known value; days
 * before the first known value and after the last one are null (not drawn),
 * so the line never claims a number nobody stored.
 */
export function runningTotal(values: Array<number | null>): Array<number | null> {
  let lastKnownIndex = -1;
  values.forEach((value, index) => {
    if (value !== null) lastKnownIndex = index;
  });
  const out: Array<number | null> = [];
  let carry: number | null = null;
  values.forEach((value, index) => {
    if (value !== null) carry = value;
    out.push(index > lastKnownIndex ? null : carry);
  });
  return out;
}

/** Days before `trackingSince` as an index span (inclusive), or null when none are. */
export function notTrackedSpan(dates: string[], trackingSince: string | null): { from: number; to: number } | null {
  if (!trackingSince || dates.length === 0) {
    return null;
  }
  let to = -1;
  dates.forEach((date, index) => {
    if (date < trackingSince) to = index;
  });
  return to < 0 ? null : { from: 0, to };
}

/** Column width for a day slot: about 55% of the slot, never wider than 24px, at least 2px. */
export function columnWidth(slot: number, groups = 1): number {
  const total = Math.min(24 * groups, slot * (groups > 1 ? 0.7 : 0.55));
  return Math.max(2, groups > 1 ? (total - 2 * (groups - 1)) / groups : total);
}

/** True when every value is zero or missing (the chart then says so). */
export function isAllEmpty(series: Array<Array<number | null>>): boolean {
  return series.every((values) => values.every((value) => value === null || value === 0));
}
