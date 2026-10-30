import type { ReactNode } from "react";
import { badgeClasses, type BadgeTone } from "@/components/ui/Badge";
import { cardClasses } from "@/components/ui/Card";
import { ChartLegend, ColumnChart, EventKey, TotalChart } from "@/components/launch/DailyChart";
import { MilestonesPanel, RedditPanel } from "@/components/launch/LaunchManualPanels";
import { markerDays, notTrackedSpan } from "@/lib/launch-metrics/chart-model";
import { formatCount, formatDay, formatEtClock, formatEtTime, formatPercent, formatPosition, healthLine, plural, sourceBadge as sourceBadgeState } from "@/lib/launch-metrics/format";
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

/**
 * A headline tile: a short sentence-case label that wraps (never clipped), the
 * big number with its status pill beside it (never over the label), and one
 * plain sub-line.
 */
function Tile({ label, value, sub, badge }: { label: string; value: string; sub?: ReactNode; badge?: ReactNode }) {
  return (
    <div className={cardClasses({ padding: "sm", className: "flex min-w-0 flex-col gap-1" })}>
      <p className="text-sm font-semibold text-[color:var(--chart-text-2)] [overflow-wrap:anywhere]">{label}</p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className={`text-3xl font-semibold ${value === "–" ? "text-muted-foreground" : "text-foreground"}`}>{value}</p>
        {badge}
      </div>
      {sub ? <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{sub}</p> : null}
    </div>
  );
}

function ChartTitle({ title, note }: { title: string; note?: string }) {
  return (
    <div className="mb-2">
      <p className="text-sm font-semibold text-[color:var(--chart-text-2)]">{title}</p>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function StateBadge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`${badgeClasses({ tone, size: "sm" })} whitespace-nowrap`}>{children}</span>;
}

/** The state badge for a source; "No data yet" only when nothing is stored for it. */
function sourceBadge(view: LaunchView, source: "app_db" | "web" | "search_console" | "apple"): ReactNode {
  const hasData =
    source === "app_db" ? view.signups.hasData : source === "web" ? view.website.hasData : source === "apple" ? view.appStore.hasData : view.search.hasData;
  const badge = sourceBadgeState(view.health.find((entry) => entry.source === source), hasData);
  return badge ? <StateBadge tone={badge.tone}>{badge.label}</StateBadge> : null;
}

/**
 * A counts table. Below a container width the rows become small cards of
 * label/value pairs (every number visible, nothing cut off at the side):
 * tables with five or more columns (App Store hand reads, accounts by day)
 * stack below 36rem (576 px) of their own width, four-column tables below 20rem.
 * The width is the table's box, not the window, so a table in a half-width
 * column stacks too. Headers may wrap; number cells stay on one line; the
 * first (label) column wraps, so a long search or page never pushes the
 * numbers out of view.
 */
const STACK_CLASSES = {
  wide: { cards: "space-y-2 @min-[36rem]:hidden", table: "hidden overflow-x-auto @min-[36rem]:block" },
  medium: { cards: "space-y-2 @min-[20rem]:hidden", table: "hidden overflow-x-auto @min-[20rem]:block" },
} as const;

function Table({ caption, head, rows, empty }: { caption: string; head: string[]; rows: ReactNode[][]; empty: string }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{empty}</p>;
  }
  const stack = head.length >= 5 ? STACK_CLASSES.wide : head.length > 3 ? STACK_CLASSES.medium : null;
  // A column of words (e.g. the App Store "Window") reads left-aligned; number columns align right.
  const textColumn = head.map((_, index) => index > 0 && rows.some((row) => typeof row[index] === "string" && /[a-z]/i.test(row[index] as string)));
  return (
    <div className="@container min-w-0">
      {stack ? (
        <ul aria-label={caption} className={stack.cards}>
          {rows.map((row, rowIndex) => (
            <li key={rowIndex} className="rounded-lg border border-stroke px-3 py-2">
              <div className="text-sm font-semibold text-foreground [overflow-wrap:anywhere]">{row[0]}</div>
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
      <div className={stack ? stack.table : "overflow-x-auto"}>
        <table className="w-full text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-[color:var(--chart-axis)] text-left text-xs text-muted-foreground">
              {head.map((cell, index) => (
                <th key={cell} scope="col" className={`py-2 pr-3 align-bottom font-semibold leading-tight last:pr-0 ${index > 0 && !textColumn[index] ? "text-right" : ""}`}>
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
                    className={`py-2 pr-3 align-top last:pr-0 ${textColumn[index] ? "text-foreground" : index > 0 ? "whitespace-nowrap text-right tabular-nums" : "min-w-[6rem] text-foreground [overflow-wrap:anywhere]"}`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function rangeText(dates: string[]): string {
  return dates.length ? `${formatDay(dates[0])} to ${formatDay(dates[dates.length - 1])}` : "no days yet";
}

export function LaunchPageBody({ view, input, now }: { view: LaunchView; input: LaunchPageInput; now: Date }) {
  const totals = view.totals;
  const signupDates = view.signups.days.map((day) => day.date);
  const signupMarkers = markerDays(
    signupDates,
    view.markers.map((marker) => ({ date: marker.date, label: marker.label, kind: marker.kind, timeLabel: formatEtClock(marker.happenedAt) }))
  );
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

  const realSum = view.signups.days.reduce((sum, day) => sum + day.real, 0);
  const familySum = view.signups.days.reduce((sum, day) => sum + day.family, 0);
  const unconfirmedSum = view.signups.days.reduce((sum, day) => sum + (day.unconfirmed ?? 0), 0);
  const peakReal = Math.max(0, ...view.signups.days.map((day) => day.real));
  const lastTotal = [...view.signups.days].reverse().find((day) => day.totalReal !== null)?.totalReal ?? null;

  const webDates = view.website.days.map((day) => day.date);
  const webNotTracked = notTrackedSpan(webDates, view.website.trackingSince);
  const webTracked = (index: number) => !webNotTracked || index > webNotTracked.to;
  const trackingDay = formatDay(view.website.trackingSince);
  const searchDates = view.search.days.map((day) => day.date);
  const appStore = view.appStore;
  const appDates = appStore.days.map((day) => day.date);
  const appWindowText = appStore.window ? `${formatDay(appStore.window.since)}–${formatDay(appStore.window.until)}` : "";
  const appDownloadsSum = appStore.days.reduce((sum, day) => sum + day.firstDownloads, 0);
  const appRedownloadsSum = appStore.days.reduce((sum, day) => sum + day.redownloads, 0);
  const appPageViewsSum = appStore.days.reduce((sum, day) => sum + day.pageViews, 0);
  const appImpressionsSum = appStore.days.reduce((sum, day) => sum + day.impressions, 0);
  const appleHealth = view.health.find((entry) => entry.source === "apple");
  const appleConnected = appleHealth ? appleHealth.state !== "not_connected" && appleHealth.state !== "never" : false;

  return (
    <div className="space-y-6">
      {view.tokenDaysLeft !== null ? (
        <p role="status" className="rounded-card border border-warning-border bg-warning-soft px-4 py-3 text-sm text-warning">
          {view.tokenDaysLeft < 0
            ? "The website token has expired, so website numbers have stopped. The runbook explains how to make a new one."
            : `The website token expires in ${plural(view.tokenDaysLeft, "day", "days")}. The runbook explains how to replace it.`}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Tile
          label="Real users"
          value={totals ? formatCount(totals.realUsers) : "–"}
          badge={sourceBadge(view, "app_db")}
          sub={
            totals
              ? `${formatCount(totals.realApple)} Apple · ${formatCount(totals.realEmail)} email · ${plural(totals.familyAccounts, "family account", "family accounts")} not counted${
                  totals.deletedAccounts ? ` · ${plural(totals.deletedAccounts, "deleted account", "deleted accounts")} not in this total` : ""
                }`
              : "Waiting for the first update"
          }
        />
        <Tile
          label="Not confirmed"
          value={totals && totals.unconfirmed !== null ? formatCount(totals.unconfirmed) : "–"}
          sub={
            totals && totals.unconfirmed === null
              ? "Email sign-ups that never confirmed · shown after the first live update"
              : "Email sign-ups that never confirmed, not counted as real users"
          }
        />
        <Tile
          label="Paying Plus"
          value={totals ? formatCount(totals.plusPaid) : "–"}
          sub={totals ? `Households · ${plural(totals.plusTrial, "trial", "trials")} · ${plural(totals.plusComp, "free family grant", "free family grants")}` : "Waiting for the first update"}
        />
        <Tile
          label="App downloads"
          value={appStore.hasData ? formatCount(appStore.firstDownloads) : "–"}
          badge={sourceBadge(view, "apple")}
          sub={
            appStore.hasData
              ? `First-time, App Store, ${appWindowText} (Apple days) · ${formatPercent(appStore.conversion)} page view → download · ${formatCount(appStore.impressions)} impressions · ${formatCount(appStore.pageViews)} page views`
              : appleConnected
                ? "Waiting for Apple's first daily report"
                : "Not connected yet"
          }
        />
        <Tile
          label="Website visitors"
          value={view.website.hasData ? formatCount(view.website.visitorsSum) : "–"}
          badge={sourceBadge(view, "web")}
          sub={view.website.hasData ? `Added up by day since tracking began ${trackingDay} · ${plural(view.website.tapsSum, "App Store tap", "App Store taps")}` : "Waiting for the first update"}
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

      <Section id="signups" title="Sign-ups since launch" note="New York days. Unconfirmed email sign-ups are shown separately. Accounts deleted later still count on the day they signed up." badge={sourceBadge(view, "app_db")}>
        {view.signups.hasData ? (
          <>
            <ChartTitle title="New accounts per day" note="Family accounts show in grey and are not counted as real users." />
            <ColumnChart
              title="New accounts per day"
              summary={`New accounts per day, ${rangeText(signupDates)}: ${plural(realSum, "real user", "real users")}, ${formatCount(unconfirmedSum)} not confirmed, ${plural(familySum, "family account", "family accounts")} not counted. Highest day ${formatCount(peakReal)} real.`}
              dates={signupDates}
              series={[
                { label: "Real users", color: "var(--chart-1)", values: view.signups.days.map((day) => day.real) },
                { label: "Started, not confirmed", color: "var(--chart-2)", values: view.signups.days.map((day) => day.unconfirmed) },
                { label: "Family (not counted)", color: "var(--chart-neutral)", values: view.signups.days.map((day) => day.family), counted: false },
              ]}
              markers={signupMarkers}
              uncountedCapLabel="family"
              emptyNote="No sign-ups on these days yet"
            />
            <ChartLegend
              items={[
                { label: "Real users", color: "var(--chart-1)", kind: "box" },
                { label: "Started, not confirmed", color: "var(--chart-2)", kind: "box" },
                { label: "Family (not counted)", color: "var(--chart-neutral)", kind: "box" },
                ...(signupMarkers.length ? [{ label: "Launch events (key below)", kind: "marker" as const }] : []),
              ]}
            />
            <div className="mt-6">
              <ChartTitle title="Total real users" />
              <TotalChart
                title="Total real users"
                summary={`Total real users, ${rangeText(signupDates)}${lastTotal === null ? ": no total stored yet." : `: ${formatCount(lastTotal)} on the latest stored day.`}`}
                dates={signupDates}
                totals={view.signups.days.map((day) => day.totalReal)}
                dailyNew={view.signups.days.map((day) => day.real)}
              />
            </div>
            <EventKey markers={signupMarkers} />
          </>
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

      <Section
        id="appstore"
        title="App Store"
        note={`Apple's report days (Apple's own dates, not New York time); Apple's numbers arrive 2–3 days late${appStore.dataThrough ? `. Data through ${formatDay(appStore.dataThrough)}.` : "."}`}
        badge={sourceBadge(view, "apple")}
      >
        {appStore.hasData ? (
          <>
            <ChartTitle title="Downloads per day" note="First-time downloads and redownloads (someone getting the app again on a device)." />
            <ColumnChart
              title="App Store downloads per day"
              summary={`App Store downloads per Apple report day, ${rangeText(appDates)}: ${plural(appDownloadsSum, "first-time download", "first-time downloads")} and ${plural(appRedownloadsSum, "redownload", "redownloads")}.`}
              dates={appDates}
              height={180}
              series={[
                { label: "First-time downloads", color: "var(--chart-1)", values: appStore.days.map((day) => day.firstDownloads) },
                { label: "Redownloads", color: "var(--chart-3)", values: appStore.days.map((day) => day.redownloads) },
              ]}
              emptyNote="No downloads on these days yet"
            />
            <ChartLegend
              items={[
                { label: "First-time downloads", color: "var(--chart-1)", kind: "box" },
                { label: "Redownloads", color: "var(--chart-3)", kind: "box" },
              ]}
            />
            <div className="mt-6">
              <ChartTitle title="Product page views per day" />
              <ColumnChart
                title="App Store product page views per day"
                summary={`App Store product page views per Apple report day, ${rangeText(appDates)}: ${plural(appPageViewsSum, "page view", "page views")} in all.`}
                dates={appDates}
                height={150}
                series={[{ label: "Page views", color: "var(--chart-1)", values: appStore.days.map((day) => day.pageViews) }]}
                emptyNote="No page views on these days yet"
              />
            </div>
            <div className="mt-6">
              <ChartTitle title="Impressions per day" note="How often the app was seen anywhere in the App Store. Its own chart, because impressions run far higher than page views." />
              <ColumnChart
                title="App Store impressions per day"
                summary={`App Store impressions per Apple report day, ${rangeText(appDates)}: ${plural(appImpressionsSum, "impression", "impressions")} in all.`}
                dates={appDates}
                height={150}
                series={[{ label: "Impressions", color: "var(--chart-1)", values: appStore.days.map((day) => day.impressions) }]}
                emptyNote="No impressions on these days yet"
              />
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {appleConnected
              ? "No App Store numbers yet. Apple sends its first daily report a day or two after the report request starts."
              : "Not connected yet. Daily App Store numbers start once the App Store keys are added (the runbook has the steps). Until then, the numbers read by hand are below."}
          </p>
        )}
        <h3 className="mb-2 mt-6 text-sm font-semibold text-foreground">Where the App Store visitors came from, since launch</h3>
        <Table
          caption="App Store numbers by source type"
          head={["Source", "Impressions", "Page views", "First downloads", "Redownloads"]}
          rows={appStore.sourceTypes.map((entry) => [
            entry.label,
            formatCount(entry.impressions),
            formatCount(entry.pageViews),
            formatCount(entry.firstDownloads),
            formatCount(entry.redownloads),
          ])}
          empty={appStore.hasData ? "Apple hasn't reported any source types yet." : "Shown once Apple's daily reports arrive."}
        />
        <p className="mt-4 text-xs text-muted-foreground">
          Referring sites, apps and campaign links come from Apple&apos;s Detailed reports. Apple leaves out any group of fewer than 5 people and adds small noise, so at launch volume these lists are mostly empty: an empty list means too few people to show, not zero.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="min-w-0">
            <h3 className="mb-2 text-sm font-semibold text-foreground">Referring sites and apps</h3>
            <Table
              caption="App Store referrers"
              head={["Site or app", "First downloads", "Page views"]}
              rows={appStore.sourceInfo.map((entry) => [entry.label, formatCount(entry.value), formatCount(entry.secondary ?? 0)])}
              empty="Nothing Apple can show yet (groups under 5 people are hidden)."
            />
          </div>
          <div className="min-w-0">
            <h3 className="mb-2 text-sm font-semibold text-foreground">Campaign links (site-hero, site-footer)</h3>
            <Table
              caption="App Store campaign links"
              head={["Campaign", "First downloads", "Page views"]}
              rows={appStore.campaigns.map((entry) => [entry.label, formatCount(entry.value), formatCount(entry.secondary ?? 0)])}
              empty="Nothing Apple can show yet (groups under 5 people are hidden)."
            />
          </div>
        </div>
        <h3 className="mb-2 mt-6 text-sm font-semibold text-foreground">Read by hand from App Store Connect (history)</h3>
        <Table
          caption="App Store numbers read by hand"
          head={["Read on", "Window", "Impressions", "Page views", "First downloads", "Page view → download"]}
          rows={input.manualReads.map((read) => [
            <>
              {formatDay(read.read_on)}
              <span className="block text-xs font-normal text-muted-foreground">through {formatDay(read.data_through)}</span>
            </>,
            read.window_label,
            formatCount(read.impressions),
            formatCount(read.product_page_views),
            formatCount(read.first_downloads),
            formatPercent(read.product_page_views > 0 ? read.first_downloads / read.product_page_views : null),
          ])}
          empty="No hand reads stored."
        />
        {latestRead ? <p className="mt-2 text-xs text-muted-foreground">These were read by hand before the live connection; they stay here as history.</p> : null}
      </Section>

      <Section id="website" title="Website (menuandmarket.com)" note="UTC days, production only. Visitors and page views share one count axis." badge={sourceBadge(view, "web")}>
        {view.website.hasData ? (
          <>
            <ChartTitle title="Visitors and page views per day" />
            <ColumnChart
              title="Website visitors and page views per day"
              summary={`Website visitors and page views per UTC day, ${rangeText(webDates)}${webNotTracked ? `; not tracked before ${trackingDay}` : ""}: ${plural(view.website.visitorsSum, "visitor", "visitors")} and ${plural(view.website.pageviewsSum, "page view", "page views")} added up by day.`}
              dates={webDates}
              layout="grouped"
              height={200}
              series={[
                { label: "Visitors", color: "var(--chart-1)", values: view.website.days.map((day, index) => (webTracked(index) ? day.visitors : null)) },
                { label: "Page views", color: "var(--chart-3)", values: view.website.days.map((day, index) => (webTracked(index) ? day.pageviews : null)) },
              ]}
              notTracked={webNotTracked}
              notTrackedNote={`Not tracked yet: website analytics started on ${trackingDay}.`}
              emptyNote="No visits on these days yet"
            />
            <ChartLegend
              items={[
                { label: "Visitors", color: "var(--chart-1)", kind: "box" },
                { label: "Page views", color: "var(--chart-3)", kind: "box" },
                ...(webNotTracked ? [{ label: `Not tracked yet (website analytics started ${trackingDay})`, kind: "hatch" as const }] : []),
              ]}
            />
          </>
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
        note={`Google Search Console, Pacific days; Google's numbers lag 2–3 days${view.search.dataThrough ? `. Data through ${formatDay(view.search.dataThrough)}.` : "."}`}
        badge={sourceBadge(view, "search_console")}
      >
        {view.search.hasData ? (
          <>
            <ChartTitle title="Clicks per day" />
            <ColumnChart
              title="Google search clicks per day"
              summary={`Google search clicks per Pacific day, ${rangeText(searchDates)}: ${plural(view.search.clicks, "click", "clicks")} in all.`}
              dates={searchDates}
              height={180}
              series={[{ label: "Clicks", color: "var(--chart-1)", values: view.search.days.map((day) => day.clicks) }]}
              emptyNote="No clicks on these days yet"
            />
            <div className="mt-6">
              <ChartTitle title="Impressions per day" note="How often the site showed up in Google results. Its own chart, because impressions run far higher than clicks." />
              <ColumnChart
                title="Google search impressions per day"
                summary={`Google search impressions per Pacific day, ${rangeText(searchDates)}: ${plural(view.search.impressions, "impression", "impressions")} in all.`}
                dates={searchDates}
                height={150}
                series={[{ label: "Impressions", color: "var(--chart-1)", values: view.search.days.map((day) => day.impressions) }]}
                emptyNote="No impressions on these days yet"
              />
            </div>
          </>
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

      <Section id="timeline" title="Launch timeline" note="Events also show as numbered markers on the sign-ups chart, with a key under it. Times are New York time.">
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
          Updates run every hour (sign-ups and website) and early every morning (everything, including the App Store). App sign-ups and the website are out of date after 2 hours, Google search after 36, the App Store after 72.
        </p>
      </footer>
    </div>
  );
}
