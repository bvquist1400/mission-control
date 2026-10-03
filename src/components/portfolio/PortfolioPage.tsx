import Link from "next/link";
import {
  formatTick,
  hasPartialCredit,
  timelinePosition,
  type LaneHealth,
  type PortfolioApp,
  type PortfolioView,
  type TaskCounts,
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

/** "3 of 20 tasks done", plus what the percent also counts when ticked checklist items add to it. */
function progressLabel(counts: TaskCounts, noun: string): string {
  const partial = hasPartial(counts) ? "; the percent also counts ticked checklist items" : "";
  return `${counts.done} of ${counts.total} ${noun} done${partial}`;
}

/** Ticked checklist items add to the percent beyond the whole tasks done. */
function hasPartial(counts: TaskCounts): boolean {
  return hasPartialCredit(counts.done, counts.credit);
}

function Progress({ pct, label }: { pct: number | null; label: string }) {
  return (
    <div className="prog" role="img" aria-label={label}>
      <span style={{ width: `${pct ?? 0}%` }} />
    </div>
  );
}

function HealthChip({ health }: { health: LaneHealth }) {
  return <span className={`pf-hc ${health.kind}`}>{health.label}</span>;
}

function dateRange(start: string, end: string): string {
  return start === end ? formatTick(start) : `${formatTick(start)} – ${formatTick(end)}`;
}

function TimelineChart({ timeline, appId }: { timeline: Timeline; appId: string }) {
  const { lanes, earlier, target } = timeline;
  // With nothing drawn, the list is all there is to see, so it starts open.
  const earlierList =
    earlier.length > 0 ? (
      <details className="pf-earlier" open={lanes.length === 0}>
        <summary>Earlier and unscheduled · {plural(earlier.length, "section")}</summary>
        <ul>
          {earlier.map((lane) => (
            <li key={`${appId}-${lane.key}`}>
              {lane.project ? <span className="pf-lbl-p">{lane.project} · </span> : null}
              {lane.label} · {lane.text}
              {lane.state ? ` · ${lane.state}` : ""}
              {lane.overdueSince ? <span className="pf-overdue"> · overdue since {formatTick(lane.overdueSince)}</span> : null}
              {lane.hasBrent ? <span className="pf-mini you">You</span> : null}
            </li>
          ))}
        </ul>
      </details>
    ) : null;

  if (lanes.length === 0) {
    return (
      <>
        <p className="tile-p">
          {earlier.length > 0
            ? "No unfinished section has planned dates, so there is nothing to chart."
            : "No sections with tasks yet."}
        </p>
        {earlierList}
      </>
    );
  }

  const todayLeft = timelinePosition(timeline, timeline.today, 0.5);
  const targetLeft = target ? timelinePosition(timeline, target.date, 0.5) : null;
  const targetText = target ? `Target ${formatTick(target.date)}` : "";
  const edge = (left: number) => (left > 88 ? " edge-r" : left < 6 ? " edge-l" : "");
  return (
    <>
      <div className="pf-chart" role="group" aria-label="Timeline">
        <div className="pf-lane-row pf-axis-row" aria-hidden="true">
          <div className="pf-lbl-gap" />
          <div className="pf-axis">
            {target && targetLeft !== null ? (
              <span className={`pf-ms target${edge(targetLeft)}`} style={{ left: `${targetLeft}%` }}>
                <b />
                <em>{targetText}</em>
              </span>
            ) : null}
            <span className={`pf-ms today${edge(todayLeft)}`} style={{ left: `${todayLeft}%` }}>
              <b />
              <em>Today</em>
            </span>
            <div className="pf-ticks">
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
          </div>
        </div>
        {lanes.map((lane) => {
          const left = timelinePosition(timeline, lane.start);
          const right = timelinePosition(timeline, lane.end, 1);
          const range = dateRange(lane.start, lane.end);
          const name = lane.project ? `${lane.project} · ${lane.label}` : lane.label;
          const summary = `${name}: ${lane.health.label}, ${lane.done} of ${lane.total} done${hasPartialCredit(lane.done, lane.credit) ? " plus partly ticked checklists" : ""}, planned ${range}`;
          return (
            <div className="pf-lane-row" key={`${appId}-${lane.key}`}>
              <div className="pf-lbl">
                <span className="pf-lbl-top">
                  <span className="pf-lname">
                    {lane.project ? <span className="pf-lbl-p">{lane.project} · </span> : null}
                    {lane.label}
                  </span>
                  <HealthChip health={lane.health} />
                </span>
                <small className="pf-meta">
                  <span className="mono">{range}</span>
                  <span>{lane.sub}</span>
                  {lane.hasBrent ? <span className="pf-mini you">You</span> : null}
                </small>
              </div>
              <div className="pf-lane">
                {targetLeft !== null ? <span className="pf-guide" style={{ left: `${targetLeft}%` }} aria-hidden="true" /> : null}
                <span
                  className={`pf-track ${lane.health.kind}${lane.total === 0 ? " empty" : ""}`}
                  style={{ left: `${left}%`, width: `${Math.max(right - left, 1.4)}%` }}
                  role="img"
                  aria-label={summary}
                  title={summary}
                >
                  <span className="pf-fill" style={{ width: `${lane.share * 100}%` }} />
                </span>
                <span className="pf-today" style={{ left: `${todayLeft}%` }} aria-hidden="true" />
              </div>
            </div>
          );
        })}
      </div>
      {earlierList}
    </>
  );
}

function AppRow({ app, open }: { app: PortfolioApp; open: boolean }) {
  const { counts } = app;
  // Open hobby tasks are Brent's, but nobody waits on him for them: not "You", not "Later".
  const hobbyOpen = Math.max(counts.open - counts.brentOpen - counts.brentLater - counts.agentOpen, 0);
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
          <Progress pct={counts.pct} label={progressLabel(counts, "tasks")} />
          <div className="pf-pl">
            <span>
              <b>{counts.pct ?? 0}%</b> done
            </span>
            <span className="mono" title={hasPartial(counts) ? "Whole tasks done. The percent also counts ticked checklist items." : undefined}>
              {counts.done} / {counts.total}
              {hasPartial(counts) ? " + partial" : ""}
            </span>
          </div>
        </div>
        <div className="pf-stand">
          {app.stand ?? <span className="pf-muted">No status yet.</span>}
          {app.next ? <span className="pf-next">Next: {app.next}</span> : null}
          {app.timeline.summary ? (
            <span className="pf-hline">
              {app.timeline.summary.health ? <HealthChip health={app.timeline.summary.health} /> : null}
              {app.timeline.summary.line ? <span>{app.timeline.summary.line}</span> : null}
            </span>
          ) : null}
        </div>
        <div className="pf-owners">
          {counts.brentOpen > 0 ? <OwnerChip who="brent" label={`You · ${counts.brentOpen}`} /> : null}
          {counts.brentLater > 0 ? <span className="pf-own quiet">Later · {counts.brentLater}</span> : null}
          {counts.agentOpen > 0 ? <OwnerChip who="agent" label={`Agents · ${counts.agentOpen}`} /> : null}
          {hobbyOpen > 0 ? <span className="pf-own quiet">Hobby · {hobbyOpen}</span> : null}
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
  const appLanes = view.apps.filter((app) => app.kind === "app");
  const projectLanes = view.apps.filter((app) => app.kind === "project");
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
              <span>
                {plural(appLanes.length, "app")}
                {projectLanes.length > 0 ? ` · ${plural(projectLanes.length, "project")}` : ""}
              </span>
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
            <Progress pct={overall.pct} label={progressLabel(overall, "tasks")} />
            <div className="pf-pl hero-pl">
              <span>
                <b>{overall.pct ?? 0}%</b> of all tasks done
              </span>
              <span className="mono" title={hasPartial(overall) ? "Whole tasks done. The percent also counts ticked checklist items." : undefined}>
                {overall.done} / {overall.total}
                {hasPartial(overall) ? " + partial" : ""}
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
            <h2 id="pf-apps-h">{projectLanes.length > 0 ? "Apps and projects" : "Apps"}</h2>
            <span className="hint">Tap a row for its timeline</span>
          </div>
          {view.apps.length > 0 ? (
            <div className="pf-apps">
              {view.apps.map((app, index) => (
                <AppRow key={app.id} app={app} open={index === 0} />
              ))}
            </div>
          ) : (
            <p className="tile-p">No apps or projects have tasks in this view.</p>
          )}
          <div className="pf-legend" aria-hidden="true">
            <span><i className="st-fill" />Planned window, filled by progress</span>
            <span><i className="st-today" />Today</span>
            <span><i className="st-target" />Target date</span>
          </div>
        </section>

        <p className="pf-fine">
          Percent done counts every task in the app equally: a done task is its whole share, and a task not done yet is
          its ticked checklist items ÷ its items (3 of 14 ticked is 3/14 of that task; no checklist, nothing yet). The
          &quot;done&quot; counts stay whole tasks. Each bar is a section&apos;s planned window, filled the same way. Green is on track or ahead, amber is behind (progress more than a quarter
          short of the share of the window that has passed), red is past its planned end with work open, and grey has not
          started. Finished sections and sections with no planned dates are listed under the chart.
        </p>
      </div>
    </TaskEditorLayer>
  );
}
