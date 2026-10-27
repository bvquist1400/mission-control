# Launch metrics fixtures

Shapes, not recordings: no live call was made to build these (phase 1 rule).

- `vercel-*.json`: the response shape in Vercel's Web Analytics API docs
  (`/docs/analytics/web-analytics-api`, `/docs/rest-api/web-analytics/aggregates-page-views`,
  read 2026-10-27): `{ version, query, data: [ { timestamp, pageviews, visitors, <dimension> } ] }`;
  events use `count` and group `eventData/<key>` under the key `eventData`. Extra
  per-visitor fields from the reference schema (`visitorId`, `userId`) are included on
  purpose: the parser must never read them.
- `app-db-summary.json`: the counts-only contract from the plan (§3.2) as changed by
  Brent's decisions (no accounts list; unconfirmed counted separately). The Grocery
  function is being built in parallel; the PM reconciles at integration.
- `gsc-*.json`: Google's documented `token` and `searchAnalytics.query` replies.
