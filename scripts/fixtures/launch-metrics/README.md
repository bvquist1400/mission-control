# Launch metrics fixtures

Shapes, not recordings: no live call was made to build these (phase 1 rule).

- `vercel-*.json`: the response shape in Vercel's Web Analytics API docs
  (`/docs/analytics/web-analytics-api`, `/docs/rest-api/web-analytics/aggregates-page-views`,
  read 2026-10-27): `{ version, query, data: [ { timestamp, pageviews, visitors, <dimension> } ] }`;
  events use `count` and group `eventData/<key>` under the key `eventData`. Extra
  per-visitor fields from the reference schema (`visitorId`, `userId`) are included on
  purpose: the parser must never read them.
- `app-db-summary.json`: the REAL reply body of the Grocery `launch-metrics` edge
  function (branch claude/launch-metrics-db @ 29083c5, JSON contract schema_version 1
  in docs/handoffs/launch-metrics-db.md). Made offline, no deploy or hosted call: a
  synthetic `launch_metrics_summary()` result in the key order Postgres jsonb emits
  was passed through that branch's own `handleLaunchMetrics()` /
  `validateSummary()` (supabase/functions/_shared/launch-metrics-core.ts) and the
  200 body was saved as is. Counts are synthetic (2 real Apple users, 1 unconfirmed,
  2 family, 1 deleted on 10-25, Plus trial 1 / comp 3). No account id of any kind.
- `gsc-*.json`: Google's documented `token` and `searchAnalytics.query` replies.
