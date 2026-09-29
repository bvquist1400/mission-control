#!/usr/bin/env node
// Pure tests for Accept scheduling (task 98683030, migration 058): the due
// choices Today / Tomorrow / This week / No date / the notes' date, resolved in
// ET to the end of the day; strict validation of `due` on actions and of
// `suggested_due` on proposals; the page's date labels. No database; see
// test-briefs-accept-db.mjs for that.
//
// Every test runs even if an earlier one fails, so a run on the old code shows
// each missing behaviour separately.

import assert from "node:assert/strict";

async function load(path) {
  try {
    return await import(path);
  } catch (error) {
    return { __missing: error.message.split("\n")[0] };
  }
}

const due = await load("../src/lib/briefs/due.ts");
const keys = await load("../src/lib/briefs/keys.ts");
const validate = await load("../src/lib/briefs/validate.ts");
const format = await load("../src/components/briefs/format.ts");

function need(mod, ...names) {
  if (mod.__missing) assert.fail(`module missing: ${mod.__missing}`);
  for (const name of names) assert.equal(typeof mod[name], "function", `${name} is not exported`);
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}\n  ${String(error.message).split("\n").join("\n  ")}`);
  }
}

const at = (iso) => new Date(iso);

// ---------------------------------------------------------------------------
// Resolution: end of the chosen ET day
// ---------------------------------------------------------------------------

await test("today / tomorrow / this_week / none / the notes' date on Tue 9/29 at 5 PM ET", () => {
  need(due, "resolveAcceptDueAt");
  const now = at("2026-09-29T21:00:00Z"); // Tue 5:00 PM EDT
  assert.equal(due.resolveAcceptDueAt("today", "2026-09-29", now), "2026-09-30T03:59:59.999Z");
  assert.equal(due.resolveAcceptDueAt("tomorrow", "2026-09-29", now), "2026-10-01T03:59:59.999Z");
  assert.equal(due.resolveAcceptDueAt("this_week", "2026-09-29", now), "2026-10-03T03:59:59.999Z");
  assert.equal(due.resolveAcceptDueAt("none", "2026-09-29", now), null);
  assert.equal(due.resolveAcceptDueAt("2026-10-12", "2026-09-29", now), "2026-10-13T03:59:59.999Z");
});

await test("tomorrow is exactly what carry-over Tomorrow uses (resolveTomorrowDueAt), including a stale brief", () => {
  need(due, "resolveAcceptDueAt");
  for (const [briefDate, iso] of [
    ["2026-09-25", "2026-09-25T20:15:00Z"], // Friday -> Monday
    ["2026-09-21", "2026-09-24T18:00:00Z"], // stale Monday brief worked Thursday -> Thursday
    ["2026-09-23", "2026-09-26T15:00:00Z"], // worked Saturday -> Monday
    ["2026-10-30", "2026-10-30T20:15:00Z"], // across the fall DST change
  ]) {
    assert.equal(due.resolveAcceptDueAt("tomorrow", briefDate, at(iso)), keys.resolveTomorrowDueAt(briefDate, at(iso)), briefDate);
  }
});

await test("this_week: Mon-Thu -> this Friday; Fri, Sat, Sun -> next Friday", () => {
  need(due, "resolveThisWeekDate");
  const cases = [
    ["2026-09-28T16:00:00Z", "2026-10-02"], // Mon
    ["2026-10-01T16:00:00Z", "2026-10-02"], // Thu
    ["2026-10-02T16:00:00Z", "2026-10-09"], // Fri
    ["2026-10-03T16:00:00Z", "2026-10-09"], // Sat
    ["2026-10-04T16:00:00Z", "2026-10-09"], // Sun
  ];
  for (const [iso, friday] of cases) assert.equal(due.resolveThisWeekDate(at(iso)), friday, iso);
});

await test("this_week and today use the ET day, never UTC (10 PM ET Thursday is still Thursday)", () => {
  need(due, "resolveThisWeekDate", "resolveAcceptDueDate");
  // Thu 10/1 10 PM EDT = Fri 10/2 02:00 UTC. UTC math would call it Friday and jump a week.
  assert.equal(due.resolveThisWeekDate(at("2026-10-02T02:00:00Z")), "2026-10-02");
  assert.equal(due.resolveAcceptDueDate("today", "2026-10-01", at("2026-10-02T02:00:00Z")), "2026-10-01");
  // Sun 10/4 11:30 PM EDT = Mon 03:30 UTC: still Sunday, so next Friday is 10/9.
  assert.equal(due.resolveThisWeekDate(at("2026-10-05T03:30:00Z")), "2026-10-09");
});

await test("DST (fall back Sun Nov 1 2026): each choice ends at 23:59:59.999 in that day's offset", () => {
  need(due, "resolveAcceptDueAt");
  // Mon 10/26 -> Fri 10/30 is still EDT (-4).
  assert.equal(due.resolveAcceptDueAt("this_week", "2026-10-26", at("2026-10-26T16:00:00Z")), "2026-10-31T03:59:59.999Z");
  // Fri 10/30 -> next Friday 11/6 is EST (-5).
  assert.equal(due.resolveAcceptDueAt("this_week", "2026-10-30", at("2026-10-30T20:15:00Z")), "2026-11-07T04:59:59.999Z");
  // Today on the changeover Sunday itself ends in EST.
  assert.equal(due.resolveAcceptDueAt("today", "2026-10-30", at("2026-11-01T16:00:00Z")), "2026-11-02T04:59:59.999Z");
  // A notes date just after the change.
  assert.equal(due.resolveAcceptDueAt("2026-11-02", "2026-10-30", at("2026-10-30T20:15:00Z")), "2026-11-03T04:59:59.999Z");
});

await test("DST (spring forward Sun Mar 14 2027): Friday after the change ends in EDT", () => {
  need(due, "resolveAcceptDueAt");
  assert.equal(due.resolveAcceptDueAt("this_week", "2027-03-12", at("2027-03-12T21:15:00Z")), "2027-03-20T03:59:59.999Z");
  assert.equal(due.resolveAcceptDueAt("this_week", "2027-03-08", at("2027-03-08T15:00:00Z")), "2027-03-13T04:59:59.999Z");
});

// ---------------------------------------------------------------------------
// Validation: actions
// ---------------------------------------------------------------------------

await test("accept takes due = today | tomorrow | this_week | none | YYYY-MM-DD; absent means the default", () => {
  need(validate, "parseBriefActions");
  for (const value of ["today", "tomorrow", "this_week", "none", " Tomorrow ", "THIS_WEEK", "2026-10-12"]) {
    const parsed = validate.parseBriefActions([{ n: 1, action: "accept", due: value }]);
    assert.equal(parsed.ok, true, `${JSON.stringify(value)}: ${parsed.errors?.join("; ")}`);
    assert.equal(parsed.value[0].due, value.trim().match(/^\d/) ? value : value.trim().toLowerCase());
  }
  const plain = validate.parseBriefActions([{ n: 1, action: "accept" }]);
  assert.equal(plain.ok, true);
  assert.equal("due" in plain.value[0], false, "no due key when the caller sent none");
  assert.equal(due.DEFAULT_ACCEPT_DUE, "tomorrow");
});

await test("anything else is a 400: null, empty, unknown words, impossible or loosely written dates, numbers", () => {
  need(validate, "parseBriefActions");
  for (const value of [null, "", "  ", "next_week", "later", "2026-02-30", "2026-9-30", " 2026-09-30", "2026-09-30T12:00:00Z", 20261012, true, {}]) {
    const parsed = validate.parseBriefActions([{ n: 1, action: "accept", due: value }]);
    assert.equal(parsed.ok, false, `${JSON.stringify(value)} should be rejected`);
    assert.match(parsed.errors.join(" "), /due must be "today", "tomorrow", "this_week", "none"/);
  }
});

await test("due on any action other than accept is rejected", () => {
  need(validate, "parseBriefActions");
  for (const action of [
    { n: 1, action: "dismiss", reason: "not_mine", due: "today" },
    { n: 2, action: "tomorrow", due: "today" },
    { n: 3, action: "pick", choice: "a", due: "none" },
  ]) {
    const parsed = validate.parseBriefActions([action]);
    assert.equal(parsed.ok, false, action.action);
    assert.match(parsed.errors.join(" "), /due only applies to accept/);
  }
});

// ---------------------------------------------------------------------------
// Validation: suggested_due on proposals
// ---------------------------------------------------------------------------

const MEETING = { id: "m1", title: "DEP", line: "Send the template to Amy by Monday 10/12 (Brent)" };

function saveWith(item) {
  return validate.parseSaveBriefInput({ date: "2026-09-29", items: [{ kind: "proposed_task", title: "Send the template", source: { meetings: [MEETING] }, ...item }] });
}

await test("suggested_due: a real YYYY-MM-DD is kept on the proposal; absent or null leaves no key", () => {
  need(validate, "parseSaveBriefInput");
  const kept = saveWith({ suggested_due: "2026-10-12" });
  assert.equal(kept.ok, true, kept.errors?.join("; "));
  assert.equal(kept.value.items[0].payload.suggested_due, "2026-10-12");
  for (const item of [{}, { suggested_due: null }]) {
    const parsed = saveWith(item);
    assert.equal(parsed.ok, true);
    assert.equal("suggested_due" in parsed.value.items[0].payload, false);
  }
});

await test("suggested_due: malformed values are rejected (the routine sees the error and retries)", () => {
  need(validate, "parseSaveBriefInput");
  for (const value of ["Monday", "10/12", "2026-10-32", "2026-10-12T09:00:00Z", " 2026-10-12", 20261012, ""]) {
    const parsed = saveWith({ suggested_due: value });
    assert.equal(parsed.ok, false, `${JSON.stringify(value)} should be rejected`);
    assert.match(parsed.errors.join(" "), /suggested_due must be a real date written YYYY-MM-DD/);
  }
});

await test("suggested_due only belongs on a proposed_task", () => {
  need(validate, "parseSaveBriefInput");
  const parsed = validate.parseSaveBriefInput({
    date: "2026-09-29",
    items: [{ kind: "carry_over", title: "x", task_ids: ["43f28321-3e6c-4e26-ad61-4f362be72e5d"], suggested_due: "2026-10-12" }],
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join(" "), /suggested_due only applies to a proposed_task/);
});

await test("suggested_due never changes a proposal's item_key (so the same proposal is still one task)", () => {
  need(validate, "parseSaveBriefInput");
  const withDate = saveWith({ suggested_due: "2026-10-12" });
  const without = saveWith({});
  assert.equal(withDate.ok && without.ok, true);
  assert.equal(
    keys.computeBriefItemKey("eod", "2026-09-29", withDate.value.items[0]),
    keys.computeBriefItemKey("eod", "2026-09-29", without.value.items[0])
  );
});

// ---------------------------------------------------------------------------
// Page labels
// ---------------------------------------------------------------------------

await test("labels: the notes' chip reads 'Mon 10/12'; an end-of-day due_at reads as its ET day", () => {
  need(format, "weekdayDate", "etDay");
  assert.equal(format.weekdayDate("2026-10-12"), "Mon 10/12");
  assert.equal(format.etDay("2026-10-01T03:59:59.999Z"), "Wed 9/30");
  assert.equal(format.etDay("2026-11-07T04:59:59.999Z"), "Fri 11/6");
  assert.equal(format.etDay(null), "");
});

// ---------------------------------------------------------------------------
// Fix round 1: a notes date that has already passed is offered, not pre-selected
// ---------------------------------------------------------------------------

await test("default chip: a past notes date pre-selects Tomorrow (Mon 9/28 notes date, Tue 9/29 5 PM ET)", () => {
  need(due, "defaultAcceptDueChoice");
  assert.equal(due.defaultAcceptDueChoice("2026-09-28", at("2026-09-29T21:00:00Z")), "tomorrow");
  assert.equal(due.defaultAcceptDueChoice("2026-01-01", at("2026-09-29T21:00:00Z")), "tomorrow");
});

await test("default chip: a notes date of today or later stays pre-selected", () => {
  need(due, "defaultAcceptDueChoice");
  const now = at("2026-09-29T21:00:00Z");
  assert.equal(due.defaultAcceptDueChoice("2026-09-29", now), "2026-09-29");
  assert.equal(due.defaultAcceptDueChoice("2026-09-30", now), "2026-09-30");
  assert.equal(due.defaultAcceptDueChoice("2026-10-12", now), "2026-10-12");
});

await test("default chip: no notes date (or a malformed one) is Tomorrow", () => {
  need(due, "defaultAcceptDueChoice");
  const now = at("2026-09-29T21:00:00Z");
  assert.equal(due.defaultAcceptDueChoice(null, now), "tomorrow");
  assert.equal(due.defaultAcceptDueChoice("", now), "tomorrow");
  assert.equal(due.defaultAcceptDueChoice("2026-9-30", now), "tomorrow");
});

await test("default chip: 'passed' is judged at ET midnight, never UTC", () => {
  need(due, "defaultAcceptDueChoice", "isDatePassed");
  // 11:59 PM ET Tue 9/29 is 03:59 UTC Wed 9/30: 9/29 is still today in ET.
  assert.equal(due.defaultAcceptDueChoice("2026-09-29", at("2026-09-30T03:59:00Z")), "2026-09-29");
  assert.equal(due.isDatePassed("2026-09-29", at("2026-09-30T03:59:00Z")), false);
  // 12:00 AM ET Wed 9/30 is 04:00 UTC: 9/29 has now passed.
  assert.equal(due.defaultAcceptDueChoice("2026-09-29", at("2026-09-30T04:00:00Z")), "tomorrow");
  assert.equal(due.isDatePassed("2026-09-29", at("2026-09-30T04:00:00Z")), true);
  // 8 PM ET is already the next UTC day, and 9/29 is still not passed at 7:30 PM ET 9/29 (23:30 UTC).
  assert.equal(due.defaultAcceptDueChoice("2026-09-29", at("2026-09-29T23:30:00Z")), "2026-09-29");
  // Winter (EST): 11:30 PM ET 1/15 is 04:30 UTC 1/16.
  assert.equal(due.defaultAcceptDueChoice("2027-01-15", at("2027-01-16T04:30:00Z")), "2027-01-15");
  assert.equal(due.defaultAcceptDueChoice("2027-01-15", at("2027-01-16T05:00:00Z")), "tomorrow");
});

await test("the server default with no choice is still tomorrow", () => {
  need(due, "resolveAcceptDueAt");
  assert.equal(due.DEFAULT_ACCEPT_DUE, "tomorrow");
});

await test("the notes chip says 'from notes', and 'from notes, passed' once the date is behind us", () => {
  need(format, "notesDueLabel");
  assert.equal(format.notesDueLabel("2026-10-12", false), "Mon 10/12 \u00b7 from notes");
  assert.equal(format.notesDueLabel("2026-09-28", true), "Mon 9/28 \u00b7 from notes, passed");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
