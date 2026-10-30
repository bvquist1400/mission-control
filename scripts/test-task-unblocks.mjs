#!/usr/bin/env node
// Pure tests for "Now unblocked" (Baseline 2f6b39f2 / S2 task 1349c17a,
// migration 067). No database:
//   - src/lib/task-unblocks.ts: when the pill shows, the "until I act" clearing
//     rule (Brent 10/30: no time limit), the landing day (weekend -> Monday for
//     work tasks) and "keep the later date", the hover text, the intelligence
//     layer's read of task_unblocks (fake client) and the merge;
//   - the pill rendered on the Now card, the week board card, the task card and
//     the task page model (react-dom/server, TSX transpiled here);
//   - static checks on 067 and its rollback: no backfill (no top-level writes,
//     the column has no default), no titles in any comment text, no 3-day
//     timeout, the 7-day undo window, SECURITY INVOKER + search_path on every
//     function, the clear reasons and the priority/boost numbers mirrored from
//     the TypeScript, and a rollback that drops everything 067 creates.
// The SQL itself runs in test:task-unblocks-db (local stack).
//
//   npm run test:task-unblocks

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".tsx")) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      const output = ts.transpileModule(source, {
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          verbatimModuleSyntax: false,
        },
        fileName: fileURLToPath(url),
      });
      return { format: "module", source: output.outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const src = (file) => pathToFileURL(path.join(ROOT, "src", file)).href;
const unblocks = await import(src("lib/task-unblocks.ts"));
const priority = await import(src("lib/priority.ts"));
const taskPage = await import(src("lib/task-page.ts"));
const { buildRecurringDueAt } = await import(src("lib/recurrence.ts"));
const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { NowTaskCard } = await import(src("components/today/cards/NowTaskCard.tsx"));
const { WeeklyTaskCard } = await import(src("components/today/cards/BoardTaskCard.tsx"));
const { TaskCard } = await import(src("components/tasks/TaskCard.tsx"));

const {
  isNowUnblocked,
  unblockPillClearReason,
  withUnblockPillRule,
  unblockLandingDate,
  unblockDueAt,
  nowUnblockedTitle,
  fetchRecentUnblockDependencySummaries,
  mergeResolvedDependencyMaps,
  UNBLOCK_CLEAR_REASONS,
  UNBLOCK_UNDO_DAYS,
  NOW_UNBLOCKED_LABEL,
} = unblocks;

const MIGRATION = readFileSync(path.join(ROOT, "supabase/migrations/067_task_unblocks.sql"), "utf8");
const ROLLBACK = readFileSync(path.join(ROOT, "supabase/rollbacks/067_task_unblocks.down.sql"), "utf8");

let passed = 0;
const failed = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed.push(name);
    console.log(`not ok - ${name}\n  ${String(error?.message ?? error).split("\n").slice(0, 8).join("\n  ")}`);
  }
}

const AT = "2026-10-30T13:40:00.000Z"; // Fri 10/30, 9:40 AM ET
const NOW = new Date("2026-10-30T15:00:00.000Z");

// ── When the pill shows ───────────────────────────────────────────────────

await test("pill: shows only with unblocked_at on an open task", () => {
  for (const status of ["Backlog", "Planned", "In Progress", "Blocked/Waiting"]) {
    assert.equal(isNowUnblocked({ status, unblocked_at: AT }), true, status);
    assert.equal(isNowUnblocked({ status, unblocked_at: null }), false, status);
    assert.equal(isNowUnblocked({ status }), false, `${status} without the field`);
  }
  for (const status of ["Done", "Parked", "Missed"]) {
    assert.equal(isNowUnblocked({ status, unblocked_at: AT }), false, status);
  }
});

// ── Until I act (Brent 10/30: no limit) ───────────────────────────────────

const pilled = { status: "Planned", due_at: "2026-10-31T03:59:59.999Z", unblocked_at: AT };

await test("clear: start, finish, park, missed and re-hold clear it, with 067's reasons", () => {
  assert.equal(unblockPillClearReason(pilled, { status: "In Progress" }), "started");
  assert.equal(unblockPillClearReason(pilled, { status: "Done" }), "finished");
  assert.equal(unblockPillClearReason(pilled, { status: "Parked" }), "parked");
  assert.equal(unblockPillClearReason(pilled, { status: "Missed" }), "missed");
  assert.equal(unblockPillClearReason(pilled, { status: "Blocked/Waiting" }), "waiting");
});

await test("clear: a new due date (or clearing it) clears it; the same instant in another spelling does not", () => {
  assert.equal(unblockPillClearReason(pilled, { due_at: "2026-11-03T04:59:59.999Z" }), "redated");
  assert.equal(unblockPillClearReason(pilled, { due_at: null }), "redated");
  assert.equal(unblockPillClearReason(pilled, { due_at: "2026-10-30T23:59:59.999-04:00" }), null);
});

await test("clear: Backlog <-> Planned (Today's sync), other edits and time passing keep it", () => {
  assert.equal(unblockPillClearReason(pilled, { status: "Backlog" }), null);
  assert.equal(unblockPillClearReason({ ...pilled, status: "Backlog" }, { status: "Planned" }), null);
  assert.equal(unblockPillClearReason(pilled, { status: "Planned" }), null, "same status");
  assert.equal(unblockPillClearReason(pilled, {}), null);
  assert.equal(unblockPillClearReason(pilled, { title: "Renamed", tags: ["x"] }), null);
  // No timeout: a pill from weeks ago still shows (the model has no clock in it).
  assert.equal(isNowUnblocked({ status: "Planned", unblocked_at: "2026-09-01T12:00:00.000Z" }), true);
});

await test("clear: nothing to clear without a pill", () => {
  assert.equal(unblockPillClearReason({ ...pilled, unblocked_at: null }, { status: "Done" }), null);
});

await test("optimistic edits drop the pill exactly when the database will", () => {
  assert.equal(withUnblockPillRule(pilled, { status: "In Progress" }).unblocked_at, null);
  assert.equal(withUnblockPillRule(pilled, { status: "In Progress" }).status, "In Progress");
  assert.equal(withUnblockPillRule(pilled, { title: "x" }).unblocked_at, AT);
  assert.equal(withUnblockPillRule(pilled, { due_at: "2026-11-05T04:59:59.999Z" }).unblocked_at, null);
});

await test("the TS reasons match 067's check list, and every SQL clear path uses one of them", () => {
  const check = /cleared_reason IN \(([^)]*)\)/.exec(MIGRATION);
  assert.ok(check, "cleared_reason check");
  const sqlReasons = check[1].split(",").map((part) => part.trim().replace(/'/g, ""));
  assert.deepEqual(sqlReasons, [...UNBLOCK_CLEAR_REASONS]);
  // The pill trigger's status -> reason mapping is the TS one.
  const pairs = [...MIGRATION.matchAll(/NEW\.status::TEXT = '([^']+)' THEN\s+v_reason := '([a-z]+)'/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(pairs, [["In Progress", "started"], ["Done", "finished"], ["Parked", "parked"], ["Missed", "missed"], ["Blocked/Waiting", "waiting"]]);
  for (const [status, reason] of pairs) {
    assert.equal(unblockPillClearReason(pilled, { status }), reason);
  }
  assert.match(MIGRATION, /NEW\.due_at IS DISTINCT FROM OLD\.due_at THEN\s+v_reason := 'redated'/);
  for (const reason of [...MIGRATION.matchAll(/cleared_reason = '([a-z]+)'/g)].map((m) => m[1])) {
    assert.ok(UNBLOCK_CLEAR_REASONS.includes(reason), reason);
  }
});

// ── Landing day and "keep the later date" ─────────────────────────────────

await test("landing: today in ET on a weekday (late evening ET is still that day)", () => {
  assert.equal(unblockLandingDate(new Date("2026-10-30T13:40:00Z"), false), "2026-10-30");
  assert.equal(unblockLandingDate(new Date("2026-10-31T03:30:00Z"), false), "2026-10-30", "Fri 11:30 PM ET");
  assert.equal(unblockLandingDate(new Date("2026-10-30T03:30:00Z"), true), "2026-10-29", "Thu 11:30 PM ET");
});

await test("landing: work tasks finished on a weekend land Monday; personal ones stay on the day", () => {
  const saturday = new Date("2026-10-31T15:00:00Z");
  const sunday = new Date("2026-11-01T15:00:00Z");
  assert.equal(unblockLandingDate(saturday, false), "2026-11-02");
  assert.equal(unblockLandingDate(sunday, false), "2026-11-02");
  assert.equal(unblockLandingDate(saturday, true), "2026-10-31");
  assert.equal(unblockLandingDate(sunday, true), "2026-11-01");
});

await test("due: none or past moves to the end of the landing day; a later (or same-day) date is kept", () => {
  assert.equal(unblockDueAt(null, "2026-10-30"), buildRecurringDueAt("2026-10-30", "America/New_York"));
  assert.equal(unblockDueAt(null, "2026-10-30"), "2026-10-31T03:59:59.999Z");
  assert.equal(unblockDueAt("2026-10-27T21:00:00.000Z", "2026-10-30"), "2026-10-31T03:59:59.999Z", "Tue 10/27 is past");
  assert.equal(unblockDueAt("2026-10-30T13:00:00.000Z", "2026-10-30"), "2026-10-30T13:00:00.000Z", "today 9 AM: kept");
  assert.equal(unblockDueAt("2026-11-04T21:00:00.000Z", "2026-10-30"), "2026-11-04T21:00:00.000Z", "Wed 11/4: kept");
  // Across the DST change (11/1): Monday 11/2 ends at 04:59:59.999Z.
  assert.equal(unblockDueAt("2026-10-30T21:00:00.000Z", "2026-11-02"), "2026-11-03T04:59:59.999Z");
});

await test("067 writes the same end of day and the same weekend rule", () => {
  assert.match(MIGRATION, /p_day::TIMESTAMP \+ INTERVAL '23 hours 59 minutes 59\.999 seconds'\) AT TIME ZONE 'America\/New_York'/);
  assert.match(MIGRATION, /ISODOW FROM \(p_now AT TIME ZONE 'America\/New_York'\)::DATE\) = 6 THEN \(p_now AT TIME ZONE 'America\/New_York'\)::DATE \+ 2/);
  assert.match(MIGRATION, /ISODOW FROM \(p_now AT TIME ZONE 'America\/New_York'\)::DATE\) = 7 THEN \(p_now AT TIME ZONE 'America\/New_York'\)::DATE \+ 1/);
  assert.match(MIGRATION, /\(v_task\.due_at AT TIME ZONE 'America\/New_York'\)::DATE < v_landing/, "only an earlier ET day moves");
});

await test("067's priority adjustment uses priority.ts's numbers", () => {
  assert.equal(priority.calculateWaitingPenalty("Blocked/Waiting"), -20);
  assert.match(MIGRATION, /CASE WHEN v_status_changed THEN 20 ELSE 0 END/);
  const now = Date.now();
  assert.equal(priority.calculateDueProximityBoost(new Date(now + 23 * 3600e3).toISOString()), 25);
  assert.equal(priority.calculateDueProximityBoost(new Date(now - 5 * 3600e3).toISOString()), 25, "overdue counts as today");
  assert.equal(priority.calculateDueProximityBoost(new Date(now + 47 * 3600e3).toISOString()), 15);
  assert.equal(priority.calculateDueProximityBoost(new Date(now + 50 * 3600e3).toISOString()), 0);
  assert.equal(priority.calculateDueProximityBoost(null), 0);
  assert.match(MIGRATION, /p_due_at - p_now <= INTERVAL '24 hours' THEN 25/);
  assert.match(MIGRATION, /p_due_at - p_now <= INTERVAL '48 hours' THEN 15/);
});

// ── Words ─────────────────────────────────────────────────────────────────

await test("hover text: the time only, never a title", () => {
  assert.equal(nowUnblockedTitle(AT, NOW), "Everything it waited on is done (since 9:40 AM)");
  assert.equal(nowUnblockedTitle(AT, new Date("2026-11-02T15:00:00Z")), "Everything it waited on is done (since Fri 10/30, 9:40 AM)");
  assert.equal(nowUnblockedTitle(null, NOW), "Everything it waited on is done");
});

await test("067's comments name no titles (FamCal-safe) and match the plan's note", () => {
  const body = MIGRATION.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(body, /\btitle\b/i, "no title column is read anywhere in 067");
  assert.match(body, /'Now unblocked: everything it waited on is done\.'/);
  const texts = [...body.matchAll(/v_comment(?: \|\|)? ?:?= ?[^;]*;/g)].map((m) => m[0]);
  assert.ok(texts.length >= 6, "comment pieces found");
  for (const text of texts) {
    assert.doesNotMatch(text, /v_task\.(?!due_at)|bt\.|bc\.|NEW\.(?!id)/, `comment piece reads only this task's dates: ${text.slice(0, 80)}`);
  }
});

// ── 067 static checks ─────────────────────────────────────────────────────

/** The statements outside function bodies ($$ ... $$), comments stripped. */
function topLevelStatements(sql) {
  const outside = sql.replace(/\$\$[\s\S]*?\$\$/g, "$$BODY$$").replace(/--[^\n]*/g, "");
  return outside.split(";").map((part) => part.trim()).filter(Boolean);
}

await test("no backfill: 067 has no top-level INSERT/UPDATE/DELETE and adds the column with no default", () => {
  const statements = topLevelStatements(MIGRATION);
  for (const statement of statements) {
    assert.doesNotMatch(statement, /^(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/i, statement.slice(0, 80));
  }
  const add = statements.find((statement) => /ADD COLUMN IF NOT EXISTS unblocked_at/.test(statement));
  assert.ok(add);
  assert.equal(add.replace(/\s+/g, " "), "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS unblocked_at TIMESTAMPTZ");
  assert.match(MIGRATION, /NO BACKFILL/);
});

await test("no timeout: the pill has no time limit; reopen undo is 7 days", () => {
  const body = MIGRATION.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(body, /INTERVAL '(3|72) (days|hours)'/i);
  assert.match(body, /v_now - INTERVAL '7 days'/);
  assert.equal(UNBLOCK_UNDO_DAYS, 7);
});

await test("every plpgsql function is SECURITY INVOKER with search_path = public; triggers wired as planned", () => {
  const functions = [...MIGRATION.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(([\s\S]*?)\)\s*RETURNS[\s\S]*?AS \$\$/g)];
  assert.ok(functions.length >= 8);
  for (const fn of functions) {
    assert.match(fn[0], /SET search_path = public/, fn[1]);
    if (/LANGUAGE plpgsql/.test(fn[0])) assert.match(fn[0], /SECURITY INVOKER/, fn[1]);
    assert.doesNotMatch(fn[0], /SECURITY DEFINER/, fn[1]);
  }
  assert.match(MIGRATION, /CREATE TRIGGER trg_tasks_unblock_dependents\s+AFTER UPDATE OF status ON tasks/);
  assert.match(MIGRATION, /CREATE TRIGGER trg_commitments_unblock_dependents\s+AFTER UPDATE OF status ON commitments/);
  assert.match(MIGRATION, /CREATE TRIGGER trg_tasks_unblock_pill\s+BEFORE UPDATE ON tasks/);
  assert.match(MIGRATION, /CREATE TRIGGER trg_tasks_unblock_pill_insert\s+BEFORE INSERT ON tasks/);
  assert.match(MIGRATION, /CREATE TRIGGER trg_task_dependencies_unblock_reblock\s+AFTER INSERT OR UPDATE OF/);
  assert.match(MIGRATION, /REVOKE ALL ON FUNCTION clear_task_unblock\(UUID, UUID, TEXT\) FROM PUBLIC, anon/);
  assert.match(MIGRATION, /GRANT EXECUTE ON FUNCTION clear_task_unblock\(UUID, UUID, TEXT\) TO authenticated, service_role/);
  assert.match(MIGRATION, /GRANT SELECT, INSERT, UPDATE ON task_unblocks TO authenticated, service_role/);
  assert.match(MIGRATION, /ALTER TABLE task_unblocks ENABLE ROW LEVEL SECURITY/);
});

await test("the unblock locks each waiting task before re-reading its links, and a failure never blocks the Done", () => {
  const fn = /CREATE OR REPLACE FUNCTION task_unblock_on_status_change\(\)[\s\S]*?\n\$\$;/.exec(MIGRATION)[0];
  const lock = fn.indexOf("FOR NO KEY UPDATE");
  const recount = fn.indexOf("SELECT count(*) INTO v_open_blockers");
  assert.ok(lock > 0 && recount > lock, "lock, then count the other links");
  assert.match(fn, /EXCEPTION WHEN OTHERS THEN\s+--[^\n]*\n[^\n]*\n\s+RAISE WARNING/);
  assert.match(fn, /SET lock_timeout = '5s'/);
  // Status rule (Brent: "Pill, but stay Waiting"): only an empty waiting_on or 'prerequisite' moves it.
  assert.match(fn, /NULLIF\(btrim\(COALESCE\(v_task\.waiting_on, ''\)\), ''\) IS NULL\s+OR v_task\.blocked_reason::TEXT IS NOT DISTINCT FROM 'prerequisite'/);
  // Recurring: pill only.
  assert.match(fn, /IF NOT v_recurring THEN/);
  // Reopen: a closed task is guarded before any compare-and-set write.
  const guard = fn.indexOf("v_task.status::TEXT NOT IN ('Backlog', 'Planned', 'In Progress', 'Blocked/Waiting') THEN\n          UPDATE public.task_unblocks");
  const compare = fn.indexOf("v_status_back := v_row.status_changed");
  assert.ok(guard > 0 && compare > guard, "closed-task guard before the compare-and-set");
  // Resolved = Done, exactly as isDependencyResolved.
  assert.match(fn, /COALESCE\(bt\.status::TEXT, bc\.status::TEXT, ''\) <> 'Done'/);
});

await test("rollback drops every function, trigger, table and column 067 creates", () => {
  const created = [
    ...[...MIGRATION.matchAll(/CREATE OR REPLACE FUNCTION (\w+)/g)].map((m) => `FUNCTION IF EXISTS ${m[1]}(`),
    ...[...MIGRATION.matchAll(/CREATE TRIGGER (\w+)/g)].map((m) => `TRIGGER IF EXISTS ${m[1]} `),
    "TABLE IF EXISTS task_unblocks",
    "DROP COLUMN IF EXISTS unblocked_at",
  ];
  for (const item of created) assert.ok(ROLLBACK.includes(item), `rollback lacks ${item}`);
  for (const statement of topLevelStatements(ROLLBACK)) {
    assert.doesNotMatch(statement, /^(INSERT|UPDATE|DELETE)\b/i, "the rollback rewrites no task data");
  }
});

// ── Intelligence layer feed (fake client) ─────────────────────────────────

function fakeClient(tables) {
  const calls = [];
  return {
    calls,
    from(table) {
      const filters = [];
      const query = {
        select() { return query; },
        eq(column, value) { filters.push(["eq", column, value]); return query; },
        in(column, values) { filters.push(["in", column, values]); return query; },
        is(column, value) { filters.push(["is", column, value]); return query; },
        gte(column, value) { filters.push(["gte", column, value]); return query; },
        order() { return query; },
        limit() { return query; },
        then(resolve) {
          calls.push({ table, filters });
          let rows = tables[table] ?? [];
          for (const [op, column, value] of filters) {
            if (op === "eq") rows = rows.filter((row) => row[column] === value);
            if (op === "in") rows = rows.filter((row) => value.includes(row[column]));
            if (op === "is") rows = rows.filter((row) => row[column] === value);
            if (op === "gte") rows = rows.filter((row) => row[column] >= value);
          }
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
      return query;
    },
  };
}

await test("detector feed: recent, not reverted unblocks become resolved-dependency summaries", async () => {
  const user = "u1";
  const client = fakeClient({
    task_unblocks: [
      { id: "ub1", user_id: user, task_id: "w1", blocker_type: "task", blocker_task_id: "b1", blocker_commitment_id: null, unblocked_at: "2026-10-30T13:40:00.000Z", created_at: "2026-10-30T13:40:00.000Z", reverted_at: null },
      { id: "ub2", user_id: user, task_id: "w2", blocker_type: "commitment", blocker_task_id: null, blocker_commitment_id: "c1", unblocked_at: "2026-10-30T14:00:00.000Z", created_at: "2026-10-30T14:00:00.000Z", reverted_at: null },
      { id: "old", user_id: user, task_id: "w1", blocker_type: "task", blocker_task_id: "b1", blocker_commitment_id: null, unblocked_at: "2026-10-01T00:00:00.000Z", created_at: "2026-10-01T00:00:00.000Z", reverted_at: null },
      { id: "rev", user_id: user, task_id: "w1", blocker_type: "task", blocker_task_id: "b1", blocker_commitment_id: null, unblocked_at: "2026-10-30T12:00:00.000Z", created_at: "2026-10-30T12:00:00.000Z", reverted_at: "2026-10-30T12:30:00.000Z" },
      { id: "other", user_id: "u2", task_id: "w1", blocker_type: "task", blocker_task_id: "b1", blocker_commitment_id: null, unblocked_at: "2026-10-30T13:00:00.000Z", created_at: "2026-10-30T13:00:00.000Z", reverted_at: null },
    ],
    tasks: [{ id: "b1", user_id: user, title: "Get sign-off", status: "Done" }],
    commitments: [{ id: "c1", user_id: user, title: "Send the contract", status: "Done" }],
  });
  const map = await fetchRecentUnblockDependencySummaries(client, user, ["w1", "w2", "w1"], "2026-10-27T15:00:00.000Z");
  assert.deepEqual([...map.keys()].sort(), ["w1", "w2"]);
  assert.deepEqual(map.get("w1").map((row) => row.id), ["ub1"]);
  assert.deepEqual(
    { ...map.get("w2")[0] },
    { id: "ub2", task_id: "w2", depends_on_task_id: null, depends_on_commitment_id: "c1", type: "commitment", title: "Send the contract", status: "Done", resolved_at: "2026-10-30T14:00:00.000Z", created_at: "2026-10-30T14:00:00.000Z" }
  );
  assert.equal(map.get("w1")[0].title, "Get sign-off");
  for (const call of client.calls) {
    assert.ok(call.filters.some(([op, column, value]) => op === "eq" && column === "user_id" && value === user), `${call.table} filtered by user`);
  }
  const empty = await fetchRecentUnblockDependencySummaries(client, user, [], "2026-10-27T15:00:00.000Z");
  assert.equal(empty.size, 0);
});

await test("detector feed: merged with removed links, newest first", () => {
  const a = new Map([["w1", [{ id: "d1", resolved_at: "2026-10-29T10:00:00.000Z" }]]]);
  const b = new Map([["w1", [{ id: "ub1", resolved_at: "2026-10-30T10:00:00.000Z" }]], ["w2", [{ id: "ub2", resolved_at: "2026-10-30T11:00:00.000Z" }]]]);
  const merged = mergeResolvedDependencyMaps(a, b);
  assert.deepEqual(merged.get("w1").map((row) => row.id), ["ub1", "d1"]);
  assert.deepEqual(merged.get("w2").map((row) => row.id), ["ub2"]);
});

await test("the intelligence context reads both sources", () => {
  const context = readFileSync(path.join(ROOT, "src/lib/intelligence-layer/context.ts"), "utf8");
  assert.match(context, /fetchRecentUnblockDependencySummaries\(supabase, userId, taskIds, windowStartIso\)/);
  assert.match(context, /mergeResolvedDependencyMaps\(removed, finished\)/);
});

// ── The pill on every surface ─────────────────────────────────────────────

const noop = () => {};
const task = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Send revised timeline",
  tags: [],
  status: "Planned",
  due_at: "2026-10-31T03:59:59.999Z",
  start_at: null,
  updated_at: "2026-10-30T13:40:00.000Z",
  unblocked_at: AT,
  dependency_blocked: false,
  implementation: { name: "Project Alpha" },
  project: null,
};
const PILL = new RegExp(`data-now-unblocked=""[^>]*>[\\s\\S]*?${NOW_UNBLOCKED_LABEL}</span>`);

await test("Now card: the green pill with its hover text; none without unblocked_at", () => {
  const html = renderToStaticMarkup(h(NowTaskCard, { task, nowMs: NOW.getTime(), completing: false, onOpen: noop, onDone: noop }));
  assert.match(html, PILL);
  assert.match(html, /border-success-border bg-success-soft text-success/);
  assert.match(html, /title="Everything it waited on is done \(since/);
  const plain = renderToStaticMarkup(h(NowTaskCard, { task: { ...task, unblocked_at: null }, nowMs: NOW.getTime(), completing: false, onOpen: noop, onDone: noop }));
  assert.doesNotMatch(plain, /Now unblocked/);
  const done = renderToStaticMarkup(h(NowTaskCard, { task: { ...task, status: "Done" }, nowMs: NOW.getTime(), completing: false, onOpen: noop, onDone: noop }));
  assert.doesNotMatch(done, /Now unblocked/);
});

await test("week board card and task card: the pill beside the state badge", () => {
  const data = {
    id: task.id, title: task.title, estimatedMinutes: 30, dueAt: task.due_at, status: "Blocked/Waiting", blocker: false, pinned: false,
    tags: [], dependencyBlocked: false, updatedAt: task.updated_at, unblockedAt: AT,
    range: null, priorityScore: 50, projectName: null, waitingOn: "Legal", followUpAt: null, isPersonal: false, needsReview: false,
  };
  const props = { completing: false, pinning: false, moving: false, dragging: false, onOpen: noop, onDone: noop, onTogglePinned: noop, onDragStart: noop, onDragEnd: noop };
  const board = renderToStaticMarkup(h(WeeklyTaskCard, { ...props, task: data }));
  assert.match(board, /Waiting<\/span>/, "stays Waiting (also waiting on something else)");
  assert.match(board, PILL);
  assert.doesNotMatch(renderToStaticMarkup(h(WeeklyTaskCard, { ...props, task: { ...data, unblockedAt: null } })), /Now unblocked/);
  const card = renderToStaticMarkup(h(TaskCard, { task: data }));
  assert.match(card, PILL);
});

await test("task grid and task page carry the pill", () => {
  const grid = readFileSync(path.join(ROOT, "src/components/tasks/TaskGrid.tsx"), "utf8");
  assert.match(grid, /<NowUnblockedPill task=\{task\}/);
  assert.match(grid, /withUnblockPillRule\(task, updates/);
  const base = { id: "t", title: "T", status: "Planned", owner: "brent", owner_label: null, status_line: null, due_at: null, waiting_on: null, follow_up_at: null, description: null, tags: [], app: null, project: null, section: null };
  const view = taskPage.buildTaskPageView({ task: { ...base, unblocked_at: AT }, checklist: [], comments: [], blockers: [], now: NOW });
  assert.equal(view.nowUnblocked, true);
  assert.equal(view.nowUnblockedTitle, "Everything it waited on is done (since 9:40 AM)");
  const none = taskPage.buildTaskPageView({ task: base, checklist: [], comments: [], blockers: [], now: NOW });
  assert.equal(none.nowUnblocked, false);
  assert.equal(none.nowUnblockedTitle, null);
  const page = readFileSync(path.join(ROOT, "src/components/portfolio/TaskRecordPage.tsx"), "utf8");
  assert.match(page, /view\.nowUnblocked \?/);
  const query = readFileSync(path.join(ROOT, "src/lib/task-page-queries.ts"), "utf8");
  assert.match(query, /due_at, unblocked_at, waiting_on/);
});

console.log(`\n${passed} passed${failed.length ? `, ${failed.length} failed` : ""}`);
if (failed.length) process.exit(1);
