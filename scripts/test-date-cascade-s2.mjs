// Tests for cascade due dates, slice S2 (Baseline task 6fcad51b): the toast and
// confirm-box words (src/lib/date-cascade-view.ts, one case per mockup panel),
// the client calls (patchTaskWithReply, the date-cascade client), the endpoint's
// request parsing, the bounded retry and plain failure reasons, the planner's
// `via` paths (L1), the replan overlay, the UI wiring that must not regress
// (the grid's Due cell saves on blur/Enter only; bulk sends cascade:false), key
// scoping (FamCal refused, OAuth write scope, the upstream router), and MCP
// undo_date_cascade.
//
// Offline: no database and no network (the real functions are pinned by
// test:date-cascade-s2-db).
//
//   npm run test:date-cascade-s2

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const LEGACY_KEY = "test-legacy-key-dddddddddddddddd";
const API_USER_ID = "00000000-0000-4000-8000-000000000001";
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.MISSION_CONTROL_API_KEY = LEGACY_KEY;
process.env.MISSION_CONTROL_USER_ID = API_USER_ID;
process.env.DEPLOYMENT_ROLE = "main";

const fetchCalls = [];
let responder = () => new Response(JSON.stringify({ error: "no responder" }), { status: 500 });
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const call = { url, method: (init.method || "GET").toUpperCase(), body: init.body ? JSON.parse(init.body) : undefined };
  fetchCalls.push(call);
  return responder(call);
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const view = await import("../src/lib/date-cascade-view.ts");
const tasksClient = await import("../src/lib/tasks-client.ts");
const cascadeClient = await import("../src/lib/date-cascade-client.ts");
const cascade = await import("../src/lib/task-date-cascade.ts");
const undo = await import("../src/lib/task-date-cascade-undo.ts");
const famcal = await import("../src/lib/famcal-api-key.ts");
const scopes = await import("../src/lib/mcp/upstream-scopes.ts");
const mcpRoute = await import("../src/app/api/mcp/route.ts");
const projectRoute = await import("../src/app/api/projects/[id]/route.ts");
const { NextRequest } = await import("next/server");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}\n    ${String(error?.stack ?? error?.message ?? error).split("\n").slice(0, 8).join("\n    ")}`);
  }
}

const etAt = (date, time = "17:00") => new Date(`${date}T${time}:00${date >= "2026-11-01" ? "-05:00" : "-04:00"}`).toISOString();
const text = (parts) => (parts ?? []).map((part) => part.text).join("");
const ROOT = "Release + verify live";
const DEPS = ["Launch analytics check", "Campaign links + day-1 metrics", "Website launch-day swap"];
const reply = (extra = {}) => ({
  status: "moved", mode: "same_gap", delta_workdays: 2, reason: null, cascade_id: "c1",
  root_old_due_at: etAt("2026-10-22"), root_new_due_at: etAt("2026-10-26"), message: "",
  moves: DEPS.map((title, index) => ({ task_id: `t${index}`, title, old_due_at: etAt("2026-10-23"), new_due_at: etAt("2026-10-27") })),
  skipped: [{ task_id: "d", title: "Press kit sent", reason: "done" }],
  project_flags: [], depth_limited: 0, planned_moves: 3, ...extra,
});

// ── The toast (mockup panels 1–5, 7, 8) ────────────────────────────────────
await test("Panel 1: same gap — title, the edited task's dates, every move old → new, the Done one named, Undo and How far (Same gap on)", () => {
  const model = view.toastForChange({ rootTitle: ROOT, cascade: reply(), choice: "same_gap", origin: "patch" });
  assert.equal(model.tone, "success");
  assert.equal(model.title, "Moved 3 tasks by 2 workdays");
  assert.equal(text(model.sub), `“${ROOT}” Thu 10/22 → Mon 10/26`);
  assert.deepEqual(model.moves.map((m) => [m.title, m.from, m.to]), DEPS.map((title) => [title, "Fri 10/23", "Tue 10/27"]));
  assert.equal(model.left, "Not moved: “Press kit sent” (already Done).");
  assert.equal(model.modes, "same_gap");
  assert.deepEqual(model.primary, { label: "Undo", action: "undo" });
  assert.deepEqual(view.MODE_OPTIONS.map((o) => o.label), ["Same gap", "Only what collides", "Just this task"]);
});

await test("Panel 2: only what collides says honestly how far each moved; tasks with room are counted; Just this task says the others stayed", () => {
  const collide = view.toastForChange({
    rootTitle: ROOT, choice: "only_collisions", origin: "switch",
    cascade: reply({ mode: "only_collisions", delta_workdays: 2, moves: [{ task_id: "t0", title: DEPS[0], old_due_at: etAt("2026-10-23"), new_due_at: etAt("2026-10-26") }], skipped: [{ task_id: "t1", title: DEPS[1], reason: "not_needed" }, { task_id: "t2", title: DEPS[2], reason: "not_needed" }] }),
  });
  assert.equal(collide.title, "Moved 1 task (only what collided)");
  assert.equal(collide.left, "Each one moved just far enough not to be due before the task it waits on. 2 tasks already had room, so they stayed.");
  assert.equal(collide.modes, "only_collisions");
  const none = view.toastForChange({ rootTitle: ROOT, choice: "none", origin: "switch", waitingCount: 3, cascade: reply({ status: "off", moves: [], skipped: [], reason: "off" }) });
  assert.equal(none.title, "Moved only this task");
  assert.equal(none.left, "The 3 tasks waiting on it were not moved.");
  assert.equal(none.modes, "none");
  assert.equal(none.primary.action, "undo");
  // On the first save, "just this task" / nothing to move shows no toast at all (NOTES a10).
  assert.equal(view.toastForChange({ rootTitle: ROOT, choice: "none", origin: "patch", cascade: reply({ status: "off", moves: [] }) }), null);
  assert.equal(view.toastForChange({ rootTitle: ROOT, choice: "same_gap", origin: "patch", cascade: reply({ status: "nothing_to_move", moves: [] }) }), null);
  assert.equal(view.toastForChange({ rootTitle: ROOT, choice: "same_gap", origin: "patch", cascade: reply({ status: "not_applicable", reason: "earlier", moves: [] }) }), null);
});

await test("Panel 3: past the target date — warning tone and block (Green → Yellow); an already-Red project shows 'no change'", () => {
  const flags = [{ project_id: "p", name: "Menu & Market 1.0", target_date: "2026-10-23", latest_due_date: "2026-10-27", tasks_past_target: 3, rag_before: "Green", rag_after: "Yellow" }];
  const model = view.toastForChange({ rootTitle: ROOT, choice: "same_gap", origin: "patch", cascade: reply({ project_flags: flags }) });
  assert.equal(model.tone, "warning");
  assert.deepEqual(model.warn, [{ name: "Menu & Market 1.0", target: "Fri 10/23", latest: "Tue 10/27", count: 3, ragBefore: "Green", ragAfter: "Yellow", includesRoot: false }]);
  const red = view.toastForChange({ rootTitle: ROOT, choice: "same_gap", origin: "patch", cascade: reply({ project_flags: [{ ...flags[0], rag_before: "Red", rag_after: "Red" }] }) });
  assert.equal(red.warn[0].ragBefore, red.warn[0].ragAfter);
});

await test("Panel 4: Week board — 'Show next week' counts the moved tasks that now sit in the next week", () => {
  const model = view.toastForChange({ rootTitle: ROOT, choice: "same_gap", origin: "patch", weekStart: "2026-10-19", cascade: reply({ moves: DEPS.map((title, i) => ({ task_id: `t${i}`, title, old_due_at: etAt("2026-10-23"), new_due_at: etAt("2026-10-26") })) }) });
  assert.equal(model.nextWeek, 3);
  assert.equal(view.movesIntoNextWeek([{ new_due_at: etAt("2026-10-23") }, { new_due_at: etAt("2026-11-02") }], "2026-10-19"), 0);
  assert.equal(view.toastForChange({ rootTitle: ROOT, choice: "same_gap", origin: "patch", cascade: reply() }).nextWeek, null);
});

await test("Panel 8: failed (busy) is danger with Try again and no database words; superseded is a warning; a changed task is named", () => {
  const failed = view.toastForChange({ rootTitle: ROOT, choice: "same_gap", origin: "patch", cascade: reply({ status: "failed", reason: "busy", moves: [], cascade_id: null }) });
  assert.equal(failed.tone, "danger");
  assert.equal(failed.title, "Only this task moved — couldn’t move the 3 linked tasks");
  assert.match(text(failed.sub), /is on Mon 10\/26\. The tasks waiting on it are still on their old dates\. Baseline was busy; a note was left on the task\./);
  assert.deepEqual(failed.primary, { label: "Try again", action: "retry" });
  assert.equal(failed.modes, null);
  const other = view.toastForChange({ rootTitle: ROOT, choice: "same_gap", origin: "patch", cascade: reply({ status: "failed", reason: "error", moves: [] }) });
  assert.match(text(other.sub), /Something went wrong; a note was left/);
  const superseded = view.toastForChange({ rootTitle: ROOT, choice: "same_gap", origin: "patch", cascade: reply({ status: "superseded", moves: [] }) });
  assert.equal(superseded.tone, "warning");
  assert.equal(superseded.title, "The linked tasks were left as they were");
  assert.equal(superseded.primary, null);
  const changed = view.toastForChange({ rootTitle: ROOT, choice: "same_gap", origin: "patch", cascade: reply({ moves: reply().moves.slice(0, 2), skipped: [{ task_id: "t2", title: DEPS[2], reason: "changed" }] }) });
  assert.equal(changed.title, "Moved 2 tasks by 2 workdays · 1 stayed as it was");
  assert.equal(text(changed.sub), `“${DEPS[2]}” changed while this was happening, so it was not touched.`);
  assert.equal(changed.tone, "warning");
});

await test("Panel 8B / 409: nothing saved — 503 offers Try again and Move only this task; 409 says reload; a 500 never shows server text", () => {
  const unreadable = view.toastForSaveFailure({ rootTitle: ROOT, status: 503, error: "x", oldDueAt: etAt("2026-10-22") });
  assert.equal(unreadable.title, "Nothing was saved");
  assert.match(text(unreadable.sub), /couldn’t read all the tasks that wait on “Release \+ verify live”, so its date is still Thu 10\/22/);
  assert.deepEqual([unreadable.primary.action, unreadable.secondary.action], ["retry_patch", "only_this"]);
  assert.match(text(view.toastForSaveFailure({ rootTitle: ROOT, status: 409, error: "x", oldDueAt: null }).sub), /changed since it was loaded/);
  assert.equal(text(view.toastForSaveFailure({ rootTitle: ROOT, status: 500, error: "relation \"tasks\" does not exist", oldDueAt: null }).sub), "Something went wrong. Try again.");
  assert.equal(text(view.toastForSaveFailure({ rootTitle: ROOT, status: 400, error: "title cannot be empty", oldDueAt: null }).sub), "title cannot be empty");
});

await test("Panel 7: after Undo — full; partial with the kept task's dates; health back to Green or still Yellow", () => {
  const base = { status: "undone", task_id: "r", title: ROOT, message: "", root: { restored: true, due_at: etAt("2026-10-22"), restore_due_at: etAt("2026-10-22"), requested: true } };
  const restored = DEPS.map((title, i) => ({ task_id: `t${i}`, title, from_due_at: etAt("2026-10-27"), to_due_at: etAt("2026-10-23") }));
  const full = view.toastForUndo({ rootTitle: ROOT, reply: { ...base, cascade: { cascade_id: "c1", restored, kept: [], projects: [] } } });
  assert.equal(full.title, "Undone — 3 tasks back to their old dates");
  assert.equal(text(full.sub), `“${ROOT}” is back on Thu 10/22 too.`);
  assert.equal(full.tone, "success");
  const partial = view.toastForUndo({ rootTitle: ROOT, reply: { ...base, cascade: { cascade_id: "c1", restored: [restored[0], restored[2]], kept: [{ task_id: "t1", title: DEPS[1], due_at: etAt("2026-10-28"), cascade_due_at: etAt("2026-10-27") }], projects: [] } } });
  assert.equal(partial.tone, "warning");
  assert.equal(partial.title, "2 restored · 1 kept because you changed it since");
  assert.match(text(partial.sub), /^“Campaign links \+ day-1 metrics” is on Wed 10\/28 now \(the move had set Tue 10\/27\), so Undo left it\./);
  assert.deepEqual(partial.moves.map((m) => [m.from, m.to]), [["Tue 10/27", "Fri 10/23"], ["Tue 10/27", "Fri 10/23"]]);
  const green = view.toastForUndo({ rootTitle: ROOT, reply: { ...base, cascade: { cascade_id: "c1", restored, kept: [], projects: [{ project_id: "p", name: "Menu & Market 1.0", rag_before: "Yellow", rag_after: "Green", kept_reason: null }] } } });
  assert.equal(green.left, "Menu & Market 1.0 is back to Green.");
  const yellow = view.toastForUndo({ rootTitle: ROOT, reply: { ...base, cascade: { cascade_id: "c1", restored, kept: [], projects: [{ project_id: "p", name: "Menu & Market 1.0", rag_before: "Yellow", rag_after: "Yellow", kept_reason: "changed_since" }] } } });
  assert.equal(yellow.left, "Menu & Market 1.0 is still Yellow. Set it back if the dates no longer pass its target.");
  const lone = view.toastForUndo({ rootTitle: ROOT, reply: { ...base, cascade: null } });
  assert.equal(lone.title, "Undone — back to Thu 10/22");
  const rootKept = view.toastForUndo({ rootTitle: ROOT, reply: { ...base, root: { ...base.root, restored: false, due_at: etAt("2026-10-29") }, cascade: { cascade_id: "c1", restored, kept: [], projects: [] } } });
  assert.equal(rootKept.tone, "warning");
  assert.match(text(rootKept.sub), /was changed again since, so it stays on Thu 10\/29/);
});

await test("Panel 6: the >25 box — title, lead with both dates and the gap, 'Nothing has been saved yet', target notice, Move all N; too large offers only Just this task", () => {
  const moves = Array.from({ length: 31 }, (_, i) => ({ task_id: `m${i}`, title: `Task ${i}`, old_due_at: etAt("2026-10-23"), new_due_at: etAt("2026-10-27") }));
  const flags = [{ project_id: "p", name: "Menu & Market 1.0", target_date: "2026-10-23", latest_due_date: "2026-10-27", tasks_past_target: 31, rag_before: "Green", rag_after: "Yellow" }];
  const model = view.confirmModel({ rootTitle: ROOT, cascade: reply({ status: "needs_confirm", moves, project_flags: flags }) });
  assert.equal(model.title, "This would move 31 tasks");
  assert.equal(text(model.lead), `Moving “${ROOT}” from Thu 10/22 to Mon 10/26 would also move 31 tasks that wait on it, each by 2 workdays. Nothing has been saved yet.`);
  assert.equal(model.notice, "It would also push tasks in Menu & Market 1.0 past its target (Fri 10/23) and turn it Yellow.");
  assert.equal(model.moveAllLabel, "Move all 31");
  assert.equal(model.canMoveAll, true);
  const big = view.confirmModel({ rootTitle: ROOT, cascade: reply({ status: "too_large", moves }) });
  assert.equal(big.canMoveAll, false);
  assert.match(text(big.lead), /Nothing has been saved yet/);
});

await test("The editor hint (Brent 10/20): '3 tasks wait on this one and will follow' only for a later date with waiting tasks that can move", () => {
  const blocks = [
    { status: "Blocked/Waiting", due_at: etAt("2026-10-23") },
    { status: "Planned", due_at: etAt("2026-10-23") },
    { status: "In Progress", due_at: etAt("2026-10-23") },
    { status: "Done", due_at: etAt("2026-10-21") },
    { status: "Parked", due_at: etAt("2026-10-23") },
  ];
  assert.equal(view.followHint({ currentDueAt: etAt("2026-10-22"), nextDateOnly: "2026-10-26", blocks }), "3 tasks wait on this one and will follow");
  assert.equal(view.followHint({ currentDueAt: etAt("2026-10-22"), nextDateOnly: "2026-10-20", blocks }), null);
  assert.equal(view.followHint({ currentDueAt: etAt("2026-10-22"), nextDateOnly: null, blocks }), null);
  assert.equal(view.followHint({ currentDueAt: etAt("2026-10-22"), nextDateOnly: "2026-10-26", blocks: [] }), null);
  assert.equal(view.followHint({ currentDueAt: etAt("2026-10-22"), nextDateOnly: "2026-10-26", blocks: [blocks[1]] }), "1 task waits on this one and will follow");
});

await test("datesChangedBy merges restored dates, new moves and the edited task (lists on screen follow a switch or Undo)", () => {
  assert.deepEqual(view.datesChangedBy({
    restored: [{ task_id: "a", to_due_at: "2026-10-23" }, { task_id: "b", to_due_at: "2026-10-23" }],
    cascade: { moves: [{ task_id: "b", new_due_at: "2026-10-26" }] },
    root: { task_id: "r", due_at: "2026-10-22" },
  }), [{ task_id: "a", due_at: "2026-10-23" }, { task_id: "b", due_at: "2026-10-26" }, { task_id: "r", due_at: "2026-10-22" }]);
});

await test("No user-facing S2 copy names the assistant (no 'Claude' in the new UI or its words)", () => {
  for (const file of ["src/lib/date-cascade-view.ts", "src/components/tasks/DateCascadeProvider.tsx", "src/components/tasks/TaskDependencies.tsx", "src/lib/task-date-cascade-undo.ts", "src/lib/date-cascade-client.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), /claude|anthropic/i, file);
  }
});

// ── Client calls ───────────────────────────────────────────────────────────
await test("patchTaskWithReply keeps the reply: the task without its cascade key, the cascade object, and the 409 preview (nothing saved)", async () => {
  fetchCalls.length = 0;
  responder = () => json({ id: "r", title: ROOT, due_at: etAt("2026-10-26"), cascade: reply() });
  const ok = await tasksClient.patchTaskWithReply("r", { due_at: etAt("2026-10-26") }, { cascade_confirm: true });
  assert.equal(ok.ok, true);
  assert.equal("cascade" in ok.task, false);
  assert.equal(ok.cascade.cascade_id, "c1");
  assert.deepEqual(fetchCalls[0].body, { due_at: etAt("2026-10-26"), cascade_confirm: true });
  responder = () => json({ error: "This would also move 31 later tasks", cascade: reply({ status: "needs_confirm" }) }, 409);
  const refused = await tasksClient.patchTaskWithReply("r", { due_at: etAt("2026-10-26") });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 409);
  assert.equal(refused.cascade.status, "needs_confirm");
  // patchTask (void) still throws the plain error for older callers.
  await assert.rejects(tasksClient.patchTask("r", { due_at: etAt("2026-10-26") }), /31 later tasks/);
});

await test("The date-cascade client posts undo/apply bodies and never shows a 5xx's text", async () => {
  fetchCalls.length = 0;
  responder = () => json({ status: "undone" });
  await cascadeClient.undoDateChange("r", { cascade_id: "c1", from_due_at: "a", to_due_at: "b" });
  assert.deepEqual(fetchCalls[0], { url: "/api/tasks/r/date-cascade", method: "POST", body: { action: "undo", cascade_id: "c1", from_due_at: "a", to_due_at: "b" } });
  await cascadeClient.applyDateChange("r", { cascade_id: null, mode: "only_collisions", from_due_at: "a", to_due_at: "b", confirm: true });
  assert.deepEqual(fetchCalls[1].body, { action: "apply", cascade_id: null, mode: "only_collisions", from_due_at: "a", to_due_at: "b", confirm: true });
  responder = () => json({ error: "deadlock detected on relation tasks" }, 500);
  const failed = await cascadeClient.undoDateChange("r", { cascade_id: "c1", from_due_at: null, to_due_at: null });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "Couldn’t do that, so nothing was changed. Try again.");
});

// ── Server pieces ──────────────────────────────────────────────────────────
await test("parseDateCascadeRequest: actions, modes, ids, and what's needed without a cascade id", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  assert.equal(undo.parseDateCascadeRequest({ action: "undo", cascade_id: id }).ok, true);
  assert.equal(undo.parseDateCascadeRequest({ action: "apply", cascade_id: id, mode: "none" }).ok, true);
  assert.equal(undo.parseDateCascadeRequest({ action: "apply", mode: "same_gap", from_due_at: etAt("2026-10-22"), to_due_at: etAt("2026-10-26") }).ok, true);
  for (const bad of [
    { action: "redo" },
    { action: "apply", cascade_id: id },
    { action: "apply", cascade_id: id, mode: "everything" },
    { action: "undo", cascade_id: id, mode: "same_gap" },
    { action: "undo", cascade_id: "c1" },
    { action: "apply", mode: "same_gap" },
    { action: "undo", restore_root: false },
    { action: "undo", cascade_id: id, confirm: "yes" },
    { action: "undo", cascade_id: id, extra: true },
    { action: "apply", mode: "same_gap", to_due_at: "not a date" },
  ]) {
    assert.equal(undo.parseDateCascadeRequest(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(undo.parseDateCascadeRequest({ action: "undo", cascade_id: id }).value.restoreRoot, true);
  assert.equal(undo.parseDateCascadeRequest({ action: "undo", cascade_id: id, restore_root: false }).value.restoreRoot, false);
});

await test("withCascadeRetry retries a deadlock (40P01) or MC062 up to 3 tries; never a lock timeout or other error; plain reasons", async () => {
  const run = async (codes) => {
    let calls = 0;
    const result = await cascade.withCascadeRetry(async () => {
      const code = codes[Math.min(calls, codes.length - 1)];
      calls += 1;
      return { data: code ? null : "ok", error: code ? { code, message: "raw" } : null };
    }, { sleep: async () => {} });
    return { calls, result };
  };
  assert.deepEqual((await run(["40P01", null])).calls, 2);
  assert.deepEqual((await run(["MC062", "40P01", null])).calls, 3);
  const exhausted = await run(["40P01"]);
  assert.equal(exhausted.calls, 3);
  assert.equal(exhausted.result.error.code, "40P01");
  assert.equal((await run(["55P03"])).calls, 1);
  assert.equal((await run(["22023"])).calls, 1);
  assert.equal(cascade.cascadeFailureReason({ code: "55P03" }), "busy");
  assert.equal(cascade.cascadeFailureReason({ code: "40P01" }), "busy");
  assert.equal(cascade.cascadeFailureReason({ code: "42501" }), "error");
  assert.equal(cascade.cascadeFailureReason(new Error("x")), "error");
});

await test("Planner `via` (L1): each move carries the tasks on its path back to the edited task (chain and diamond); the root is never in it", () => {
  const task = (id, due, extra = {}) => ({ id, title: id, status: "Planned", due_at: due, project_id: null, is_recurring_template: false, recurring_template_id: null, ...extra });
  const graph = {
    rootId: "R",
    tasks: new Map([["A", { ...task("A", etAt("2026-10-23")), depth: 1 }], ["P", { ...task("P", etAt("2026-10-23"), { status: "Parked" }), depth: 1 }], ["B", { ...task("B", etAt("2026-10-26")), depth: 2 }], ["C", { ...task("C", etAt("2026-10-27")), depth: 3 }]]),
    edges: [{ task_id: "A", depends_on_task_id: "R" }, { task_id: "P", depends_on_task_id: "R" }, { task_id: "B", depends_on_task_id: "A" }, { task_id: "B", depends_on_task_id: "P" }, { task_id: "C", depends_on_task_id: "B" }],
    depthLimited: 0,
    tooLarge: false,
  };
  const plan = cascade.planTaskDateCascade({ graph, mode: "same_gap", deltaWorkdays: 1, rootOldDueAt: etAt("2026-10-22"), rootNewDueAt: etAt("2026-10-23") });
  const via = Object.fromEntries(plan.moves.map((move) => [move.task_id, move.via]));
  assert.deepEqual(via, { A: [], B: ["A", "P"], C: ["A", "B", "P"] });
});

await test("overlayRestoredDates plans a switch from the dates the replaced cascade will put back (only tasks still on its date)", () => {
  const graph = { rootId: "R", tasks: new Map([["A", { id: "A", due_at: etAt("2026-10-27"), depth: 1 }], ["B", { id: "B", due_at: etAt("2026-10-28"), depth: 1 }]]), edges: [], depthLimited: 0, tooLarge: false };
  const out = undo.overlayRestoredDates(graph, [
    { task_id: "A", old_due_at: etAt("2026-10-23"), new_due_at: etAt("2026-10-27") },
    { task_id: "B", old_due_at: etAt("2026-10-23"), new_due_at: etAt("2026-10-27") },
  ]);
  assert.equal(out.tasks.get("A").due_at, etAt("2026-10-23"));
  assert.equal(out.tasks.get("B").due_at, etAt("2026-10-28"), "changed since: planned from where it is");
  assert.equal(graph.tasks.get("A").due_at, etAt("2026-10-27"), "the read graph itself is untouched");
});

await test("Cascade replies carry the edited task's dates and planned count; project flags in replies drop the internal rag_set_at", () => {
  const r = cascade.buildCascadeReply({ status: "off", mode: "same_gap", reason: "off", root: { old_due_at: "a", new_due_at: "b" } });
  assert.deepEqual([r.root_old_due_at, r.root_new_due_at, r.planned_moves], ["a", "b", 0]);
  const flag = { project_id: "p", name: "P", target_date: "2026-10-23", latest_due_date: "2026-10-27", tasks_past_target: 1, rag_before: "Green", rag_after: "Yellow", rag_set_at: "2026-10-20T00:00:00Z" };
  const moved = cascade.buildCascadeReply({ status: "moved", mode: "same_gap", applied: { status: "moved", cascade_id: "c", moved: [], skipped: [], project_flags: [flag] } });
  assert.equal("rag_set_at" in moved.project_flags[0], false);
  const failed = cascade.buildCascadeReply({ status: "failed", mode: "same_gap", reason: "busy" });
  assert.match(failed.message, /Baseline was busy/);
});

await test("FR2 P2-1: the PATCH sends when it saved the edited task (p_root_saved_at) on both apply calls; a replayed (adopted) cascade keeps its id, moves and titles", async () => {
  const calls = [];
  const replay = {
    status: "moved", cascade_id: "winner", adopted: true, skipped: [], project_flags: [],
    moved: [{ task_id: "c", old_due_at: "2026-10-23T21:00:00Z", new_due_at: "2026-10-27T21:00:00Z", project_id: null, title: "Child (from the log)" }],
  };
  const fakeDb = { rpc: async (name, args) => { calls.push({ name, args }); return { data: replay, error: null }; } };
  const applied = await cascade.applyTaskDateCascade(fakeDb, {
    userId: "u", rootTaskId: "r", rootOldDueAt: null, rootNewDueAt: "2026-10-26T21:00:00Z", mode: "same_gap", deltaWorkdays: 2,
    scope: "all", source: "session", moves: [], rootTitle: "R", rootWasVisible: false, rootSavedAt: "2026-10-20T16:00:00.123456+00:00",
  });
  assert.equal(calls[0].name, "apply_task_date_cascade");
  assert.equal(calls[0].args.p_root_saved_at, "2026-10-20T16:00:00.123456+00:00");
  assert.equal(applied.adopted, true);
  assert.equal(applied.cascade_id, "winner");
  const reply = cascade.buildCascadeReply({ status: "moved", mode: "same_gap", applied });
  assert.deepEqual(reply.moves.map((m) => [m.task_id, m.title]), [["c", "Child (from the log)"]]);
  assert.equal(reply.cascade_id, "winner");
  // Without a save time (direct callers) the argument is sent as null: 061's behaviour.
  await cascade.applyTaskDateCascade(fakeDb, { userId: "u", rootTaskId: "r", rootOldDueAt: null, rootNewDueAt: "x", mode: "same_gap", deltaWorkdays: 0, scope: "all", source: "s", moves: [], rootTitle: "R", rootWasVisible: false });
  assert.equal(calls[1].args.p_root_saved_at, null);
  // Both PATCH apply calls (the cascade and the edited task's own flag) pass the saved row's updated_at.
  const route = readFileSync(new URL("../src/app/api/tasks/[id]/route.ts", import.meta.url), "utf8");
  assert.match(route, /const rootSavedAt = \(data as \{ updated_at\?: string \| null \}\)\.updated_at \?\? null;/);
  assert.equal((route.match(/^\s+rootSavedAt,$/gm) ?? []).length, 2);
  // 062: the initial apply checks the change's identity under the lock, stamps log rows under the locks.
  const sql = readFileSync(new URL("../supabase/migrations/062_task_date_cascade_undo.sql", import.meta.url), "utf8");
  const core = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION task_date_cascade_apply_core"), sql.indexOf("CREATE OR REPLACE FUNCTION apply_task_date_cascade"));
  assert.ok(core.indexOf("task_date_cascade_current(") > core.indexOf("PERFORM task_date_cascade_lock("), "identity read after the locks");
  assert.ok(core.indexOf("task_date_cascade_current(") < core.indexOf("INSERT INTO public.task_date_cascades"), "and before any log row");
  assert.match(core, /c\.created_at > p_root_saved_at/);
  assert.match(core, /clock_timestamp\(\)\)\s+RETURNING id INTO v_cascade_id/);
});

await test("Project PATCH: a deadlock (40P01) from 046's re-point trigger is sent again (bounded, 3 tries); other errors are not retried", async () => {
  const fakeProjects = (codes) => {
    const calls = [];
    const client = {
      from(table) {
        const ops = [];
        const proxy = new Proxy({}, {
          get(_t, prop) {
            if (prop === "then") {
              const code = codes[Math.min(calls.length, codes.length - 1)];
              calls.push({ table, ops: [...ops] });
              const result = code ? { data: null, error: { code, message: "deadlock detected" } } : { data: { id: "p", name: "x", stage: "Build" }, error: null };
              return (resolve) => resolve(result);
            }
            return (...args) => { ops.push([prop, args]); return proxy; };
          },
        });
        return proxy;
      },
    };
    return { client, calls };
  };
  const send = async (codes) => {
    const db = fakeProjects(codes);
    const request = writeInternalAuthContext(
      new NextRequest("http://localhost/api/projects/p", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) }),
      { supabase: db.client, user: { id: API_USER_ID }, userId: API_USER_ID, authSource: "legacy_api_key" }
    );
    const response = await projectRoute.PATCH(request, { params: Promise.resolve({ id: "p" }) });
    return { status: response.status, updates: db.calls.filter((c) => c.ops.some(([op]) => op === "update")).length };
  };
  assert.deepEqual(await send(["40P01", null]), { status: 200, updates: 2 });
  assert.deepEqual(await send(["40P01", "40P01", "40P01", null]), { status: 500, updates: 3 });
  assert.deepEqual(await send(["23505"]), { status: 500, updates: 1 });
});

// ── UI wiring that must not regress (source checks) ────────────────────────
await test("Grid Due and Estimate cells (FR1 #1): Escape drops the draft and a synchronous blur right after saves nothing; blur or Enter saves once; bulk Apply Due sends cascade:false + cascade_quiet", async () => {
  const { createDraftStore, draftCellHandlers } = await import("../src/lib/cell-draft.ts");
  // The browser runs the blur handler synchronously inside blur(), during the keydown event.
  const cell = (enter) => {
    const saves = [];
    let renders = 0;
    const store = createDraftStore(() => { renders += 1; });
    const handlers = draftCellHandlers({ id: "r", store, commit: (draft) => saves.push(draft), enter });
    const key = (name) => handlers.onKeyDown({ key: name, preventDefault() {}, currentTarget: { blur: () => handlers.onBlur() } });
    return { saves, store, handlers, key, renders: () => renders };
  };
  for (const enter of ["commit", "blur"]) {
    const escape = cell(enter);
    escape.handlers.onChange("2026-10-26");
    assert.equal(escape.store.get("r"), "2026-10-26");
    escape.key("Escape");
    assert.deepEqual(escape.saves, [], `${enter}: Escape then the blur it triggers saves nothing`);
    assert.equal(escape.store.get("r"), undefined, "the cell shows the saved value again");
    escape.handlers.onBlur();
    assert.deepEqual(escape.saves, [], "a later blur has nothing to save either");
    assert.ok(escape.renders() >= 2);

    const enterKey = cell(enter);
    enterKey.handlers.onChange("2026-10-26");
    enterKey.key("Enter");
    enterKey.handlers.onBlur();
    assert.deepEqual(enterKey.saves, ["2026-10-26"], `${enter}: Enter saves exactly once`);

    const blur = cell(enter);
    blur.handlers.onChange("2026-10-2");
    blur.handlers.onChange("2026-10-26");
    assert.deepEqual(blur.saves, [], "typing never saves");
    blur.handlers.onBlur();
    blur.handlers.onBlur();
    assert.deepEqual(blur.saves, ["2026-10-26"], "blur saves once");
  }

  // TaskGrid wires both cells through these handlers (no React-state drafts left to go stale).
  const grid = readFileSync(new URL("../src/components/tasks/TaskGrid.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(grid, /setDueDrafts|setEstimateDrafts|useState<Record<string, string>>\(\{\}\)/);
  const due = grid.slice(grid.indexOf('aria-label={`Due date for ${task.title}`}'), grid.indexOf("disabled={isBusy}", grid.indexOf('aria-label={`Due date for ${task.title}`}')));
  assert.match(due, /onChange=\{\(event\) => dueCell\.onChange\(event\.target\.value\)\}/);
  assert.match(due, /onBlur=\{dueCell\.onBlur\}/);
  assert.match(due, /onKeyDown=\{dueCell\.onKeyDown\}/);
  assert.match(grid, /const dueCell = draftCellHandlers\(\{ id: task\.id, store: dueDrafts, commit: \(draft\) => commitDueDraft\(task, draft\) \}\)/);
  assert.match(grid, /const estimateCell = draftCellHandlers\(\{ id: task\.id, store: estimateDrafts, commit: \(draft\) => void commitEstimatedMinutes\(task, draft\), enter: "blur" \}\)/);
  assert.match(grid, /onBlur=\{estimateCell\.onBlur\}/);
  assert.match(grid, /const requestOptions = "due_at" in updates \? \{ cascade: false, cascade_quiet: true \} : \{\};/);
  assert.match(grid, /Bulk changes don’t move linked tasks\./);
  assert.match(grid, /requestOptions\.cascade !== false && dateCascade/);
});

await test("Week board drag and the task window's editor save dates through the cascade provider (toast, confirm, Undo)", () => {
  const week = readFileSync(new URL("../src/components/today/sections/WeekBoard.tsx", import.meta.url), "utf8");
  assert.match(week, /dateCascade\.changeDueDate\(\{[\s\S]*week: \{ weekStart: selectedWeekStart, showNextWeek/);
  const detail = readFileSync(new URL("../src/hooks/useTaskDetail.ts", import.meta.url), "utf8");
  assert.match(detail, /"due_at" in updates && dateCascade/);
  const layout = readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /<ToastProvider>\s*<DateCascadeProvider>/);
});

// ── Key scoping and routing ────────────────────────────────────────────────
await test("Key scoping: the FamCal key can't reach /date-cascade; OAuth needs mcp.write for it; the upstream router serves it", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  assert.equal(famcal.isFamcalKeyRouteAllowed("POST", `/api/tasks/${id}/date-cascade`), false);
  assert.deepEqual([...scopes.getRequiredScopesForPath(["tasks", id, "date-cascade"], "POST")], ["mcp.write"]);
  const upstream = readFileSync(new URL("../src/app/api/mcp-upstream/[...path]/route.ts", import.meta.url), "utf8");
  assert.match(upstream, /segments\[2\] === 'date-cascade'[\s\S]*taskDateCascadeRoute\.POST/);
});

// ── MCP undo_date_cascade ──────────────────────────────────────────────────
async function mcpRpc(body) {
  const request = new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-mission-control-key": LEGACY_KEY,
      "mcp-session-id": "stateless",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify(body),
  });
  const response = await mcpRoute.POST(request);
  const raw = await response.text();
  const payload = raw.startsWith("event:") || raw.startsWith("data:") ? raw.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim() ?? "" : raw;
  return JSON.parse(payload);
}
await mcpRpc({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cascade-s2-test", version: "1" } } });

await test("MCP undo_date_cascade: in the tool list with task_id, cascade_id, restore_task; posts action undo; an error reply is flagged", async () => {
  const list = await mcpRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const tool = list.result.tools.find((t) => t.name === "undo_date_cascade");
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["cascade_id", "restore_task", "task_id"]);
  assert.deepEqual([...tool.inputSchema.required].sort(), ["cascade_id", "task_id"]);
  assert.doesNotMatch(tool.description, /claude|anthropic/i);
  assert.match(list.result.tools.find((t) => t.name === "update_task").description, /undo_date_cascade/);

  fetchCalls.length = 0;
  responder = () => json({ status: "undone", message: "Put 3 tasks back on their old date." });
  const ok = await mcpRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "undo_date_cascade", arguments: { task_id: "r1", cascade_id: "c1" } } });
  assert.equal(fetchCalls[0].method, "POST");
  assert.match(fetchCalls[0].url, /\/api\/tasks\/r1\/date-cascade$/);
  assert.deepEqual(fetchCalls[0].body, { action: "undo", cascade_id: "c1", restore_root: true });
  assert.equal(ok.result.isError, undefined);
  await mcpRpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "undo_date_cascade", arguments: { task_id: "r1", cascade_id: "c1", restore_task: false } } });
  assert.equal(fetchCalls[1].body.restore_root, false);
  responder = () => json({ error: "That date change wasn't found for this task." }, 404);
  const missing = await mcpRpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "undo_date_cascade", arguments: { task_id: "r1", cascade_id: "c9" } } });
  assert.equal(missing.result.isError, true);
});

// ── Fix round 1 (FR1) ──────────────────────────────────────────────────────
await test("FR1 #6 toast: the edited task alone past its target shows the warning with Undo (patch: nothing else to move, or Just this task); no flag, no toast", () => {
  const flag = { project_id: "p", name: "Menu & Market 1.0", target_date: "2026-10-23", latest_due_date: "2026-10-26", tasks_past_target: 1, rag_before: "Green", rag_after: "Yellow", includes_edited_task: true };
  for (const [status, choice, title] of [["nothing_to_move", "same_gap", "Moved only this task"], ["not_applicable", "same_gap", "Moved only this task"], ["off", "none", "Moved only this task"]]) {
    const model = view.toastForChange({ rootTitle: ROOT, choice, origin: "patch", cascade: reply({ status, moves: [], cascade_id: "c9", project_flags: [flag] }) });
    assert.ok(model, status);
    assert.equal(model.tone, "warning", status);
    assert.equal(model.title, title, status);
    assert.deepEqual(model.primary, { label: "Undo", action: "undo" }, status);
    assert.deepEqual(model.warn, [{ name: "Menu & Market 1.0", target: "Fri 10/23", latest: "Mon 10/26", count: 1, ragBefore: "Green", ragAfter: "Yellow", includesRoot: true }], status);
    assert.equal(view.warnSentence(model.warn[0]), "This puts this task in Menu & Market 1.0 after its target (Fri 10/23). The latest is now Mon 10/26.");
  }
  const alone = view.toastForChange({ rootTitle: ROOT, choice: "same_gap", origin: "patch", cascade: reply({ status: "nothing_to_move", moves: [], skipped: [], planned_moves: 0, cascade_id: "c9", project_flags: [flag] }) });
  assert.equal(alone.modes, null, "nothing waits on it: no How far row");
  const roomy = view.toastForChange({ rootTitle: ROOT, choice: "same_gap", origin: "patch", cascade: reply({ status: "nothing_to_move", moves: [], skipped: [{ task_id: "w", title: "W", reason: "not_needed" }], cascade_id: "c9", project_flags: [flag] }) });
  assert.equal(roomy.modes, "same_gap");
  assert.equal(view.warnSentence({ name: "P", target: "Fri 10/23", latest: "Tue 10/27", count: 4, includesRoot: true }), "This puts this task and 3 more in P after its target (Fri 10/23). The latest is now Tue 10/27.");
  assert.equal(view.warnSentence({ name: "P", target: "Fri 10/23", latest: "Tue 10/27", count: 3, includesRoot: false }), "This pushes 3 tasks in P after its target (Fri 10/23). The latest is now Tue 10/27.");
  const provider = readFileSync(new URL("../src/components/tasks/DateCascadeProvider.tsx", import.meta.url), "utf8");
  assert.match(provider, /warnSentenceParts\(warn\)/);
});

await test("FR1 #6 options: cascade_quiet (bulk date sets) means just this task and no project flag; MCP update_task does not offer it", async () => {
  assert.deepEqual(cascade.parseCascadeOptions({ due_at: "x", cascade: false, cascade_quiet: true }), { ok: true, value: { cascade: false, mode: "same_gap", confirm: false, quiet: true } });
  assert.deepEqual(cascade.parseCascadeOptions({ due_at: "x", cascade_quiet: true }), { ok: true, value: { cascade: false, mode: "same_gap", confirm: false, quiet: true } });
  assert.deepEqual(cascade.parseCascadeOptions({ due_at: "x", cascade: false }), { ok: true, value: { cascade: false, mode: "same_gap", confirm: false, quiet: false } });
  assert.equal(cascade.parseCascadeOptions({ cascade_quiet: "yes" }).ok, false);
  assert.equal(cascade.parseCascadeOptions({ due_at: "x", cascade: "preview", cascade_quiet: true }).ok, false);
  const list = await mcpRpc({ jsonrpc: "2.0", id: 50, method: "tools/list", params: {} });
  const update = list.result.tools.find((t) => t.name === "update_task");
  assert.equal("cascade_quiet" in update.inputSchema.properties, false);
  assert.ok("cascade" in update.inputSchema.properties);
});

await test("FR1 LOW: the >25 box lists rows by date, then by title in natural order (1, 2, 10 — not 1, 10, 2)", () => {
  const moves = [10, 2, 1, 11].map((n) => ({ task_id: `m${n}`, title: `Big follower ${n}`, old_due_at: etAt("2026-10-23"), new_due_at: etAt("2026-10-27") }));
  moves.push({ task_id: "early", title: "Big follower 99", old_due_at: etAt("2026-10-22"), new_due_at: etAt("2026-10-26") });
  const model = view.confirmModel({ rootTitle: ROOT, cascade: reply({ status: "needs_confirm", moves }) });
  assert.deepEqual(model.rows.map((row) => row.title), ["Big follower 99", "Big follower 1", "Big follower 2", "Big follower 10", "Big follower 11"]);
});

await test("FR1 LOW: the persistent cascade toast is never pushed out by other toasts; ordinary ones still cap at 3", async () => {
  const { nextToastStack } = await import("../src/components/ui/toast-stack.ts");
  let stack = [];
  const add = (record) => { stack = nextToastStack(stack, record); };
  add({ id: 1, duration: 0, key: "date-cascade" });
  for (let id = 2; id <= 6; id += 1) add({ id, duration: 5000 });
  assert.deepEqual(stack.map((t) => t.id), [1, 5, 6]);
  add({ id: 7, duration: 0, key: "date-cascade" });
  assert.deepEqual(stack.map((t) => t.id), [7, 5, 6], "a newer date change replaces it in place");
  stack = [];
  for (let id = 1; id <= 5; id += 1) add({ id, duration: 5000 });
  assert.deepEqual(stack.map((t) => t.id), [3, 4, 5]);
  const toastSource = readFileSync(new URL("../src/components/ui/Toast.tsx", import.meta.url), "utf8");
  assert.match(toastSource, /setToasts\(\(current\) => nextToastStack\(current, record\)\)/);
});

await test("FR1 LOW (L1): a plan whose paths would exceed 20,000 ids is too large (plain too-large reply, nothing saved); paths are never silently dropped", async () => {
  const task = (id, due) => ({ id, user_id: "u", title: id, status: "Planned", due_at: due, project_id: null, is_recurring_template: false, recurring_template_id: null, base_priority: 50, priority_score: 50, stakeholder_mentions: [] });
  // Codex's valid 226-task, depth-16 graph: one bottleneck, then 15 layers of 15 (23,850 path ids).
  const graph = { rootId: "R", tasks: new Map(), edges: [], tooLarge: false, depthLimited: 0 };
  graph.tasks.set("bottleneck", { ...task("bottleneck", etAt("2026-10-23")), depth: 1 });
  graph.edges.push({ task_id: "bottleneck", depends_on_task_id: "R" });
  let previous = ["bottleneck"];
  for (let depth = 1; depth <= 15; depth += 1) {
    const ids = Array.from({ length: 15 }, (_, i) => `layer${depth}-${i}`);
    for (const id of ids) {
      graph.tasks.set(id, { ...task(id, etAt("2026-10-23")), depth: depth + 1 });
      for (const prerequisite of previous) graph.edges.push({ task_id: id, depends_on_task_id: prerequisite });
    }
    previous = ids;
  }
  const plan = cascade.planTaskDateCascade({ graph, mode: "same_gap", deltaWorkdays: 2, rootOldDueAt: etAt("2026-10-22"), rootNewDueAt: etAt("2026-10-26") });
  assert.equal(plan.moves.length, 226);
  assert.equal(plan.moves.reduce((sum, move) => sum + move.via.length, 0), 23850);
  assert.equal(plan.tooLarge, true);
  assert.equal(plan.tooLargeReason, "links");
  const reply409 = cascade.buildCascadeReply({ status: "too_large", mode: "same_gap", plan });
  assert.equal(reply409.reason, "links");
  assert.doesNotMatch(reply409.message, /500/);
  assert.match(text(view.confirmModel({ rootTitle: ROOT, cascade: reply409 }).lead), /too many links between them/);
  const fakeDb = { from: () => ({ select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }) }) };
  await assert.rejects(() => cascade.prepareCascadeApplyMoves(fakeDb, "u", { rootTitle: "R", plan, graph }), /too many/i);
  const small = cascade.planTaskDateCascade({ graph: { ...graph, tasks: new Map([...graph.tasks].slice(0, 16)) }, mode: "same_gap", deltaWorkdays: 2, rootOldDueAt: etAt("2026-10-22"), rootNewDueAt: etAt("2026-10-26") });
  assert.equal(small.tooLarge, false);
  assert.equal(small.tooLargeReason, null);
});

// A model of 062's identity rule for the service tests: replace/undo answer
// "stale" unless the id they were given is the newest active cascade of the
// change (none = no active one).
function identityFixture() {
  const U = API_USER_ID;
  const R = "00000000-0000-4000-8000-0000000000aa";
  const C = "00000000-0000-4000-8000-0000000000bb";
  const tables = {
    tasks: [
      { id: R, user_id: U, title: "Root", due_at: etAt("2026-10-26"), project_id: null, tags: ["work"], status: "Planned", base_priority: 50, priority_score: 50, stakeholder_mentions: [], is_recurring_template: false, recurring_template_id: null },
      { id: C, user_id: U, title: "Child", due_at: etAt("2026-10-23"), project_id: null, tags: ["work"], status: "Planned", base_priority: 50, priority_score: 50, stakeholder_mentions: [], is_recurring_template: false, recurring_template_id: null },
    ],
    task_dependencies: [{ id: "00000000-0000-4000-8000-0000000000cc", user_id: U, task_id: C, depends_on_task_id: R, is_resolved: false }],
    stakeholders: [], projects: [], task_date_cascades: [], task_date_cascade_moves: [],
  };
  const rpcCalls = [];
  let seq = 1;
  let pause = null;
  const current = () => tables.task_date_cascades.filter((c) => !c.undone_at).sort((a, b) => b.seq - a.seq)[0]?.id ?? null;
  const undoLog = (id) => {
    const log = tables.task_date_cascades.find((c) => c.id === id);
    for (const move of tables.task_date_cascade_moves.filter((m) => m.cascade_id === id)) {
      const row = tables.tasks.find((t) => t.id === move.task_id);
      if (row.due_at === move.new_due_at) row.due_at = move.old_due_at;
    }
    log.undone_at = "x";
    return { status: "undone", cascade_id: id, restored: [], kept: [], projects: [] };
  };
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.one = false; }
    select() { return this; }
    eq(k, v) { this.filters.push((r) => r[k] === v); return this; }
    is(k, v) { return this.eq(k, v); }
    in(k, v) { this.filters.push((r) => v.includes(r[k])); return this; }
    gt(k, v) { this.filters.push((r) => r[k] > v); return this; }
    contains(k, v) { this.filters.push((r) => v.every((x) => (r[k] || []).includes(x))); return this; }
    order() { return this; }
    limit() { return this; }
    maybeSingle() { this.one = true; return this; }
    async run() {
      const rows = (tables[this.table] || []).filter((r) => this.filters.every((f) => f(r))).map((r) => structuredClone(r));
      if (this.table === "task_date_cascades" && !this.one && pause) { const fn = pause; pause = null; await fn(); }
      return { data: this.one ? rows[0] ?? null : this.table === "task_date_cascades" ? rows.sort((a, b) => b.seq - a.seq) : rows, error: null };
    }
    then(resolve, reject) { return this.run().then(resolve, reject); }
  }
  const db = {
    from: (table) => new Query(table),
    async rpc(name, p) {
      rpcCalls.push({ name, p: structuredClone(p) });
      if (name === "undo_task_date_cascade") {
        if ((p.p_cascade_id ?? null) !== current()) return { data: { status: "stale", current_cascade_id: current() }, error: null };
        if (p.p_cascade_id) undoLog(p.p_cascade_id);
        return { data: { status: "undone", cascade: null, root: { restored: false, due_at: null, restore_due_at: null } }, error: null };
      }
      if ((p.p_replace_cascade_id ?? null) !== current()) return { data: { status: "stale", current_cascade_id: current(), undo: null, apply: null }, error: null };
      const undone = p.p_replace_cascade_id ? undoLog(p.p_replace_cascade_id) : null;
      const moved = [];
      for (const move of p.p_moves || []) {
        const row = tables.tasks.find((t) => t.id === move.task_id);
        if (row.due_at === move.old_due_at) { row.due_at = move.new_due_at; moved.push({ task_id: row.id, old_due_at: move.old_due_at, new_due_at: move.new_due_at, project_id: null }); }
      }
      let id = null;
      if (moved.length) {
        id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
        tables.task_date_cascades.push({ id, seq: seq++, user_id: U, root_task_id: R, root_old_due_at: p.p_root_old_due_at, root_new_due_at: p.p_root_new_due_at, mode: p.p_mode, undone_at: null });
        for (const m of moved) tables.task_date_cascade_moves.push({ cascade_id: id, user_id: U, task_id: m.task_id, old_due_at: m.old_due_at, new_due_at: m.new_due_at });
      }
      return { data: { status: "replaced", undo: undone, apply: p.p_mode ? { status: moved.length ? "moved" : "nothing_moved", cascade_id: id, moved, skipped: [], project_flags: [] } : null }, error: null };
    },
  };
  return { db, tables, rpcCalls, R, C, child: () => tables.tasks.find((t) => t.id === C).due_at, pause: (fn) => { pause = fn; } };
}
const parsed = (body) => { const out = undo.parseDateCascadeRequest(body); assert.equal(out.ok, true, JSON.stringify(out)); return out.value; };

await test("FR1 P2-1 (service): an id that was already undone or replaced is refused before any write (409 stale with the current id); Undo with it restores nothing", async () => {
  const f = identityFixture();
  const body = { action: "apply", mode: "same_gap", from_due_at: etAt("2026-10-22"), to_due_at: etAt("2026-10-26") };
  const first = await undo.applyDateChange(f.db, API_USER_ID, f.R, parsed(body), "session");
  const c1 = first.cascade.cascade_id;
  assert.equal(f.child(), etAt("2026-10-27"));
  const second = await undo.applyDateChange(f.db, API_USER_ID, f.R, parsed({ ...body, cascade_id: c1 }), "session");
  const c2 = second.cascade.cascade_id;
  assert.equal(f.child(), etAt("2026-10-27"));
  const calls = f.rpcCalls.length;
  for (const mode of ["same_gap", "only_collisions", "none"]) {
    await assert.rejects(() => undo.applyDateChange(f.db, API_USER_ID, f.R, parsed({ ...body, mode, cascade_id: c1 }), "session"), (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.body.reason, "stale");
      assert.equal(error.body.current_cascade_id, c2);
      return true;
    });
  }
  await assert.rejects(() => undo.undoDateChange(f.db, API_USER_ID, f.R, parsed({ action: "undo", cascade_id: c1 })), (error) => error.status === 409 && error.body.reason === "stale");
  assert.equal(f.rpcCalls.length, calls, "no RPC for a stale id");
  assert.equal(f.child(), etAt("2026-10-27"));
  const provider = readFileSync(new URL("../src/components/tasks/DateCascadeProvider.tsx", import.meta.url), "utf8");
  assert.match(provider, /cascadeId: reply\.cascade\.cascade_id,/, "the toast keeps the reply's id, null included");
  assert.doesNotMatch(provider, /cascade_id \?\? stateRef\.current\.cascadeId/);
});

await test("FR1 P2-2 (service): an id-less Try again that finds a cascade appeared since its lookup is re-planned against it once (moves once)", async () => {
  const f = identityFixture();
  const body = { action: "apply", mode: "same_gap", from_due_at: etAt("2026-10-22"), to_due_at: etAt("2026-10-26") };
  f.pause(async () => { await undo.applyDateChange(f.db, API_USER_ID, f.R, parsed(body), "session"); });
  const result = await undo.applyDateChange(f.db, API_USER_ID, f.R, parsed(body), "session");
  assert.equal(result.status, "replaced");
  assert.equal(f.child(), etAt("2026-10-27"), "Tue 10/27, never Thu 10/29");
  assert.equal(f.tables.task_date_cascades.filter((c) => !c.undone_at).length, 1);
  assert.equal(f.rpcCalls.filter((c) => c.name === "replace_task_date_cascade").length, 3, "B, A (stale), A again");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`Failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
