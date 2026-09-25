#!/usr/bin/env node
// Pure tests for brief pages: stable item keys, ET "Tomorrow" date math, input
// validation and the email line. No database; see test-briefs-db.mjs for that.

import assert from "node:assert/strict";

const keys = await import("../src/lib/briefs/keys.ts");
const validate = await import("../src/lib/briefs/validate.ts");
const { buildBriefEmail } = await import("../src/lib/briefs/service.ts");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const TASK_A = "43f28321-3e6c-4e26-ad61-4f362be72e5d";
const TASK_B = "0da49726-0615-412f-96ad-4266b69935f4";

function proposal(overrides = {}) {
  return {
    kind: "proposed_task",
    payload: { title: "Verify research nurse job codes in the SailPoint spreadsheet" },
    task_ids: [],
    source: {
      meetings: [
        { id: "81eb535e", title: "RN sub-template with Brenda", start: null, url: null, lines: ["Verify research nurse job codes in CellPoint spreadsheet (Brent)"] },
        { id: "58210575", title: "Brent-Saif 1:1", start: null, url: null, lines: ["Loop in Brenda on job codes"] },
      ],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// item_key stability
// ---------------------------------------------------------------------------

test("proposal key ignores reworded titles, meeting order, line order, case and punctuation", () => {
  const base = keys.computeBriefItemKey("eod", "2026-09-24", proposal());
  const reworded = keys.computeBriefItemKey(
    "eod",
    "2026-09-24",
    proposal({
      payload: { title: "Check where the RN job codes sit in SailPoint and add template columns" },
      source: {
        meetings: [
          { id: "58210575", title: "1:1", start: null, url: null, lines: ["  loop in BRENDA on job codes. "] },
          { id: "81eb535e", title: "Brenda", start: null, url: null, lines: ["Verify research nurse job codes in CellPoint spreadsheet (Brent)"] },
        ],
      },
    })
  );
  assert.equal(reworded, base);
  assert.match(base, /^proposal:[0-9a-f]{20}$/);
});

test("proposal key is date-free, so a rerun on another day maps to the same key (and the same task)", () => {
  assert.equal(
    keys.computeBriefItemKey("eod", "2026-09-24", proposal()),
    keys.computeBriefItemKey("eod", "2026-09-25", proposal())
  );
});

test("different cited lines give a different proposal key", () => {
  const other = proposal();
  other.source.meetings[1].lines = ["Present the in-basket fix to the security workgroup"];
  assert.notEqual(keys.computeBriefItemKey("eod", "2026-09-24", other), keys.computeBriefItemKey("eod", "2026-09-24", proposal()));
});

test("a proposal without cited lines keys on its title", () => {
  const noLines = proposal({ source: { meetings: [{ id: "m1", title: "M", start: null, url: null, lines: [] }] } });
  const same = proposal({ payload: { title: "verify RESEARCH nurse job codes in the SailPoint spreadsheet!" }, source: noLines.source });
  assert.equal(keys.computeBriefItemKey("eod", "2026-09-24", noLines), keys.computeBriefItemKey("eod", "2026-09-24", same));
});

test("carry keys are per brief date; group and choice keys ignore order", () => {
  const carry = { kind: "carry_over", payload: { title: "x" }, task_ids: [TASK_A], source: { meetings: [] } };
  assert.equal(keys.computeBriefItemKey("eod", "2026-09-24", carry), `eod:2026-09-24:carry_over:${TASK_A}`);
  assert.notEqual(keys.computeBriefItemKey("eod", "2026-09-24", carry), keys.computeBriefItemKey("eod", "2026-09-25", carry));

  const group = (ids) => ({ kind: "carry_group", payload: { title: "g" }, task_ids: ids, source: { meetings: [] } });
  assert.equal(
    keys.computeBriefItemKey("eod", "2026-09-24", group([TASK_A, TASK_B])),
    keys.computeBriefItemKey("eod", "2026-09-24", group([TASK_B, TASK_A]))
  );

  const choice = (options) => ({ kind: "choice", payload: { title: "Two meetings at 10 AM", options }, task_ids: [], source: { meetings: [] } });
  const a = { key: "bootcamp", label: "Bootcamp", recommended: true };
  const b = { key: "workflows", label: "Workflows", recommended: false };
  assert.equal(
    keys.computeBriefItemKey("eod", "2026-09-24", choice([a, b])),
    keys.computeBriefItemKey("eod", "2026-09-24", choice([b, a]))
  );
});

test("brief codes", () => {
  assert.equal(keys.buildBriefCode("eod", "2026-09-24"), "EOD-0924");
  assert.equal(keys.buildBriefCode("eod", "2027-09-24", true), "EOD-09242027");
  assert.equal(keys.normalizeBriefCode(" eod-0924 "), "EOD-0924");
});

// ---------------------------------------------------------------------------
// "Tomorrow" = next ET weekday, never UTC
// ---------------------------------------------------------------------------

test("Tomorrow from a Friday is Monday", () => {
  assert.equal(keys.resolveTomorrowDate("2026-09-25", new Date("2026-09-25T20:15:00Z")), "2026-09-28");
});

test("Tomorrow across the fall DST boundary (Nov 1 2026): Monday ends at 23:59:59.999 EST", () => {
  // Friday Oct 30 brief, acted on at 4:15 PM EDT; DST ends Sunday Nov 1.
  assert.equal(keys.resolveTomorrowDueAt("2026-10-30", new Date("2026-10-30T20:15:00Z")), "2026-11-03T04:59:59.999Z");
  // Thursday Oct 29 brief: Friday is still EDT.
  assert.equal(keys.resolveTomorrowDueAt("2026-10-29", new Date("2026-10-29T20:15:00Z")), "2026-10-31T03:59:59.999Z");
});

test("Tomorrow across the spring DST boundary (Mar 14 2027): Monday ends at 23:59:59.999 EDT", () => {
  assert.equal(keys.resolveTomorrowDueAt("2027-03-12", new Date("2027-03-12T21:15:00Z")), "2027-03-16T03:59:59.999Z");
  assert.equal(keys.resolveTomorrowDueAt("2027-03-11", new Date("2027-03-11T21:15:00Z")), "2027-03-13T04:59:59.999Z");
});

test("the UTC seam: 10 PM ET Thursday is still Thursday", () => {
  // Wed 9/23 brief worked Thu 9/24 at 10 PM ET (= Fri 02:00 UTC). The brief's
  // tomorrow (Thu) isn't past in ET, so it stays Thu. UTC math would say Fri.
  assert.equal(keys.resolveTomorrowDate("2026-09-23", new Date("2026-09-25T02:00:00Z")), "2026-09-24");
  assert.equal(keys.todayInBriefTimeZone(new Date("2026-09-25T02:00:00Z")), "2026-09-24");
});

test("a stale brief worked later moves to today (weekday) or the next weekday (weekend)", () => {
  // Mon 9/21 brief worked Thu 9/24 afternoon -> today.
  assert.equal(keys.resolveTomorrowDate("2026-09-21", new Date("2026-09-24T18:00:00Z")), "2026-09-24");
  // Wed 9/23 brief worked Sat 9/26 -> Mon 9/28.
  assert.equal(keys.resolveTomorrowDate("2026-09-23", new Date("2026-09-26T15:00:00Z")), "2026-09-28");
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("dismiss without a reason or a note is rejected; either one alone is enough", () => {
  assert.equal(validate.parseBriefActions([{ n: 1, action: "dismiss" }]).ok, false);
  assert.equal(validate.parseBriefActions([{ n: 1, action: "dismiss", note: "   " }]).ok, false);
  const withReason = validate.parseBriefActions([{ n: 1, action: "dismiss", reason: "Not worth it" }]);
  assert.equal(withReason.ok, true);
  assert.equal(withReason.value[0].reason, "not_worth_it");
  const withNote = validate.parseBriefActions([{ n: 2, action: "dismiss", note: "Nancy owns this" }]);
  assert.equal(withNote.ok, true);
  assert.equal(withNote.value[0].note, "Nancy owns this");
});

test("dismiss note over 500 characters, unknown reasons, repeated n and a pick without choice are rejected", () => {
  assert.equal(validate.parseBriefActions([{ n: 1, action: "dismiss", note: "x".repeat(501) }]).ok, false);
  assert.equal(validate.parseBriefActions([{ n: 1, action: "dismiss", note: "x".repeat(500) }]).ok, true);
  assert.equal(validate.parseBriefActions([{ n: 1, action: "dismiss", reason: "boring" }]).ok, false);
  assert.equal(validate.parseBriefActions([{ n: 1, action: "accept" }, { n: 1, action: "accept" }]).ok, false);
  assert.equal(validate.parseBriefActions([{ n: 3, action: "pick" }]).ok, false);
  assert.equal(validate.parseBriefActions([{ n: 0, action: "accept" }]).ok, false);
  assert.equal(validate.parseBriefActions([]).ok, false);
});

test("save input: proposals must cite a meeting; carry kinds need task UUIDs; choices need options", () => {
  const bad = validate.parseSaveBriefInput({
    date: "2026-09-24",
    items: [
      { kind: "proposed_task", title: "No citation" },
      { kind: "carry_over", title: "Two tasks", task_ids: [TASK_A, TASK_B] },
      { kind: "carry_group", title: "One task", task_ids: [TASK_A] },
      { kind: "carry_over", title: "Not a uuid", task_ids: ["abc"] },
      { kind: "choice", title: "One option", options: [{ key: "a", label: "A" }] },
      { kind: "memo", title: "Unknown kind" },
    ],
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length >= 6, true, bad.errors.join("\n"));
});

test("save input: defaults, normalization and unsafe links", () => {
  const parsed = validate.parseSaveBriefInput(
    {
      content: {
        narrative: "  A good day. ",
        meetings: [
          { id: "m1", title: "DEP", start: "2026-09-24T13:43:00Z", url: "javascript:alert(1)" },
          { title: "No notes", start: "2026-09-24T14:00:00Z" },
          { title: "Missing start" },
        ],
        bogus: 1,
      },
      items: [
        {
          kind: "proposed_task",
          title: "Invite DEP",
          source: { meetings: [{ id: "m1", title: "DEP", url: "https://notes.granola.ai/d/m1", line: "Invite DEP (Brent)" }] },
          maybe_tracked: { task_id: TASK_A.toUpperCase(), text: "waiting on DEP already" },
        },
      ],
    },
    new Date("2026-09-25T02:00:00Z")
  );
  assert.equal(parsed.ok, true, parsed.errors?.join("\n"));
  assert.equal(parsed.value.brief_date, "2026-09-24");
  assert.equal(parsed.value.edition, "eod");
  assert.equal(parsed.value.claim_email, false);
  assert.equal(parsed.value.content.narrative, "A good day.");
  assert.equal("bogus" in parsed.value.content, false);
  assert.equal(parsed.value.content.meetings.length, 2);
  assert.equal(parsed.value.content.meetings[0].url, null);
  assert.equal(parsed.value.content.meetings[1].has_notes, false);
  assert.deepEqual(parsed.value.items[0].source.meetings[0].lines, ["Invite DEP (Brent)"]);
  assert.equal(parsed.value.items[0].payload.maybe_tracked.task_id, TASK_A);
});

test("email subject is EOD-MMDD · N to decide · N done", () => {
  const email = buildBriefEmail(
    "EOD-0924",
    "https://example.test/briefs/EOD-0924",
    { total: 13, open: 12, from_meetings: 10, calls: 2 },
    { stats: [{ key: "done", label: "done", value: 19 }] }
  );
  assert.equal(email.subject, "EOD-0924 · 12 to decide · 19 done");
  assert.match(email.body, /^12 to decide: 10 from meetings, 2 need a call\.\n19 done\.\n\nhttps:\/\/example\.test\/briefs\/EOD-0924\n\nOr in Claude: review EOD-0924$/);
});

console.log(`\n${passed} passed`);
