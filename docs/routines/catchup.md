# Catch-up routines (morning 8:45, EOD 5:00) — DRAFT

**DRAFT (Baseline task e8f1449d, plan `baseline-plans/brief-refresh/PLAN.md`).
Not live.** The PM creates these two routines, and pastes the updated prompts
into the two existing ones, only after Brent says yes to the exact text. The
Baseline side (`brief_status`, `mode: "refresh"`, the page's "Refreshed" line
and late-digest banner, migration 068) must be deployed first: the prompts call
`brief_status`, which the live server doesn't have before that.

## Why

The briefs are built on a fixed clock (7:55 AM and 4:15 PM ET), but their
inputs aren't: the work digest is filed from Brent's work PC when Copilot
finishes (AM-1103 was built at 7:57; the AM note landed at 8:06), and Granola
notes for a 4:00 meeting are not there at 4:15. Before this, a brief built
without them stayed that way. A catch-up run 50 minutes later checks once and,
only if something new came in, rebuilds the brief in place.

## How it works

Each catch-up routine uses **the same prompt as its main routine**, word for
word: [morning.md](morning.md) for 8:45 and [eod.md](eod.md) for 5:00. Their
step 0 makes one cheap call, `brief_status`, and then:

| `brief_status` says | The run does |
|---|---|
| No brief today (the main run failed or hasn't run) | Builds it, a normal first save (Brent gets the one notice). |
| A brief, and `refresh_needed.digest` true, or a finished Granola meeting with notes not in `brief.covered_meeting_ids` | Re-reads everything and saves with `mode: "refresh"`: the page's text is rewritten, every item and its state stay exactly as Brent left them, new items are added at the end, the old text is kept in `brief_revisions`, and no second notice is sent. The page shows "Refreshed 8:45 AM: <reason>". |
| A brief, nothing new | Replies "<code>: no change" and stops. Nothing is read or saved. |

The main runs use the same step 0, so a re-run of the 7:55 routine after the
brief exists is a refresh check too, never a duplicate.

The page itself also flags a late digest without any routine: when a digest
note the brief should cover is filed but isn't in the brief, it shows "The AM
work digest came in after this brief was built (filed 8:06 AM). A refresh is
queued for 8:45 AM." (after 8:45: "The catch-up run hasn't added it yet. Run
the catch-up again to refresh this page."). The 8:45 and 5:00 times in that
sentence come from `BRIEF_CATCHUP_TIME_ET` in `src/lib/briefs/refresh-view.ts`;
change both together.

## Routine settings

Two new routines. Everything not listed here is the same as the main routine
it follows (model, connectors, tools, "must not use").

| Setting | Morning catch-up | EOD catch-up |
|---|---|---|
| Name | Baseline morning brief catch-up | Baseline EOD brief catch-up |
| Model | Claude Opus 5.5 (`claude-opus-5-5`) | Claude Opus 5.5 (`claude-opus-5-5`) |
| Schedule | Weekdays 8:45 AM ET. UTC: `45 13 * * 1-5` while EST (now, until Sun Mar 14 2027), then `45 12 * * 1-5` while EDT. | Weekdays 5:00 PM ET. UTC: `0 22 * * 1-5` while EST, then `0 21 * * 1-5` while EDT. |
| Prompt | The prompt in [morning.md](morning.md), pasted unchanged. | The prompt in [eod.md](eod.md), pasted unchanged. |
| Connectors | Baseline (Mission Control MCP), Granola | Baseline (Mission Control MCP), Granola |
| Baseline tools permitted | The morning routine's list (which now includes `brief_status`). | The EOD routine's list (which now includes `brief_status` and `get_brief`). |
| The one write | `save_brief` | `save_eod_brief` |

The two main routines need `brief_status` added to their permitted tools (and
`get_brief` for the EOD) when their prompts are updated.

**Manual trigger.** "Run now" on either catch-up routine in claude.ai is
Brent's button for "the digest is in, rebuild the brief now". It is safe at any
time: with nothing new it stops after one call; with no brief it builds one.
The PM can start one the same way.

## Cost

A catch-up with nothing new is one `brief_status` call (plus a Granola
`list_meetings`). A refresh costs about the same as the main run.

## Live test (plan step 5, after ship and with Brent's OK; writes to his live pages)

Refresh AM-1103 and EOD-1102 with `date`, check that their items keep their
states (AM-1103 #3 dismissed and #4 accepted; EOD-1102 #1–#13), compare old
and new from `brief_revisions` (narrative, first moves, mail tile, footnote),
and check `notified_at` didn't change (no second Telegram notice).
