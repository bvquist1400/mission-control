"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { ProjectSquare, resolveSquareFromCatalog, shortProjectName } from "@/components/project-colors/ProjectSquare";
import { useProjectColors } from "@/components/project-colors/ProjectColorsProvider";
import type { ColorEntity, ProjectColorEntity } from "@/lib/project-colors";
import { meetingCountdown, meetingLength, nextMeetingOf, stripDateLabel } from "@/lib/today/today-board";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";

const TIME_ZONE = DEFAULT_WORKDAY_CONFIG.timezone;

export interface StripEvent {
  title: string;
  start: string;
  end: string;
  location: string | null;
}

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: TIME_ZONE }).format(date);
}

type SquareInput = { app: ColorEntity | null; project: ProjectColorEntity | null };

/** The colour key at the end of the strip: one square per app / project on the board, then Edit colours. */
function BoardLegend({ inputs }: { inputs: SquareInput[] }) {
  const colors = useProjectColors();
  const entries = useMemo(() => {
    const seen = new Map<string, { id: string; input: SquareInput; name: string }>();
    for (const input of inputs) {
      const square = resolveSquareFromCatalog(colors, input.app, input.project);
      if (!square || seen.has(square.owner.id)) continue;
      seen.set(square.owner.id, { id: square.owner.id, input, name: shortProjectName(square.owner.name) });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [inputs, colors]);

  if (entries.length === 0 && !colors.available) return null;
  const shown = entries.slice(0, 8);
  return (
    <div className="tb-legend" aria-label="Project colours on this board">
      {shown.map((entry) =>
        colors.available ? (
          <button key={entry.id} type="button" className="tb-key" onClick={() => colors.openEditor(entry.id)} aria-label={`${entry.name} colour: edit colours`}>
            <ProjectSquare {...entry.input} editable={false} />
            {entry.name}
          </button>
        ) : (
          <span key={entry.id}>
            <ProjectSquare {...entry.input} editable={false} />
            {entry.name}
          </span>
        )
      )}
      {entries.length > shown.length ? <span>+{entries.length - shown.length}</span> : null}
      {colors.available ? (
        <button type="button" className="tb-edit" onClick={() => colors.openEditor()}>
          Edit colours
        </button>
      ) : null}
    </div>
  );
}

/**
 * Now + today's meetings as ONE line under the menu (redesign S4; Brent 11/5:
 * "I dont really utalize the "todays meetings" or "now" section"): the date,
 * the meeting in progress or next (time, title, length, countdown), and how
 * many more are left today, which unfolds the day's list. The legend and
 * Edit colours sit at the right.
 */
export function TodayStrip({
  todayDate,
  events,
  meetingsFailed,
  workCalendarNote,
  chips,
  legendInputs,
}: {
  todayDate: string;
  events: StripEvent[];
  meetingsFailed: boolean;
  /** Personal mode: the meetings are the work calendar's. */
  workCalendarNote: boolean;
  chips?: ReactNode;
  legendInputs: SquareInput[];
}) {
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const listId = useId();

  // The countdown is the browser's (the server's clock would not match on hydration).
  useEffect(() => {
    const first = window.setTimeout(() => setNowMs(Date.now()), 0);
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, []);

  const sorted = useMemo(
    () => [...events].filter((event) => Number.isFinite(Date.parse(event.start))).sort((a, b) => Date.parse(a.start) - Date.parse(b.start)),
    [events]
  );
  const { next, moreLater } = nextMeetingOf(sorted, nowMs ?? 0);
  const label = workCalendarNote ? "Work calendar" : null;

  return (
    <div className="tb-strip" role="region" aria-label="Today at a glance">
      <b>{stripDateLabel(todayDate)}</b>
      <span className="tb-sep" aria-hidden="true" />
      {meetingsFailed ? (
        <span>Meetings didn&apos;t load</span>
      ) : nowMs === null ? (
        <span>{sorted.length === 0 ? "No meetings today" : `${sorted.length} ${sorted.length === 1 ? "meeting" : "meetings"} today`}</span>
      ) : next ? (
        <span>
          {label ? `${label} · ` : ""}Next: <b>{clock(next.start)} {next.title || "Untitled meeting"}</b>
          {meetingLength(next) ? ` · ${meetingLength(next)}` : ""} · {meetingCountdown(next, nowMs)}
        </span>
      ) : (
        <span>{sorted.length === 0 ? "No meetings today" : "No more meetings today"}</span>
      )}
      {sorted.length > 0 && !meetingsFailed ? (
        <>
          <span className="tb-sep" aria-hidden="true" />
          <button
            type="button"
            className="tb-more"
            aria-expanded={listOpen}
            aria-controls={listId}
            onClick={() => setListOpen((value) => !value)}
          >
            {nowMs !== null && next
              ? moreLater > 0
                ? `${moreLater} more ${moreLater === 1 ? "meeting" : "meetings"} today`
                : "all of today's meetings"
              : "today's meetings"}
          </button>
        </>
      ) : null}
      <div className="tb-strip-right">
        {chips}
        <BoardLegend inputs={legendInputs} />
      </div>
      {listOpen ? (
        <ul id={listId} className="tb-meetings" aria-label="Today's meetings">
          {sorted.map((event, index) => {
            const ended = nowMs !== null && Date.parse(event.end) <= nowMs;
            return (
              <li key={`${event.start}-${index}`} data-ended={ended ? "" : undefined}>
                <span>
                  {clock(event.start)}–{clock(event.end)}
                </span>
                <span>
                  {event.title || "Untitled meeting"}
                  {event.location ? ` · ${event.location}` : ""}
                  {ended ? " · ended" : ""}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
