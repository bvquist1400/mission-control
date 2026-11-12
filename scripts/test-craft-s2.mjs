#!/usr/bin/env node
// Craft S2, offline: the pure previews (Row done, Undo, Fix count, Log sitting, Change total), the timer numbers,
// the view model's timer / rows / band checks, the write routes' refusals before any database work, and the
// S1C carry-overs that live in TypeScript (c: Remove's 40P01/55P03 → 409; d: one explicit section order). No network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { writeInternalAuthContext } from "../src/lib/supabase/internal-auth.ts";
import { buildCraftView, bandCheckFor, removeBlockersText } from "../src/lib/craft.ts";
import * as A from "../src/lib/craft/actions.ts";
import * as setupService from "../src/lib/craft/setup-service.ts";
const { CraftSetupRefusal, removeCraftProject } = setupService;
import { orderSetupTasks } from "../src/lib/craft/setup.ts";
import { blanketInput, scarfInput, input, part, rows } from "./fixtures/craft/sample-views.mjs";

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`ok - ${name}`); } catch (e) { failed++; console.error(`FAIL - ${name}`, e); } }
const states = (total, done, extra = {}) => Array.from({ length: total }, (_, i) => ({ row: i + 1, done: i < done, linked: false, today: false, ...extra }));

// ── Pure previews ──────────────────────────────────────────────────────────
await test("currentRowOf / nextExistingRow: lowest unticked; past the end = total + 1; gaps are skipped", () => {
  assert.equal(A.currentRowOf(states(10, 4), 10), 5);
  assert.equal(A.currentRowOf(states(10, 10), 10), 11);
  const gap = states(31, 21).filter((s) => s.row < 22 || s.row > 28);
  assert.equal(A.currentRowOf(gap, 31), 29);
  assert.equal(A.nextExistingRow(gap, 21, 31), 29);
  assert.equal(A.nextExistingRow(gap, 31, 31), null);
});
await test("rowsText: runs joined, singular/plural, rounds", () => {
  assert.equal(A.rowsText("row", [57, 58]), "rows 57–58");
  assert.equal(A.rowsText("row", [57]), "row 57");
  assert.equal(A.rowsText("round", [7, 3, 5, 6]), "rounds 3, 5–7");
  assert.equal(A.rowsText("row", []), "no rows");
});
await test("Fix count plan: forward ticks only unticked rows from the current row; back unticks only from the new row; rows outside stay; linked rows are named", () => {
  const s = states(100, 58);
  s[69].done = true; // row 70 ticked ahead (chat)
  assert.deepEqual(A.fixCountPlan(s, 100, 62), { current: 59, to: 62, tick: [59, 60, 61], untick: [], next: 62, linked: [] });
  s[56].linked = true; // row 57 in a sitting
  const back = A.fixCountPlan(s, 100, 57);
  assert.deepEqual([back.untick, back.next, back.linked], [[57, 58], 57, [57]]);
  assert.deepEqual(A.fixCountPlan(s, 100, 59).tick, []);
  const ahead = A.fixCountPlan(s, 100, 75);
  assert.equal(ahead.tick.includes(70), false);
  assert.equal(ahead.next, 75);
});
await test("Undo choices: ticked rows below the current row, newest first, at most 12", () => {
  assert.deepEqual(A.undoChoices(states(100, 58), 100).slice(0, 3), [58, 57, 56]);
  assert.equal(A.undoChoices(states(100, 58), 100).length, 12);
  assert.deepEqual(A.undoChoices(states(10, 0), 10), []);
});
await test("Ridges: 48 ridges done = row 97 next", () => { assert.equal(A.rowFromRidgesDone(48), 97); });
await test("Count check text: the first number (\"Count the last row: 195 stitches\", \"Count: 195 stitches\", \"Count check: 1,040\"); none → null; only items starting Count", () => {
  assert.equal(A.countFromCheckText("Count the last row: 195 stitches"), 195);
  assert.equal(A.countFromCheckText("Count: 195 stitches"), 195);
  assert.equal(A.countFromCheckText("Count check: 1,040"), 1040);
  assert.equal(A.countFromCheckText("Count the last row"), null);
  assert.equal(A.isCountItemText("  count: 195"), true);
  assert.equal(A.isCountItemText("Row 52: count 195"), false);
});
await test("New row items keep the part's own word: \"Rnd 15 · k1, p1 rib\" → \"Rnd 32\"; \"Round 2\" → \"Round 3\"; \"Row 519\" → \"Row 520\"; no item → the part's word", () => {
  assert.equal(A.newRowItemText("Rnd 15 · k1, p1 rib", "round", 32), "Rnd 32");
  assert.equal(A.newRowItemText("Round 2", "round", 3), "Round 3");
  assert.equal(A.newRowItemText("Row 519", "row", 520), "Row 520");
  assert.equal(A.newRowItemText(null, "round", 4), "Round 4");
  // The S1C planner's row rule reads the new text as a row of the same word.
  const rule = /^(Row|Rnd|Round)[ \t]+([0-9]+)(?![0-9A-Za-z_])/;
  for (const text of ["Rnd 32", "Row 520", "Round 3"]) assert.match(text, rule);
});
await test("Change total plan: more adds at the end; fewer removes trailing unticked rows in no sitting; ticked or linked trailing rows refuse; 0 and 2,001 refuse", () => {
  const s = states(519, 96);
  assert.deepEqual(A.setTotalPlan(s, 519, 522), { kind: "add", total: 522, add: [520, 521, 522] });
  assert.deepEqual(A.setTotalPlan(s, 519, 519), { kind: "same", total: 519 });
  const cut = A.setTotalPlan(s, 519, 455);
  assert.equal(cut.kind, "remove");
  assert.equal(cut.remove.length, 64);
  assert.deepEqual(A.setTotalPlan(s, 519, 90), { kind: "refused", total: 90, reason: "ticked", rows: [91, 92, 93, 94, 95, 96] });
  s[499].linked = true;
  assert.deepEqual(A.setTotalPlan(s, 519, 455), { kind: "refused", total: 455, reason: "in_sitting", rows: [500] });
  assert.equal(A.setTotalPlan(s, 519, 0).reason, "range");
  assert.equal(A.setTotalPlan(s, 519, 2001).reason, "range");
  assert.equal(A.setTotalRefusalText("row", { reason: "ticked", rows: [91, 92] }), "Can't remove rows 91–92: they are ticked. Undo them first if that was a mistake.");
  assert.equal(A.setTotalRefusalText("round", { reason: "in_sitting", rows: [33] }), "Can't remove round 33: it is part of a saved sitting.");
});
await test("Log sitting defaults: with the timer from its start row, minutes from the clock (capped at 1,440); without, from the first row ticked today that no sitting has, else zero rows", () => {
  const s = states(157, 61);
  assert.deepEqual(A.logSittingDefaults(s, 157, { start_row: 59, elapsed_seconds: 40 * 60 + 29 }), { from: 58, to: 61, minutes: 40 });
  assert.deepEqual(A.logSittingDefaults(s, 157, { start_row: 59, elapsed_seconds: 30 * 3600 }).minutes, 1440);
  s[58].today = s[59].today = s[60].today = true;
  s[58].linked = true;
  assert.deepEqual(A.logSittingDefaults(s, 157, null), { from: 59, to: 61, minutes: null });
  assert.deepEqual(A.logSittingDefaults(states(157, 61), 157, null), { from: 61, to: 61, minutes: null });
});
await test("Sitting plan: (from, to] ticked and linked unless already in a sitting; rows after \"last full row\" up to the current row unticked", () => {
  const s = states(157, 63);
  s[58].linked = true;
  assert.deepEqual(A.sittingPlan(s, 157, 58, 61), { current: 64, rows: [59, 60, 61], tick: [], link: [60, 61], untick: [62, 63] });
  assert.deepEqual(A.sittingPlan(states(157, 58), 157, 58, 60).tick, [59, 60]);
});

// ── Timer numbers ─────────────────────────────────────────────────────────
await test("Timer elapsed from server timestamps: banked + adjust + running stretch; never negative; offset from server_now", () => {
  const now = Date.parse("2026-11-12T20:00:00Z");
  assert.equal(A.timerElapsedAt({ running_since: "2026-11-12T19:50:00Z", banked_seconds: 120, adjust_seconds: 60 }, now), 780);
  assert.equal(A.timerElapsedAt({ running_since: null, banked_seconds: 120, adjust_seconds: -600 }, now), 0);
  assert.equal(A.timerElapsedAt({ running_since: "2026-11-12T20:00:30Z", banked_seconds: 5, adjust_seconds: 0 }, now), 5, "a clock behind the server never counts backwards");
  const offset = A.clockOffsetMs("2026-11-12T20:00:10Z", now);
  assert.equal(offset, 10_000);
  assert.equal(A.serverNowMs(now, offset), now + 10_000);
});
await test("Clock and minutes text: 4:07, 23:14, 1:02:03; 45 min, 1 h, 2 h 05 min; minutes round like 073", () => {
  assert.deepEqual([A.clockText(247), A.clockText(1394), A.clockText(3723), A.clockText(-5)], ["4:07", "23:14", "1:02:03", "0:00"]);
  assert.deepEqual([A.minutesText(45), A.minutesText(60), A.minutesText(125)], ["45 min", "1 h", "2 h 05 min"]);
  assert.deepEqual([A.timerMinutes(29), A.timerMinutes(30), A.timerMinutes(40 * 60 + 29)], [0, 1, 40]);
});
await test("New ET day: a sitting started 9:30 PM ET yesterday is a new day after ET midnight, not at UTC midnight", () => {
  assert.equal(A.isNewEtDay("2026-11-12T02:30:00Z", "2026-11-12T04:59:00Z"), false); // 9:30 PM and 11:59 PM ET on 11/11
  assert.equal(A.isNewEtDay("2026-11-12T02:30:00Z", "2026-11-12T05:01:00Z"), true);
});
await test("Write failures never pass silently: a dropped connection says Not saved, retry; a 409 shows the server's words", () => {
  assert.match(A.writeFailureText(null, null), /^Not saved, retry/);
  assert.equal(A.writeFailureText(409, { error: "Not saved: the count changed on another screen." }), "Not saved: the count changed on another screen.");
  assert.match(A.writeFailureText(500, { error: "Internal server error" }), /^Not saved, retry/);
  assert.equal(A.writeFailureText(400, { error: "minutes must be 1 to 1440" }), "Not saved: minutes must be 1 to 1440");
});

// ── View model ────────────────────────────────────────────────────────────
const timer = (over = {}) => ({ user_id: "u", project_id: "project", part_id: "Body", sitting_started_at: "2026-11-08T17:20:00Z", running_since: "2026-11-08T17:40:00Z",
  paused_at: null, banked_seconds: 600, adjust_seconds: 120, start_row: 119, start_quarter: 0, version: 3, created_at: "", updated_at: "", ...over });
await test("View timer: this project's timer at server_now (elapsed, running, version); another project's timer is other_timer with its name", () => {
  const v = scarfInput(); v.timer = timer();
  const out = buildCraftView(v);
  assert.deepEqual([out.timer.running, out.timer.elapsed_seconds, out.timer.version, out.timer.long_run, out.timer.over_cap, out.timer.new_day, out.other_timer], [true, 600 + 120 + 20 * 60, 3, false, false, false, null]);
  v.timer = timer({ project_id: "elsewhere", running_since: null });
  v.timer_project = { id: "elsewhere", name: "Mom's Scarf" };
  const other = buildCraftView(v);
  assert.equal(other.timer, null);
  assert.deepEqual(other.other_timer, { project_id: "elsewhere", project_name: "Mom's Scarf", elapsed_seconds: 720, running: false, version: 3 });
});
await test("View timer: long runs (4 h+) ask Was it left on?; over 1,440 min is over the cap; an earlier ET day is new_day", () => {
  const v = scarfInput(); v.timer = timer({ running_since: "2026-11-08T13:00:00Z", banked_seconds: 0, adjust_seconds: 0 });
  assert.deepEqual([buildCraftView(v).timer.long_run, buildCraftView(v).timer.over_cap], [true, false]);
  v.timer = timer({ running_since: "2026-11-07T16:00:00Z", sitting_started_at: "2026-11-07T16:00:00Z", banked_seconds: 0, adjust_seconds: 0 });
  assert.deepEqual([buildCraftView(v).timer.over_cap, buildCraftView(v).timer.new_day], [true, true]);
});
await test("View rows: the active part's rows with done / linked / ticked today (ET), gaps left out", () => {
  const v = input([part("Body", 10)], rows("Body", 10, 4));
  v.items.splice(6, 2); // rows 7–8 deleted
  v.items[3].completed_at = "2026-11-08T17:00:00Z";
  v.session_items = [{ session_id: "s", checklist_item_id: "Body-1" }];
  const out = buildCraftView(v);
  assert.deepEqual(out.row_states.map((s) => s.row), [1, 2, 3, 4, 5, 6, 9, 10]);
  assert.deepEqual(out.row_states.slice(0, 4).map((s) => [s.done, s.linked, s.today]), [[true, true, false], [true, false, false], [true, false, false], [true, false, true]]);
});
await test("View band checks: a close_check band with every row ticked and its task not Done is pending, with the count from its item (else the part's stitches); a ticked count item or a Done task is not", () => {
  const v = blanketInput();
  v.band_tasks = v.segments.map((s) => ({ id: s.task_id, status: s.to_row <= 52 ? "Done" : "Planned", title: s.name }));
  v.count_items = [{ id: "c4", task_id: "task-4", text: "Count the last row: 195 stitches", is_done: false, sort_order: 20 }, { id: "c3", task_id: "task-3", text: "Count the last row: 195 stitches", is_done: true, sort_order: 20 }];
  v.items.forEach((row) => { if (row.craft_part_id === "Blanket" && row.craft_row <= 71) { row.is_done = true; } });
  let out = buildCraftView(v);
  assert.deepEqual(out.pending_checks.map((c) => [c.name, c.count, c.count_source, c.item_id]), [["Tree 2", 195, "item", "c4"]]);
  v.count_items = [];
  out = buildCraftView(v);
  assert.deepEqual(out.pending_checks.map((c) => [c.name, c.count, c.count_source, c.item_id]), [["Tree 2", 195, "part", null]]);
  v.band_tasks.find((t) => t.id === "task-4").status = "Done";
  assert.deepEqual(buildCraftView(v).pending_checks, []);
  assert.deepEqual(bandCheckFor("task-4", [{ id: "b", task_id: "task-4", text: "Count: 190", is_done: true, sort_order: 1 }, { id: "a", task_id: "task-4", text: "Count: 195", is_done: false, sort_order: 9 }], null).item_id, "a", "unticked first");
});
await test("View notes: newest first, at most 50; Remove words name craft screen sittings", () => {
  const v = scarfInput();
  v.notes = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, part_id: "Body", row: i + 1, text: `note ${i}`, session_id: null, created_at: `2026-11-08T${String(i % 24).padStart(2, "0")}:${String(i).padStart(2, "0")}:00Z` }));
  const out = buildCraftView(v);
  assert.equal(out.notes.length, 50);
  assert.ok(out.notes[0].created_at >= out.notes[1].created_at);
  assert.equal(removeBlockersText(["notes", "sittings"]), "notes and craft screen sittings");
});

// ── Routes (no database) ────────────────────────────────────────────────────
const routeCtx = (projectId) => ({ params: Promise.resolve({ projectId }) });
const noDb = new Proxy({}, { get() { throw new Error("database touched"); } });
const asUser = (method, path, body) => {
  const r = new NextRequest(`http://localhost${path}`, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } }) });
  writeInternalAuthContext(r, { supabase: noDb, userId: "11111111-1111-4111-8111-111111111111", user: { id: "u" }, authSource: "session" });
  return r;
};
const P = "22222222-2222-4222-8222-222222222222", PART = "33333333-3333-4333-8333-333333333333";
await test("Write routes refuse bad input before any database read (400), with no-store and CORS headers", async () => {
  const routes = { row: await import("../src/app/api/craft/[projectId]/row/route.ts"), timer: await import("../src/app/api/craft/[projectId]/timer/route.ts"),
    sittings: await import("../src/app/api/craft/[projectId]/sittings/route.ts"), total: await import("../src/app/api/craft/[projectId]/total/route.ts"), notes: await import("../src/app/api/craft/[projectId]/notes/route.ts") };
  const cases = [
    ["row", { part_id: PART, mode: "skip", expected_row: 3 }], ["row", { part_id: PART, mode: "done" }], ["row", { part_id: PART, mode: "undo", expected_row: 3 }], ["row", { part_id: PART, mode: "done", expected_row: 3, to_row: 4 }],
    ["timer", { action: "explode" }], ["timer", { action: "adjust", minutes: 2000 }], ["timer", { action: "start", force: "yes" }],
    ["sittings", { part_id: PART, use_timer: false, from_row: 1, to_row: 2, expected_row: 2, idempotency_key: "k" }],
    ["sittings", { part_id: PART, use_timer: true, timer_version: 1, to_row: 2, expected_row: 2, idempotency_key: "k", date: "2026-11-08" }],
    ["sittings", { part_id: PART, use_timer: false, minutes: 0, from_row: 1, to_row: 2, expected_row: 2, idempotency_key: "k" }],
    ["sittings", { part_id: PART, use_timer: false, minutes: 30, from_row: 1, to_row: 2, to_quarter: 5, expected_row: 2, idempotency_key: "k" }],
    ["total", { part_id: PART, total: 2001, expected_total: 519 }], ["total", { part_id: PART, total: 10 }],
    ["notes", { row: 3, text: "needs a part" }], ["notes", { part_id: PART, text: " " }], ["notes", { part_id: PART, text: "x".repeat(1001) }],
  ];
  for (const [kind, body] of cases) {
    const res = await routes[kind].POST(asUser("POST", `/api/craft/${P}/${kind}`, body), routeCtx(P));
    assert.equal(res.status, 400, `${kind} ${JSON.stringify(body)}: ${await res.clone().text()}`);
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
  assert.equal((await routes.row.POST(asUser("POST", "/api/craft/x/row", { part_id: PART, mode: "done", expected_row: 1 }), routeCtx("not-a-uuid"))).status, 400);
  assert.equal((await routes.row.POST(asUser("POST", `/api/craft/${P}/row`, "{oops"), routeCtx(P))).status, 400);
  assert.equal((await routes.notes.DELETE(asUser("DELETE", `/api/craft/${P}/notes`, { id: "nope" }), routeCtx(P))).status, 400);
});

// ── Carry-over c: Remove maps 40P01 / 55P03 to 409 like Create ────────────────
await test("Carry-over c: Remove that meets a deadlock (40P01) or a lock timeout (55P03) is a 409 \"busy\" with plain words, not a 500", async () => {
  for (const code of ["40P01", "55P03"]) {
    const client = {
      from() { const q = { select() { return q; }, eq() { return q; }, single: async () => ({ data: { project_id: P }, error: null }) }; return q; },
      rpc: async () => ({ data: null, error: { code, message: "deadlock detected" } }),
    };
    await assert.rejects(removeCraftProject(client, "u", P), (error) => error instanceof CraftSetupRefusal && error.status === 409 && error.reason === "busy" && error.message === setupService.CRAFT_REMOVE_BUSY, code);
  }
});

// ── Carry-over d: one explicit section order ─────────────────────────────────
await test("Carry-over d: sections with one sort_order in the same whole second sort by created_at to the millisecond (none first), then id, as 073's SQL does", () => {
  const sections = [
    { id: "00000000-0000-4000-8000-000000000002", sort_order: 0, created_at: "2026-11-10T12:00:00.5+00:00" },
    { id: "ffffffff-0000-4000-8000-000000000001", sort_order: 0, created_at: "2026-11-10T12:00:00+00:00" },
    { id: "aaaaaaaa-0000-4000-8000-000000000003", sort_order: 0, created_at: null },
    { id: "bbbbbbbb-0000-4000-8000-000000000004", sort_order: 0, created_at: "2026-11-10T12:00:00.5004+00:00" },
  ];
  const tasks = sections.map((s, i) => ({ id: `t${i}`, section_id: s.id, title: `T${i}`, is_sample: false, created_at: "2026-11-10T12:00:01Z" }));
  assert.deepEqual(orderSetupTasks({ sections, tasks }).map((t) => t.id), ["t2", "t1", "t0", "t3"], "null first, then 12:00:00.000, then .500 by id");
});

// ── The screen (server render: what shows before any script runs) ────────────
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true };
  if (url.startsWith("file:") && url.endsWith(".tsx")) {
    const fileName = fileURLToPath(url);
    const result = ts.transpileModule(readFileSync(fileName, "utf8"), { fileName, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    return { format: "module", source: result.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
} });
const { CraftScreen } = await import("../src/components/craft/CraftScreen.tsx");
const screen = (data) => renderToStaticMarkup(createElement(CraftScreen, { view: buildCraftView(data) }));
const timerCard = (html) => html.match(/<div class="craft-timer"[\s\S]*?(?=<div class="craft-actions">|<div class="craft-failure"|<section class="craft-today")/)?.[0] ?? "";
await test("Screen: a running timer shows the server's elapsed time, the time it started, Pause and ± time; the Auto-Lock tip until the screen lock is held", () => {
  const v = scarfInput(); v.timer = timer();
  const html = screen(v), card = timerCard(html);
  assert.match(card, /data-state="running"/);
  assert.match(card, /aria-label="Timer 32:00">32:00</);
  assert.match(card, /Timing since 12:20 PM/);
  assert.match(card, />Pause<\/button>/);
  assert.match(card, />± time<\/button>/);
  assert.match(card, /Set Auto-Lock to Never while you craft/);
  assert.doesNotMatch(html, /screen on</, "\"screen on\" only while the lock is held (never in the server render)");
});
await test("Screen: paused says when it stopped (\"stopped 20 min ago\") with Resume; a long run asks Was it left on?; idle says Not timing with Start", () => {
  const v = scarfInput(); v.timer = timer({ running_since: null, paused_at: "2026-11-08T17:40:00Z" });
  let card = timerCard(screen(v));
  assert.match(card, /Paused · stopped 20 min ago/);
  assert.match(card, />Resume<\/button>/);
  v.timer = timer({ running_since: "2026-11-08T12:00:00Z", banked_seconds: 0, adjust_seconds: 0 });
  card = timerCard(screen(v));
  assert.match(card, /6 h on the timer\. Was it left on\?/);
  assert.match(card, />Stopped earlier…<\/button>/);
  card = timerCard(screen(scarfInput()));
  assert.match(card, /data-state="idle"/);
  assert.match(card, /Not timing/);
  assert.match(card, />Start<\/button>/);
});
await test("Screen: another project's unsaved timer is named on the idle timer card", () => {
  const v = blanketInput(); v.timer = timer({ project_id: "scarf-project" }); v.timer_project = { id: "scarf-project", name: "Mom's Scarf" };
  assert.match(timerCard(screen(v)), /Mom&#x27;s Scarf&#x27;s timer is running \(32 min not saved\)/);
});
await test("Screen: Row done is the big button with the next existing row (gaps skipped); Undo rows…, Fix count… and Note under it; rounds say round", () => {
  const gap = input([part("Cuff", 31, { row_word: "round" })], rows("Cuff", 31, 20).filter((r) => r.craft_row < 22 || r.craft_row > 28).map((r) => ({ ...r, text: `Rnd ${r.craft_row}` })));
  const html = screen(gap);
  assert.match(html, /<button type="button" class="craft-done"><span>✓ Round done<\/span><small>round 21 → 29<\/small><\/button>/);
  assert.match(html, /<div class="craft-actions-more"><button type="button">Undo rounds…<\/button><button type="button">Fix count…<\/button><button type="button">Note<\/button><\/div>/);
  const last = input([part("Body", 3)], rows("Body", 3, 2));
  assert.match(screen(last), /<small>row 3 \(last\)<\/small>/);
});
await test("Screen: a pending band check is a button (\"Tree 2 is finished · Count is 195?\"); notes on the current row show in the pattern card and in Notes with Delete", () => {
  const v = blanketInput();
  v.band_tasks = v.segments.map((s) => ({ id: s.task_id, status: s.to_row <= 52 ? "Done" : "Planned", title: s.name }));
  v.count_items = [{ id: "c4", task_id: "task-4", text: "Count the last row: 195 stitches", is_done: false, sort_order: 20 }];
  v.items.forEach((row) => { if (row.craft_part_id === "Blanket" && row.craft_row <= 71) row.is_done = true; });
  v.notes = [{ id: "n1", part_id: "Blanket", row: 72, text: "extra dc in the turning chain", session_id: null, created_at: "2026-11-08T17:00:00Z" }];
  const html = screen(v);
  assert.match(html, /<button type="button" class="craft-check"><strong>Tree 2 is finished<\/strong><span>Count is 195\? Confirm to close the band<\/span><\/button>/);
  assert.match(html, /<ul class="craft-pf-notes" aria-label="Notes on row 72"><li>extra dc in the turning chain<\/li><\/ul>/);
  assert.match(html, /<h2>Notes<\/h2>[\s\S]*Row 72 · 2026-11-08[\s\S]*aria-label="Delete note: extra dc in the turning chain">Delete<\/button>/);
});
await test("Screen copy: plain words, no vendor names; the header has no Read only label", () => {
  const v = scarfInput(); v.timer = timer();
  const html = screen(v);
  assert.doesNotMatch(html, /Claude|Anthropic|OpenAI|ChatGPT|Read only/);
  for (const file of ["../src/components/craft/CraftScreen.tsx", "../src/components/craft/CraftSheets.tsx", "../src/lib/craft/actions.ts", "../src/lib/craft/write-service.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /Claude|Anthropic|OpenAI|ChatGPT/, file);
  }
});
await test("Screen wiring: every write goes to /api/craft/<id>/<row|timer|sittings|total|notes>; replies' view replaces the screen; re-read on show and every 30 s; Wake Lock re-asked on visibilitychange and resize", () => {
  const src = readFileSync(new URL("../src/components/craft/CraftScreen.tsx", import.meta.url), "utf8");
  assert.match(src, /fetch\(`\/api\/craft\/\$\{projectId\}\/\$\{kind\}`/);
  assert.match(src, /if \(json && typeof json === "object" && "view" in json\) accept\(json\.view as Screen\)/);
  assert.match(src, /setInterval\(\(\) => \{ void refresh\(\); \}, VIEW_REFRESH_MS\)/);
  assert.match(src, /addEventListener\("visibilitychange", onVisibility\)/);
  assert.match(src, /setTimeout\(\(\) => setToast\(\(t\) => \(t\?\.id === id \? null : t\)\), UNDO_TOAST_MS\)/);
  const wake = readFileSync(new URL("../src/components/craft/useWakeLock.ts", import.meta.url), "utf8");
  assert.match(wake, /document\.addEventListener\("visibilitychange", request\)/);
  assert.match(wake, /window\.addEventListener\("resize", request\)/);
  assert.match(wake, /request\("screen"\)/);
  const sheets = readFileSync(new URL("../src/components/craft/CraftSheets.tsx", import.meta.url), "utf8");
  for (const title of ["Log sitting", "Fix count", "Add a note", "Fix the time", "New day", "Another timer has time"]) assert.ok(sheets.includes(`title="${title}"`), title);
  assert.match(sheets, /<form onSubmit=\{submit\}>/, "Enter saves");
  assert.equal(A.VIEW_REFRESH_MS, 30_000);
  assert.equal(A.UNDO_TOAST_MS, 5000);
});
await test("CSS (S2): tokens only, nothing under 12px, a sticky action bar above the home bar, 44px+ touch targets, focus shown on the hidden radios, reduced motion", () => {
  const css = readFileSync(new URL("../src/components/craft/craft.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|oklch\(/i);
  assert.doesNotMatch(css, /font-size:\s*(\d|1[01])(\.\d+)?px/);
  assert.match(css, /\.craft-actions \{ position: sticky; bottom: 0;[^}]*env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.craft-done \{[^}]*min-height: 64px;/);
  assert.match(css, /\.craft-stepper button \{ min-height: 56px;/);
  assert.match(css, /\.craft-stepper input \{[^}]*font-size: 30px;/);
  assert.match(css, /label:has\(input:focus-visible\)/);
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{ \.craft-toast/);
  assert.match(css, /@media \(pointer: coarse\) \{ \.craft-actions-more button \{ min-height: 44px; \} \}/);
});

console.log(`\nCraft S2: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
