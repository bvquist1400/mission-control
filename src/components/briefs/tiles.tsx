"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type {
  BriefContent,
  BriefCounts,
  BriefItemRow,
  BriefMeeting,
  BriefTaskSummary,
  BriefTile,
  BriefTileType,
} from "@/lib/briefs/types";
import { TaskLink } from "@/components/briefs/cards";
import { etClock, etMinutes, etTime, hourTick } from "@/components/briefs/format";

function OpenButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="open stretch" onClick={onClick}>
      {label} <span className="chev">›</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Hero: how much is left to decide
// ---------------------------------------------------------------------------

export function HeroTile({
  code,
  heading,
  savedAt,
  counts,
  stats,
  wide,
}: {
  code: string;
  heading: string;
  savedAt: string;
  counts: BriefCounts;
  stats: BriefContent["stats"];
  wide: boolean;
}) {
  const decided = counts.total - counts.open;
  const pct = counts.total ? (decided / counts.total) * 100 : 100;
  return (
    <article className={`tile hero ${wide ? "span-6" : "span-4"}`}>
      <div className="hero-text">
        <div className="eyebrow">
          <span className="code">{code}</span>
          <span>
            {heading} · saved {etTime(savedAt)}
          </span>
        </div>
        <h1>
          {counts.open ? (
            <>
              {counts.open} left<span className="dim">to decide</span>
            </>
          ) : (
            <>
              All decided<span className="dim">nothing left open</span>
            </>
          )}
        </h1>
        <div className="where">
          {counts.from_meetings ? (
            <span>
              <b>{counts.from_meetings}</b> from meetings
            </span>
          ) : null}
          {counts.calls ? (
            <span>
              <b>{counts.calls}</b> {counts.calls === 1 ? "needs" : "need"} a call
            </span>
          ) : null}
        </div>
        <div className="prog" role="img" aria-label={`${decided} of ${counts.total} decided`}>
          <span style={{ width: `${pct.toFixed(1)}%` }} />
        </div>
        <div className="prog-l">
          {decided} of {counts.total} decided
        </div>
        {stats?.length ? (
          <div className="stats">
            {stats.map((stat) => (
              <span key={stat.key}>
                <b>{stat.value}</b> {stat.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Next day: agenda, with a clash line that follows its choice item
// ---------------------------------------------------------------------------

export function NextTile({
  next,
  items,
  movesCount,
  onOpen,
}: {
  next: NonNullable<BriefContent["next"]>;
  items: BriefItemRow[];
  movesCount: number;
  onOpen: () => void;
}) {
  return (
    <article className="tile span-2 link">
      <div className="tile-k">{next.label}</div>
      <ul className="agenda">
        {next.agenda.map((line, index) => {
          const choice = line.choice_n ? items.find((item) => item.n === line.choice_n) : undefined;
          const picked =
            choice?.state === "decided" ? choice.payload.options?.find((option) => option.key === choice.choice)?.label : undefined;
          const className = choice ? (picked ? "picked" : "clash") : undefined;
          return (
            <li key={`${line.time}-${index}`} className={className}>
              <span className="tm">{line.time}</span>
              <span>{choice ? (picked ? `${picked} ✓` : `${line.title} · pick in #${choice.n}`) : line.title}</span>
            </li>
          );
        })}
      </ul>
      <div className="tile-foot">
        <OpenButton label={movesCount ? `${movesCount} first move${movesCount === 1 ? "" : "s"}` : "Details"} onClick={onOpen} />
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Day timeline: meetings as coloured blocks (hatched = no notes); tap to filter
// ---------------------------------------------------------------------------

export function DayTile({
  meetings,
  savedAt,
  filter,
  onFilter,
  meetingColor,
  openCounts,
}: {
  meetings: BriefMeeting[];
  savedAt: string;
  filter: string | null;
  onFilter: (meetingId: string) => void;
  meetingColor: (meetingId: string) => string;
  openCounts: Record<string, number>;
}) {
  const spans = meetings
    .map((meeting) => {
      const start = etMinutes(meeting.start);
      if (start === null) return null;
      const end = Math.max(start, etMinutes(meeting.end) ?? start);
      return { meeting, start, end };
    })
    .filter((span): span is { meeting: BriefMeeting; start: number; end: number } => span !== null);
  const saved = etMinutes(savedAt);

  const first = Math.min(8 * 60, ...spans.map((span) => span.start));
  const last = Math.max(17 * 60, ...spans.map((span) => span.end), saved ?? 0);
  const S = Math.floor(first / 60) * 60;
  const E = Math.ceil(last / 60) * 60;
  const pct = (minutes: number) => `${(((minutes - S) / (E - S)) * 100).toFixed(2)}%`;
  const ticks: number[] = [];
  for (let hour = S / 60; hour <= E / 60; hour += 2) ticks.push(hour);

  const withNotes = spans.filter((span) => span.meeting.id && span.meeting.has_notes);
  const withoutNotes = spans.filter((span) => !(span.meeting.id && span.meeting.has_notes));

  return (
    <article className="tile span-6">
      <div className="tile-k">
        Meetings · {spans.length} on the calendar, {withNotes.length} with notes
      </div>
      <div className="track-wrap">
        <div className="ticks">
          {ticks.map((hour) => (
            <span key={hour} style={{ left: pct(hour * 60) }}>
              {hourTick(hour)}
            </span>
          ))}
        </div>
        <div className="bar" />
        {spans.map(({ meeting, start, end }) => {
          const style = { left: pct(start), width: `${(((end - start) / (E - S)) * 100).toFixed(2)}%` };
          if (!meeting.id || !meeting.has_notes) {
            return <span key={`${meeting.title}-${meeting.start}`} className="blk nonotes" style={style} title={`${meeting.title} (no notes)`} />;
          }
          const id = meeting.id;
          return (
            <button
              key={id}
              type="button"
              className={`blk notes ${filter && filter !== id ? "dim" : ""}`}
              style={{ ...style, ["--mc" as string]: meetingColor(id) }}
              title={meeting.title}
              aria-label={`${meeting.title}, show only its items`}
              aria-pressed={filter === id}
              onClick={() => onFilter(id)}
            />
          );
        })}
        {saved !== null ? <span className="blk now" style={{ left: pct(saved) }} title={`Brief saved ${etTime(savedAt)}`} /> : null}
      </div>
      <div className="mchips">
        {withNotes.map(({ meeting }) => {
          const id = meeting.id as string;
          const count = openCounts[id] ?? 0;
          return (
            <button
              key={id}
              type="button"
              className="mchip"
              style={{ ["--mc" as string]: meetingColor(id) }}
              aria-pressed={filter === id}
              onClick={() => onFilter(id)}
            >
              <span className="dot" />
              {meeting.short ?? meeting.title} <span className="t">{etClock(meeting.start)}</span>
              {count ? <span className="c">{count}</span> : null}
            </button>
          );
        })}
        {withoutNotes.length ? (
          <span className="mchip nonote">
            No notes: {withoutNotes.map(({ meeting }) => `${meeting.short ?? meeting.title} ${etClock(meeting.start)}`).join(", ")}
          </span>
        ) : null}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Recap tiles: data-driven labels; one renderer per tile type
// ---------------------------------------------------------------------------

type TileProps = { tile: BriefTile; onOpen: () => void };
type SheetProps = { tile: BriefTile; tasks: Record<string, BriefTaskSummary> };

function TileRows({ tile, tasks }: SheetProps) {
  return (
    <>
      {(tile.groups ?? []).map((group, groupIndex) => (
        <div key={groupIndex}>
          {group.label ? <p className="subh">{group.label}</p> : null}
          <ul className="rows">
            {group.rows.map((row, rowIndex) => (
              <li key={rowIndex}>
                <div className="r">
                  <span style={{ fontWeight: 500 }}>{row.title}</span>
                  {row.task_id ? <TaskLink id={row.task_id} /> : null}
                </div>
                {row.meta ? <span className="meta">{row.meta}</span> : null}
                {row.task_id && tasks[row.task_id] && tasks[row.task_id].title !== row.title ? (
                  <span className="meta">{tasks[row.task_id].title}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

function SheetExtras({ tile }: { tile: BriefTile }) {
  return (
    <>
      {tile.list?.length ? (
        <>
          {tile.list_label ? <p className="subh">{tile.list_label}</p> : null}
          <ol className="moves">
            {tile.list.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ol>
        </>
      ) : null}
      {tile.footnote ? <p className="meta" style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>{tile.footnote}</p> : null}
    </>
  );
}

export const TILE_REGISTRY: Record<
  BriefTileType,
  { span: string; Tile: (props: TileProps) => ReactNode; Sheet: (props: SheetProps) => ReactNode }
> = {
  narrative: {
    span: "span-4 row-2",
    Tile: ({ tile, onOpen }) => (
      <>
        <div className="tile-k">{tile.label}</div>
        {tile.text ? <p className="narr">{tile.text}</p> : null}
        <div className="tile-foot">
          <OpenButton label={tile.list_label ? `With ${tile.list_label.toLowerCase()}` : "Open"} onClick={onOpen} />
        </div>
      </>
    ),
    Sheet: ({ tile, tasks }) => (
      <>
        {tile.text ? <p className="narr">{tile.text}</p> : null}
        <SheetExtras tile={tile} />
        <TileRows tile={tile} tasks={tasks} />
      </>
    ),
  },
  list: {
    span: "span-2",
    Tile: ({ tile, onOpen }) => (
      <>
        <div className="tile-k">{tile.label}</div>
        {tile.value !== undefined ? (
          <div className="tile-n">
            {tile.value}
            {tile.suffix ? <small>{tile.suffix}</small> : null}
          </div>
        ) : null}
        {tile.summary ? <p className="tile-p">{tile.summary}</p> : null}
        <div className="tile-foot">
          <OpenButton label="Open" onClick={onOpen} />
        </div>
      </>
    ),
    Sheet: ({ tile, tasks }) => (
      <>
        {tile.text ? <p className="narr">{tile.text}</p> : null}
        <TileRows tile={tile} tasks={tasks} />
        <SheetExtras tile={tile} />
      </>
    ),
  },
};

export function RecapBento({ tiles, onOpen }: { tiles: BriefTile[]; onOpen: (key: string) => void }) {
  return (
    <div className="bento">
      {tiles.map((tile) => {
        const entry = TILE_REGISTRY[tile.type];
        return (
          <article key={tile.key} className={`tile ${entry.span} link`}>
            <entry.Tile tile={tile} onOpen={() => onOpen(`tile:${tile.key}`)} />
          </article>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Side sheet
// ---------------------------------------------------------------------------

export function Sheet({ eyebrow, title, onClose, children }: { eyebrow: string; title: string; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="sheet-host">
      <div className="sheet-bd" onClick={onClose} />
      <aside className="sheet" role="dialog" aria-modal="true" aria-labelledby="brief-sheet-title">
        <header>
          <div>
            <div className="tile-k">{eyebrow}</div>
            <h2 id="brief-sheet-title">{title}</h2>
          </div>
          <button ref={closeRef} type="button" className="x" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </aside>
    </div>
  );
}
