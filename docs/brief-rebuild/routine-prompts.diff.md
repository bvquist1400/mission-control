# Brief rebuild: routine prompt changes (DRAFT, not applied)

Baseline task 5dbe87fd (Brent 11/19: "Both A and B (Recommended)"). These are
**proposals only**. Nothing here is live and no routine, RemoteTrigger, n8n or
Vercel setting was changed. The PM applies them after (1) the server change on
branch `claude/brief-rebuild` is deployed, and (2) Brent says yes to the exact
text below. Order matters: the live server today ignores `force`, so a
"rebuild" before the deploy would be a plain refresh, and on a day with no
brief yet it would build one and send the notice.

**Where the current text came from.** The routine prompts are kept in the repo
as `docs/routines/morning.md`, `docs/routines/eod.md` and
`docs/routines/catchup.md`; every "Old" block below is copied byte for byte
from those files at base `42f6f3d`. Those files still say "DRAFT, not live",
but the catch-up routines are live (AM-1119 was refreshed at 8:47 on 11/19),
so the live trigger prompts may differ. **Before pasting, read the live prompt
of each routine back (RemoteTrigger `derived_state.prompt`) and check each
"Old" block is in it word for word**; if one isn't, stop and re-draft that
block from the live text. The chat-project instructions for "am" / "eod" in
the Baseline Claude project live in claude.ai, not in the repo; the "In chat"
sections of `morning.md` / `eod.md` are the repo's copy of them, so the chat
changes below are drafted against those.

What changes, in plain words:

1. **Re-filed digest is noticed.** `brief_status` now flags a digest note the
   brief read but that was re-filed after the brief was last built or
   refreshed (`am_digest_updated` / `pm_digest_updated`). The prompts already
   refresh on any `refresh_needed.digest`; the new text only names the new
   reasons, so the routine says why on the page ("AM work digest re-filed").
   On the EOD, `work_digest.am.in_morning_brief` is now false after a re-file,
   so the EOD takes in the newer AM text.
2. **"rebuild am" / "rebuild eod".** A rebuild on command, even with nothing
   new: same refresh rules (items keep their states, old text kept, no notice),
   saved with `mode: "refresh"` + `force: true`. The server refuses a forced
   rebuild when the brief doesn't exist (409), so it can never send the notice.
3. **One unscheduled routine**, "Baseline brief — rebuild now", for a phone tap:
   [rebuild-now-routine.md](rebuild-now-routine.md).

Tools: no new tool. The morning routine already has `save_brief`, the EOD
`save_eod_brief`; `force` is a new optional field on both. The PM also copies
each "New" block into the repo files above when it applies them (so the repo
copy matches live again).

## Prompt, step 0 (morning)

File: `docs/routines/morning.md`

**Old** (exact):

```text
### 0. Build, refresh or stop

Start with `brief_status(edition="am")` for today, before anything else.

- `brief.exists` is false: build today's brief (steps 1–4), a normal save.
- `brief.exists` is true: this run only refreshes it, and only if something
  came in after it was built:
  - `refresh_needed.digest` is true (this morning's work digest was filed
    after the brief was built; `refresh_needed.reasons` says which note), or
  - a late meeting from step 5's sweep (Granola `list_meetings`, same window
    and rules) whose id is **not** in `brief.covered_meeting_ids` and whose
    notes are there now (`get_meetings` for those ids only).
- Neither: reply with one line, "<code>: no change (built <built_at as h:mm
  AM>, <last refresh, or never refreshed>)", and stop. Read nothing else and
  save nothing.
- Something new: also `get_brief(code=<brief.code>)` to see what Brent has
  already decided on the page, then run steps 1–4 again in full (re-read
  everything; don't patch the old text) and save with `mode: "refresh"` (step
  3). Write the narrative and first moves for where things stand now, counting
  what Brent already decided.
```

**New**:

```text
### 0. Build, refresh, rebuild or stop

Start with `brief_status(edition="am")` for today, before anything else.

- `brief.exists` is false: build today's brief (steps 1–4), a normal save.
  This holds for "rebuild am" too: there is nothing to rebuild yet.
- **Rebuild on command.** The run was started with "rebuild am" (Brent in
  chat, or the "rebuild now" routine) and `brief.exists` is true: skip the
  "no change" check below and do "Something new" even if nothing is new. Save
  with `mode: "refresh"` and `force: true` (step 3).
- `brief.exists` is true: this run only refreshes it, and only if something
  came in after it was built:
  - `refresh_needed.digest` is true: this morning's work digest was filed
    after the brief was built (`am_digest_not_in_brief`), or was re-filed
    after the brief was last built or refreshed (`am_digest_updated`: same
    note, newer text). `refresh_needed.reasons` says which. Or
  - a late meeting from step 5's sweep (Granola `list_meetings`, same window
    and rules) whose id is **not** in `brief.covered_meeting_ids` and whose
    notes are there now (`get_meetings` for those ids only).
- Neither: reply with one line, "<code>: no change (built <built_at as h:mm
  AM>, <last refresh, or never refreshed>)", and stop. Read nothing else and
  save nothing.
- Something new: also `get_brief(code=<brief.code>)` to see what Brent has
  already decided on the page, then run steps 1–4 again in full (re-read
  everything; don't patch the old text) and save with `mode: "refresh"` (step
  3). Write the narrative and first moves for where things stand now, counting
  what Brent already decided.
```

## Prompt, step 3: the Refresh bullet (morning)

File: `docs/routines/morning.md`

**Old** (exact):

```text
- **Refresh** (step 0 found something new): call `save_brief` with
  `edition: "am"`, `mode: "refresh"`, `refresh_reason` (a few words for the
  page's "Refreshed 8:45 AM: …" line, e.g. "AM work digest added", "1 late
  meeting added"), the whole new `content` (every field you'd send on a first
  build: anything you leave out disappears from the page), `items` built
  exactly as for a first build, and `covered_meeting_ids` as above. Items
  already on the page come back as `kept_on_refresh` with their number and
  stay exactly as Brent left them; only new ones are added (the usual append
  rules apply). Never leave an item out to "clean up": a refresh never removes
  items.
```

**New**:

```text
- **Refresh** (step 0 found something new): call `save_brief` with
  `edition: "am"`, `mode: "refresh"`, `refresh_reason` (a few words for the
  page's "Refreshed 8:45 AM: …" line, e.g. "AM work digest added", "1 late
  meeting added", "AM work digest re-filed"), the whole new `content` (every field you'd send on a first
  build: anything you leave out disappears from the page), `items` built
  exactly as for a first build, and `covered_meeting_ids` as above. Items
  already on the page come back as `kept_on_refresh` with their number and
  stay exactly as Brent left them; only new ones are added (the usual append
  rules apply). Never leave an item out to "clean up": a refresh never removes
  items.
- **Rebuild on command** ("rebuild am"): the same call as Refresh, plus
  `force: true`, with a `refresh_reason` that says why in a few words (e.g.
  "rebuilt on request"; left out, the page says "Rebuilt on request"). It
  keeps every item and its state, keeps the old text in Baseline's history and
  never sends a notice. If the save answers 409 (no brief to rebuild), say so
  in your reply and stop; don't retry without `force`.
```

## "In chat (the Baseline Claude project)": after the "morning"/"am" bullet

File: `docs/routines/morning.md`

**Old** (exact):

```text
- **"morning"** or **"am"**: run steps 1–3 above, then show the brief in chat
  in the same voice, numbered like the page. If the 8:00 run already saved
  today's AM brief, the save changes nothing and sends no second notice.
```

**New**:

```text
- **"morning"** or **"am"**: run steps 1–3 above, then show the brief in chat
  in the same voice, numbered like the page. If the 8:00 run already saved
  today's AM brief, the save changes nothing and sends no second notice.
- **"rebuild am"**: rebuild today's AM brief now, even if nothing new came
  in: step 0's "Rebuild on command", steps 1–3 in full, save with
  `mode: "refresh"` and `force: true`, then show the brief in chat. Every item
  keeps its state and no notice is sent. With no AM brief yet, build it
  normally instead.
```

## Prompt, step 0 (EOD)

File: `docs/routines/eod.md`

**Old** (exact):

```text
### 0. Build, refresh or stop

Start with `brief_status(edition="eod")` for today, before anything else.

- `brief.exists` is false: build today's brief (steps 1–4), a normal save.
- `brief.exists` is true: this run only refreshes it, and only if something
  came in after it was built:
  - `refresh_needed.digest` is true (a work digest note it should cover was
    filed after it was built; `refresh_needed.reasons` says which), or
  - a meeting from today that has now ended (Granola `list_meetings` for
    today) whose id is **not** in `brief.covered_meeting_ids` and whose notes
    are there now (`get_meetings` for those ids only).
- Neither: reply with one line, "<code>: no change (built <built_at as h:mm
  PM>, <last refresh, or never refreshed>)", and stop. Read nothing else and
  save nothing.
- Something new: also `get_brief(code=<brief.code>)` to see what Brent has
  already decided on the page, then run steps 1–4 again in full (re-read
  everything; don't patch the old text) and save with `mode: "refresh"` (step
  3). Write the narrative and first moves for where things stand now, counting
  what Brent already decided.
```

**New**:

```text
### 0. Build, refresh, rebuild or stop

Start with `brief_status(edition="eod")` for today, before anything else.

- `brief.exists` is false: build today's brief (steps 1–4), a normal save.
  This holds for "rebuild eod" too: there is nothing to rebuild yet.
- **Rebuild on command.** The run was started with "rebuild eod" (Brent in
  chat, or the "rebuild now" routine) and `brief.exists` is true: skip the
  "no change" check below and do "Something new" even if nothing is new. Save
  with `mode: "refresh"` and `force: true` (step 3).
- `brief.exists` is true: this run only refreshes it, and only if something
  came in after it was built:
  - `refresh_needed.digest` is true: a work digest note it should cover was
    filed after it was built (`am_digest_not_in_brief`,
    `pm_digest_not_in_brief`), or was re-filed after the brief that read it
    was last built or refreshed (`am_digest_updated`, `pm_digest_updated`:
    same note, newer text). `refresh_needed.reasons` says which. Or
  - a meeting from today that has now ended (Granola `list_meetings` for
    today) whose id is **not** in `brief.covered_meeting_ids` and whose notes
    are there now (`get_meetings` for those ids only).
- Neither: reply with one line, "<code>: no change (built <built_at as h:mm
  PM>, <last refresh, or never refreshed>)", and stop. Read nothing else and
  save nothing.
- Something new: also `get_brief(code=<brief.code>)` to see what Brent has
  already decided on the page, then run steps 1–4 again in full (re-read
  everything; don't patch the old text) and save with `mode: "refresh"` (step
  3). Write the narrative and first moves for where things stand now, counting
  what Brent already decided.
```

## Prompt, step 1.5: the work digest (EOD; first four lines only)

File: `docs/routines/eod.md`

**Old** (exact):

```text
5. **The work digest.** The digest's `work_digest` has today's two digests of
   Brent's work mail and Teams. Use `work_digest.pm` (this afternoon's), plus
   `work_digest.am`'s items **only if** `work_digest.am.in_morning_brief` is
   false (this morning's brief didn't have it). Each `ok` note has `items`
```

**New**:

```text
5. **The work digest.** The digest's `work_digest` has today's two digests of
   Brent's work mail and Teams. Use `work_digest.pm` (this afternoon's), plus
   `work_digest.am`'s items **only if** `work_digest.am.in_morning_brief` is
   false (this morning's brief didn't have it, or the AM note was re-filed
   after the morning brief was built: then `updated_after_morning_brief` is
   true). Each `ok` note has `items`
```

## Prompt, step 3: the Refresh bullet (EOD)

File: `docs/routines/eod.md`

**Old** (exact):

```text
- **Refresh** (step 0 found something new): call `save_eod_brief` with
  `mode: "refresh"`, `refresh_reason` (a few words for the page's "Refreshed
  5:00 PM: …" line, e.g. "PM work digest added", "4:00 meeting notes added"),
  the whole new `content` (every field you'd send on a first build: anything
  you leave out disappears from the page), `items` built exactly as for a
  first build, and `covered_meeting_ids` as above. Items already on the page
  come back as `kept_on_refresh` with their number and stay exactly as Brent
  left them; only new ones are added (the usual append rules apply). Never
  leave an item out to "clean up": a refresh never removes items.
```

**New**:

```text
- **Refresh** (step 0 found something new): call `save_eod_brief` with
  `mode: "refresh"`, `refresh_reason` (a few words for the page's "Refreshed
  5:00 PM: …" line, e.g. "PM work digest added", "4:00 meeting notes added", "AM work digest re-filed"),
  the whole new `content` (every field you'd send on a first build: anything
  you leave out disappears from the page), `items` built exactly as for a
  first build, and `covered_meeting_ids` as above. Items already on the page
  come back as `kept_on_refresh` with their number and stay exactly as Brent
  left them; only new ones are added (the usual append rules apply). Never
  leave an item out to "clean up": a refresh never removes items.
- **Rebuild on command** ("rebuild eod"): the same call as Refresh, plus
  `force: true`, with a `refresh_reason` that says why in a few words (e.g.
  "rebuilt on request"; left out, the page says "Rebuilt on request"). It
  keeps every item and its state, keeps the old text in Baseline's history and
  never sends a notice. If the save answers 409 (no brief to rebuild), say so
  in your reply and stop; don't retry without `force`.
```

## "In chat (the Baseline Claude project)": after the "eod" bullet

File: `docs/routines/eod.md`

**Old** (exact):

```text
- **"eod"**: run steps 1–3 above, then show the brief in chat in the same
  voice, numbered like the page. On a day the 4:15 run already happened, this
  only appends items from meetings it didn't cover, and sends no second
  notice. Without a rerun, the next morning brief picks those meetings up
  ([morning.md](morning.md)). If it's the first save of the day, Baseline sends the notice.
```

**New**:

```text
- **"eod"**: run steps 1–3 above, then show the brief in chat in the same
  voice, numbered like the page. On a day the 4:15 run already happened, this
  only appends items from meetings it didn't cover, and sends no second
  notice. Without a rerun, the next morning brief picks those meetings up
  ([morning.md](morning.md)). If it's the first save of the day, Baseline sends the notice.
- **"rebuild eod"**: rebuild today's EOD brief now, even if nothing new came
  in: step 0's "Rebuild on command", steps 1–3 in full, save with
  `mode: "refresh"` and `force: true`, then show the brief in chat. Every item
  keeps its state and no notice is sent. With no EOD brief yet, build it
  normally instead.
```

## "How it works" table, second row

File: `docs/routines/catchup.md`

**Old** (exact):

```text
| A brief, and `refresh_needed.digest` true, or a finished Granola meeting with notes not in `brief.covered_meeting_ids` | Re-reads everything and saves with `mode: "refresh"`: the page's text is rewritten, every item and its state stay exactly as Brent left them, new items are added at the end, the old text is kept in `brief_revisions`, and no second notice is sent. The page shows "Refreshed 8:45 AM: <reason>". |
```

**New**:

```text
| A brief, and `refresh_needed.digest` true (a digest note filed after the build, or re-filed after the brief was last built or refreshed), or a finished Granola meeting with notes not in `brief.covered_meeting_ids` | Re-reads everything and saves with `mode: "refresh"`: the page's text is rewritten, every item and its state stay exactly as Brent left them, new items are added at the end, the old text is kept in `brief_revisions`, and no second notice is sent. The page shows "Refreshed 8:45 AM: <reason>". |
```

## "Manual trigger" paragraph

File: `docs/routines/catchup.md`

**Old** (exact):

```text
**Manual trigger.** "Run now" on either catch-up routine in claude.ai is
Brent's button for "the digest is in, rebuild the brief now". It is safe at any
time: with nothing new it stops after one call; with no brief it builds one.
The PM can start one the same way.
```

**New**:

```text
**Manual trigger.** "Run now" on either catch-up routine in claude.ai is
Brent's button for "the digest is in, refresh the brief now". It is safe at any
time: with nothing new it stops after one call; with no brief it builds one.
A re-filed digest counts as new (same note, newer text). To rebuild a brief
when nothing new came in (after Brent changed tasks or decided items), use the
"Baseline brief — rebuild now" routine ([../brief-rebuild/rebuild-now-routine.md](../brief-rebuild/rebuild-now-routine.md))
or say "rebuild am" / "rebuild eod" in the Baseline Claude project. The PM can
start one the same way.
```
