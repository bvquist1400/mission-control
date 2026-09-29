// Pure tests for the redesigned task page (src/lib/task-page.ts): comment
// gists (first sentence or ~140 characters, computed in code), comment
// authors, and the page model. No database.
//
//   npm run test:task-page

import assert from "node:assert/strict";

const {
  commentGist,
  commentAuthor,
  firstSentence,
  markdownToPlain,
  cutAtWord,
  formatCommentTime,
  buildTaskPageView,
  composePageComment,
  GIST_MAX_LENGTH,
  RECENT_COMMENT_COUNT,
} = await import("../src/lib/task-page.ts");

let passed = 0;
const failed = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed.push(name);
    console.log(`not ok - ${name}\n  ${String(error?.message ?? error).split("\n").slice(0, 6).join("\n  ")}`);
  }
}

// ── Gists ─────────────────────────────────────────────────────────────────
test("gist: a short one-sentence comment is itself, nothing to unfold", () => {
  assert.deepEqual(commentGist("Sent the pantry bugs to Codex."), { gist: "Sent the pantry bugs to Codex.", truncated: false });
  assert.deepEqual(commentGist("ok"), { gist: "ok", truncated: false });
});

test("gist: the first sentence of a longer comment, with the rest folded", () => {
  const body = "Only two changes were refused, and neither was the test rice.\n\n- 3:13 PM, Flour: the server had no Flour.\n- 3:41 PM: one extra change was rejected.";
  assert.deepEqual(commentGist(body), { gist: "Only two changes were refused, and neither was the test rice.", truncated: true });
});

test("gist: a first sentence over 140 characters is cut at a word with an ellipsis", () => {
  const long = `${"Word ".repeat(60).trim()}. Second sentence.`;
  const { gist, truncated } = commentGist(long);
  assert.ok(gist.length <= GIST_MAX_LENGTH, `${gist.length}`);
  assert.ok(gist.endsWith("…"));
  assert.ok(!gist.includes("Word…") || gist.endsWith("Word…"));
  assert.equal(truncated, true);
});

test("gist: no sentence end → first ~140 characters", () => {
  const text = "a".repeat(20) + " " + "b".repeat(200);
  const { gist } = commentGist(text);
  assert.ok(gist.length <= GIST_MAX_LENGTH);
  assert.ok(gist.endsWith("…"));
  assert.equal(commentGist("no full stop here").gist, "no full stop here");
});

test("gist: Markdown markers, bullets, links and code are removed", () => {
  assert.equal(
    commentGist("**Verdict: PASS.** Everything in scope works.").gist,
    "Verdict: PASS."
  );
  assert.equal(commentGist("- [x] Done the [checklist](https://example.test/x) and `npm test`.").gist, "Done the checklist and npm test.");
  assert.equal(markdownToPlain("# Title\n> quoted _word_ here\n```\ncode\n```\nafter"), "Title quoted word here after");
  assert.equal(markdownToPlain("snake_case_name stays"), "snake_case_name stays");
});

test("gist: abbreviations, version numbers, times and initials don't end the sentence", () => {
  assert.equal(firstSentence("Use a test value, e.g. the seed user, then retry. Next."), "Use a test value, e.g. the seed user, then retry.");
  assert.equal(firstSentence("Built with Opus 5.5 at 9:30 today. Then more."), "Built with Opus 5.5 at 9:30 today.");
  assert.equal(firstSentence("Ask J. Smith about the rename today. Then more."), "Ask J. Smith about the rename today.");
  assert.equal(firstSentence("Hi. This is the real first sentence."), "Hi. This is the real first sentence.");
  assert.equal(firstSentence("Is it live? Yes."), "Is it live? Yes.");
  assert.equal(firstSentence("nothing ends"), null);
});

test("gist: only the first paragraph is used for the sentence", () => {
  const body = "Build 28 is uploaded\n\nIt passed every check. More detail.";
  assert.deepEqual(commentGist(body), { gist: "Build 28 is uploaded", truncated: true });
});

test("gist: empty and whitespace", () => {
  assert.deepEqual(commentGist(""), { gist: "", truncated: false });
  assert.deepEqual(commentGist("   \n\n "), { gist: "", truncated: false });
});

test("cutAtWord keeps short text and never ends on a dangling comma or dash", () => {
  assert.equal(cutAtWord("short", 140), "short");
  assert.equal(cutAtWord("alpha beta, gamma delta", 13), "alpha beta…");
});

// ── Authors ───────────────────────────────────────────────────────────────
test("author: Brent's hand-backs and page comments are 'You', with the stamp removed", () => {
  assert.deepEqual(commentAuthor("Brent (handed back): Keep both boards."), { who: "brent", label: "You", body: "Keep both boards." });
  assert.deepEqual(commentAuthor("Brent: Looks good on my phone."), { who: "brent", label: "You", body: "Looks good on my phone." });
  assert.equal(commentAuthor("Brent picked this up today.").who, null, "a sentence about Brent isn't by Brent");
});

test("author: PM stamps are stripped; the time's own colon doesn't confuse it", () => {
  assert.deepEqual(commentAuthor("PM 9/28 ~4:15 PM: Brent picked this up today."), { who: "agent", label: "PM", body: "Brent picked this up today." });
  const odd = commentAuthor("PM 9/28 ~7:56 PM, first real use of slice 2a: Brent handed back 028135d4.");
  assert.equal(odd.label, "PM");
  assert.equal(odd.body, "PM 9/28 ~7:56 PM, first real use of slice 2a: Brent handed back 028135d4.", "not a bare stamp: kept whole");
});

test("author: handoffs, reviews and claims name the agent; unknown text has no author", () => {
  assert.equal(commentAuthor("HANDOFF — slice 1 built (Claude Opus 5.5 · Claude Code).").label, "Builder");
  assert.equal(commentAuthor("REVIEW (Codex, GPT-6 Sol, account 2). Verdict: PASS.").label, "Codex");
  assert.equal(commentAuthor("REVIEW r1 — Claude Fable 5.1 (high). Verdict: FAIL.").label, "Fable");
  assert.equal(commentAuthor("REVIEW r3 by someone. Verdict: PASS.").label, "Reviewer");
  assert.equal(commentAuthor("Claimed by builder subagent (Claude Opus 5.5 · high)").label, "Builder");
  assert.equal(commentAuthor("Claimed by reviewer subagent (Claude Fable 5.1 · high)").label, "Reviewer");
  assert.deepEqual(commentAuthor("Just a note."), { who: null, label: null, body: "Just a note." });
  assert.equal(commentAuthor("PM, can you check the iPad build?").who, null, "addressed to the PM, not written by it");
  assert.equal(commentAuthor("Codex is looking at it.").who, null);
});

test("page comments are saved as 'Brent: …' and read back as his", () => {
  assert.equal(composePageComment("  Tried it on the iPad.  "), "Brent: Tried it on the iPad.");
  assert.equal(composePageComment("   "), null);
  assert.equal(commentAuthor(composePageComment("Tried it.")).who, "brent");
});

// ── Times ─────────────────────────────────────────────────────────────────
test("comment times are ET: today shows the time, other days the date too", () => {
  const now = new Date("2026-09-29T14:00:00Z"); // 10 AM ET
  assert.equal(formatCommentTime("2026-09-29T13:05:00Z", now), "9:05 AM");
  assert.equal(formatCommentTime("2026-09-28T20:10:00Z", now), "Sep 28, 4:10 PM");
  // 11:30 PM ET on 9/28 is 9/29 in UTC: still "Sep 28".
  assert.equal(formatCommentTime("2026-09-29T03:30:00Z", now), "Sep 28, 11:30 PM");
  assert.equal(formatCommentTime("not a date", now), "");
});

// ── The page model ────────────────────────────────────────────────────────
const NOW = new Date("2026-09-29T14:00:00Z");
function baseTask(overrides = {}) {
  return {
    id: "t1",
    title: "Build 28 phone checklist",
    status: "In Progress",
    owner: "brent",
    owner_label: null,
    status_line: "8 of 11 checks passed.",
    due_at: null,
    waiting_on: null,
    follow_up_at: null,
    description: "Short.",
    tags: [],
    app: "Stock & Stir",
    project: "Personal — Stock & Stir",
    section: "Brent's actions",
    ...overrides,
  };
}

test("page: the stand sentence is the status line; context, owner chip and checklist count", () => {
  const view = buildTaskPageView({
    task: baseTask(),
    checklist: [
      { id: "c2", text: "Two", is_done: false, sort_order: 2 },
      { id: "c1", text: "One", is_done: true, sort_order: 1 },
    ],
    comments: [],
    blockers: [],
    now: NOW,
  });
  assert.equal(view.stand, "8 of 11 checks passed.");
  assert.equal(view.standIsDerived, false);
  assert.equal(view.ownerLabel, "You");
  assert.deepEqual(view.context, ["Stock & Stir", "Brent's actions"]);
  assert.deepEqual(
    buildTaskPageView({ task: baseTask({ app: null, section: null }), checklist: [], comments: [], blockers: [], now: NOW }).context,
    ["Personal — Stock & Stir"]
  );
  assert.deepEqual(view.checklist.map((item) => item.id), ["c1", "c2"]);
  assert.equal(view.checklistDone, 1);
  assert.equal(view.blocked, false);
  assert.equal(view.decision, false);
  assert.equal(buildTaskPageView({ task: baseTask({ tags: ["decision"] }), checklist: [], comments: [], blockers: [], now: NOW }).decision, true);
});

test("page: no status line → a plain sentence built from owner, status, blockers and checklist", () => {
  const view = buildTaskPageView({
    task: baseTask({ status_line: null, owner: "agent", owner_label: "Codex", status: "Blocked/Waiting", waiting_on: "Release 3.1" }),
    checklist: [{ id: "c1", text: "One", is_done: true, sort_order: 0 }],
    comments: [],
    blockers: ["Ship the rename build"],
    now: NOW,
  });
  assert.equal(view.stand, "With Codex, blocked (waiting on Release 3.1). 1 of 1 checklist items done.");
  assert.equal(view.standIsDerived, true);
  assert.equal(view.blocked, true);
  assert.deepEqual(view.waits, ["Waiting on Release 3.1", "Waits for “Ship the rename build”"]);
  const plain = buildTaskPageView({ task: baseTask({ status_line: "  ", owner: "agent", status: "Planned" }), checklist: [], comments: [], blockers: [], now: NOW });
  assert.equal(plain.stand, "With the agents, planned.");
  assert.equal(plain.ownerLabel, "Agent");
});

test("page: a dependency alone marks the task blocked", () => {
  const view = buildTaskPageView({ task: baseTask({ status: "Planned" }), checklist: [], comments: [], blockers: ["Other task"], now: NOW });
  assert.equal(view.blocked, true);
});

test("page: due and overdue in ET; done tasks are never overdue", () => {
  const late = buildTaskPageView({ task: baseTask({ due_at: "2026-09-29T03:30:00Z" }), checklist: [], comments: [], blockers: [], now: NOW });
  assert.equal(late.due, "2026-09-28");
  assert.equal(late.overdue, true);
  const done = buildTaskPageView({ task: baseTask({ due_at: "2026-09-20T15:00:00Z", status: "Done" }), checklist: [], comments: [], blockers: [], now: NOW });
  assert.equal(done.overdue, false);
});

test("page: comments newest first with gists and authors; older ones fold after 20", () => {
  const comments = Array.from({ length: RECENT_COMMENT_COUNT + 3 }, (_, i) => ({
    id: `k${i}`,
    content: i === 0 ? "PM 9/28 ~4:10 PM: Sent the pantry bugs to Codex. Details follow here." : `Comment number ${i}.`,
    created_at: new Date(Date.UTC(2026, 8, 28, 12, i)).toISOString(),
  }));
  const view = buildTaskPageView({ task: baseTask(), checklist: [], comments, blockers: [], now: NOW });
  assert.equal(view.recentComments.length, RECENT_COMMENT_COUNT);
  assert.equal(view.olderComments.length, 3);
  assert.equal(view.recentComments[0].id, `k${RECENT_COMMENT_COUNT + 2}`);
  const pm = view.olderComments.at(-1);
  assert.deepEqual([pm.who, pm.label, pm.gist, pm.truncated], ["agent", "PM", "Sent the pantry bugs to Codex.", true]);
  assert.equal(pm.body, comments[0].content, "the full text keeps the original");
  assert.equal(pm.when, "Sep 28, 8:00 AM");
});

test("page: long descriptions start folded; empty ones are null", () => {
  assert.equal(buildTaskPageView({ task: baseTask({ description: "x".repeat(701) }), checklist: [], comments: [], blockers: [], now: NOW }).descriptionFolded, true);
  const none = buildTaskPageView({ task: baseTask({ description: "  " }), checklist: [], comments: [], blockers: [], now: NOW });
  assert.equal(none.description, null);
  assert.equal(none.descriptionFolded, false);
});

console.log(`\n${passed} passed${failed.length ? `, ${failed.length} failed` : ""}`);
if (failed.length) process.exit(1);
