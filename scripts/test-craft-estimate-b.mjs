// Craft estimates B (Baseline f98e79da; plan baseline-plans/craft-estimates/PLAN.md, Brent's picks 11/23): offline.
//   E4 (All projects): shared time across open craft projects with a due date, soonest due first, in minutes
//      (src/lib/craft/shared.ts over each project's own estimate; the route's `shared`; the tab).
//   E3 (Add rows to a sitting already logged): the sheet's plan and words (src/lib/craft/actions.ts), the write path
//      (writeSittingRows: Fix count's craft_rows, then ONE work_session_update through addFinishedRowsToSession) with
//      a fake client that records every call, and the screen's wiring.
//
//   npm run test:craft-estimate   (runs scripts/test-craft-estimate.mjs, then this file)
//
// Each test loads what it needs itself, so on the base commit (8abf4c9) the new tests fail one by one instead of
// stopping the file. Tests marked "control" pin behaviour that was already right before this build.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const load = async (spec) => { try { return await import(spec); } catch (error) { return { __missing: String(error?.message ?? error).split("\n")[0] }; } };
const need = (mod, name) => {
  if (mod.__missing) throw new Error(`module not loaded: ${mod.__missing}`);
  if (typeof mod[name] !== "function") throw new Error(`${name} is not exported`);
  return mod[name];
};

const estimateModule = await import("../src/lib/craft/estimate.ts");
const shared = await load("../src/lib/craft/shared.ts");
const actions = await import("../src/lib/craft/actions.ts");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}\n    ${String(error?.message ?? error).split("\n").slice(0, 8).join("\n    ")}`);
  }
}

// ── Builders (the same shapes as scripts/test-craft-estimate.mjs) ────────────

let seq = 0;
function session(extra) {
  seq += 1;
  return {
    id: `s${String(seq).padStart(3, "0")}`, task_id: null, session_date: "2026-11-22", minutes: 10, exclude_from_stats: false,
    item_ids: [], in_progress_item_ids: [], extra_units: null, extra_work_type: null, ...extra,
  };
}
function craft({
  today = "2026-11-22", target = "2026-12-18", unit = "stitches", parts = [{ id: "p1", name: "Scarf", rows: 385, stitches: () => 30, planSec: 9.95 }],
  done = {}, sessions = [], finishingMinutes = 83, activePart = null, prefix = "",
} = {}) {
  const tasks = [], items = [], rows = [], estimateParts = [];
  parts.forEach((part, index) => {
    let units = 0;
    for (let row = 1; row <= part.rows; row += 1) {
      const stitches = part.stitches(row);
      const key = `${prefix}${part.id}:${row}`;
      const completed = done[`${part.id}:${row}`] ?? null;
      items.push({ id: key, task_id: `${prefix}t-${part.id}`, is_done: Boolean(completed), unit_count: stitches, work_type: part.type ?? "knit", craft_part_id: part.id, craft_row: row });
      rows.push({ item_id: key, part_id: part.id, row, is_done: Boolean(completed), completed_at: completed === true ? null : completed });
      units += stitches ?? 0;
    }
    tasks.push({
      id: `${prefix}t-${part.id}`, status: "In Progress", estimated_minutes: part.planSec ? Math.round((units * part.planSec) / 60) : 0,
      unit_count: null, work_type: part.type ?? "knit", is_sample: false, section_id: null,
    });
    estimateParts.push({ id: part.id, name: part.name, sort_order: index, row_word: part.word ?? "row", total_rows: part.rows });
  });
  if (finishingMinutes > 0) tasks.push({ id: `${prefix}t-finish`, status: "Planned", estimated_minutes: finishingMinutes, unit_count: null, work_type: null, is_sample: false, section_id: null });
  return {
    pace: { project: { unit_label: unit, target_date: target, pace_settings: null }, sections: [], tasks, items, sessions, today, otherProjectRates: [] },
    parts: estimateParts, rows, active_part_id: activePart ?? estimateParts[0]?.id ?? null,
  };
}
function nextDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function ticks(partId, from, to, day) {
  const out = {};
  for (let row = from; row <= to; row += 1) out[`${partId}:${row}`] = `${nextDay(day)}T01:00:00.000Z`;
  return out;
}
const rowIds = (partId, from, to, prefix = "") => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${partId}:${from + i}`);
const est = (input) => estimateModule.buildCraftEstimate(input);
const hoodStitches = (row) => 3 + Math.floor((row - 1) / 4);
/** Sophie Hood (Jenna) on Sun 11/22, as in the plan: rows 1–50 in two counted sittings and a learning sitting. */
function hoodToday({ today = "2026-11-22", target = "2026-12-22" } = {}) {
  return craft({
    today, target, finishingMinutes: 0, prefix: "h-",
    parts: [
      { id: "s1", name: "Scarf 1", rows: 318, stitches: (r) => Math.min(hoodStitches(r), 60), planSec: 6.78 },
      { id: "hd", name: "Hood", rows: 135, stitches: () => 60, planSec: 6.78 },
      { id: "s2", name: "Scarf 2", rows: 317, stitches: (r) => Math.min(hoodStitches(r), 60), planSec: 6.78 },
    ],
    done: ticks("s1", 1, 50, "2026-11-22"),
    sessions: [
      session({ id: "h1", session_date: "2026-11-22", minutes: 26, exclude_from_stats: true }),
      session({ id: "h2", session_date: "2026-11-22", minutes: 60, item_ids: rowIds("s1", 1, 27, "h-") }),
      session({ id: "h3", session_date: "2026-11-22", minutes: 52, item_ids: rowIds("s1", 28, 50, "h-") }),
    ],
  });
}
/** Mom's One Row Scarf on Sun 11/22: two sittings with time but no rows. */
const scarfInput = (extra = {}) => craft({ sessions: [session({ id: "a", session_date: "2026-11-21", minutes: 90 }), session({ id: "b", session_date: "2026-11-22", minutes: 15 })], ...extra });
const entry = (id, name, estimate, stage = "In Progress") => ({ project_id: id, name, stage, estimate });
const share = (entries, today = "2026-11-22") => need(shared, "buildSharedTime")(entries, today);

// ── E4: shared time ─────────────────────────────────────────────────────────

await test("E4 one project only = This project: minutes needed, rows a day, your minutes a day and days are its own", () => {
  for (const [name, input] of [["scarf", scarfInput()], ["hood", hoodToday()]]) {
    const e = est(input);
    const s = share([entry("p", name, e)]);
    assert.equal(s.projects.length, 1, name);
    const [line] = s.projects;
    assert.equal(line.needed, e.forecast.needed_minutes_per_day, `${name}: minutes needed`);
    assert.equal(s.needed_minutes_per_day, e.forecast.needed_minutes_per_day, `${name}: total`);
    assert.equal(s.you_minutes_per_day, e.forecast.cadence_minutes_per_day, `${name}: your minutes a day`);
    assert.equal(s.you_days, e.forecast.cadence_days, `${name}: days`);
    assert.equal(line.rows_text, `${e.rows_needed_per_day} rows a day`, `${name}: rows a day = This project's From here`);
    assert.equal(s.tiles[0].value, String(Math.round(e.forecast.needed_minutes_per_day)));
    assert.equal(s.tiles[0].sub, "for 1 project");
    assert.equal(s.tiles[1].value, String(Math.round(e.forecast.cadence_minutes_per_day)));
  }
  // The scarf alone fits (105 min over 2 days = 52.5 a day < 74? no: it is short, and says so in its own minutes).
  const scarf = share([entry("p", "Scarf", est(scarfInput()))]);
  assert.equal(scarf.projects[0].state, "short");
  assert.equal(scarf.projects[0].given, 52.5);
  assert.match(scarf.warn.strong, /^At 53 min a day there isn't time for it\.$/);
});

await test("E4 the plan's picture: scarf (Dec 18) first, the Hood (Dec 22) gets what is left: 122 you, 74 to the scarf, 48 min to the Hood", () => {
  const scarf = est(scarfInput());
  const hood = est(hoodToday());
  const rowsWithin = need(estimateModule, "rowsWithin");
  // Given in the other order: the order is by due date, not by input.
  const s = share([entry("hood", "Sophie Hood (Jenna)", hood), entry("scarf", "Mom's One Row Scarf", scarf)]);
  assert.deepEqual(s.projects.map((p) => p.name), ["Mom's One Row Scarf", "Sophie Hood (Jenna)"]);
  assert.equal(s.tiles[0].value, String(Math.round(scarf.forecast.needed_minutes_per_day + hood.forecast.needed_minutes_per_day)));
  assert.deepEqual([s.tiles[0].unit, s.tiles[0].sub], ["min a day", "for 2 projects"], "the simple sum (the plan's 251 used a guessed Hood; this fixture's Hood needs more)");
  assert.deepEqual([s.tiles[1].value, s.tiles[1].unit, s.tiles[1].sub], ["122", "min a day", "over 2 days"], "(105 + 138) ÷ 2 days");
  const [first, second] = s.projects;
  assert.equal(first.state, "fits");
  assert.equal(first.given, scarf.forecast.needed_minutes_per_day);
  assert.equal(first.rows_text, "15 rows a day");
  assert.equal(first.minutes_text, "74 min");
  assert.equal(first.due_text, "due Fri, Dec 18");
  assert.equal(first.line, "Fits, at plan speed.");
  assert.equal(second.state, "short");
  assert.equal(second.given, 121.5 - 74, "what is left after the scarf's 74");
  assert.equal(second.rows, rowsWithin(hood.walk_minutes, second.given), "rows that fit in it, by the same walk");
  assert.equal(second.rows_text, `${hood.rows_needed_per_day} rows a day`);
  assert.equal(second.line, `Short: 48 min a day left for it, about ${second.rows} rows.`);
  assert.ok(second.rows > 0 && second.rows < hood.rows_needed_per_day);
  assert.ok(Math.abs(second.bar - 47.5 / hood.forecast.needed_minutes_per_day) < 1e-9);
  assert.equal(s.warn.strong, "At 122 min a day there is time for Mom's One Row Scarf, but not both.");
  const alt = Math.round(scarf.forecast.needed_minutes_per_day + hood.forecast.plan_cadence_minutes_per_day);
  assert.equal(s.warn.rest, ` If Sophie Hood (Jenna) reaches its plan speed, both need ${alt}.`);
  assert.deepEqual(s.facts.map((f) => [f.label, f.strong]), [["Order", "Soonest due first"], ["Finish", "No dates until 3 days of sittings"]]);
  assert.equal(s.facts[0].small, "Its rows come first. The rest goes to the next one.");
});

await test("E4 minutes, never rows, across projects: a big-row and a small-row project add up by minutes", () => {
  const big = est(craft({ target: "2026-12-01", finishingMinutes: 0, parts: [{ id: "p1", name: "Blanket", rows: 40, stitches: () => 400, planSec: 6 }] }));
  const small = est(craft({ target: "2026-12-05", finishingMinutes: 0, prefix: "x-", parts: [{ id: "p1", name: "Cord", rows: 400, stitches: () => 4, planSec: 6 }] }));
  const s = share([entry("a", "Blanket", big), entry("b", "Cord", small)]);
  const sum = big.forecast.needed_minutes_per_day + small.forecast.needed_minutes_per_day;
  assert.equal(s.needed_minutes_per_day, Math.round(sum * 10) / 10);
  assert.notEqual(big.rows_needed_per_day + small.rows_needed_per_day, Math.round(sum), "a row sum would be another number");
  assert.equal(s.tiles[0].unit, "min a day");
  assert.ok(s.projects.every((p) => /^\d+ rows a day$/.test(p.rows_text)), "each project keeps its own rows");
});

await test("E4 left out: no due date (named), Done / Cancelled (quietly), On Hold (named), every row ticked (quietly), unreadable (counted)", () => {
  const due = est(scarfInput());
  const noDue = est(scarfInput({ target: null }));
  const allDone = est(craft({ finishingMinutes: 0, parts: [{ id: "p1", name: "Hat", rows: 3, stitches: () => 30, planSec: 9 }], done: ticks("p1", 1, 3, "2026-11-20") }));
  assert.equal(allDone.chip.kind, "done");
  const s = share([
    entry("a", "Scarf", due), entry("b", "Socks", noDue), entry("c", "Old blanket", due, "Done"), entry("d", "Gone", due, "Cancelled"),
    entry("e", "Mittens", due, "On Hold"), entry("f", "Hat", allDone), { project_id: "g", name: null, stage: null, estimate: null },
  ]);
  assert.deepEqual(s.projects.map((p) => p.name), ["Scarf"]);
  assert.equal(s.left_out, "Not shared: Socks (no due date); Mittens (on hold). 1 project couldn't be read.");
  const none = share([entry("b", "Socks", noDue)]);
  assert.equal(none.empty, "No open craft project has a due date, so there is no time to share.");
  assert.deepEqual(none.projects, []);
  // Sittings on a left-out project are not in "You".
  const withNoDue = share([entry("a", "Scarf", due), entry("b", "Socks", est(craft({ target: null, prefix: "n-", sessions: [session({ minutes: 300 })] })))]);
  assert.equal(withNoDue.you_minutes_per_day, due.forecast.cadence_minutes_per_day);
});

await test("E4 ties: same due date, the one needing fewer minutes a day first (then by name); the Order fact says so", () => {
  const heavy = est(craft({ target: "2026-12-10", finishingMinutes: 0, parts: [{ id: "p1", name: "A", rows: 100, stitches: () => 80, planSec: 8 }] }));
  const light = est(craft({ target: "2026-12-10", finishingMinutes: 0, prefix: "l-", parts: [{ id: "p1", name: "B", rows: 100, stitches: () => 20, planSec: 8 }] }));
  const s = share([entry("1", "Heavy", heavy), entry("2", "Light", light)]);
  assert.deepEqual(s.projects.map((p) => p.name), ["Light", "Heavy"]);
  assert.match(s.facts[0].small, / Same due date: the smaller one first\.$/);
  const same = share([entry("1", "Zed", light), entry("2", "Abe", light)]);
  assert.deepEqual(same.projects.map((p) => p.name), ["Abe", "Zed"], "equal need: by name");
});

await test("E4 not enough time for everyone: the later ones give way, in order; one that gets nothing says so", () => {
  const mk = (target, prefix) => est(craft({ target, prefix, finishingMinutes: 0, parts: [{ id: "p1", name: "P", rows: 200, stitches: () => 30, planSec: 10 }] }));
  // Your time: 40 min a day over the last 3 days on the first project.
  const first = est(craft({ target: "2026-12-01", prefix: "f-", finishingMinutes: 0, parts: [{ id: "p1", name: "P", rows: 200, stitches: () => 30, planSec: 10 }],
    sessions: [session({ session_date: "2026-11-20", minutes: 40 }), session({ session_date: "2026-11-21", minutes: 40 }), session({ session_date: "2026-11-22", minutes: 40 })] }));
  const s = share([entry("c", "Third", mk("2026-12-20", "c-")), entry("a", "First", first), entry("b", "Second", mk("2026-12-10", "b-"))]);
  assert.deepEqual(s.projects.map((p) => [p.name, p.state]), [["First", "short"], ["Second", "short"], ["Third", "short"]]);
  assert.equal(s.projects[0].given, 40, "the soonest due takes all 40");
  assert.equal(s.projects[1].given, 0);
  assert.equal(s.projects[1].line, "Short: no time left for it at 40 min a day.");
  assert.equal(s.projects[1].rows, 0);
  assert.equal(s.warn.strong, "At 40 min a day there isn't time for any of them.");
  // More time: the first fits, what is left goes to the second (short), the third gets nothing.
  const second = mk("2026-12-10", "b-"), third = mk("2026-12-20", "c-");
  const minutes = Math.round(first.forecast.needed_minutes_per_day + second.forecast.needed_minutes_per_day / 2);
  const roomy = est(craft({ target: "2026-12-01", prefix: "f-", finishingMinutes: 0, parts: [{ id: "p1", name: "P", rows: 200, stitches: () => 30, planSec: 10 }],
    sessions: [session({ session_date: "2026-11-22", minutes })] }));
  const t = share([entry("a", "First", roomy), entry("b", "Second", second), entry("c", "Third", third)]);
  const [a, b, c] = t.projects;
  assert.equal(t.you_minutes_per_day, minutes);
  assert.deepEqual([a.state, b.state, c.state], ["fits", "short", "short"]);
  assert.ok(Math.abs(b.given - (minutes - a.needed)) < 1e-9, "what is left after the first goes to the next");
  assert.equal(c.given, 0);
  assert.equal(b.line, `Short: ${Math.round(minutes - a.needed)} min a day left for it, about ${b.rows} rows.`);
  assert.equal(t.warn.strong, `At ${minutes} min a day there is time for First, but not all 3.`);
  // Enough for all: everyone fits and there is no warning.
  const plenty = est(craft({ target: "2026-12-01", prefix: "f-", finishingMinutes: 0, parts: [{ id: "p1", name: "P", rows: 200, stitches: () => 30, planSec: 10 }],
    sessions: [session({ session_date: "2026-11-22", minutes: 400 })] }));
  const u = share([entry("a", "First", plenty), entry("b", "Second", second), entry("c", "Third", third)]);
  assert.deepEqual(u.projects.map((p) => p.state), ["fits", "fits", "fits"]);
  assert.equal(u.warn, null);
});

await test("E4 a project already past due: listed first, given no time, out of the minutes; the others get the whole day", () => {
  const late = est(craft({ target: "2026-11-20", prefix: "z-", finishingMinutes: 0, parts: [{ id: "p1", name: "P", rows: 20, stitches: () => 30, planSec: 10 }], done: ticks("p1", 1, 8, "2026-11-19"),
    sessions: [session({ session_date: "2026-11-19", minutes: 60, item_ids: rowIds("p1", 1, 8, "z-") })] }));
  const scarf = est(scarfInput());
  const s = share([entry("s", "Scarf", scarf), entry("l", "Late hat", late)]);
  assert.deepEqual(s.projects.map((p) => [p.name, p.state]), [["Late hat", "past_due"], ["Scarf", "short"]]);
  const [l, sc] = s.projects;
  assert.equal(l.given, null);
  assert.equal(l.needed, null);
  assert.equal(l.rows_text, "12 rows left");
  assert.equal(l.line, "2 days past. No time is set aside for it until it has a new due date.");
  assert.equal(s.needed_minutes_per_day, scarf.forecast.needed_minutes_per_day, "the past-due project isn't in the minutes");
  assert.equal(s.tiles[0].sub, "for 1 of 2 projects");
  assert.equal(sc.given, s.you_minutes_per_day, "the scarf gets every minute (the late hat's 60 count as your time too)");
  assert.match(s.facts[0].small, /Past due projects get no time until they have a new due date\./);
});

await test("E4 rows only (no stitch counts): listed with rows a day, never in the minutes; no sittings at all: a plain warning", () => {
  const rowsOnly = est(craft({ prefix: "r-", target: "2026-12-12", finishingMinutes: 0, parts: [{ id: "p1", name: "P", rows: 60, stitches: () => null, planSec: 0 }] }));
  assert.equal(rowsOnly.mode, "rows");
  const fresh = est(craft({ target: "2026-12-18" }));
  const s = share([entry("r", "Rows only", rowsOnly), entry("f", "Fresh", fresh)]);
  const r = s.projects.find((p) => p.name === "Rows only");
  assert.equal(r.state, "rows_only");
  assert.equal(r.rows_text, `${rowsOnly.rows_needed_per_day} rows a day`);
  assert.equal(r.minutes_text, null);
  assert.equal(s.needed_minutes_per_day, fresh.forecast.needed_minutes_per_day);
  assert.equal(s.you_minutes_per_day, 0);
  assert.deepEqual(s.warn, { strong: "No sittings on these projects in the last 14 days.", rest: " So far there is no time to share." });
  assert.equal(s.projects.find((p) => p.name === "Fresh").state, "no_time");
  assert.equal(s.tiles[1].sub, "no sittings in 14 days");
});

await test("E4 control: This project numbers don't move (every field the base commit's estimate.ts returns is the same)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "craft-b-base-"));
  const base = path.join(dir, "estimate-base.ts");
  writeFileSync(base, execFileSync("git", ["show", "8abf4c9:src/lib/craft/estimate.ts"], { encoding: "utf8" }));
  return import(base).then((old) => {
    for (const input of [scarfInput(), hoodToday(), hoodToday({ today: "2026-11-24" }), craft({ target: null }), craft({ target: "2026-11-20" })]) {
      const now = est(input), before = old.buildCraftEstimate(input);
      for (const key of Object.keys(before)) assert.deepEqual(now[key], before[key], key);
    }
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
});

// ── E4: the route and the tab ───────────────────────────────────────────────

const { registerHooks } = await import("node:module");
const { fileURLToPath } = await import("node:url");
const ts = (await import("typescript")).default;
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true };
  if (url.startsWith("file:") && url.endsWith(".tsx")) {
    const fileName = fileURLToPath(url);
    const result = ts.transpileModule(readFileSync(fileName, "utf8"), { fileName, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    return { format: "module", source: result.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
} });
const ui = await import("../src/components/craft/CraftPace.tsx");
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const { NextRequest } = await import("next/server");
const { writeInternalAuthContext } = await import("../src/lib/supabase/internal-auth.ts");
const { GET: paceGet } = await import("../src/app/api/craft/pace/route.ts");

await test("E4 tab: needed vs you, who gives way, each project soonest due first with a bar, Order and Finish; the placeholder is gone", () => {
  const s = share([entry("scarf", "Mom's One Row Scarf", est(scarfInput())), entry("hood", "Sophie Hood (Jenna)", est(hoodToday()))]);
  const html = render(ui.CraftPaceBody, { estimate: est(scarfInput()), tab: "all", onTab: () => {}, shared: s });
  assert.doesNotMatch(html, /comes in the next update/);
  assert.match(html, new RegExp(`<span class="craft-eyebrow">Needed</span><p class="cp-num"><strong>${s.tiles[0].value}</strong> min a day</p><p class="cp-sub">for 2 projects</p>`));
  assert.match(html, /<span class="craft-eyebrow">You<\/span><p class="cp-num"><strong>122<\/strong> min a day<\/p><p class="cp-sub">over 2 days<\/p>/);
  assert.match(html, /<p class="cp-warn"><strong>At 122 min a day there is time for Mom(&#x27;|')s One Row Scarf, but not both\.<\/strong> If Sophie Hood \(Jenna\) reaches its plan speed, both need \d+\.<\/p>/);
  assert.match(html, /<ol class="cp-projects" aria-label="Projects, soonest due first"><li data-state="fits"><div class="cp-p1"><strong>Mom(&#x27;|')s One Row Scarf<\/strong><span>due Fri, Dec 18<\/span><\/div><div class="cp-p2"><strong>15 rows a day<\/strong><span>74 min<\/span><\/div><span class="cp-meter" role="img" aria-label="Gets 74 of 74 min a day"><i style="width:100%"><\/i><\/span><p class="cp-pl">Fits, at plan speed\.<\/p><\/li>/);
  assert.match(html, /<li data-state="short">.*<span class="cp-meter short" role="img" aria-label="Gets 48 of \d+ min a day"><i style="width:\d+%"><\/i><\/span><p class="cp-pl">Short: 48 min a day left for it, about \d+ rows\.<\/p><\/li><\/ol>/);
  assert.match(html, /<dt>Order<\/dt><dd><strong>Soonest due first<\/strong><small>Its rows come first\. The rest goes to the next one\.<\/small><\/dd>/);
  assert.match(html, /<dt>Finish<\/dt><dd><strong>No dates until 3 days of sittings<\/strong>/);
  assert.match(render(ui.SharedTimeBody, { shared: null }), /Working out the shared time…/);
  assert.match(render(ui.SharedTimeBody, { shared: "failed" }), /couldn&#x27;t be read/);
  const empty = render(ui.SharedTimeBody, { shared: share([entry("b", "Socks", est(scarfInput({ target: null })))]) });
  assert.match(empty, /<div class="cp-all"><p>No open craft project has a due date, so there is no time to share\.<\/p><p class="cp-sub">Not shared: Socks \(no due date\)\.<\/p><\/div>/);
});

await test("E4 wiring: the tab reads every project only while it is open, with the screen's reload key; never on a timer", () => {
  const src = readFileSync(new URL("../src/components/craft/CraftPace.tsx", import.meta.url), "utf8");
  const screen = readFileSync(new URL("../src/components/craft/CraftScreen.tsx", import.meta.url), "utf8");
  assert.match(src, /export function useSharedTime\(enabled: boolean, reload: string\)/);
  assert.match(src, /if \(!enabled\) return;/);
  assert.match(src, /fetch\("\/api\/craft\/pace", \{ cache: "no-store" \}\)/);
  assert.equal((src.match(/useSharedTime\(tab === "all", reload\)/g) ?? []).length, 2, "the inside section and the sheet");
  assert.doesNotMatch(src, /setInterval|setTimeout/);
  assert.match(screen, /<CraftPaceSection estimate=\{estimate\} reload=\{paceKey\} onAddRows=\{addRows\} \/>/);
  assert.match(screen, /<CraftPaceSheet estimate=\{estimate\} onClose=\{\(\) => setSheet\(null\)\} reload=\{paceKey\} onAddRows=\{addRows\} \/>/);
  const css = readFileSync(new URL("../src/components/craft/craft.css", import.meta.url), "utf8").split("Craft estimates E3 + E4")[1];
  assert.ok(css, "E3 + E4 styles");
  for (const size of css.matchAll(/font(?:-size)?:[^;]*?(\d+)px/g)) assert.ok(Number(size[1]) >= 12, `type floor: ${size[0]}`);
  assert.doesNotMatch(css, /!important|#[0-9a-f]{3,6}\b/i, "tokens only");
  const shared = readFileSync(new URL("../src/lib/craft/shared.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src + screen + shared, /Claude|Anthropic|inch/i);
  assert.doesNotMatch(shared, /computeForecast\(|buildUnitEntries\(/, "one copy of the math: shared time reads the estimates, it never re-prices");
});

// A small in-memory database (every query must filter by user); rpc calls are recorded.
function fakeDb(tables, rpcs = {}) {
  const queries = [], calls = [], writes = [];
  return {
    queries, calls, writes,
    rpc(name, args) { calls.push([name, args]); const fn = rpcs[name]; return Promise.resolve(fn ? fn(args, tables) : { data: null, error: null }); },
    from(table) {
      const filters = [];
      let range = null;
      const q = {
        select() { return q; },
        insert(row) { writes.push([table, "insert", row]); return q; },
        update(row) { writes.push([table, "update", row]); return q; },
        delete() { writes.push([table, "delete"]); return q; },
        eq(col, val) { filters.push((row) => row[col] === val); queries.push([table, "eq", col]); return q; },
        neq(col, val) { filters.push((row) => row[col] !== val); return q; },
        in(col, vals) { filters.push((row) => vals.includes(row[col])); return q; },
        is(col, val) { filters.push((row) => row[col] === val); return q; },
        gte(col, val) { filters.push((row) => row[col] >= val); return q; },
        lte(col, val) { filters.push((row) => row[col] <= val); return q; },
        order() { return q; },
        limit() { return q; },
        range(from, to) { range = [from, to]; return q; },
        rows() { const all = (tables[table] ?? []).filter((row) => filters.every((f) => f(row))); return range ? all.slice(range[0], range[1] + 1) : all; },
        maybeSingle() { return Promise.resolve({ data: q.rows()[0] ?? null, error: null }); },
        single() { const r = q.rows(); return Promise.resolve(r.length === 1 ? { data: r[0], error: null } : { data: null, error: { code: "PGRST116" } }); },
        then(resolve, reject) { return Promise.resolve({ data: q.rows(), error: null }).then(resolve, reject); },
      };
      return q;
    },
  };
}
const UID = "00000000-0000-4000-8000-000000000001";
const SCARF = "00000000-0000-4000-8000-0000000000aa";
const HOOD = "00000000-0000-4000-8000-0000000000bb";
const own = (row) => ({ ...row, user_id: UID });
function tablesFor(projects) {
  const t = { craft_projects: [], projects: [], project_sections: [], tasks: [], task_checklist_items: [], work_sessions: [], work_session_items: [], craft_parts: [] };
  for (const { id, name, input, stage = "In Progress" } of projects) {
    t.craft_projects.push(own({ project_id: id, active_part_id: input.active_part_id }));
    t.projects.push(own({ id, name, stage, unit_label: "stitches", target_date: input.pace.project.target_date, pace_settings: null }));
    t.tasks.push(...input.pace.tasks.map((task) => own({ ...task, project_id: id, title: task.id, is_recurring_template: false, source_checklist_item_id: null })));
    t.task_checklist_items.push(...input.pace.items.map((item, n) => own({ ...item, text: `Row ${n + 1}`, sort_order: n,
      completed_at: input.rows.find((row) => row.item_id === item.id)?.completed_at ?? null })));
    t.work_sessions.push(...input.pace.sessions.map((s) => own({ ...s, project_id: id, started_at: null, ended_at: null, created_at: `${s.session_date}T20:00:00Z`, note: null, exclude_reason: null, source: "manual" })));
    for (const s of input.pace.sessions) {
      t.work_session_items.push(...s.item_ids.map((itemId) => own({ session_id: s.id, checklist_item_id: itemId, in_progress: false })));
      t.work_session_items.push(...(s.in_progress_item_ids ?? []).map((itemId) => own({ session_id: s.id, checklist_item_id: itemId, in_progress: true })));
    }
    t.craft_parts.push(...input.parts.map((part) => own({ ...part, project_id: id })));
  }
  return t;
}
const paceReq = (db, query = "") => {
  const r = new NextRequest(`http://localhost/api/craft/pace${query}`);
  writeInternalAuthContext(r, { supabase: db, userId: UID, user: { id: UID }, authSource: "session" });
  return r;
};
async function atScarfEvening(fn) {
  const realDate = Date;
  globalThis.Date = class extends realDate { constructor(...args) { super(...(args.length ? args : ["2026-11-23T01:24:00Z"])); } static now() { return new realDate("2026-11-23T01:24:00Z").getTime(); } };
  try { return await fn(); } finally { globalThis.Date = realDate; }
}

await test("E4 route: GET /api/craft/pace (no project_id) carries `shared` over every project's own estimate and stage; ?project_id= doesn't", async () => {
  const projects = [{ id: SCARF, name: "Mom's One Row Scarf", input: scarfInput() }, { id: HOOD, name: "Sophie Hood (Jenna)", input: hoodToday() }];
  const db = fakeDb(tablesFor(projects));
  const body = await atScarfEvening(async () => (await paceGet(paceReq(db))).json());
  assert.ok(body.shared, "shared time in the reply");
  assert.deepEqual(body.shared.projects.map((p) => p.name), ["Mom's One Row Scarf", "Sophie Hood (Jenna)"]);
  for (const p of body.shared.projects) {
    const own = body.projects.find((x) => x.project_id === p.project_id).estimate;
    assert.equal(p.needed, own.forecast.needed_minutes_per_day, "the same minutes as the project's own estimate");
  }
  assert.equal(body.shared.tiles[0].value, Math.round(body.shared.projects.reduce((sum, p) => sum + p.needed, 0)).toLocaleString("en-US"));
  const tablesRead = new Set(db.queries.map(([table]) => table));
  for (const table of tablesRead) assert.ok(db.queries.some(([t, op, col]) => t === table && op === "eq" && col === "user_id"), `${table} filtered by user`);
  const one = await atScarfEvening(async () => (await paceGet(paceReq(fakeDb(tablesFor(projects)), `?project_id=${SCARF}`))).json());
  assert.equal(one.shared, undefined, "the screen's own read is unchanged");
  assert.equal(one.projects.length, 1);
  // An On Hold project is read but not shared.
  const held = await atScarfEvening(async () => (await paceGet(paceReq(fakeDb(tablesFor([projects[0], { ...projects[1], stage: "On Hold" }]))))).json());
  assert.deepEqual(held.shared.projects.map((p) => p.name), ["Mom's One Row Scarf"]);
  assert.equal(held.shared.left_out, "Not shared: Sophie Hood (Jenna) (on hold).");
});

// ── E3: add rows to a sitting already logged ────────────────────────────────

const states = (total, done = [], linked = [], inProgress = []) => Array.from({ length: total }, (_, i) => ({
  row: i + 1, done: done.includes(i + 1), linked: linked.includes(i + 1), today: false, in_progress: inProgress.includes(i + 1),
}));
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

await test("E3 sheet plan: the first guess, what Save ticks and adds, and the refusals in plain words", () => {
  const defaults = need(actions, "addRowsDefaults"), plan = need(actions, "addRowsPlan"), refusal = need(actions, "addRowsRefusal"), summary = need(actions, "addRowsSummary");
  // Nothing ticked (the scarf before 11/23): row 1.
  assert.deepEqual(defaults(states(385), 385), { from: 1, to: 1 });
  // Rows 1–30 ticked with no sitting ("Save without rows"): rows 1–30.
  assert.deepEqual(defaults(states(385, range(1, 30)), 385), { from: 1, to: 30 });
  // Rows 1–30 in a sitting, 31–40 ticked in none: rows 31–40.
  assert.deepEqual(defaults(states(385, range(1, 40), range(1, 30)), 385), { from: 31, to: 40 });
  const p = plan(states(385, range(1, 30)), 385, 1, 45);
  assert.deepEqual(p.tick, range(31, 45));
  assert.deepEqual(p.add, range(1, 45));
  assert.equal(refusal("row", p, 1, 45), null);
  assert.equal(summary("row", p, { id: "a", date: "2026-11-21", minutes: 90 }), "Ticks rows 31–45. Adds rows 1–45 to Sat 11/21, 90 min. Its 90 min stay as they are.");
  const taken = plan(states(385, range(1, 40), range(1, 30)), 385, 25, 40);
  assert.deepEqual(taken.in_sitting, range(25, 30));
  assert.equal(refusal("row", taken, 25, 40), "Rows 25–30 are already in a sitting. A row is finished in one sitting only.");
  const early = plan(states(385, range(1, 10)), 385, 20, 25);
  assert.deepEqual(early.earlier, range(11, 19));
  assert.equal(refusal("row", early, 20, 25), "Rows 11–19 before row 20 aren't ticked. Start at row 11.");
  assert.deepEqual(plan(states(385, range(1, 10)), 385, 5, 8).earlier, [], "all ticked: rows before them don't matter");
  assert.equal(refusal("round", plan(states(10), 10, 11, 12), 11, 12), "There are no rounds 11–12 on this part.");
  // A row partway (in progress) is added as finished.
  assert.deepEqual(plan(states(385, range(1, 30), [], [31]), 385, 31, 31).add, [31]);
  assert.equal(need(actions, "sittingRowsAddedText")("row", { added: range(1, 30), ticked: [], session_date: "2026-11-21", minutes: 90 }), "Added rows 1–30 to Sat 11/21, 90 min.");
});

// The write path against a fake client: ONE call to migration 076's craft_add_sitting_rows (one transaction); its
// refusals (SQLSTATE MC076, the rows in DETAIL) keep the sheet's words and HTTP codes. The real function runs in
// scripts/test-craft-e3-db.mjs.
const S_ID = "00000000-0000-4000-8000-00000000a001";
const PART = "00000000-0000-4000-8000-00000000c001";
const OTHER_PROJECT = "00000000-0000-4000-8000-0000000000cc";
function e3Tables() {
  return {
    craft_projects: [own({ project_id: SCARF, active_part_id: PART, craft: "knit", gear: null })],
    projects: [own({ id: SCARF, name: "Mom's One Row Scarf" }), own({ id: OTHER_PROJECT, name: "Other" })],
    craft_parts: [own({ id: PART, project_id: SCARF, name: "Scarf", sort_order: 0, row_word: "row", total_rows: 40, stitch_count: 30, quarters: false, ridges: false, quarter: 0, quarter_row: null, created_at: "2026-11-20T00:00:00Z", row_numbering: "label" }),
      own({ id: "00000000-0000-4000-8000-00000000c002", project_id: OTHER_PROJECT, name: "Other", sort_order: 0, row_word: "round", total_rows: 10 })],
    tasks: [], task_checklist_items: [], work_sessions: [], work_session_items: [],
    craft_segments: [], craft_notes: [], craft_frogs: [], craft_sitting_details: [], craft_timers: [],
  };
}
const OK = { status: "ok", session_id: S_ID, part_id: PART, session_date: "2026-11-21", minutes: 90, current_row: 31, ticked: [11, 12], added: [1, 2, 11, 12], already: [] };
const refuse = (message, details) => () => ({ data: null, error: { code: "MC076", message, details } });
const writeService = await load("../src/lib/craft/write-service.ts");
const call = async (db, body, projectId = SCARF) => {
  try { return { ok: true, reply: await need(writeService, "writeSittingRows")(db, UID, projectId, body) }; } catch (error) {
    if (/not loaded|not exported/.test(error.message)) throw error;
    return { ok: false, status: error.status, reason: error.reason, message: error.message, code: error.code, extra: error.extra };
  }
};
const body = (extra) => ({ session_id: S_ID, part_id: PART, expected_row: 1, from_row: 1, to_row: 30, ...extra });
const writes = (db) => db.calls.filter(([n]) => n !== "craft_remove_blockers");

await test("E3 write: ONE call to craft_add_sitting_rows (migration 076, one transaction) with the sheet's values; no other write", async () => {
  const db = fakeDb(e3Tables(), { craft_add_sitting_rows: () => ({ data: OK, error: null }) });
  const out = await call(db, body({ expected_row: 11, from_row: 1, to_row: 12 }));
  assert.ok(out.ok, out.message);
  assert.deepEqual(writes(db), [["craft_add_sitting_rows", { p_user_id: UID, p_project_id: SCARF, p_session_id: S_ID, p_part_id: PART, p_expected_row: 11, p_from_row: 1, p_to_row: 12 }]]);
  assert.deepEqual(db.writes, [], "no PostgREST writes");
  assert.deepEqual(out.reply.result, OK);
  assert.ok(out.reply.view, "the fresh view comes back");
  const src = readFileSync(new URL("../src/lib/craft/write-service.ts", import.meta.url), "utf8").split("export async function writeSittingRows")[1];
  assert.doesNotMatch(src, /craft_rows|work_session_update|addFinishedRowsToSession/, "no two-step path left");
});

await test("E3 write: the function's refusals keep the sheet's words and codes (rows in another sitting, earlier rows, stale, none, no sitting)", async () => {
  const cases = [
    [refuse("in_sitting", "3,4,5"), 409, "in_sitting", "Not saved: Rows 3–5 are already in a sitting. A row is finished in one sitting only."],
    [refuse("earlier", "11,12,13"), 409, "earlier", "Not saved: Rows 11–13 before row 1 aren't ticked. Start at row 11."],
    [refuse("no_rows", ""), 400, "no_rows", "Not saved: There are no rows 1–30 on this part."],
    [refuse("stale", "11"), 409, "stale", "Not saved: the count changed on another screen. The screen now shows the latest."],
    [() => ({ data: null, error: { code: "P0002", message: "CRAFT_SITTING_NOT_FOUND" } }), 404, "not_found", "Sitting not found in this project"],
    [() => ({ data: null, error: { code: "55P03", message: "lock timeout" } }), 409, "busy", "Not saved: the rows were busy. Try again."],
  ];
  for (const [fn, status, reason, message] of cases) {
    const out = await call(fakeDb(e3Tables(), { craft_add_sitting_rows: fn }), body());
    assert.deepEqual([out.status, out.reason, out.message], [status, reason, message], reason);
  }
  const stale = await call(fakeDb(e3Tables(), { craft_add_sitting_rows: refuse("stale", "11") }), body());
  assert.equal(stale.extra.result.current_row, 11);
  assert.ok(stale.extra.view, "a stale count comes back with the fresh view");
});

await test("E3 write: another project's part, bad input and the minutes are refused before the function is called", async () => {
  const db = fakeDb(e3Tables(), { craft_add_sitting_rows: () => ({ data: OK, error: null }) });
  const otherPart = await call(db, body({ part_id: "00000000-0000-4000-8000-00000000c002" }));
  assert.equal(otherPart.code, "PGRST116", "the part isn't in this project: 404");
  const unknown = await call(db, { ...body(), minutes: 5 });
  assert.deepEqual([unknown.status, unknown.message], [400, "Unknown fields: minutes"]);
  const backwards = await call(db, body({ from_row: 5, to_row: 4 }));
  assert.equal(backwards.status, 400);
  assert.deepEqual(writes(db), []);
});

await test("E3 migration 076: function only (one new function, SECURITY INVOKER, the craft grants), locks in the craft order, nothing existing replaced; the rollback drops only it", () => {
  const sql = readFileSync(new URL("../supabase/migrations/076_craft_add_sitting_rows.sql", import.meta.url), "utf8");
  const down = readFileSync(new URL("../supabase/rollbacks/076_craft_add_sitting_rows.down.sql", import.meta.url), "utf8");
  const code = sql.replace(/--[^\n]*/g, "");
  assert.deepEqual([...code.matchAll(/CREATE (OR REPLACE )?FUNCTION (\w+)/g)].map((m) => [m[1] ?? "", m[2]]), [["", "craft_add_sitting_rows"]]);
  assert.doesNotMatch(code, /CREATE (TABLE|INDEX|POLICY|TRIGGER|UNIQUE)|ALTER |DROP |INSERT INTO|SECURITY DEFINER|GRANT [A-Z, ]+ ON (TABLE )?\w+ TO/i);
  assert.match(code, /REVOKE ALL ON FUNCTION craft_add_sitting_rows\(UUID, UUID, UUID, UUID, INTEGER, INTEGER, INTEGER\) FROM PUBLIC, anon;/);
  assert.match(code, /GRANT EXECUTE ON FUNCTION craft_add_sitting_rows\(UUID, UUID, UUID, UUID, INTEGER, INTEGER, INTEGER\) TO authenticated, service_role;/);
  assert.match(code, /SET search_path = public\s+SET lock_timeout = '5s'/);
  const at = (needle) => { const i = code.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  assert.ok(at("PERFORM work_sessions_assert_caller(p_user_id)") < at("FROM work_sessions\n    WHERE id = p_session_id"));
  assert.ok(at("FOR UPDATE;\n  IF NOT FOUND THEN\n    RAISE EXCEPTION 'CRAFT_SITTING_NOT_FOUND'") < at("PERFORM work_sessions_lock_tasks("), "the sitting first, then the tasks in id order");
  assert.ok(at("PERFORM work_sessions_lock_tasks(") < at("v_part := craft_part_lock("), "then the part (craft project, part)");
  assert.ok(at("v_part := craft_part_lock(") < at("ORDER BY id FOR UPDATE"), "then the rows");
  assert.ok(at("ORDER BY id FOR UPDATE") < at("RAISE EXCEPTION 'in_sitting'"), "links are read under the locks");
  assert.ok(at("RAISE EXCEPTION 'earlier'") < at("UPDATE task_checklist_items SET is_done = true"), "every refusal before the first write");
  assert.match(code, /PERFORM work_session_update\(p_user_id, p_session_id, '\{\}'::jsonb, v_have \|\| v_add\)/, "the session write path, no field of the sitting");
  assert.deepEqual([...down.replace(/--[^\n]*/g, "").matchAll(/DROP (\w+) ([^;]+);/g)].map((m) => `${m[1]} ${m[2]}`), ["FUNCTION craft_add_sitting_rows(UUID, UUID, UUID, UUID, INTEGER, INTEGER, INTEGER)"]);
  const types = readFileSync(new URL("../src/types/supabase.generated.ts", import.meta.url), "utf8");
  assert.match(types, /craft_add_sitting_rows: \{\n\s+Args: \{\n\s+p_expected_row: number\n\s+p_from_row: number\n\s+p_part_id: string\n\s+p_project_id: string\n\s+p_session_id: string\n\s+p_to_row: number\n\s+p_user_id: string\n\s+\}\n\s+Returns: Json/);
});

await test("E3 control: after adding rows the forecast moves the right way (sittings with rows, your speed, the day they count on)", () => {
  // Before: the scarf's two sittings with time but no rows. After: rows 1–30 finished in Saturday's 90-minute sitting.
  const before = est(scarfInput());
  const after = est(craft({ done: ticks("p1", 1, 30, "2026-11-23"),
    sessions: [session({ id: "a", session_date: "2026-11-21", minutes: 90, item_ids: rowIds("p1", 1, 30) }), session({ id: "b", session_date: "2026-11-22", minutes: 15 })] }));
  assert.equal(before.forecast.sittings_with_rows, 0);
  assert.equal(after.forecast.sittings_with_rows, 1);
  assert.deepEqual(after.sittings_without_rows.map((s) => s.id), ["b"]);
  assert.equal(after.forecast.cadence_minutes_per_day, before.forecast.cadence_minutes_per_day, "the minutes are the same");
  assert.equal(after.measured, true, "your speed now: 90 min for 900 stitches");
  assert.equal(before.measured, false);
  assert.ok(after.sheet.chart === null && after.rows_done_today === 0, "the rows count on Saturday, not today");
  assert.equal(after.rows_left, 355);
});

await test("E3 wiring: 'N sittings have no rows. Add rows' and the Pace sheet's Add rows… open the sheet; it saves through the screen's send", () => {
  const scarf = est(scarfInput());
  const box = render(ui.CraftTodayBox, { estimate: scarf, onOpen: () => {}, onAddRows: () => {} });
  assert.match(box, /<button type="button" class="cp-link">2 sittings have no rows\. Add rows<\/button>/);
  const body = render(ui.CraftPaceBody, { estimate: scarf, tab: "this", onTab: () => {}, onAddRows: () => {} });
  assert.match(body, /<div class="cp-fix"><p>2 sittings have time but no rows: [^<]*<\/p><button[^>]*>Add rows…<\/button><\/div>/);
  const screen = readFileSync(new URL("../src/components/craft/CraftScreen.tsx", import.meta.url), "utf8");
  const sheets = readFileSync(new URL("../src/components/craft/CraftSheets.tsx", import.meta.url), "utf8");
  assert.match(screen, /const addRows = part && noRowSittings\.length > 0 \? \(\) => setSheet\("add-rows"\) : undefined;/);
  assert.match(screen, /<CraftTodayBox estimate=\{estimate\} onOpen=\{\(\) => setSheet\("pace"\)\} onAddRows=\{addRows\} \/>/);
  assert.match(screen, /sheet === "add-rows" && <AddRowsSheet open/);
  assert.match(sheets, /send\("sitting-rows", \{ session_id: sitting\.id, part_id: part\.id, expected_row: part\.current_row, from_row: from, to_row: to \}\)/);
  assert.ok(readFileSync(new URL("../src/app/api/craft/[projectId]/sitting-rows/route.ts", import.meta.url), "utf8").includes('craftWriteRoute(request, "sitting_rows"'));
  assert.doesNotMatch(screen + sheets, /Claude|Anthropic|inch/i);
});

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed` : ""}`);
if (failures.length) process.exit(1);
