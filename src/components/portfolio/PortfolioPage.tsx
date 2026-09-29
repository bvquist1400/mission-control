import Link from "next/link";
import type { CSSProperties } from "react";
import {
  formatShortDate,
  formatTick,
  timelinePosition,
  type PortfolioApp,
  type PortfolioView,
  type Timeline,
} from "@/lib/portfolio";
import type { TaskScope } from "@/lib/personal-exclusion";
import { AssignedList, LaterList, TaskEditorLayer } from "@/components/portfolio/PortfolioTasks";

const SCOPES: Array<{ value: TaskScope; label: string }> = [
  { value: "personal", label: "Personal" },
  { value: "work", label: "Work" },
  { value: "all", label: "All" },
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekdayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()].toUpperCase()} ${m}/${d}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function OwnerChip({ who, label }: { who: "brent" | "agent"; label: string }) {
  return (
    <span className={`pf-own ${who === "brent" ? "you" : "agent"}`}>
      <i aria-hidden="true">{who === "brent" ? "B" : label.charAt(0).toUpperCase()}</i>
      {label}
    </span>
  );
}

function Progress({ pct, label }: { pct: number | null; label: string }) {
  return (
    <div className="prog" role="img" aria-label={label}>
      <span style={{ width: `${pct ?? 0}%` }} />
    </div>
  );
}

function TimelineChart({ timeline, appId }: { timeline: Timeline; appId: string }) {
  if (timeline.lanes.length === 0) {
    return (
      <p className="tile-p">
        {timeline.hiddenEarlier > 0
          ? `Nothing on the calendar right now; ${plural(timeline.hiddenEarlier, "section")} finished earlier.`
          : "No sections with tasks yet."}
      </p>
    );
  }
  const todayLeft = timelinePosition(timeline, timeline.today);
  return (
    <>
      <div className="pf-tlscroll" role="region" aria-label="Timeline" tabIndex={0}>
        <div className="pf-gantt">
          <div aria-hidden="true" />
          <div className="pf-axis" aria-hidden="true">
            {timeline.ticks.map((tick, index) => {
              const left = timelinePosition(timeline, tick);
              // With many ticks, every other label hides on a phone (see portfolio.css).
              const classes = [
                left < 3 ? "first" : left > 94 ? "last" : "",
                timeline.ticks.length > 7 && index % 2 === 1 ? "minor" : "",
              ].filter(Boolean);
              return (
                <span key={tick} className={classes.join(" ") || undefined} style={{ left: `${left}%` }}>
                  {formatTick(tick)}
                </span>
              );
            })}
          </div>
          {timeline.lanes.map((lane) => {
            const left = timelinePosition(timeline, lane.start);
            const right = timelinePosition(timeline, lane.end);
            const style: CSSProperties = { left: `${left}%`, width: `${Math.max(right - left, 1.4)}%` };
            const range =
              lane.start === lane.end
                ? formatShortDate(lane.start)
                : `${formatShortDate(lane.start)} – ${formatShortDate(lane.end)}`;
            const stateText =
              lane.state === "done"
                ? "done"
                : lane.overdue
                  ? "past due"
                  : lane.estimated
                    ? "no due date"
                    : lane.state === "wait"
                      ? "waiting"
                      : lane.state === "prog"
                        ? "in progress"
                        : "not started";
            const when = lane.planned ? `${range} (planned)` : range;
            return (
              <div className="pf-lane-row" key={`${appId}-${lane.key}`}>
                <div className="pf-lbl">
                  <span>
                    {lane.project ? <span className="pf-lbl-p">{lane.project} · </span> : null}
                    {lane.label}
                  </span>
                  <small>
                    {lane.sub}
                    {lane.hasBrent ? <span className="pf-mini you">You</span> : null}
                  </small>
                </div>
                <div className="pf-lane">
                  <span className="pf-today" style={{ left: `${todayLeft}%` }} aria-hidden="true" />
                  <span
                    className={`pf-seg st-${lane.state}${lane.estimated ? " est" : ""}${lane.planned ? " planned" : ""}${lane.overdue ? " late" : ""}${lane.continues ? " cont" : ""}`}
                    style={style}
                    title={`${when} · ${stateText}`}
                  >
                    <span className="pf-sr">
                      {when}, {stateText}
                    </span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {timeline.hiddenEarlier > 0 ? (
        <p className="pf-fine">{plural(timeline.hiddenEarlier, "earlier section")} finished before {formatShortDate(timeline.start)}.</p>
      ) : null}
    </>
  );
}

function AppRow({ app, open }: { app: PortfolioApp; open: boolean }) {
  const { counts } = app;
  return (
    <details className="pf-app" open={open}>
      <summary>
        <div className="pf-name">
          <span className="pf-nm">
            <span className="pf-chev" aria-hidden="true">
              ›
            </span>
            {app.name}
          </span>
          <span className="pf-ph">{app.phase}</span>
        </div>
        <div className="pf-pc">
          <Progress pct={counts.pct} label={`${counts.done} of ${counts.total} tasks done`} />
          <div className="pf-pl">
            <span>
              <b>{counts.pct ?? 0}%</b> done
            </span>
            <span className="mono">
              {counts.done} / {counts.total}
            </span>
          </div>
        </div>
        <div className="pf-stand">
          {app.stand ?? <span className="pf-muted">No status yet.</span>}
          {app.next ? <span className="pf-next">Next: {app.next}</span> : null}
        </div>
        <div className="pf-owners">
          {counts.brentOpen > 0 ? <OwnerChip who="brent" label={`You · ${counts.brentOpen}`} /> : null}
          {counts.brentLater > 0 ? <span className="pf-own quiet">Later · {counts.brentLater}</span> : null}
          {counts.agentOpen > 0 ? <OwnerChip who="agent" label={`Agents · ${counts.agentOpen}`} /> : null}
          {counts.open === 0 ? <span className="pf-own agent quiet">Nothing open</span> : null}
        </div>
      </summary>
      <div className="pf-tl">
        <TimelineChart timeline={app.timeline} appId={app.id} />
      </div>
    </details>
  );
}

export function PortfolioPage({ view }: { view: PortfolioView }) {
  const { overall } = view;
  const needs = view.brentOpen;
  return (
    <TaskEditorLayer>
      <div className="page pf-portfolio">
        <nav className="pf-top" aria-label="Baseline">
          <Link href="/" className="pf-back">
            <span aria-hidden="true">←</span> Baseline
          </Link>
          <div className="pf-scope" role="group" aria-label="Which tasks">
            {SCOPES.map((scope) => (
              <Link
                key={scope.value}
                href={scope.value === "personal" ? "/portfolio" : `/portfolio?scope=${scope.value}`}
                aria-current={view.scope === scope.value ? "page" : undefined}
              >
                {scope.label}
              </Link>
            ))}
          </div>
        </nav>

        <div className="bento">
          <section className="tile hero span-6" aria-label="Summary">
            <div className="eyebrow">
              <span className="code">PORTFOLIO</span>
              <span>{weekdayLabel(view.today)}</span>
              <span>{plural(view.apps.length, "app")}</span>
            </div>
            <h1>
              {needs === 0 ? "Nothing needs you" : `${needs} ${needs === 1 ? "thing needs" : "things need"} you`}
              <span className="dim">
                {view.brentLater > 0
                  ? `${plural(view.brentLater, "more comes", "more come")} to you once unblocked.`
                  : view.agentOpen > 0
                    ? "Everything else is with the agents."
                    : "Nothing is open with the agents either."}
              </span>
            </h1>
            <Progress pct={overall.pct} label={`${overall.done} of ${overall.total} tasks done`} />
            <div className="pf-pl hero-pl">
              <span>
                <b>{overall.pct ?? 0}%</b> of all tasks done
              </span>
              <span className="mono">
                {overall.done} / {overall.total}
              </span>
            </div>
            {view.apps.length > 0 ? (
              <div className="pf-where">
                {view.apps.map((app) => (
                  <span key={app.id}>
                    {app.name} <b>{app.counts.pct ?? 0}%</b>
                  </span>
                ))}
              </div>
            ) : null}
          </section>

          <section className="tile span-4" aria-labelledby="pf-you-h">
            <div className="sec-h pf-sec-h">
              <h2 id="pf-you-h">Assigned to you</h2>
              <OwnerChip who="brent" label="You" />
            </div>
            <AssignedList tasks={view.assigned} />
            <LaterList tasks={view.comingLater} />
          </section>

          <section className="tile span-2" aria-labelledby="pf-agents-h">
            <span className="tile-k" id="pf-agents-h">
              With the agents
            </span>
            <div className="tile-n">
              {view.agentInProgress}
              <small>in progress</small>
            </div>
            <p className="tile-p">
              {view.agentOpen - view.agentInProgress > 0
                ? `${view.agentOpen - view.agentInProgress} more open ${view.agentOpen - view.agentInProgress === 1 ? "task is" : "tasks are"} queued. `
                : ""}
              {needs > 0 ? `Nothing blocked on you but the ${needs === 1 ? "one" : needs} on the left.` : "Nothing blocked on you."}
            </p>
            {view.agentLabels.length > 0 ? (
              <div className="pf-where pf-labels">
                {view.agentLabels.map((label) => (
                  <OwnerChip key={label} who="agent" label={label} />
                ))}
              </div>
            ) : null}
          </section>
        </div>

        <section className="sec" aria-labelledby="pf-apps-h">
          <div className="sec-h pf-sec-h">
            <h2 id="pf-apps-h">Apps</h2>
            <span className="hint">Tap a row for its timeline</span>
          </div>
          {view.apps.length > 0 ? (
            <div className="pf-apps">
              {view.apps.map((app, index) => (
                <AppRow key={app.id} app={app} open={index === 0} />
              ))}
            </div>
          ) : (
            <p className="tile-p">No apps have tasks in this view.</p>
          )}
          <div className="pf-legend" aria-hidden="true">
            <span><i className="st-done" />Done</span>
            <span><i className="st-prog" />In progress</span>
            <span><i className="st-wait" />Waiting</span>
            <span><i className="st-plan" />Not started</span>
            <span><i className="st-est" />No dates yet (estimate)</span>
            <span><i className="st-today" />Today</span>
          </div>
        </section>

        <p className="pf-fine">
          Percent done counts every task in the app equally: done ÷ all tasks. Solid bars use a section&apos;s planned dates
          or its tasks&apos; due dates; dashed bars have no dates yet and are estimates.
        </p>
      </div>
    </TaskEditorLayer>
  );
}
