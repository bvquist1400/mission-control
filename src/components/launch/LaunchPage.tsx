import type { ReactNode } from "react";
import { badgeClasses, type BadgeTone } from "@/components/ui/Badge";
import { cardClasses } from "@/components/ui/Card";
import { DailyChart } from "@/components/launch/DailyChart";
import { MilestonesPanel, RedditPanel } from "@/components/launch/LaunchManualPanels";
import { formatCount, formatDay, formatEtTime, formatPercent, formatPosition, healthLine, plural, sourceBadge as sourceBadgeState } from "@/lib/launch-metrics/format";
import type { LaunchPageInput, LaunchView } from "@/lib/launch-metrics/page-data";
import { isoToEtLocal } from "@/lib/launch-metrics/dates";

function Section({ id, title, note, badge, children }: { id: string; title: string; note?: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className={cardClasses({ padding: "md" })}>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${id}-title`} className="text-lg font-semibold text-foreground">
          {title}
        </h2>
        {badge}
      </div>
      {note ? <p className="-mt-2 mb-4 text-xs text-muted-foreground">{note}</p> : null}
      {children}
    </section>
  );
}

function Tile({ label, value, sub, badge }: { label: string; value: string; sub?: ReactNode; badge?: ReactNode }) {
  return (
    <div className={cardClasses({ padding: "sm" })}>
      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        {badge}
      </div>
      <p className="mt-1 text-3xl font-semibold tabular-nums text-foreground">{value}</p>
      {sub ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

function StateBadge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`${badgeClasses({ tone, size: "sm" })} whitespace-nowrap`}>{children}</span>;
}

/** The state badge for a source; "No data yet" only when nothing is stored for it. */
function sourceBadge(view: LaunchView, source: "app_db" | "web" | "search_console"): ReactNode {
  const hasData = source === "app_db" ? view.signups.hasData : source === "web" ? view.website.hasData : view.search.hasData;
  const badge = sourceBadgeState(view.health.find((entry) => entry.source === source), hasData);
  return badge ? <StateBadge tone={badge.tone}>{badge.label}</StateBadge> : null;
}

/**
 * A counts table. Tables with more than three columns don't fit a phone, so
 * below `sm` each row becomes a small card of label/value pairs (every number
 * visible, nothing off to the side); from `sm` up it is a normal table whose
 * first (label) column wraps, so a long search or page never pushes the
 * numbers out of view.
 */
function Table({ caption, head, rows, empty }: { caption: string; head: string[]; rows: ReactNode[][]; empty: string }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{empty}</p>;
  }
  const stackOnPhone = head.length > 3;
  return (
    <>
      {stackOnPhone ? (
        <ul aria-label={caption} className="space-y-2 sm:hidden">
          {rows.map((row, rowIndex) => (
            <li key={rowIndex} className="rounded-lg border border-stroke px-3 py-2">
              <p className="text-sm font-medium text-foreground [overflow-wrap:anywhere]">{row[0]}</p>
              <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1">
                {row.slice(1).map((cell, index) => {
                  // A text value (e.g. "Since release (90-day view)") gets the full width and may wrap;
                  // short numbers sit two to a line.
                  const wide = typeof cell === "string" && cell.length > 10;
                  return (
                    <div key={index} className={`flex min-w-0 items-baseline justify-between gap-2 ${wide ? "col-span-2" : ""}`}>
                      <dt className={`text-xs text-muted-foreground ${wide ? "shrink-0" : "min-w-0"}`}>{head[index + 1]}</dt>
                      <dd className={`text-right text-sm tabular-nums text-foreground ${wide ? "min-w-0 [overflow-wrap:anywhere]" : "shrink-0 whitespace-nowrap"}`}>{cell}</dd>
                    </div>
                  );
                })}
              </dl>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={stackOnPhone ? "hidden sm:block overflow-x-auto" : "overflow-x-auto"}>
        <table className="w-full text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-stroke text-left text-xs text-muted-foreground">
              {head.map((cell, index) => (
                <th key={cell} scope="col" className={`whitespace-nowrap py-2 pr-3 font-medium ${index > 0 ? "text-right" : ""}`}>
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b border-stroke/60 last:border-0">
                {row.map((cell, index) => (
                  <td
                    key={index}
                    className={`py-2 pr-3 ${index > 0 ? "whitespace-nowrap text-right tabular-nums" : "min-w-[6rem] text-foreground [overflow-wrap:anywhere]"}`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function LaunchPageBody({ view, input, now }: { view: LaunchView; input: LaunchPageInput; now: Date }) {
  const totals = view.totals;
  const signupDates = view.signups.days.map((day) => day.date);
  const signupMarkers = view.markers.filter((marker) => signupDates.includes(marker.date));
  const accountRows = [...view.signups.days]
    .reverse()
    .filter((day) => day.real + (day.unconfirmed ?? 0) + day.family > 0)
    .map((day) => [
      formatDay(day.date),
      formatCount(day.real),
      formatCount(day.apple),
      formatCount(day.email),
      formatCount(day.deleted),
      day.unconfirmed === null ? "–" : formatCount(day.unconfirmed),
      formatCount(day.family),
    ]);
  const latestRead = input.manualReads[0] ?? null;
  const nowLocal = isoToEtLocal(now.toISOString());

  return (
    <div className="space-y-6">
      {view.tokenDaysLeft !== null ? (
        <p role="status" className="rounded-card border border-warning-border bg-warning-soft px-4 py-3 text-sm text-warning">
          {view.tokenDaysLeft < 0
            ? "The website token has expired, so website numbers have stopped. The runbook explains how to make a new one."
            : `The website token expires in ${plural(view.tokenDaysLeft, "day", "days")}. The runbook explains how to replace it.`}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Tile
          label="Real users"
          value={totals ? formatCount(totals.realUsers) : "–"}
          badge={sourceBadge(view, "app_db")}
          sub={
            totals ? (
              <>
                <p>
                  {formatCount(totals.realApple)} Apple · {formatCount(totals.realEmail)} email
                </p>
                {totals.deletedAccounts ? <p>{plural(totals.deletedAccounts, "account", "accounts")} deleted since sign-up, not in this total</p> : null}
                <p>plus {plural(totals.familyAccounts, "family account", "family accounts")}, not counted</p>
              </>
            ) : (
              "Waiting for the first update"
            )
          }
        />
        <Tile
          label="Started, not confirmed"
          value={totals && totals.unconfirmed !== null ? formatCount(totals.unconfirmed) : "–"}
          sub={
            totals && totals.unconfirmed === null
              ? "Email sign-ups that never confirmed. Shown after the first live update (the hand-kept numbers don't have it)."
              : "Email sign-ups that never confirmed. Counted separately, not as real users."
          }
        />
        <Tile
          label="Paying Plus (households)"
          value={totals ? formatCount(totals.plusPaid) : "–"}
          sub={totals ? `Trials ${formatCount(totals.plusTrial)} · free family grants ${formatCount(totals.plusComp)}` : undefined}
        />
        <Tile
          label="Website visitors"
          value={view.website.hasData ? formatCount(view.website.visitorsSum) : "–"}
          badge={sourceBadge(view, "web")}
          sub={view.website.hasData ? `Daily visitors added up since launch · ${plural(view.website.tapsSum, "App Store tap", "App Store taps")}` : "Waiting for the first update"}
        />
        <Tile
          label="Google search clicks"
          value={view.search.hasData ? formatCount(view.search.clicks) : "–"}
          badge={sourceBadge(view, "search_console")}
          sub={
            view.search.hasData
              ? `${formatCount(view.search.impressions)} impressions · ${formatPercent(view.search.ctr)} click rate · position ${formatPosition(view.search.position)}`
              : "Waiting for the first update"
          }
        />
      </div>
      {totals ? (
        <p className="-mt-3 text-xs text-muted-foreground">
          App numbers as of {formatDay(totals.asOfDate)} (New York)
          {totals.plusAsOfDate !== totals.asOfDate ? `; Plus as of ${formatDay(totals.plusAsOfDate)}` : ""}. Plus is counted by household.
        </p>
      ) : null}

      <Section id="signups" title="Sign-ups since launch" note="Real users per day (New York days). Unconfirmed email sign-ups are shown separately. Accounts deleted later still count on the day they signed up." badge={sourceBadge(view, "app_db")}>
        {view.signups.hasData ? (
          <DailyChart
            title="Sign-ups per day"
            dates={signupDates}
            series={[
              { label: "Real users", fillClass: "fill-accent", swatchClass: "bg-accent" },
              { label: "Started, not confirmed", fillClass: "fill-warning", swatchClass: "bg-warning" },
            ]}
            values={[view.signups.days.map((day) => day.real), view.signups.days.map((day) => day.unconfirmed ?? 0)]}
            line={{ label: "Total real users", values: view.signups.days.map((day) => day.totalReal), strokeClass: "stroke-success", swatchClass: "bg-success" }}
            markers={signupMarkers}
            zoneNote="New York days"
          />
        ) : (
          <p className="text-sm text-muted-foreground">No sign-up numbers yet. They appear after the first update.</p>
        )}
        <h3 className="mb-2 mt-6 text-sm font-semibold text-foreground">Accounts by day (counts only)</h3>
        <Table
          caption="New accounts per day"
          head={["Day", "Real", "Apple", "Email", "Deleted later", "Not confirmed", "Family"]}
          rows={accountRows}
          empty="No accounts since launch yet."
        />
      </Section>

      <Section id="appstore" title="App Store" badge={<StateBadge tone="neutral">Not connected yet</StateBadge>}>
        <p className="text-sm text-muted-foreground">
          Daily App Store numbers (impressions, page views, first-time downloads, sources) are connected in the next phase. Until then, these are the numbers read by hand from App Store Connect.
        </p>
        <div className="mt-4">
          <Table
            caption="App Store numbers read by hand"
            head={["Read on", "Window", "Impressions", "Page views", "First downloads", "Page view → download"]}
            rows={input.manualReads.map((read) => [
              `${formatDay(read.read_on)} (through ${formatDay(read.data_through)})`,
              read.window_label,
              formatCount(read.impressions),
              formatCount(read.product_page_views),
              formatCount(read.first_downloads),
              formatPercent(read.product_page_views > 0 ? read.first_downloads / read.product_page_views : null),
            ])}
            empty="No hand reads stored."
          />
        </div>
        {latestRead ? <p className="mt-2 text-xs text-muted-foreground">Apple hides groups of fewer than 5 people and adds small noise to its numbers.</p> : null}
      </Section>

      <Section id="website" title="Website (menuandmarket.com)" note="Visitors per day (UTC days, production only). Page views are the line." badge={sourceBadge(view, "web")}>
        {view.website.hasData ? (
          <DailyChart
            title="Website visitors per day"
            dates={view.website.days.map((day) => day.date)}
            series={[{ label: "Visitors", fillClass: "fill-accent", swatchClass: "bg-accent" }]}
            values={[view.website.days.map((day) => day.visitors)]}
            line={{ label: "Page views", values: view.website.days.map((day) => day.pageviews), strokeClass: "stroke-success", swatchClass: "bg-success" }}
            zoneNote="UTC days"
          />
        ) : (
          <p className="text-sm text-muted-foreground">No website numbers yet.</p>
        )}
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="min-w-0">
            <h3 className="mb-2 text-sm font-semibold text-foreground">Top referrers, last 7 days</h3>
            <Table
              caption="Top referrers"
              head={["Site", "Page views", "Visitors"]}
              rows={view.website.referrers.map((entry) => [entry.label, formatCount(entry.value), formatCount(entry.secondary ?? 0)])}
              empty="No referrers in the last 7 days."
            />
          </div>
          <div className="min-w-0">
            <h3 className="mb-2 text-sm font-semibold text-foreground">App Store taps by button, since launch</h3>
            <Table
              caption="App Store taps by placement"
              head={["Button", "Taps"]}
              rows={view.website.placements.map((entry) => [entry.label, formatCount(entry.value)])}
              empty="No App Store taps yet."
            />
          </div>
        </div>
      </Section>

      <Section
        id="search"
        title="Google search"
        note={`Clicks per day from Google Search Console (Pacific days; Google's numbers lag 2–3 days)${view.search.dataThrough ? `. Data through ${formatDay(view.search.dataThrough)}.` : "."}`}
        badge={sourceBadge(view, "search_console")}
      >
        {view.search.hasData ? (
          <DailyChart
            title="Google search clicks per day"
            dates={view.search.days.map((day) => day.date)}
            series={[{ label: "Clicks", fillClass: "fill-accent", swatchClass: "bg-accent" }]}
            values={[view.search.days.map((day) => day.clicks)]}
            line={{ label: "Impressions", values: view.search.days.map((day) => day.impressions), strokeClass: "stroke-success", swatchClass: "bg-success" }}
            zoneNote="Pacific days"
          />
        ) : (
          <p className="text-sm text-muted-foreground">No Google search numbers yet.</p>
        )}
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="min-w-0">
            <h3 className="mb-2 text-sm font-semibold text-foreground">Top searches{view.search.topWindow ? `, ${formatDay(view.search.topWindow.since)}–${formatDay(view.search.topWindow.until)}` : ""}</h3>
            <Table
              caption="Top searches"
              head={["Search", "Clicks", "Impressions", "Position"]}
              rows={view.search.topQueries.map((entry) => [entry.label, formatCount(entry.clicks), formatCount(entry.impressions), formatPosition(entry.position)])}
              empty="Google hasn't reported any searches yet (rare searches are hidden by Google)."
            />
          </div>
          <div className="min-w-0">
            <h3 className="mb-2 text-sm font-semibold text-foreground">Top pages</h3>
            <Table
              caption="Top pages from Google search"
              head={["Page", "Clicks", "Impressions", "Position"]}
              rows={view.search.topPages.map((entry) => [entry.label, formatCount(entry.clicks), formatCount(entry.impressions), formatPosition(entry.position)])}
              empty="No pages reported yet."
            />
          </div>
        </div>
      </Section>

      <Section id="reddit" title="Reddit posts" note="Kept by hand. Update the stats when you check a post.">
        <RedditPanel
          nowLocal={nowLocal}
          posts={input.reddit.map((post) => ({
            id: post.id,
            label: post.label,
            subreddit: post.subreddit,
            postedLabel: formatEtTime(post.posted_at),
            views: post.views,
            upvotes: post.upvotes,
            comments: post.comments,
            statsAsOfLabel: post.stats_as_of ? formatEtTime(post.stats_as_of) : null,
          }))}
        />
      </Section>

      <Section id="timeline" title="Launch timeline" note="Events also show as dashed lines on the sign-ups chart. Times are New York time.">
        <MilestonesPanel
          nowLocal={nowLocal}
          milestones={input.milestones.map((milestone) => ({
            id: milestone.id,
            whenLabel: formatEtTime(milestone.happened_at),
            label: milestone.label,
            kind: milestone.kind,
          }))}
        />
      </Section>

      <footer aria-labelledby="launch-updates-title" className={cardClasses({ padding: "md" })}>
        <h2 id="launch-updates-title" className="mb-3 text-sm font-semibold text-foreground">
          Last update per source
        </h2>
        <ul className="space-y-1.5 text-sm">
          {view.health.map((health) => {
            const line = healthLine(health);
            return (
              <li key={health.source} className="flex items-start gap-2">
                <span className={badgeClasses({ tone: line.tone === "neutral" ? "neutral" : line.tone, size: "sm" })}>
                  {line.tone === "success" ? "OK" : line.tone === "warning" ? "Late" : line.tone === "danger" ? "Failing" : "Waiting"}
                </span>
                <span className="text-foreground">{line.text}</span>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          {view.lastRun
            ? `Last run ${formatEtTime(view.lastRun.started_at)} (${view.lastRun.trigger === "manual" ? "Refresh now" : "scheduled"}, ${view.lastRun.unfinished ? "did not finish" : view.lastRun.status}). `
            : "No runs yet. "}
          Updates run every hour (sign-ups and website) and early every morning (everything). App sign-ups and the website are out of date after 2 hours, Google search after 36.
        </p>
      </footer>
    </div>
  );
}
