// Speed check fixes 1 + 2 (Baseline task 7b92254a): the Backlog loader and the
// brief reads. Offline: no database, no network, no browser.
//
//   npm run test:backlog-speed
//
// 1. Pure loader rules (src/lib/backlog/task-loader.ts): Missed excluded by
//    default and fetched on demand, pages in parallel waves, unchanged rows
//    kept, the refresh gate (no reload while hidden or while one is running).
// 2. BacklogList wiring (source checks: no timer, no unconditional Missed).
// 3. Call counts: the real GET /api/tasks handler on an in-memory Supabase,
//    the base code's loop (copied from BacklogList.tsx at 0194521) against the
//    new loader. Same rows in every view; fewer requests, DB calls and bytes.
// 4. Requests per minute with the tab hidden (before: the 15 s timer).
// 5. Brief reads (src/lib/briefs/service.ts): getBrief and the layout's
//    getTodayBriefStatus with one request fewer each, same output.
//
// The script prints the before/after numbers it measured (SPEED lines).

import assert from "node:assert/strict";
import fs from "node:fs";

const API_USER_ID = "00000000-0000-4000-8000-000000000001";
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.MISSION_CONTROL_API_KEY = "test-legacy-key-aaaaaaaaaaaaaaaa";
process.env.MISSION_CONTROL_USER_ID = API_USER_ID;
process.env.DEPLOYMENT_ROLE = "main";

const missing = (error) => ({ missing: error.message });
const loader = await import("../src/lib/backlog/task-loader.ts").catch(missing);
const { NextRequest } = await import("next/server");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const tasksRoute = await import("../src/app/api/tasks/route.ts");
const briefService = await import("../src/lib/briefs/service.ts");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}\n    ${String(error?.stack ?? error?.message ?? error).split("\n").slice(0, 6).join("\n    ")}`);
  }
}
function need(name) {
  if (loader.missing) throw new Error(`src/lib/backlog/task-loader.ts is missing: ${loader.missing}`);
  assert.equal(typeof loader[name], "function", `${name} is not exported`);
  return loader[name];
}
const SPEED = [];
const speed = (line) => {
  SPEED.push(line);
};

// ── 1. Pure loader rules ───────────────────────────────────────────────────
await test("Missed is excluded by default and only included for the Missed filter", () => {
  const backlogNeedsMissed = need("backlogNeedsMissed");
  for (const status of ["All", "Backlog", "Planned", "In Progress", "Blocked/Waiting", "Parked", "Done"]) {
    assert.equal(backlogNeedsMissed(status), false, status);
  }
  assert.equal(backlogNeedsMissed("Missed"), true);

  const params = need("backlogTaskPageParams");
  assert.deepEqual(params({ includeCompleted: false, missed: "exclude" }, 0, 200), {
    include_done: "false", include_parked: "true", include_missed: "false", limit: "200", offset: "0",
  });
  assert.equal(params({ includeCompleted: true, missed: "exclude" }, 400, 200).include_done, "true");
  assert.equal(params({ includeCompleted: false, missed: "include" }, 0, 200).include_missed, "true");
  assert.deepEqual(params({ includeCompleted: false, missed: "only" }, 200, 200), { status: "Missed", limit: "200", offset: "200" });
});

function pagedSource(total, { delayMs = 0 } = {}) {
  const rows = Array.from({ length: total }, (_, index) => ({ id: `t${String(index).padStart(5, "0")}`, status: "Backlog" }));
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchPage = async (params) => {
    calls.push(params);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    inFlight -= 1;
    const offset = Number(params.offset);
    return rows.slice(offset, offset + Number(params.limit));
  };
  return { rows, calls, fetchPage, max: () => maxInFlight };
}

await test("pages: every row once, in order, fetched in parallel waves", async () => {
  const fetchAll = need("fetchAllBacklogTaskPages");
  for (const total of [0, 1, 199, 200, 201, 799, 800, 801, 1650]) {
    const source = pagedSource(total, { delayMs: 1 });
    const got = await fetchAll(source.fetchPage, { includeCompleted: false, missed: "exclude" }, { pageSize: 200, wave: 4 });
    assert.deepEqual(got.map((row) => row.id), source.rows.map((row) => row.id), `total ${total}`);
    assert.equal(source.calls.length, (Math.floor(total / 800) + 1) * 4, `requests for ${total}`);
    assert.equal(source.max(), 4, `parallel requests for ${total}`);
    assert.ok(source.calls.every((call) => call.include_missed === "false"));
  }
});

await test("pages: a row repeated across a page boundary (edit mid-load) is kept once", async () => {
  const fetchAll = need("fetchAllBacklogTaskPages");
  const fetchPage = async ({ offset }) =>
    offset === "0" ? [{ id: "a" }, { id: "b" }] : offset === "2" ? [{ id: "b" }] : [];
  const got = await fetchAll(fetchPage, { includeCompleted: false, missed: "exclude" }, { pageSize: 2, wave: 2 });
  assert.deepEqual(got.map((row) => row.id), ["a", "b"]);
});

await test("withMissedRows swaps in the fetched Missed rows and keeps the rest", () => {
  const withMissedRows = need("withMissedRows");
  const current = [{ id: "1", status: "Backlog" }, { id: "2", status: "Missed" }, { id: "3", status: "Planned" }];
  const missed = [{ id: "4", status: "Missed" }, { id: "3", status: "Missed" }];
  assert.deepEqual(withMissedRows(current, missed), [{ id: "1", status: "Backlog" }, ...missed]);
});

await test("reuseUnchangedRows: nothing changed → the same array (no re-render); one change → only that row is new", () => {
  const reuse = need("reuseUnchangedRows");
  const previous = [{ id: "a", title: "A", n: 1 }, { id: "b", title: "B", n: 2 }];
  const same = JSON.parse(JSON.stringify(previous));
  assert.equal(reuse(previous, same), previous);

  const edited = JSON.parse(JSON.stringify(previous));
  edited[1].title = "B2";
  const merged = reuse(previous, edited);
  assert.notEqual(merged, previous);
  assert.equal(merged[0], previous[0]);
  assert.equal(merged[1], edited[1]);

  const reordered = [same[1], same[0]];
  const moved = reuse(previous, reordered);
  assert.notEqual(moved, previous);
  assert.deepEqual(moved.map((row) => row.id), ["b", "a"]);
  assert.equal(reuse(previous, [same[0]]).length, 1);
});

function fakePage(initial = "visible") {
  const doc = new EventTarget();
  doc.visibilityState = initial;
  const win = new EventTarget();
  return {
    doc,
    win,
    hide() {
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
      win.dispatchEvent(new Event("blur"));
    },
    show() {
      doc.visibilityState = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
      win.dispatchEvent(new Event("focus"));
    },
    focus() {
      win.dispatchEvent(new Event("focus"));
    },
  };
}

/** The same wiring BacklogList uses: listeners → gate → tracked refresh. */
function wireRefresh(page, clock, refreshMs = 50) {
  const gate = need("createRefreshGate")({ isHidden: () => page.doc.visibilityState === "hidden", now: () => clock.now, minGapMs: 2000 });
  const started = [];
  const decisions = [];
  let release = [];
  const detach = need("attachRefreshOnReturn")(page.doc, page.win, () => {
    const decision = gate.decide();
    decisions.push(decision);
    if (decision !== "go") return;
    started.push(clock.now);
    void gate.track(new Promise((resolve) => release.push(resolve)));
  });
  return {
    gate, started, decisions, detach,
    async settle() {
      const pending = release;
      release = [];
      pending.forEach((resolve) => resolve());
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    refreshMs,
  };
}

await test("refresh gate: no reload while hidden, none while one is running, one per return", async () => {
  const clock = { now: 100_000 };
  const page = fakePage();
  const wired = wireRefresh(page, clock);

  // Coming back fires visibilitychange AND focus: one reload, the second is dropped as in flight.
  page.hide();
  clock.now += 30_000;
  page.show();
  assert.equal(wired.started.length, 1);
  assert.deepEqual(wired.decisions, ["go", "in_flight"]);

  // More focus events while it runs: still one.
  page.focus();
  page.focus();
  assert.equal(wired.started.length, 1);
  assert.equal(wired.gate.inFlight, true);
  await wired.settle();
  assert.equal(wired.gate.inFlight, false);

  // Right after it finished: too soon.
  page.focus();
  assert.equal(wired.decisions.at(-1), "too_soon");
  clock.now += 2_500;
  page.focus();
  assert.equal(wired.started.length, 2);
  await wired.settle();

  // A focus event while hidden (some browsers) never reloads.
  page.hide();
  page.focus();
  assert.equal(wired.decisions.at(-1), "hidden");
  assert.equal(wired.started.length, 2);

  // A user-driven load (filter change) counts as in flight too.
  page.show();
  await wired.settle();
  clock.now += 5_000;
  let finishLoad;
  void wired.gate.track(new Promise((resolve) => (finishLoad = resolve)));
  page.focus();
  assert.equal(wired.decisions.at(-1), "in_flight");
  finishLoad();
  wired.detach();
});

await test("hidden tab for 60 s: 0 reloads (before: 4 timer reloads)", async () => {
  const clock = { now: 0 };
  const page = fakePage();
  const wired = wireRefresh(page, clock);
  page.hide();
  for (let second = 0; second < 60; second += 1) {
    clock.now += 1000;
    if (second % 15 === 0) page.focus(); // stray focus events while hidden
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(wired.started.length, 0);
  // Visible and untouched for 60 s: also 0 (no timer at all).
  page.doc.visibilityState = "visible";
  for (let second = 0; second < 60; second += 1) clock.now += 1000;
  assert.equal(wired.started.length, 0);
  wired.detach();
});

// ── 2. BacklogList wiring ──────────────────────────────────────────────────
await test("BacklogList: no timer, no unconditional Missed, loader + gate wired, sprints fetched once", () => {
  const list = fs.readFileSync(new URL("../src/components/backlog/BacklogList.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(list, /setInterval\(/, "the 15 s reload timer is still there");
  assert.doesNotMatch(list, /include_missed:\s*"true"/, "Missed is still always fetched");
  assert.match(list, /fetchAllBacklogTaskPages\(fetchTaskPage,/);
  assert.match(list, /missed: includeMissed \? "include" : "exclude"/);
  assert.match(list, /missed: "only"/);
  assert.match(list, /attachRefreshOnReturn\(document, window,/);
  assert.match(list, /refreshGate\.decide\(\) === "go"/);
  assert.match(list, /refreshGate\.track\(loadData\(\)\)/);
  assert.match(list, /reuseUnchangedRows\(current, taskData\)/);
  assert.match(list, /sprints=\{sprints\}/);
  const grid = fs.readFileSync(new URL("../src/components/tasks/TaskGrid.tsx", import.meta.url), "utf8");
  assert.match(grid, /useSprints\(\{ skip: sprintsFromParent !== undefined \}\)/);
});

// ── 3. Call counts on the real /api/tasks handler ──────────────────────────
const id = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
function seedTasks() {
  const tasks = [];
  const add = (count, status) => {
    for (let index = 0; index < count; index += 1) {
      const n = tasks.length + 1;
      tasks.push({
        id: id(n), user_id: API_USER_ID, title: `Task ${n}`, description: `About task ${n}`, status, tags: ["work"],
        due_at: null, start_at: null, follow_up_at: null, project_id: null, implementation_id: null, sprint_id: null, section_id: null,
        base_priority: (n * 37) % 100, priority_score: (n * 37) % 100, needs_review: false, owner: "agent",
        stakeholder_mentions: [], recurrence: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
      });
    }
  };
  // A plausible Backlog: open work, Parked, a pile of Missed recurring copies, history.
  add(450, "Backlog"); add(120, "Planned"); add(30, "In Progress"); add(20, "Blocked/Waiting");
  add(60, "Parked"); add(400, "Missed"); add(300, "Done");
  const deps = Array.from({ length: 40 }, (_, index) => ({
    id: `dep-${String(index).padStart(3, "0")}`, user_id: API_USER_ID, task_id: id(index * 3 + 2), depends_on_task_id: id(index * 3 + 1),
    depends_on_commitment_id: null, is_resolved: false, resolved_at: null, created_at: "2026-10-01T00:00:00Z",
  }));
  return { tasks, task_dependencies: deps, commitments: [] };
}

/** Generic in-memory PostgREST stand-in; every awaited query is one DB round trip (logged). */
function makeDb(state, { latencyMs = 0 } = {}) {
  const log = [];
  function run(table, ops) {
    const op = (name) => ops.find(([n]) => n === name);
    const mode = op("maybeSingle") ? "maybeSingle" : op("single") ? "single" : "many";
    const matches = (row) => ops.every(([name, args]) => {
      if (name === "eq") return row[args[0]] === args[1];
      if (name === "neq") return row[args[0]] !== args[1];
      if (name === "in") return args[1].includes(row[args[0]]);
      if (name === "gt") return String(row[args[0]]) > String(args[1]);
      if (name === "not" && args[1] === "is") return row[args[0]] !== args[2];
      if (name === "contains") return args[1].every((tag) => (row[args[0]] || []).includes(tag));
      return true;
    });
    let rows = (state[table] || []).filter(matches);
    const orders = ops.filter(([name]) => name === "order").map(([, args]) => args);
    rows = [...rows].sort((a, b) => {
      for (const [column, options = {}] of orders) {
        const dir = options.ascending === false ? -1 : 1;
        if (a[column] < b[column]) return -dir;
        if (a[column] > b[column]) return dir;
      }
      return 0;
    });
    const range = op("range")?.[1];
    if (range) rows = rows.slice(range[0], range[1] + 1);
    const limit = op("limit")?.[1][0];
    if (typeof limit === "number") rows = rows.slice(0, limit);
    rows = rows.slice(0, 1000).map((row) => (table === "tasks" ? { ...row, project: null, implementation: null, sprint: null, section: null } : { ...row }));
    if (mode === "many") return { data: rows, error: null };
    return { data: rows[0] ?? null, error: null };
  }
  const client = {
    from(table) {
      const ops = [];
      const proxy = new Proxy({}, {
        get(_target, prop) {
          if (prop === "then") {
            log.push({ table, ops });
            const result = run(table, ops);
            return (resolve, reject) =>
              new Promise((done) => setTimeout(done, latencyMs)).then(() => result).then(resolve, reject);
          }
          return (...args) => {
            ops.push([prop, args]);
            return proxy;
          };
        },
      });
      return proxy;
    },
  };
  return { client, log };
}

/**
 * The browser side: one GET /api/tasks per call, through the real handler.
 * `authMs` models requireAuthenticatedRoute's supabase.auth.getUser() trip,
 * which the internal auth context used here skips.
 */
function apiClient(db, { authMs = 0 } = {}) {
  const stats = { requests: 0, bytes: 0, maxInFlight: 0 };
  let inFlight = 0;
  const fetchPage = async (params) => {
    stats.requests += 1;
    inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, authMs));
    const request = writeInternalAuthContext(new NextRequest(`http://localhost/api/tasks?${new URLSearchParams(params)}`), {
      supabase: db.client, user: { id: API_USER_ID }, userId: API_USER_ID, authSource: "session",
    });
    const response = await tasksRoute.GET(request);
    const text = await response.text();
    inFlight -= 1;
    assert.equal(response.status, 200, text.slice(0, 200));
    stats.bytes += text.length;
    return JSON.parse(text);
  };
  return { fetchPage, stats };
}

/** BacklogList.tsx at 0194521, fetchAllTaskPages (verbatim logic): sequential, always Missed. */
async function baseFetchAllTaskPages(fetchTaskPage, includeCompleted) {
  const allTasks = [];
  let offset = 0;
  while (true) {
    const page = await fetchTaskPage({
      include_done: includeCompleted ? "true" : "false",
      include_parked: "true",
      include_missed: "true",
      limit: String(200),
      offset: String(offset),
    });
    allTasks.push(...page);
    if (page.length < 200) break;
    offset += 200;
  }
  return allTasks;
}

/** BacklogList's status filter (unchanged): "All" hides Missed; any other value is exact. */
function visible(tasks, statusFilter) {
  return tasks
    .filter((task) => !(statusFilter === "All" && task.status === "Missed"))
    .filter((task) => statusFilter === "All" || task.status === statusFilter)
    .map((task) => task.id)
    .sort();
}

async function measure(label, run, { latencyMs = 0, authMs = 0 } = {}) {
  const db = makeDb(seedTasks(), { latencyMs });
  const api = apiClient(db, { authMs });
  const started = performance.now();
  const rows = await run(api.fetchPage);
  const ms = Math.round(performance.now() - started);
  return { label, rows, requests: api.stats.requests, dbCalls: db.log.length, authCalls: api.stats.requests, bytes: api.stats.bytes, parallel: api.stats.maxInFlight, ms };
}

const describe = (m) =>
  `${m.label}: ${m.requests} /api/tasks requests (${m.parallel} at a time), ${m.authCalls} auth + ${m.dbCalls} DB calls, ${(m.bytes / 1024).toFixed(0)} KB, ${m.rows.length} rows`;

let defaultBefore;
let defaultAfter;
await test("default view: same visible rows, Missed not downloaded, fewer calls and bytes", async () => {
  const fetchAll = need("fetchAllBacklogTaskPages");
  defaultBefore = await measure("before", (fetchPage) => baseFetchAllTaskPages(fetchPage, false));
  defaultAfter = await measure("after", (fetchPage) => fetchAll(fetchPage, { includeCompleted: false, missed: "exclude" }));
  for (const status of ["All", "Backlog", "Planned", "In Progress", "Blocked/Waiting", "Parked", "Done"]) {
    assert.deepEqual(visible(defaultAfter.rows, status), visible(defaultBefore.rows, status), `visible rows for ${status}`);
  }
  assert.equal(defaultAfter.rows.filter((task) => task.status === "Missed").length, 0);
  assert.equal(defaultBefore.rows.filter((task) => task.status === "Missed").length, 400);
  assert.ok(defaultAfter.dbCalls < defaultBefore.dbCalls, `${defaultAfter.dbCalls} DB calls vs ${defaultBefore.dbCalls}`);
  assert.ok(defaultAfter.bytes < defaultBefore.bytes * 0.7);
  assert.equal(defaultBefore.parallel, 1);
  speed(`Backlog open (default view), ${describe(defaultBefore)}`);
  speed(`Backlog open (default view), ${describe(defaultAfter)}`);
});

await test("Missed filter: fetched on demand, the same Missed rows as before", async () => {
  const fetchAll = need("fetchAllBacklogTaskPages");
  const withMissedRows = need("withMissedRows");
  const missed = await measure("after (on demand)", (fetchPage) => fetchAll(fetchPage, { includeCompleted: false, missed: "only" }));
  assert.ok(missed.rows.every((task) => task.status === "Missed"));
  const merged = withMissedRows(defaultAfter.rows, missed.rows);
  assert.deepEqual(visible(merged, "Missed"), visible(defaultBefore.rows, "Missed"));
  assert.deepEqual(visible(merged, "All"), visible(defaultBefore.rows, "All"));
  speed(`Switch Status to Missed, ${describe(missed)} (before: 0 extra, already downloaded on every open)`);

  // A reload while the Missed filter is on includes them, like before.
  const withMissed = await measure("after (Missed filter on)", (fetchPage) => fetchAll(fetchPage, { includeCompleted: false, missed: "include" }));
  assert.deepEqual(visible(withMissed.rows, "Missed"), visible(defaultBefore.rows, "Missed"));
});

await test("Include completed: same rows as before", async () => {
  const fetchAll = need("fetchAllBacklogTaskPages");
  const before = await measure("before", (fetchPage) => baseFetchAllTaskPages(fetchPage, true));
  const after = await measure("after", (fetchPage) => fetchAll(fetchPage, { includeCompleted: true, missed: "exclude" }));
  for (const status of ["All", "Done", "Backlog", "Parked"]) {
    assert.deepEqual(visible(after.rows, status), visible(before.rows, status), status);
  }
  speed(`Backlog with completed, ${describe(before)}`);
  speed(`Backlog with completed, ${describe(after)}`);
});

await test("wall clock with a simulated 70 ms cross-country trip per call (Virginia → Oregon)", async () => {
  const fetchAll = need("fetchAllBacklogTaskPages");
  const options = { latencyMs: 70, authMs: 70 };
  const before = await measure("before", (fetchPage) => baseFetchAllTaskPages(fetchPage, false), options);
  const after = await measure("after", (fetchPage) => fetchAll(fetchPage, { includeCompleted: false, missed: "exclude" }), options);
  assert.ok(after.ms < before.ms / 2, `${after.ms} ms vs ${before.ms} ms`);
  speed(`Backlog open at 70 ms per trip: before ~${before.ms} ms, after ~${after.ms} ms (task requests only; applications/projects/commitments/sprints run alongside)`);
  const near = { latencyMs: 3, authMs: 3 };
  const afterNear = await measure("after", (fetchPage) => fetchAll(fetchPage, { includeCompleted: false, missed: "exclude" }), near);
  speed(`Backlog open at 3 ms per trip (functions next to the database): after ~${afterNear.ms} ms`);
});

await test("requests per minute with the tab hidden: before 4 reloads × pages, after 0", () => {
  // Base: setInterval(15000) re-ran fetchAllTaskPages + commitments with no visibility check.
  const perReload = defaultBefore.requests + 1; // task pages + /api/commitments
  speed(`Hidden tab, per minute: before ${4 * perReload} requests (4 reloads × ${defaultBefore.requests} task pages + 1 commitments), after 0`);
  assert.equal(4 * perReload, 4 * (Math.ceil(1080 / 200) + 1)); // 1,080 non-Done rows → 6 pages incl. the short one
});

// ── 5. Brief reads ─────────────────────────────────────────────────────────
const BRIEF_ID = "b0000000-0000-4000-8000-000000000001";
const TASK_A = id(9001);
const TASK_B = id(9002);
function briefState() {
  const item = (n, extra = {}) => ({
    id: `i${n}`, user_id: API_USER_ID, brief_id: BRIEF_ID, n, item_key: `k${n}`, kind: "carry_over",
    payload: { title: `Item ${n}` }, task_ids: [TASK_A], source: { meetings: [] }, state: n === 2 ? "accepted" : "open",
    dismissed_reason: null, dismissed_note: null, choice: null, created_task_id: n === 2 ? TASK_B : null, prior_due: null,
    acted_at: null, created_at: "2026-10-28T20:15:00Z", updated_at: "2026-10-28T20:15:00Z", ...extra,
  });
  return {
    brief: {
      id: BRIEF_ID, user_id: API_USER_ID, edition: "eod", brief_date: "2026-10-28", code: "EOD-1028",
      content: { tiles: [], meetings: [] }, covered_meeting_ids: [], notified_at: null, notify_sent_at: null, notify_error: null,
      created_at: "2026-10-28T20:15:00Z", updated_at: "2026-10-28T20:15:00Z",
    },
    items: [item(3), item(1), item(2)],
    tasks: [
      { id: TASK_A, user_id: API_USER_ID, title: "A", status: "Planned", due_at: null, owner: "brent" },
      { id: TASK_B, user_id: API_USER_ID, title: "B", status: "Backlog", due_at: null, owner: "agent" },
    ],
  };
}

/** Answers briefs (with an embedded brief_items select), brief_items and tasks; logs each request. */
function briefDb(world) {
  const log = [];
  return {
    log,
    client: {
      from(table) {
        const ops = [];
        const entry = { table, ops };
        const proxy = new Proxy({}, {
          get(_target, prop) {
            if (prop === "then" || prop === "maybeSingle") {
              log.push(entry);
              const result = answer(table, ops);
              if (prop === "maybeSingle") {
                return () => Promise.resolve({ data: result.data[0] ?? null, error: null });
              }
              return (resolve, reject) => Promise.resolve(result).then(resolve, reject);
            }
            return (...args) => {
              ops.push([prop, args]);
              return proxy;
            };
          },
        });
        return proxy;
      },
    },
  };
  function answer(table, ops) {
    const top = ops.filter(([name, args]) => name === "eq" && !String(args[0]).includes("."));
    const nested = ops.filter(([name, args]) => name === "eq" && String(args[0]).includes("."));
    const keep = (row, filters, prefix = "") => filters.every(([, [column, value]]) => row[column.slice(prefix.length)] === value);
    if (table === "briefs") {
      const select = ops.find(([name]) => name === "select")[1][0];
      const rows = [world.brief].filter((row) => keep(row, top));
      return {
        data: rows.map((row) => {
          const columns = select.replace(/,?\s*brief_items\([^)]*\)/, "").split(",").map((column) => column.trim());
          const out = Object.fromEntries(columns.map((column) => [column, row[column]]));
          const embed = select.match(/brief_items\(([^)]*)\)/);
          if (embed) {
            const itemColumns = embed[1].split(",").map((column) => column.trim());
            const ordered = ops.some(([name, args]) => name === "order" && args[1]?.referencedTable === "brief_items");
            let items = world.items.filter((item) => item.brief_id === row.id && keep(item, nested, "brief_items."));
            if (ordered) items = [...items].sort((a, b) => a.n - b.n);
            out.brief_items = items.map((item) => Object.fromEntries(itemColumns.map((column) => [column, item[column]])));
          }
          return out;
        }),
        error: null,
      };
    }
    if (table === "brief_items") {
      const items = world.items.filter((item) => keep(item, top)).sort((a, b) => a.n - b.n);
      return { data: items, error: null };
    }
    if (table === "tasks") {
      const ids = ops.find(([name]) => name === "in")[1][1];
      return { data: world.tasks.filter((task) => ids.includes(task.id) && keep(task, top)), error: null };
    }
    return { data: [], error: null };
  }
}

await test("getBrief: brief + items in one request (3 → 2 in a row), same view", async () => {
  const world = briefState();
  const db = briefDb(world);
  const view = await briefService.getBrief(db.client, API_USER_ID, "eod-1028", { appUrl: "https://example.test" });
  assert.deepEqual(db.log.map((entry) => entry.table), ["briefs", "tasks"]);
  const briefQuery = db.log[0].ops;
  assert.ok(briefQuery.some(([name, args]) => name === "eq" && args[0] === "user_id" && args[1] === API_USER_ID));
  assert.ok(briefQuery.some(([name, args]) => name === "eq" && args[0] === "brief_items.user_id" && args[1] === API_USER_ID), "items still filtered by user");
  assert.ok(briefQuery.some(([name, args]) => name === "order" && args[0] === "n" && args[1].referencedTable === "brief_items" && args[1].ascending === true));

  assert.equal("brief_items" in view.brief, false, "the embed must not leak into the brief");
  assert.deepEqual(Object.keys(view.brief), ["id", "user_id", "edition", "brief_date", "code", "content", "covered_meeting_ids", "notified_at", "notify_sent_at", "notify_error", "created_at", "updated_at"]);
  assert.deepEqual(view.items.map((item) => item.n), [1, 2, 3]);
  assert.deepEqual(Object.keys(view.tasks).sort(), [TASK_A, TASK_B].sort());
  assert.deepEqual(view.counts, { total: 3, open: 2, from_meetings: 0, calls: 2 });
  assert.equal(view.url, "https://example.test/briefs/EOD-1028");
  speed("Brief page: before 3 DB reads in a row after sign-in (brief → items → tasks), after 2 (brief+items → tasks)");
});

await test("getBrief: missing code is still a 404", async () => {
  const db = briefDb(briefState());
  await assert.rejects(
    briefService.getBrief(db.client, API_USER_ID, "EOD-0101", { appUrl: "https://example.test" }),
    (error) => error instanceof briefService.BriefServiceError && error.status === 404
  );
});

await test("getTodayBriefStatus (every page's layout): one request instead of two, same counts", async () => {
  const world = briefState();
  const db = briefDb(world);
  const status = await briefService.getTodayBriefStatus(db.client, API_USER_ID, { now: new Date("2026-10-28T21:00:00Z") });
  assert.deepEqual(status, { code: "EOD-1028", brief_date: "2026-10-28", open: 2, total: 3 });
  assert.deepEqual(db.log.map((entry) => entry.table), ["briefs"]);
  assert.ok(db.log[0].ops.some(([name, args]) => name === "eq" && args[0] === "brief_items.user_id"));
  assert.equal(await briefService.getTodayBriefStatus(briefDb(world).client, API_USER_ID, { now: new Date("2026-10-30T15:00:00Z") }), null);
  speed("Layout brief button (every page): before 2 DB reads in a row, after 1");
});

await test("brief loading placeholder exists for /briefs/[code]", () => {
  const file = new URL("../src/app/briefs/[code]/loading.tsx", import.meta.url);
  assert.ok(fs.existsSync(file), "src/app/briefs/[code]/loading.tsx is missing");
  const source = fs.readFileSync(file, "utf8");
  assert.match(source, /export default function/);
  assert.match(source, /brief-page/);
  assert.match(source, /role="status"/);
  assert.doesNotMatch(source, /Claude|Anthropic/);
});

console.log("");
for (const line of SPEED) console.log(`SPEED ${line}`);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  process.exitCode = 1;
}
