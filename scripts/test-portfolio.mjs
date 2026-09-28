// Pure tests for the Portfolio page model (src/lib/portfolio.ts), the task
// owner field parser (src/lib/task-owner.ts) and the record-page Markdown
// parser (src/lib/markdown.ts). No database.
//
//   npm run test:portfolio

import assert from "node:assert/strict";

const {
  percentDone,
  countTasks,
  buildPortfolio,
  buildTimeline,
  timelinePosition,
  toEtDate,
} = await import("../src/lib/portfolio.ts");
const { parseTaskOwnerFields, normalizeTaskOwner } = await import("../src/lib/task-owner.ts");
const { parseMarkdown, parseInline, safeHref } = await import("../src/lib/markdown.ts");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// 5:00 PM ET on Mon 9/28/2026.
const NOW = new Date("2026-09-28T21:00:00Z");
const TODAY = "2026-09-28";

let seq = 0;
function task(overrides = {}) {
  seq += 1;
  const id = overrides.id ?? `t${seq}`;
  return {
    id,
    title: `Task ${id}`,
    status: "Backlog",
    owner: "agent",
    owner_label: null,
    status_line: null,
    due_at: null,
    created_at: "2026-09-24T14:00:00Z",
    updated_at: "2026-09-24T14:00:00Z",
    priority_score: 50,
    implementation_id: "app-a",
    project_id: "proj-a",
    section_id: null,
    is_recurring_template: false,
    tags: ["personal"],
    project: { tags: ["personal"] },
    ...overrides,
  };
}

const IMPLS = [
  { id: "app-a", name: "Stock & Stir", phase: "Build", rag: "Green", status_summary: "Release 3 is on phones. More detail follows.", next_milestone: "", next_milestone_date: null, portfolio_rank: 2 },
  { id: "app-b", name: "FamCal", phase: "Build", rag: "Green", status_summary: "", next_milestone: "Friday page", next_milestone_date: "2026-10-09", portfolio_rank: 1 },
  { id: "app-w", name: "OnCore", phase: "Discovery", rag: "Green", status_summary: "", next_milestone: "", next_milestone_date: null, portfolio_rank: 3 },
];
const PROJECTS = [
  { id: "proj-a", name: "Stock & Stir", implementation_id: "app-a", stage: "In Progress", portfolio_rank: 1 },
  { id: "proj-b1", name: "Finance Loop", implementation_id: "app-b", stage: "In Progress", portfolio_rank: 1 },
  { id: "proj-b2", name: "Sunday Brief", implementation_id: "app-b", stage: "In Progress", portfolio_rank: 2 },
  { id: "proj-x", name: "Old idea", implementation_id: "app-b", stage: "Cancelled", portfolio_rank: 3 },
];
const SECTIONS = [
  { id: "sec-r3", project_id: "proj-a", name: "Release 3", sort_order: 0 },
  { id: "sec-r4", project_id: "proj-a", name: "Release 4", sort_order: 1 },
];

// ── % done ────────────────────────────────────────────────────────────────
test("percentDone is done ÷ all, rounded", () => {
  assert.equal(percentDone(10, 28), 36);
  assert.equal(percentDone(1, 3), 33);
  assert.equal(percentDone(2, 3), 67);
  assert.equal(percentDone(4, 4), 100);
  assert.equal(percentDone(0, 5), 0);
});

test("percentDone never claims 100% with work left, or 0% once something is done", () => {
  assert.equal(percentDone(199, 200), 99);
  assert.equal(percentDone(1, 300), 1);
});

test("percentDone is null with no tasks and clamps bad input", () => {
  assert.equal(percentDone(0, 0), null);
  assert.equal(percentDone(5, 4), 100);
  assert.equal(percentDone(-1, 4), 0);
});

test("countTasks: Parked and Missed are closed but not done; owners count open tasks only", () => {
  const counts = countTasks([
    task({ status: "Done" }),
    task({ status: "Done", owner: "brent" }),
    task({ status: "Parked" }),
    task({ status: "Missed" }),
    task({ status: "In Progress", owner: "brent" }),
    task({ status: "Blocked/Waiting" }),
    task({ status: "Backlog" }),
  ]);
  assert.deepEqual(counts, { done: 2, total: 7, pct: 29, open: 3, brentOpen: 1, agentOpen: 2 });
});

// ── buildPortfolio ────────────────────────────────────────────────────────
function sampleInput() {
  return {
    implementations: IMPLS,
    projects: PROJECTS,
    sections: SECTIONS,
    tasks: [
      task({ id: "a1", status: "Done", section_id: "sec-r3" }),
      task({ id: "a2", status: "In Progress", section_id: "sec-r3", owner: "brent", status_line: "8 of 11 checks passed.", due_at: "2026-10-01T21:00:00Z", updated_at: "2026-09-28T19:00:00Z" }),
      task({ id: "a3", status: "Backlog", section_id: "sec-r4", priority_score: 90 }),
      task({ id: "a4", status: "In Progress", owner_label: "Codex", status_line: "Diagnosing two pantry bugs.", updated_at: "2026-09-28T20:00:00Z" }),
      task({ id: "a5", status: "Parked" }),
      task({ id: "tmpl", status: "Parked", is_recurring_template: true }),
      task({ id: "b1", implementation_id: "app-b", project_id: "proj-b1", status: "Done", project: { tags: ["personal"] } }),
      task({ id: "b2", implementation_id: "app-b", project_id: "proj-b2", status: "Planned", owner: "brent", due_at: "2026-09-26T21:00:00Z" }),
      task({ id: "b3", implementation_id: "app-b", project_id: "proj-x", status: "Backlog" }),
      task({ id: "w1", implementation_id: "app-w", project_id: null, status: "Done", tags: [], project: null }),
      task({ id: "w2", implementation_id: "app-w", project_id: null, status: "Backlog", owner: "brent", tags: [], project: null }),
      task({ id: "loose", implementation_id: null, project_id: null, status: "Planned", owner: "brent" }),
    ],
  };
}

test("personal scope keeps personal tasks only, skips recurring templates, orders apps by rank", () => {
  const view = buildPortfolio(sampleInput(), { scope: "personal", now: NOW });
  assert.equal(view.today, TODAY);
  assert.deepEqual(view.apps.map((app) => app.name), ["FamCal", "Stock & Stir"]);
  const ss = view.apps.find((app) => app.name === "Stock & Stir");
  // a1..a5 count (the recurring template doesn't): 1 done of 5.
  assert.deepEqual([ss.counts.done, ss.counts.total, ss.counts.pct], [1, 5, 20]);
  assert.equal(ss.counts.brentOpen, 1);
  assert.equal(ss.counts.agentOpen, 2);
  assert.deepEqual(ss.agentLabels, ["Codex"]);
});

test("hero: Brent's open count includes tasks with no app; % done covers app tasks", () => {
  const view = buildPortfolio(sampleInput(), { scope: "personal", now: NOW });
  assert.equal(view.brentOpen, 3); // a2, b2, loose
  assert.deepEqual([view.overall.done, view.overall.total], [2, 8]);
  assert.equal(view.overall.pct, 25);
  assert.equal(view.agentInProgress, 1); // a4 (a2 is Brent's)
});

test("work and all scopes", () => {
  const work = buildPortfolio(sampleInput(), { scope: "work", now: NOW });
  assert.deepEqual(work.apps.map((app) => app.name), ["OnCore"]);
  assert.equal(work.apps[0].counts.pct, 50);
  assert.equal(work.brentOpen, 1);
  const all = buildPortfolio(sampleInput(), { scope: "all", now: NOW });
  assert.deepEqual(all.apps.map((app) => app.name), ["FamCal", "Stock & Stir", "OnCore"]);
  assert.equal(all.brentOpen, 4);
});

test("assigned to you: dated first (soonest, overdue flagged), then by priority", () => {
  const view = buildPortfolio(sampleInput(), { scope: "personal", now: NOW });
  assert.deepEqual(view.assigned.map((t) => t.id), ["b2", "a2", "loose"]);
  assert.equal(view.assigned[0].overdue, true);
  assert.equal(view.assigned[0].due, "2026-09-26");
  assert.equal(view.assigned[1].overdue, false);
  assert.equal(view.assigned[1].statusLine, "8 of 11 checks passed.");
  assert.equal(view.assigned[1].app, "Stock & Stir");
  assert.equal(view.assigned[2].app, null);
});

test("where it stands: newest open status_line, else the app summary's first sentence", () => {
  const view = buildPortfolio(sampleInput(), { scope: "personal", now: NOW });
  const ss = view.apps.find((app) => app.name === "Stock & Stir");
  assert.equal(ss.stand, "Diagnosing two pantry bugs.");
  const input = sampleInput();
  input.tasks = input.tasks.map((t) => ({ ...t, status_line: null }));
  const ss2 = buildPortfolio(input, { scope: "personal", now: NOW }).apps.find((app) => app.name === "Stock & Stir");
  assert.equal(ss2.stand, "Release 3 is on phones.");
});

test("next: the app's milestone if set, else the soonest upcoming due task, else top priority", () => {
  const view = buildPortfolio(sampleInput(), { scope: "personal", now: NOW });
  assert.equal(view.apps.find((app) => app.name === "FamCal").next, "Friday page (Oct 9)");
  const ss = view.apps.find((app) => app.name === "Stock & Stir");
  const a2 = sampleInput().tasks.find((t) => t.id === "a2");
  assert.equal(ss.next, a2.title); // due 10/1 beats a3's higher priority
  const input = sampleInput();
  input.tasks = input.tasks.map((t) => ({ ...t, due_at: null }));
  const ss2 = buildPortfolio(input, { scope: "personal", now: NOW }).apps.find((app) => app.name === "Stock & Stir");
  assert.equal(ss2.next, input.tasks.find((t) => t.id === "a3").title);
});

test("ET dates: a due time late in the ET evening stays on that ET day", () => {
  assert.equal(toEtDate("2026-10-04T03:30:00Z"), "2026-10-03");
  assert.equal(toEtDate("2026-10-04T04:30:00Z"), "2026-10-04");
  assert.equal(toEtDate(null), null);
  assert.equal(toEtDate("not a date"), null);
});

// ── Timeline ──────────────────────────────────────────────────────────────
test("timeline: one lane per section, unsectioned tasks as 'Other tasks', cancelled projects skipped", () => {
  const view = buildPortfolio(sampleInput(), { scope: "personal", now: NOW });
  const ss = view.apps.find((app) => app.name === "Stock & Stir").timeline;
  assert.deepEqual(ss.lanes.map((lane) => lane.label), ["Release 3", "Release 4", "Other tasks"]);
  const fam = view.apps.find((app) => app.name === "FamCal").timeline;
  assert.deepEqual(fam.lanes.map((lane) => lane.label), ["Finance Loop", "Sunday Brief"]);
  assert.equal(fam.lanes.every((lane) => lane.project === null), true);
});

test("timeline lanes: state, due-date bars, dashed estimates, overdue, Brent marker", () => {
  const view = buildPortfolio(sampleInput(), { scope: "personal", now: NOW });
  const [r3, r4, other] = view.apps.find((app) => app.name === "Stock & Stir").timeline.lanes;
  assert.equal(r3.state, "prog");
  assert.equal(r3.estimated, false);
  assert.equal(r3.start, "2026-09-24");
  assert.equal(r3.end, "2026-10-01");
  assert.equal(r3.hasBrent, true);
  assert.equal(r3.sub, "1 of 2 done");
  assert.equal(r4.state, "plan");
  assert.equal(r4.estimated, true); // no due dates: dashed, ends a week after today
  assert.equal(r4.end, "2026-10-05");
  assert.match(r4.sub, /no due date/);
  assert.equal(other.state, "prog");
  const fam = view.apps.find((app) => app.name === "FamCal").timeline;
  const sunday = fam.lanes.find((lane) => lane.label === "Sunday Brief");
  assert.equal(sunday.overdue, true);
  const loop = fam.lanes.find((lane) => lane.label === "Finance Loop");
  assert.equal(loop.state, "done");
  assert.equal(loop.sub, "Done");
});

test("timeline window: starts on a Monday, hides long-finished lanes, clips far-future bars", () => {
  const tasks = [
    task({ id: "old", status: "Done", project_id: "proj-b1", implementation_id: "app-b", created_at: "2026-03-01T15:00:00Z", updated_at: "2026-03-10T15:00:00Z" }),
    task({ id: "now", status: "In Progress", project_id: "proj-b2", implementation_id: "app-b", due_at: "2027-03-18T21:00:00Z" }),
  ];
  const timeline = buildTimeline(tasks, PROJECTS, SECTIONS, TODAY);
  assert.equal(timeline.hiddenEarlier, 1);
  assert.deepEqual(timeline.lanes.map((lane) => lane.label), ["Sunday Brief"]);
  assert.equal(new Date(`${timeline.start}T00:00:00Z`).getUTCDay(), 1);
  assert.ok(timeline.start <= "2026-09-21");
  assert.equal(timeline.end, "2026-12-21"); // 12 weeks ahead at most
  assert.equal(timeline.lanes[0].continues, true);
  assert.equal(timelinePosition(timeline, timeline.start), 0);
  assert.equal(timelinePosition(timeline, "2030-01-01"), 100);
  const todayAt = timelinePosition(timeline, TODAY);
  assert.ok(todayAt > 0 && todayAt < 100);
  assert.equal(timeline.ticks[0], timeline.start);
  // A 13-week window gets fortnightly ticks, all on Mondays.
  assert.deepEqual(timeline.ticks.slice(0, 3), ["2026-09-21", "2026-10-05", "2026-10-19"]);
});

test("timeline with no tasks is empty and centred on today", () => {
  const timeline = buildTimeline([], PROJECTS, SECTIONS, TODAY);
  assert.deepEqual(timeline.lanes, []);
  assert.equal(timeline.today, TODAY);
  assert.ok(timeline.start <= TODAY && timeline.end > TODAY);
});

// ── Owner fields ──────────────────────────────────────────────────────────
test("parseTaskOwnerFields: absent keys change nothing (old callers)", () => {
  assert.deepEqual(parseTaskOwnerFields({ title: "x" }), { ok: true, value: {} });
  assert.deepEqual(parseTaskOwnerFields({ owner: undefined }), { ok: true, value: {} });
});

test("parseTaskOwnerFields: normalizes owner, trims and collapses lines, empty clears", () => {
  const result = parseTaskOwnerFields({ owner: " Brent ", owner_label: "  PM ", status_line: "Line one.\n\n  Line   two. " });
  assert.deepEqual(result, { ok: true, value: { owner: "brent", owner_label: "PM", status_line: "Line one. Line two." } });
  assert.deepEqual(parseTaskOwnerFields({ owner_label: "", status_line: null }), {
    ok: true,
    value: { owner_label: null, status_line: null },
  });
});

test("parseTaskOwnerFields: rejects unknown owners, null owner, non-strings and long values", () => {
  assert.equal(parseTaskOwnerFields({ owner: "bob" }).ok, false);
  assert.equal(parseTaskOwnerFields({ owner: null }).ok, false);
  assert.equal(parseTaskOwnerFields({ owner_label: 5 }).ok, false);
  assert.match(parseTaskOwnerFields({ owner_label: "x".repeat(41) }).error, /40/);
  assert.equal(parseTaskOwnerFields({ owner_label: "x".repeat(40) }).ok, true);
  assert.match(parseTaskOwnerFields({ status_line: "y".repeat(281) }).error, /280/);
  assert.equal(parseTaskOwnerFields({ status_line: "y".repeat(280) }).ok, true);
  assert.equal(normalizeTaskOwner("AGENT"), "agent");
  assert.equal(normalizeTaskOwner("you"), null);
});

// ── Markdown ──────────────────────────────────────────────────────────────
test("markdown: headings, paragraphs with line breaks, bold/italic/code", () => {
  const blocks = parseMarkdown("# Title\n\nFirst **bold** and *it* and `code`.\nSecond line\n\n## Sub");
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "paragraph", "heading"]);
  assert.equal(blocks[0].level, 1);
  const para = blocks[1].children;
  assert.deepEqual(para.map((n) => n.type), ["text", "strong", "text", "em", "text", "code", "text", "br", "text"]);
  assert.equal(para[1].children[0].value, "bold");
});

test("markdown: task lists (the raw '- [ ]' Brent saw), nested and ordered lists", () => {
  const [list] = parseMarkdown("- [x] Siri\n- [ ] Split View\n  - nested detail\n- plain");
  assert.equal(list.type, "list");
  assert.deepEqual(list.items.map((item) => item.checked), [true, false, null]);
  assert.equal(list.items[1].children[1].type, "list");
  assert.equal(list.items[1].children[1].items[0].children[0].children[0].value, "nested detail");
  const [ordered] = parseMarkdown("3. three\n4. four");
  assert.equal(ordered.ordered, true);
  assert.equal(ordered.start, 3);
  assert.equal(ordered.items.length, 2);
});

test("markdown: a blank line between items keeps one list; lazy continuation joins the item", () => {
  const blocks = parseMarkdown("- one\n\n- two\ncontinued\n\nAfter");
  assert.deepEqual(blocks.map((b) => b.type), ["list", "paragraph"]);
  assert.equal(blocks[0].items.length, 2);
  assert.deepEqual(blocks[0].items[1].children[0].children.map((n) => n.type), ["text", "br", "text"]);
});

test("markdown: GFM tables with alignment and escaped pipes", () => {
  const [table] = parseMarkdown("| Project | Id |\n| :--- | ---: |\n| A \\| B | 1 |\n| C | 2 |");
  assert.equal(table.type, "table");
  assert.deepEqual(table.align, ["left", "right"]);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0][0][0].value, "A | B");
});

test("markdown: fenced code, blockquote, rule", () => {
  const blocks = parseMarkdown("```sql\nselect 1;\n**not bold**\n```\n> quoted\n\n---");
  assert.deepEqual(blocks.map((b) => b.type), ["code", "blockquote", "hr"]);
  assert.equal(blocks[0].lang, "sql");
  assert.equal(blocks[0].value, "select 1;\n**not bold**");
});

test("markdown links: safe schemes only; bare URLs lose trailing punctuation", () => {
  assert.equal(safeHref("https://claude.ai/x"), "https://claude.ai/x");
  assert.equal(safeHref("/r/task/1"), "/r/task/1");
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("//evil.example"), null);
  // Browsers treat "\" like "/", so "/\evil.example/x" is protocol-relative too.
  assert.equal(safeHref("/\\evil.example/x"), null);
  assert.equal(parseInline("[x](/\\evil.example/x)").some((n) => n.type === "link"), false);
  assert.equal(safeHref("data:text/html,x"), null);
  const bad = parseInline("[click](javascript:alert(1))");
  assert.equal(bad.some((n) => n.type === "link"), false);
  const good = parseInline("[mockup](https://claude.ai/artifact/abc)");
  assert.equal(good[0].type, "link");
  const bare = parseInline("See https://example.com/a_b, then (https://example.com/c).");
  const links = bare.filter((n) => n.type === "link").map((n) => n.href);
  assert.deepEqual(links, ["https://example.com/a_b", "https://example.com/c"]);
});

test("markdown: snake_case and lone asterisks stay text; raw HTML stays text", () => {
  const nodes = parseInline("owner_label and status_line, 2 * 3 * 4");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].value, "owner_label and status_line, 2 * 3 * 4");
  const html = parseInline("<script>alert(1)</script>");
  assert.deepEqual(html, [{ type: "text", value: "<script>alert(1)</script>" }]);
  assert.equal(parseInline("\\*literal\\*")[0].value, "*literal*");
});

test("markdown: empty and pathological input", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown(null), []);
  const deep = Array.from({ length: 40 }, (_, i) => `${"  ".repeat(i)}- level ${i}`).join("\n");
  const started = Date.now();
  assert.equal(parseMarkdown(deep).length, 1);
  const stars = "*".repeat(5000) + "a" + "_".repeat(5000);
  parseInline(stars);
  assert.ok(Date.now() - started < 2000, "parser stays fast on hostile input");
});

console.log(`\n${passed} passed`);
