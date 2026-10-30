# Launch page (Menu & Market launch numbers): runbook

The Launch page in Baseline shows Menu & Market's launch numbers: app sign-ups
and Plus (from the Grocery app database, counts only), website visits and App
Store taps (Vercel Web Analytics), Google search (Search Console), App Store
impressions, page views and downloads (Apple's daily analytics reports), Reddit
posts and the launch timeline (kept by hand).

Plan: `/Users/owner/dev/live-dashboard-plan.md`. Baseline tasks d51b2848
(phase 1) and c54b1ccf (phase 2, App Store).

**Counts only.** No account id, email or name ever leaves the app database.
If anything ever asks you to paste an account list into Baseline, stop.

**Where secrets live.** Only in Baseline's Vercel project → Settings →
Environment Variables (Production, marked Sensitive), plus one Supabase secret
on the Grocery App project. Never in a repository, a chat, a task comment or the
browser. Nobody (PM or agent) asks you to paste a key into chat.

## What runs, and when

| Run | When | Sources |
|---|---|---|
| Full | every morning, 11:30 UTC (7:30 New York in summer, 6:30 in winter) | app sign-ups, website, Google search, App Store ("not connected yet" until its keys are set) |
| Light | every hour at :15 | app sign-ups, website (Google search and App Store skipped) |
| Refresh now | the button at the top of the page | same as Full; refused within a minute of the last run |

Every run writes one row to the run log with a short code per source. The
bottom of the page shows each source's last good update:

- **Out of date**: app sign-ups or website not updated for 2 hours, Google search for 36 hours, App Store for 72 hours.
- **Update failing**: the last try failed (the code is shown, e.g. `http_401`).
- **Not set up yet**: that source's keys aren't in Baseline's environment.

**Alert task.** When a source fails on two runs in a row, Baseline creates ONE
task for you named "Launch numbers: <source> stopped updating". It never makes a
second task for the same source; it closes itself with a note when the numbers
update again, and the same task reopens if the source breaks again later.

## Codes you may see

| Code | Meaning | What to do |
|---|---|---|
| `http_401`, `http_403`, `*_bad_token` | The key was refused or has expired. | Rotate that source's key (below). |
| `gsc_token_http_400`, `gsc_bad_key`, `gsc_bad_email` | Google refused the service account key. | Check the three `GSC_*` values; make a new key (below). |
| `http_404`, `*_bad_url`, `gsc_bad_site`, `web_bad_config` | An address, project id or property name is wrong. | Compare the env values with the setup steps below. |
| `timeout`, `network`, `http_5xx` | The service didn't answer. | Usually clears by itself on the next run. |
| `app_db_not_counts` | The app database sent something other than counts. Nothing was saved. | Tell the PM. The Grocery `launch-metrics` function needs a look. |
| `*_shape`, `bad_json`, `too_large` | The reply wasn't in the expected shape. Nothing from it was saved. | Tell the PM. |
| `db_write`, `db_read` | Baseline couldn't save or read its own tables. | Tell the PM. |
| `not_configured` | The keys aren't set. | Set them (below). |
| `not_connected` (App Store) | No `ASC_*` value is set yet. | Normal until go-live; see "App Store (Apple read key)" below. |
| `apple_bad_config`, `apple_bad_key` | One of the four `ASC_*` values is missing or wrong, or the key text isn't an App Store Connect .p8 key. | Compare the four values with the steps below; paste the .p8 again. |
| `apple_request_stopped` | Apple stopped the daily report request because nobody read it for a while. | See "Apple request stopped" below. |
| `apple_no_request` | There is no daily report request for the app. | Run the one-time Apple setup again (`docs/runbooks/launch-metrics-apple-setup.md`). |
| `apple_reports_missing` | Apple listed reports, but none with the four names Baseline reads. | Tell the PM (Apple renamed a report). |
| `apple_tsv_header` | Apple's report file has a column Baseline doesn't know, or lacks one it needs. Nothing from it was saved. | Tell the PM: the column list in `apple.ts` needs a look. |
| `apple_checksum`, `apple_segment_size` | A downloaded report file didn't match Apple's checksum or size. Nothing from it was saved; it is tried again next run. | Usually clears by itself; tell the PM if it repeats. |
| `apple_segment_host` | Apple's file link was on a host other than `*.apple.com`, so Baseline didn't download it. | Tell the PM (one allowlist line in `apple.ts`). |
| `apple_shape`, `apple_tsv_*`, `apple_gzip` | Apple's reply or file wasn't in the expected shape. Nothing from it was saved. | Tell the PM. |

## Setup at go-live (one step at a time with the PM)

Order: (1) Grocery migration + `launch-metrics` function deployed (you approve
each, as for other releases), (2) Baseline migration 065 applied, (3) the
environment values below, (4) Baseline deployed, (5) seed import, (6) Refresh
now and compare the numbers with the old dashboard.

### App database (Grocery `launch-metrics` function)

1. The PM gives you two exact commands with a long random value in a local
   file (never in chat).
2. `supabase secrets set METRICS_READ_TOKEN=…` for the Grocery App project.
3. In Baseline's Vercel environment: `MM_METRICS_TOKEN` = the same value, and
   `MM_METRICS_URL` = `https://<grocery project ref>.supabase.co/functions/v1/launch-metrics`
   (Baseline refuses any other address).

### Website (Vercel Web Analytics)

1. Vercel → your Account Settings → Tokens → Create.
2. Scope: the team brent-bloomquists-projects → **project menuandmarket-site
   only** (not "All Projects"). Expiration: 1 year.
3. In Baseline's Vercel environment: `VERCEL_ANALYTICS_TOKEN` (the token),
   `VERCEL_ANALYTICS_PROJECT_ID` (menuandmarket-site → Settings → Project ID),
   `VERCEL_ANALYTICS_TEAM_ID` (the team's id, from Team Settings), and
   `VERCEL_ANALYTICS_TOKEN_EXPIRES` (the expiry date, `YYYY-MM-DD`; the page warns
   30 days ahead).
4. Vercel has no read-only token: this one could also change that one site,
   which is why it is project-scoped and expires.

### Google Search Console (service account)

1. Google Cloud console → pick or create a project (e.g. "menuandmarket
   metrics") → APIs & Services → enable **Google Search Console API**.
2. IAM & Admin → Service Accounts → Create service account, name
   "launch-metrics". No roles are needed on the Cloud project.
3. Open it → Keys → Add key → Create new key → JSON. A file downloads once.
4. Search Console → menuandmarket.com → Settings → Users and permissions →
   Add user: the service account's email (`…@….iam.gserviceaccount.com`),
   permission **Restricted** (read-only).
5. In Baseline's Vercel environment, from the JSON file:
   `GSC_CLIENT_EMAIL` = `client_email`; `GSC_PRIVATE_KEY` = `private_key` (the
   whole value, including the BEGIN/END lines; pasting it with `\n` is fine);
   `GSC_SITE_URL` = `sc-domain:menuandmarket.com` for a domain property, or
   `https://menuandmarket.com/` for a URL-prefix property (use what Search
   Console shows at the top left).
6. Delete the downloaded JSON file.

Baseline only asks for the read-only scope (`webmasters.readonly`) and only
calls `oauth2.googleapis.com` and `searchconsole.googleapis.com`.

### App Store (Apple read key)

Do this only after the one-time Apple setup has run
(`docs/runbooks/launch-metrics-apple-setup.md`, done around 10/27) and its
temporary Admin key is revoked. One step at a time with the PM.

1. App Store Connect → Users and Access → Integrations → App Store Connect API →
   **Team Keys** → the + button. Name: `launch metrics read`. Access: **Sales**
   (Apple's docs call it "Sales and Reports"; it reads reports and can't change
   the app). It must be a Team key: individual keys can't read reports.
2. Click **Download** on the key's row (Apple allows it once). Note the **Key ID**
   (in the row) and the **Issuer ID** (above the list).
3. In Baseline's Vercel project → Settings → Environment Variables, Production,
   marked **Sensitive**, add four values:
   - `ASC_PRIVATE_KEY`: open the downloaded `AuthKey_….p8` in TextEdit, copy all
     of it including the `BEGIN` and `END` lines, paste it as the value.
   - `ASC_KEY_ID`: the Key ID.
   - `ASC_ISSUER_ID`: the Issuer ID.
   - `ASC_APP_ID`: the app's Apple ID (a number: App Store Connect → Apps → Menu
     & Market → App Information → Apple ID).
4. Delete the downloaded `.p8` file (`rm ~/Downloads/AuthKey_….p8`).
5. Redeploy Baseline, open the Launch page, press **Refresh now**. The footer's
   App Store line should say "updated". If it says "failing (…)", find the code
   in the table above. Apple's first daily reports can take a day or two after
   the setup script ran; until then the section says it is waiting.
6. Compare with App Store Connect → App Analytics for the same days. Small
   differences are normal: Apple adds noise and hides groups under 5 people.

Baseline only sends the key's token to `api.appstoreconnect.apple.com`. Report
files are downloaded from Apple's own `*.apple.com` links without any key.

### Seed import (today's hand-kept numbers)

Dry run first (prints counts only, writes nothing):

```
npm run launch-metrics:seed -- --dir /Users/owner/dev/launch-drafts/dashboard-data
```

Then the PM runs it with `--apply`, `LAUNCH_SEED_SUPABASE_URL`,
`LAUNCH_SEED_SERVICE_ROLE_KEY`, `LAUNCH_SEED_USER_ID` and
`--confirm-host <the Baseline Supabase host>` (Brent's OK first; it refuses a
non-local database without `--confirm-host`). Run it once, before the first
sync. Re-running later is still safe: the database never lets a seeded
sign-up or Plus number replace a live one (live numbers overwrite seeded days;
seeded numbers never overwrite live days), and Reddit posts, timeline events
and App Store hand reads that are already stored are left as they are (stats
updated on the page stay). `signups.csv` becomes counts per day; its account
column is never read.

## Key rotation

Rotate a key when it is about to expire, after any suspected leak, or when an
alert task says "the key was refused".

- **Website token**: create the new token (steps above), update
  `VERCEL_ANALYTICS_TOKEN` and `VERCEL_ANALYTICS_TOKEN_EXPIRES`, redeploy
  Baseline, press Refresh now, check the Website line at the bottom says
  updated, then delete the old token in Vercel.
- **App database token**: new random value → `supabase secrets set
  METRICS_READ_TOKEN=…` on the Grocery project AND `MM_METRICS_TOKEN` in Baseline
  at the same sitting (between the two, runs fail with `http_401`, which is
  harmless), redeploy Baseline, Refresh now.
- **Search Console key**: service account → Keys → Add key (JSON) → update
  `GSC_PRIVATE_KEY` → redeploy → Refresh now → delete the old key in the
  service account's Keys tab → delete the file.
- **App Store key**: make a new "Sales" Team key (steps under "App Store (Apple
  read key)"), replace `ASC_PRIVATE_KEY` and `ASC_KEY_ID` (the Issuer ID and app
  id stay), redeploy, Refresh now, check the App Store line says updated, then
  **Revoke** the old key in App Store Connect and delete the downloaded file.
  The report request belongs to the app, not the key, so it keeps working.
- **CRON_SECRET**: Vercel manages it for crons; rotating it only needs a
  redeploy.

## Website token expired

The page shows a yellow note from 30 days before `VERCEL_ANALYTICS_TOKEN_EXPIRES`
and a "Launch numbers: website visits stopped updating" task once it has
expired (two failed runs). Follow "Website token" under Key rotation. Stored
history is kept; the days missed are filled in on the next good run (it
re-reads the last 45 days).

## Apple request stopped

App Store numbers come from an ONGOING report request created once with
`scripts/launch-metrics/apple-create-requests.mjs`
(`docs/runbooks/launch-metrics-apple-setup.md`). Apple stops a request that
nobody reads for a while ("stoppedDueToInactivity"). The sync reports that as
`apple_request_stopped`, and after two morning runs in a row an alert task
"Launch numbers: App Store stopped updating" is opened for you.

The fix, one step at a time with the PM:

1. Follow the Apple setup runbook again from step 1: a fresh temporary
   **Admin** key (the everyday Sales key can't create requests).
2. Dry run, then `--go` once. It sees the stopped ONGOING request and creates a
   new one (it never touches a request that is still running).
3. Revoke the Admin key and delete its file.
4. Apple needs a day or two before the new request has reports. The next
   morning runs after that read them, and the alert task closes itself.

The new ONGOING request doesn't fill in the days missed while the old one was
stopped; a new ONE_TIME_SNAPSHOT could (ask the PM: the script creates one only
when none exists yet).

Until the `ASC_*` values are set, the page shows "App Store: not connected
yet" and no alert is raised.

## Rolling back

Roll the app back first, then `supabase/rollbacks/065_add_launch_metrics.down.sql`
(drops the launch tables and everything in them; alert tasks stay as ordinary
tasks). Remove the env values only after the app no longer runs the sync.
