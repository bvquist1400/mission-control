# Launch metrics: one-time Apple setup

This tells Apple to start making daily App Store analytics reports for Menu & Market, so the launch dashboard can read them later. You do it once. About 10 minutes. Apple needs 1–2 days after this before the first reports appear.

It needs an **Admin** key from App Store Connect, because only Admin can ask Apple to start reports. That key is temporary: you delete it at the end. The everyday read key (role "Sales") is a separate, later step in the dashboard plan.

The script runs on your Mac, from your own Terminal. Nobody else sees the key: the script never prints it, never saves it, and never copies it anywhere. It only talks to `api.appstoreconnect.apple.com`.

## What you need

- The app's **Apple ID** (a number). App Store Connect → Apps → Menu & Market → App Information → General Information → Apple ID.
- About 10 minutes at your Mac.

## Steps

1. **Make the temporary Admin key.**
   - App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → the + button (Generate API Key).
   - Name: `launch metrics setup`. Access: **Admin**. Generate.
   - Click **Download** on that key's row. Apple lets you download it only once. It lands in Downloads as `AuthKey_XXXXXXXXXX.p8` (the X's are the Key ID).
   - Note the **Key ID** (in the key's row) and the **Issuer ID** (shown above the list of keys).
   - Leave the file in Downloads. Don't move it into any code folder: the script refuses to run if the key sits inside a code repository.

2. **Lock the key file so only you can read it.** In Terminal (change the X's to your Key ID):

   ```
   chmod 600 ~/Downloads/AuthKey_XXXXXXXXXX.p8
   ```

   The script refuses to run until you do this, because Downloads files are readable by other accounts on the Mac by default.

   If macOS asks whether Terminal may use the Downloads folder, that's your call; it's needed for these steps.

3. **Dry run (sends nothing).** In Terminal, swap in your Key ID, Issuer ID and the app's Apple ID:

   ```
   cd "/Users/owner/dev/Cooper Mission Control/mission-control"
   node scripts/launch-metrics/apple-create-requests.mjs --key ~/Downloads/AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --issuer 00000000-0000-0000-0000-000000000000 --app-id 1234567890
   ```

   It should say `Dry run: no requests were sent to Apple` and list the three things it would do. If it says `Refused:`, follow what it says and run it again.

4. **Do it for real.** Run the same command with `--go` at the end:

   ```
   node scripts/launch-metrics/apple-create-requests.mjs --key ~/Downloads/AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --issuer 00000000-0000-0000-0000-000000000000 --app-id 1234567890 --go
   ```

5. **Delete the Admin key at Apple.** Same Team Keys screen → click `launch metrics setup` → **Revoke API Key**. Do this even if step 4 failed; you can make a fresh key to try again.

6. **Delete the file on your Mac.**

   ```
   rm ~/Downloads/AuthKey_XXXXXXXXXX.p8
   ```

7. **Tell the PM the lines the script printed** (they're safe to share: request ids only). Don't share the Key ID, Issuer ID or the file. There's no need to.

## What the output means

Each line looks like `Request <id>: <type>, <created or already existed>, stopped: <yes or no>`.

- **ONGOING**: the request that makes new reports every day. This is the one the dashboard needs.
- **ONE_TIME_SNAPSHOT**: a one-off request that captures history from before today (launch week). Apple never adds to it after the day it was made.
- **created**: the script just asked Apple for it.
- **already existed**: it was there before; the script left it alone. Running the script twice is safe.
- **stopped: yes**: Apple stopped that request because nobody downloaded its reports for a long time. The script then creates a new ONGOING request and says so.
- The last line, `Done. Apple usually needs 1-2 days…`, means it worked.

If something goes wrong it prints one line, for example `Apple returned HTTP 401 (code NOT_AUTHORIZED) while listing report requests. Stopped.` Common ones:

| What it says | What it usually means |
|---|---|
| HTTP 401 | The Key ID or Issuer ID doesn't match the file, the key was already revoked, or the Mac's clock is wrong. |
| HTTP 403 | The key isn't Admin. Make a new key with Admin access. |
| HTTP 404 | The app's Apple ID is wrong. |
| HTTP 409 | Apple says a request like this already exists. Run it again without changes; if it repeats, tell the PM. |
| HTTP 429 | Too many requests; wait a few minutes and run it again. |
| Could not reach Apple | Internet problem; run it again. |
| Refused: … | A safety check stopped it before anything was sent. Do what it says. |

Exit codes, for scripts: 0 = worked, 1 = Apple or network problem, 2 = refused before sending anything.

## If Apple stops the request later

If the dashboard ever shows `apple_request_stopped`, Apple stopped the ONGOING request (for example after a long gap with no downloads). Do steps 1–7 again. The script sees the stopped request, makes a new ONGOING one, and leaves the snapshot alone. Reports start again 1–2 days later; days in the gap may need the snapshot or a manual read.

## For reviewers: what the script does

`scripts/launch-metrics/apple-create-requests.mjs` (plain Node 20+, no dependencies; tests: `npm run test:launch-metrics-apple-setup`):

1. Checks the arguments (numeric app id, key id letters/digits, issuer a UUID) and the key file (not inside any git repository, following symlinks; no group/other permission bits; a P-256 EC private key).
2. Without `--go`: signs a token locally to prove the key works, prints the plan, and exits. No network.
3. With `--go`: signs one ES256 token (`alg ES256`, `kid`, `typ JWT`; `iss`, `iat`, `exp` = 15 minutes, `aud appstoreconnect-v1`), then
   - `GET /v1/apps/{id}/analyticsReportRequests?fields[analyticsReportRequests]=accessType,stoppedDueToInactivity&limit=200` (follows `links.next` only on Apple's host);
   - `POST /v1/analyticsReportRequests` with `accessType: ONGOING` if no ONGOING request with `stoppedDueToInactivity` false exists;
   - `POST /v1/analyticsReportRequests` with `accessType: ONE_TIME_SNAPSHOT` if no snapshot request exists (stopped or not).
   - Every call: `redirect: 'error'`, 30-second timeout. Stops at the first error.
4. Prints only ids, access types, created/already existed and the stopped flag. Errors: HTTP status and Apple's `errors[0].code` (only if it is plain letters, digits, `_ . -`). Response bodies, headers, the key and the token are never printed or written.

Apple pages this follows (checked 2026-10-26):

- Downloading analytics reports (steps; only Admin can create requests; first reports in 1–2 days; `stoppedDueToInactivity` needs a new request): https://developer.apple.com/documentation/appstoreconnectapi/downloading-analytics-reports
- Request analytics reports, `POST /v1/analyticsReportRequests` (body shape; 201/400/401/403/409/422/429): https://developer.apple.com/documentation/appstoreconnectapi/post-v1-analyticsreportrequests
- List an app's report requests, `GET /v1/apps/{id}/analyticsReportRequests` (fields, `filter[accessType]`, limit up to 200): https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps-_id_-analyticsreportrequests
- Report request attributes (`accessType` ONGOING / ONE_TIME_SNAPSHOT, `stoppedDueToInactivity`): https://developer.apple.com/documentation/appstoreconnectapi/analyticsreportrequest/attributes-data.dictionary
- Generating tokens for API requests (ES256, header and claims, 20-minute limit, `Authorization: Bearer`): https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests
- Error response (`errors[].code`, `status`, `title`, `detail`): https://developer.apple.com/documentation/appstoreconnectapi/errorresponse

Not stated in Apple's docs, so the script plays safe:

- Whether Apple allows a second ONGOING or snapshot request per app, and exactly when it answers 409. The script never asks for a duplicate; a 409 is reported and stops.
- The paging link names. The list call asks for up to 200 requests (an app has a handful), and follows `links.next` only to Apple's own host.
- The App Store Connect screen labels above may differ slightly from what you see; the Key ID, Issuer ID and Admin access are what matter.
