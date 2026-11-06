"use client";

import { useEffect, useRef, type ReactNode, type TouchEvent } from "react";
import { ProjectSquare } from "@/components/project-colors/ProjectSquare";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { MoveToMenu } from "@/components/today/MoveToMenu";
import { OwnerChip, type CardMove, type WeekBoardTaskData } from "@/components/today/cards/BoardTaskCard";
import { NowUnblockedPill } from "@/components/tasks/task-state";
import type { RangeDay } from "@/lib/task-range";
import {
  dayMonthLabel,
  longDayName,
  shortDayName,
  stepDay,
  swipeDay,
  type DayGroupKind,
  type DayTab,
  type StatusOption,
} from "@/lib/today/today-day";

/**
 * One day as a list (Today v2, mockup today-v2 frames 3–6). The header (← Week,
 * the day, ‹ day before / day after ›, counts), the week as seven day tabs,
 * then the rows grouped Due <day> / Running through <day> / Done. Each row:
 * the Done box (marks the task done; not a selection box), project square +
 * title, project · where it stands, status drop-down, who has it, due, steps,
 * Move to… and Open (the task panel). Overdue and Waiting are the side tabs
 * (`railTabs`, `rail`) WeekBoard passes in, so they live in one place.
 */

export interface DayRowModel {
  group: DayGroupKind;
  data: WeekBoardTaskData;
  due: { text: string; late: boolean };
  rangeDay: RangeDay | null;
  steps: { done: number; total: number } | null;
  statusOptions: StatusOption[];
  move?: CardMove;
}

export interface DayListProps {
  day: string;
  todayDate: string;
  rows: { due: DayRowModel[]; running: DayRowModel[]; done: DayRowModel[] };
  tabs: DayTab[];
  openTaskId: string | null;
  completingIds: ReadonlySet<string>;
  movingIds: ReadonlySet<string>;
  loading: boolean;
  /** "in" (from the week), "prev" / "next" (a day nudge), or null. */
  motion: "in" | "prev" | "next" | null;
  motionKey: number;
  railTabs: ReactNode;
  rail: ReactNode;
  onWeek: () => void;
  onDay: (date: string, direction: "prev" | "next" | null) => void;
  onOpen: (taskId: string) => void;
  onDone: (taskId: string) => void;
  onStatus: (taskId: string, value: string) => void;
  onAdd?: () => void;
}

function StepsBar({ steps }: { steps: { done: number; total: number } | null }) {
  if (!steps) {
    return (
      <span className="td-steps" data-none="">
        —
      </span>
    );
  }
  const share = steps.total > 0 ? Math.round((steps.done / steps.total) * 100) : 0;
  return (
    <span className="td-steps" aria-label={`${steps.done} of ${steps.total} steps done`}>
      <span className="td-bar" aria-hidden="true">
        <i style={{ width: `${share}%` }} />
      </span>
      <span>
        {steps.done}/{steps.total}
      </span>
    </span>
  );
}

function DayRow({
  row,
  open,
  completing,
  moving,
  onOpen,
  onDone,
  onStatus,
}: {
  row: DayRowModel;
  open: boolean;
  completing: boolean;
  moving: boolean;
  onOpen: () => void;
  onDone: () => void;
  onStatus: (value: string) => void;
}) {
  const { data, group } = row;
  const isDone = group === "done";
  const busy = completing || moving;
  const where = data.projectName ?? data.implementationName ?? null;
  const statusId = `td-status-${data.id}`;
  return (
    <li
      className="td-row"
      data-task-open={data.id}
      data-day-row=""
      data-group={group}
      data-open={open ? "" : undefined}
      data-late={row.due.late ? "" : undefined}
      data-busy={busy ? "" : undefined}
    >
      {/* Marks the task done (not a selection box). */}
      <span className="td-cell td-c-box">
        {isDone ? (
          <span className="td-done" data-checked="" role="img" aria-label="Done">
            ✓
          </span>
        ) : (
          <button type="button" className="td-done" onClick={onDone} disabled={busy} aria-label={`Mark “${data.title}” done`}>
            <span aria-hidden="true">{completing ? "…" : ""}</span>
          </button>
        )}
      </span>

      <span className="td-cell td-c-main">
        <span className="td-line">
          {open ? <span className="td-openmark">Open in panel</span> : null}
          {data.squareInput ? <ProjectSquare {...data.squareInput} editable={false} /> : null}
          <button type="button" className="td-title" onClick={onOpen} data-done={isDone ? "" : undefined}>
            {data.title}
          </button>
          {row.rangeDay ? (
            <span className="td-chip">
              Day {row.rangeDay.day} of {row.rangeDay.of}
            </span>
          ) : null}
          <NowUnblockedPill task={{ status: data.status, unblocked_at: data.unblockedAt }} />
        </span>
        <span className="td-where">
          {where ? <span className="td-proj">{where}</span> : null}
          {data.statusLine ? <span className="td-st">{data.statusLine}</span> : null}
          {/* Phone: the due words and who has it sit on this line (the columns are desktop). */}
          <span className="td-phone-meta">
            <span className="td-due" data-late={row.due.late ? "" : undefined}>
              {row.due.text}
            </span>
            <OwnerChip owner={data.owner} label={data.ownerLabel} />
          </span>
        </span>
      </span>

      <span className="td-cell td-c-status">
        {isDone ? (
          <span className="td-status-done">Done</span>
        ) : (
          <>
            <label className="sr-only" htmlFor={statusId}>
              Status of “{data.title}”
            </label>
            <Select
              id={statusId}
              size="xs"
              className="td-status"
              value={data.status}
              disabled={busy}
              data-status={data.status}
              onChange={(event) => onStatus(event.target.value)}
            >
              {row.statusOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.hint ? `${option.label} · ${option.hint}` : option.label}
                </option>
              ))}
            </Select>
          </>
        )}
      </span>

      <span className="td-cell td-c-owner">
        <OwnerChip owner={data.owner} label={data.ownerLabel} />
      </span>

      <span className="td-cell td-c-due">
        <span className="td-due" data-late={row.due.late ? "" : undefined} title={row.due.text}>
          {row.due.text}
        </span>
      </span>

      <span className="td-cell td-c-steps">{isDone ? <span className="td-steps" data-none="">—</span> : <StepsBar steps={row.steps} />}</span>

      <span className="td-cell td-c-move">
        {!isDone && row.move ? (
          <MoveToMenu title={data.title} task={row.move.input} choices={row.move.choices} onPick={row.move.onPick} disabled={busy} size="xs" />
        ) : null}
      </span>

      <span className="td-cell td-c-open">
        <Button variant="secondary" size="xs" onClick={onOpen} aria-label={`Open “${data.title}” in the panel`} className="td-openbtn">
          <span aria-hidden="true" className="td-openicon" />
          <span className="td-opentext">Open</span>
        </Button>
        {/* Phone: the row's › opens the panel sheet. */}
        <button type="button" className="td-chev" onClick={onOpen} aria-label={`Open “${data.title}”`}>
          <span aria-hidden="true">›</span>
        </button>
      </span>
    </li>
  );
}

export function DayList({
  day,
  todayDate,
  rows,
  tabs,
  openTaskId,
  completingIds,
  movingIds,
  loading,
  motion,
  motionKey,
  railTabs,
  rail,
  onWeek,
  onDay,
  onOpen,
  onDone,
  onStatus,
  onAdd,
}: DayListProps) {
  const touch = useRef<{ x: number; y: number } | null>(null);
  const tabsRef = useRef<HTMLElement>(null);
  // Keep the day shown in view in the tab strip (it scrolls sideways on a phone).
  useEffect(() => {
    const strip = tabsRef.current;
    const tab = strip?.querySelector<HTMLElement>('[aria-current="date"]');
    if (!strip || !tab || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft = Math.max(0, tab.offsetLeft - strip.offsetLeft - (strip.clientWidth - tab.offsetWidth) / 2);
  }, [day]);
  const prev = stepDay(day, "prev");
  const next = stepDay(day, "next");
  const name = shortDayName(day);
  const counts = { due: rows.due.length, running: rows.running.length, done: rows.done.length };
  const groups: Array<{ key: DayGroupKind; title: string; items: DayRowModel[] }> = [
    { key: "due", title: `Due ${name}`, items: rows.due },
    { key: "running", title: `Running through ${name}`, items: rows.running },
    { key: "done", title: "Done", items: rows.done },
  ];
  const empty = counts.due + counts.running + counts.done === 0;

  const onTouchStart = (event: TouchEvent) => {
    const point = event.touches[0];
    touch.current = point ? { x: point.clientX, y: point.clientY } : null;
  };
  const onTouchEnd = (event: TouchEvent) => {
    const start = touch.current;
    touch.current = null;
    const point = event.changedTouches[0];
    if (!start || !point) return;
    const direction = swipeDay(point.clientX - start.x, point.clientY - start.y);
    if (direction) onDay(direction === "next" ? next : prev, direction);
  };

  return (
    <section className="td" aria-labelledby="today-day-h" data-motion={motion ?? undefined} key={`${day}-${motionKey}`}>
      <div className="td-head">
        <Button variant="secondary" size="sm" onClick={onWeek} className="td-weekbtn">
          <span aria-hidden="true">←</span> Week
        </Button>
        <h2 id="today-day-h" className="td-name">
          <span className="td-long">{longDayName(day)}</span>
          <span className="td-short">{name}</span>{" "}
          <span className="td-date">
            {dayMonthLabel(day)}
            {day === todayDate ? " · today" : ""}
          </span>
        </h2>
        <div className="td-pager" role="group" aria-label="Day">
          <button type="button" onClick={() => onDay(prev, "prev")} aria-label={`The day before: ${longDayName(prev)} ${dayMonthLabel(prev)}`}>
            ‹ <span className="td-pager-word">{shortDayName(prev)}</span>
          </button>
          <button type="button" onClick={() => onDay(next, "next")} aria-label={`The day after: ${longDayName(next)} ${dayMonthLabel(next)}`}>
            <span className="td-pager-word">{shortDayName(next)}</span> ›
          </button>
        </div>
        <p className="td-counts" aria-live="polite">
          <span>
            <b>{counts.due}</b> due
          </span>
          <span>
            <b>{counts.running}</b> running
          </span>
          <span>
            <b>{counts.done}</b> done
          </span>
        </p>
      </div>

      <nav ref={tabsRef} className="td-tabs" aria-label="Days of the week">
        {tabs.map((tab) => (
          <button
            key={tab.date}
            type="button"
            className="td-tab"
            data-tense={tab.tense}
            aria-current={tab.date === day ? "date" : undefined}
            onClick={() => (tab.date === day ? undefined : onDay(tab.date, tab.date < day ? "prev" : "next"))}
          >
            <span className="td-tab-name">
              {tab.name} <span className="td-tab-num">{tab.day}</span>
              {tab.tense === "today" ? <span className="td-tdy">TODAY</span> : null}
            </span>
            <span className="td-tab-n">{tab.label}</span>
          </button>
        ))}
      </nav>

      <div className="td-board">
        {railTabs}
        {rail}
        <div className="td-main" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <div className="td-cols" aria-hidden="true">
            <span className="td-c-main">Task · where it stands</span>
            <span className="td-c-status">Status</span>
            <span className="td-c-owner">Owner</span>
            <span className="td-c-due">Due</span>
            <span className="td-c-steps">Steps</span>
          </div>
          {loading ? (
            <p className="tb-note" role="status">
              Loading {dayMonthLabel(day)}…
            </p>
          ) : null}
          {empty && !loading ? <p className="td-empty">Nothing due on {longDayName(day)}.</p> : null}
          <div className="td-list" data-task-list="day">
            {groups.map((group) =>
              group.items.length > 0 ? (
                <section key={group.key} className="td-group" data-group={group.key} aria-label={group.title}>
                  <h3 className="td-gh">
                    {group.title} <span>{group.items.length}</span>
                  </h3>
                  <ul>
                    {group.items.map((row) => (
                      <DayRow
                        key={row.data.id}
                        row={row}
                        open={openTaskId === row.data.id}
                        completing={completingIds.has(row.data.id)}
                        moving={movingIds.has(row.data.id)}
                        onOpen={() => onOpen(row.data.id)}
                        onDone={() => onDone(row.data.id)}
                        onStatus={(value) => onStatus(row.data.id, value)}
                      />
                    ))}
                  </ul>
                </section>
              ) : null
            )}
          </div>
          {onAdd ? (
            <button type="button" className="tb-addrow td-add" onClick={onAdd} aria-label={`Add a task due ${longDayName(day)} ${dayMonthLabel(day)}`}>
              + add to {name}
            </button>
          ) : null}
          <p className="td-keys" aria-hidden="true">
            <span>
              <kbd>←</kbd>
              <kbd>→</kbd> day before / after
            </span>
            <span>
              <kbd>Esc</kbd> back to the week
            </span>
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> move between rows
            </span>
            <span>
              <kbd>Enter</kbd> open in panel
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}
