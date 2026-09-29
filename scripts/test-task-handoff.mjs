// Pure tests for editing ownership and handing tasks back (src/lib/task-handoff.ts).
// No database; the network runner is exercised with a fake fetch.
//
//   npm run test:task-handoff

import assert from "node:assert/strict";

const {
  buildOwnerUpdate,
  composeHandBack,
  formatHandBackDate,
  handBackTask,
  toOneLine,
  truncateLine,
  HAND_BACK_COMMENT_PREFIX,
  HAND_BACK_NOTE_MAX_LENGTH,
  HAND_BACK_NOTE_LABEL,
  handBackNeedsAnswerWarning,
  isDecisionTask,
} = await import("../src/lib/task-handoff.ts");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// 11:30 PM ET on Mon 9/28 is already 9/29 in UTC.
const LATE_EVENING = new Date("2026-09-29T03:30:00Z");
const brentTask = { owner: "brent", owner_label: null, status_line: "8 of 11 checks passed." };

// ── Owner editor payload ─────────────────────────────────────────────────
await test("no change → nothing to send", () => {
  const result = buildOwnerUpdate(brentTask, { owner: "brent", ownerLabel: "", statusLine: "8 of 11 checks passed." });
  assert.deepEqual(result, { ok: true, changes: {}, changed: false });
});

await test("only the changed fields are sent, normalized like the API stores them", () => {
  const result = buildOwnerUpdate(brentTask, { owner: "brent", ownerLabel: "", statusLine: "  9 of 11 done.\nSplit View left.  " });
  assert.deepEqual(result, { ok: true, changes: { status_line: "9 of 11 done. Split View left." }, changed: true });
});

await test("handing to an agent sends owner + label; an empty line clears status_line", () => {
  const result = buildOwnerUpdate(brentTask, { owner: "agent", ownerLabel: " Codex ", statusLine: "   " });
  assert.deepEqual(result.changes, { owner: "agent", owner_label: "Codex", status_line: null });
});

await test("taking a task yourself drops the agent label", () => {
  const agentTask = { owner: "agent", owner_label: "PM", status_line: null };
  const result = buildOwnerUpdate(agentTask, { owner: "brent", ownerLabel: "PM", statusLine: "" });
  assert.deepEqual(result.changes, { owner: "brent", owner_label: null });
});

await test("over-long label or line is refused with a plain message (limits 40 / 280)", () => {
  const long = buildOwnerUpdate(brentTask, { owner: "agent", ownerLabel: "x".repeat(41), statusLine: "" });
  assert.equal(long.ok, false);
  assert.match(long.error, /40 characters/);
  const line = buildOwnerUpdate(brentTask, { owner: "brent", ownerLabel: "", statusLine: "y".repeat(281) });
  assert.equal(line.ok, false);
  assert.match(line.error, /280 characters/);
  assert.equal(buildOwnerUpdate(brentTask, { owner: "brent", ownerLabel: "", statusLine: "y".repeat(280) }).ok, true);
});

// ── Trimming helpers ─────────────────────────────────────────────────────
await test("toOneLine and truncateLine", () => {
  assert.equal(toOneLine("  a\n\tb  c "), "a b c");
  assert.equal(toOneLine(null), "");
  assert.equal(truncateLine("abc", 3), "abc");
  assert.equal(truncateLine("abcd", 3), "ab…");
  assert.equal(truncateLine("ab   cd", 4), "ab…");
});

// ── Hand-back composition ────────────────────────────────────────────────
await test("hand back with a note: owner agent/PM, 'With the PM:' line, prefixed comment keeps line breaks", () => {
  const plan = composeHandBack("  Checked on my iPhone.\nSplit View still fails.  ", LATE_EVENING);
  assert.deepEqual(plan.update, {
    owner: "agent",
    owner_label: "PM",
    status_line: "With the PM: Checked on my iPhone. Split View still fails.",
  });
  assert.equal(plan.comment, `${HAND_BACK_COMMENT_PREFIX} Checked on my iPhone.\nSplit View still fails.`);
  assert.ok(plan.comment.startsWith("Brent (handed back):"));
});

await test("hand back without a note: dated line on the ET calendar, no comment", () => {
  const plan = composeHandBack("   ", LATE_EVENING);
  assert.equal(plan.update.status_line, "With the PM: handed back by Brent Sep 28");
  assert.equal(plan.comment, null);
  assert.equal(composeHandBack(undefined, new Date("2026-10-05T14:00:00Z")).update.status_line, "With the PM: handed back by Brent Oct 5");
  assert.equal(formatHandBackDate(new Date("2027-01-01T04:59:00Z")), "Dec 31");
});

await test("a long note is cut to 280 for the line but kept (to 2,000) in the comment", () => {
  const note = "word ".repeat(200).trim(); // 999 characters
  const plan = composeHandBack(note, LATE_EVENING);
  assert.equal(plan.update.status_line.length, 280);
  assert.ok(plan.update.status_line.endsWith("…"));
  assert.ok(plan.update.status_line.startsWith("With the PM: word word"));
  assert.equal(plan.comment, `${HAND_BACK_COMMENT_PREFIX} ${note}`);
  const huge = composeHandBack("z".repeat(HAND_BACK_NOTE_MAX_LENGTH + 500), LATE_EVENING);
  assert.equal(huge.comment.length, HAND_BACK_COMMENT_PREFIX.length + 1 + HAND_BACK_NOTE_MAX_LENGTH);
  assert.ok(huge.comment.length <= 5000, "fits the comment API limit");
});

// ── Hand-back runner (fake fetch) ────────────────────────────────────────
function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  return { impl, calls };
}

await test("runner: PATCH first, then the comment; returns both", async () => {
  const { impl, calls } = fakeFetch([
    { status: 200, body: { id: "t1", owner: "agent" } },
    { status: 201, body: { id: "c1", content: "Brent (handed back): done" } },
  ]);
  const result = await handBackTask("t1", "done", { fetchImpl: impl, now: LATE_EVENING });
  assert.equal(result.ok, true);
  assert.deepEqual(result.task, { id: "t1", owner: "agent" });
  assert.equal(result.comment.id, "c1");
  assert.equal(result.commentError, null);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["PATCH /api/tasks/t1", "POST /api/tasks/t1/comments"]);
  assert.deepEqual(calls[0].body, { owner: "agent", owner_label: "PM", status_line: "With the PM: done" });
  assert.deepEqual(calls[1].body, { content: "Brent (handed back): done" });
});

await test("runner: no note → only the PATCH", async () => {
  const { impl, calls } = fakeFetch([{ status: 200, body: { id: "t1" } }]);
  const result = await handBackTask("t1", "", { fetchImpl: impl, now: LATE_EVENING });
  assert.equal(result.ok, true);
  assert.equal(result.comment, null);
  assert.equal(calls.length, 1);
});

await test("runner: a failed PATCH is an error and no comment is posted", async () => {
  const { impl, calls } = fakeFetch([{ status: 400, body: { error: "Invalid owner" } }]);
  const result = await handBackTask("t1", "note", { fetchImpl: impl });
  assert.deepEqual(result, { ok: false, error: "Invalid owner" });
  assert.equal(calls.length, 1);
  const offline = await handBackTask("t1", "note", { fetchImpl: fakeFetch([new Error("offline")]).impl });
  assert.equal(offline.ok, false);
  assert.match(offline.error, /Couldn't reach Baseline/);
});

await test("runner: the note failing is reported, but the hand-back stands", async () => {
  const { impl } = fakeFetch([
    { status: 200, body: { id: "t1" } },
    { status: 500, body: { error: "Internal server error" } },
  ]);
  const result = await handBackTask("t1", "note", { fetchImpl: impl });
  assert.equal(result.ok, true);
  assert.equal(result.comment, null);
  assert.match(result.commentError, /Handed back, but the note wasn't saved/);
});

await test("runner: task ids are URL-encoded", async () => {
  const { impl, calls } = fakeFetch([{ status: 200, body: {} }]);
  await handBackTask("a/b", "", { fetchImpl: impl });
  assert.equal(calls[0].url, "/api/tasks/a%2Fb");
});

// ── Decision tasks (slice 2) ──────────────────────────────────────────────
await test("the hand-back box is labelled as Brent's answer", () => {
  assert.equal(HAND_BACK_NOTE_LABEL, "Your answer or decision (the agent reads this)");
});

await test("isDecisionTask: tag 'decision' (any case) or a title starting 'Decide:' / 'Decision'", () => {
  assert.equal(isDecisionTask({ title: "Decide: keep both boards?", tags: [] }), true);
  assert.equal(isDecisionTask({ title: "  decide : which sign-in", tags: null }), true);
  assert.equal(isDecisionTask({ title: "Decision on the iPad sign-in", tags: [] }), true);
  assert.equal(isDecisionTask({ title: "Board merge", tags: ["personal", " Decision "] }), true);
  assert.equal(isDecisionTask({ title: "Decisions log cleanup", tags: [] }), false);
  assert.equal(isDecisionTask({ title: "Undecided: nothing", tags: [] }), false);
  assert.equal(isDecisionTask({ title: "Run the checklist", tags: ["decisions"] }), false);
  assert.equal(isDecisionTask({ title: "Run the checklist" }), false);
});

await test("an empty answer on a decision task needs the warning; anything typed, or a non-decision, doesn't", () => {
  assert.equal(handBackNeedsAnswerWarning(true, ""), true);
  assert.equal(handBackNeedsAnswerWarning(true, "   \n "), true);
  assert.equal(handBackNeedsAnswerWarning(true, null), true);
  assert.equal(handBackNeedsAnswerWarning(true, "Keep both."), false);
  assert.equal(handBackNeedsAnswerWarning(false, ""), false);
});

// ── Drafts survive a Status change (fix round 1, Fable finding 1) ─────────
// The editor keys TaskOwnerSection on the task; a Status PATCH bumps updated_at,
// and keying on that remounted the section with an empty answer box. The rule
// now lives in ownerDraftReset (exported from the component), loaded here from
// the real source: TypeScript strips the types, the imports are stubbed out
// (they are only used when the component renders), and the exported function runs.
import { readFileSync } from "node:fs";
import ts from "typescript";

const ownerSectionSource = readFileSync(new URL("../src/components/tasks/TaskOwnerSection.tsx", import.meta.url), "utf8");
const modalSource = readFileSync(new URL("../src/components/tasks/TaskDetailModal.tsx", import.meta.url), "utf8");
const ownerSectionJs = ts
  .transpileModule(ownerSectionSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } })
  .outputText.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "");
const ownerSectionModule = await import(`data:text/javascript;base64,${Buffer.from(ownerSectionJs).toString("base64")}`);
const { ownerDraftReset } = ownerSectionModule;

const savedBrent = { owner: "brent", owner_label: null, status_line: "Needs your call on the boards." };

await test("ownerDraftReset: a save that leaves owner, agent name and status line alone touches no drafts (Status change)", () => {
  assert.equal(ownerDraftReset(savedBrent, { ...savedBrent }), "none");
  // Status, due date, title etc. are not part of the snapshot, so they can't reset anything.
  assert.equal(ownerDraftReset(savedBrent, { ...savedBrent, status: "Done", updated_at: "2026-09-29T20:00:00Z" }), "none");
});

await test("ownerDraftReset: a new owner (a hand-back, an owner flip) starts everything fresh", () => {
  assert.equal(ownerDraftReset(savedBrent, { owner: "agent", owner_label: "PM", status_line: "With the PM: keep both." }), "all");
  assert.equal(ownerDraftReset({ owner: "agent", owner_label: "PM", status_line: null }, savedBrent), "all");
});

await test("ownerDraftReset: a new status line or agent name refreshes those drafts but not the answer box", () => {
  assert.equal(ownerDraftReset(savedBrent, { ...savedBrent, status_line: "8 of 11 checks passed." }), "fields");
  assert.equal(ownerDraftReset(savedBrent, { ...savedBrent, status_line: null }), "fields");
  const agent = { owner: "agent", owner_label: "PM", status_line: "Building." };
  assert.equal(ownerDraftReset(agent, { ...agent, owner_label: "Builder" }), "fields");
});

await test("the editor keys the owner section on the task id only, never on updated_at", () => {
  const section = modalSource.match(/<TaskOwnerSection[\s\S]*?\/>/);
  assert.ok(section, "TaskOwnerSection is rendered in TaskDetailModal");
  const key = section[0].match(/\bkey=(\{[^}]*\}|"[^"]*")/);
  assert.ok(key, "TaskOwnerSection has a key");
  assert.equal(key[1], "{task.id}");
  assert.ok(!/updated_at/.test(key[1]));
});

console.log(`\n${passed} passed`);
