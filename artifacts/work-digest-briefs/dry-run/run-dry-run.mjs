// Dry run, step 2: each hand-applied save payload goes through the real
// validator (parseSaveBriefInput) and the real saveBrief against an in-memory
// store holding only the fixture notes, so every work digest citation is
// checked against its note exactly as on a live save. Nothing leaves this
// process. Writes dry-run-result.json and dry-run-page.html next to it.
// Run from the repo root:
//   node --experimental-strip-types --loader ./scripts/alias-loader.mjs artifacts/work-digest-briefs/dry-run/run-dry-run.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".tsx")) {
      const output = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
        fileName: fileURLToPath(url),
      });
      return { format: "module", source: output.outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const here = (name) => new URL(`./${name}`, import.meta.url);
const src = (file) => new URL(`../../../src/${file}`, import.meta.url).href;
const validate = await import(src("lib/briefs/validate.ts"));
const service = await import(src("lib/briefs/service.ts"));
const cards = await import(src("components/briefs/cards.tsx"));
const tiles = await import(src("components/briefs/tiles.tsx"));
const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

const USER = "00000000-0000-4000-8000-000000000001"; // placeholder
const fixture = (name) => readFileSync(new URL(`../../../scripts/fixtures/work-digest/${name}`, import.meta.url), "utf8");
const filedLine = (when) => `Filed from the Cooper digest file on ${when}.\n`;
const legacy = fixture("work-digest-2026-10-28-pm.md");
const upgraded = legacy.replace("skipped_sensitive: 1", "still_waiting: 0\nskipped_sensitive: 1").replace(/^(owner: .*)$/gm, "$1\nstatus: open");
const NOTES = {
  am: { id: "00000000-0000-4000-8000-0000000000a1", user_id: USER, title: "Work digest 2026-10-29 AM", body_markdown: fixture("work-digest-2026-10-29-am.md") + filedLine("10/29/2026 7:41 AM ET"), status: "active" },
  pmFiled: { id: "00000000-0000-4000-8000-0000000000b2", user_id: USER, title: "Work digest 2026-10-28 PM", body_markdown: legacy + filedLine("10/28/2026 4:21 PM ET"), status: "active" },
  pmUpgraded: { id: "00000000-0000-4000-8000-0000000000b2", user_id: USER, title: "Work digest 2026-10-28 PM", body_markdown: upgraded + filedLine("10/28/2026 4:21 PM ET"), status: "active" },
};

function store(notes) {
  const tables = { briefs: [], brief_items: [], notes: notes.map((note) => ({ ...note })) };
  let seq = 0;
  return {
    tables,
    from(table) {
      const rows = (tables[table] ??= []);
      let op = "select", payload = null, single = null;
      const filters = [];
      const builder = {
        select: () => builder,
        insert: (value) => ((op = "insert"), (payload = Array.isArray(value) ? value : [value]), builder),
        update: (value) => ((op = "update"), (payload = value), builder),
        eq: (column, value) => (filters.push((row) => row[column] === value), builder),
        in: (column, values) => (filters.push((row) => values.includes(row[column])), builder),
        is: (column, value) => (filters.push((row) => (row[column] ?? null) === value), builder),
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => ((single = "maybe"), run()),
        single: () => ((single = "one"), run()),
        then: (resolve, reject) => run().then(resolve, reject),
      };
      function run() {
        let data;
        if (op === "insert") {
          const base = table === "briefs" ? { notified_at: null, notify_sent_at: null, notify_error: null, created_at: "dry-run", updated_at: "dry-run" } : { state: "open", created_task_id: null, prior_due: null, acted_at: null };
          data = payload.map((row) => ({ id: `dry-${++seq}`, ...base, ...structuredClone(row) }));
          rows.push(...data);
        } else if (op === "update") {
          data = rows.filter((row) => filters.every((filter) => filter(row)));
          for (const row of data) Object.assign(row, structuredClone(payload));
        } else data = rows.filter((row) => filters.every((filter) => filter(row)));
        data = structuredClone(data);
        if (single) data = data[0] ?? null;
        return Promise.resolve({ data, error: single === "one" && !data ? { code: "PGRST116" } : null });
      }
      return builder;
    },
    rpc: async () => ({ data: null, error: { message: "no rpc in the dry run" } }),
  };
}

const runs = [
  { file: "am-1029-save.json", now: "2026-10-29T11:58:00Z", notes: [NOTES.am] },
  { file: "eod-1028-as-filed-save.json", now: "2026-10-28T20:18:00Z", notes: [NOTES.pmFiled] },
  { file: "eod-1028-upgraded-save.json", now: "2026-10-28T20:18:00Z", notes: [NOTES.pmUpgraded] },
];

const results = [];
const sections = [];
const noop = () => {};
for (const run of runs) {
  const { _dry_run: about, ...raw } = JSON.parse(readFileSync(here(run.file), "utf8"));
  const text = JSON.stringify(raw);
  const parsed = validate.parseSaveBriefInput(raw, new Date(run.now));
  if (!parsed.ok) {
    results.push({ file: run.file, ok: false, errors: parsed.errors });
    continue;
  }
  const db = store(run.notes);
  let saved;
  try {
    saved = await service.saveBrief(db, USER, parsed.value, { appUrl: "http://localhost:3000", notifier: { send: async () => {} } });
  } catch (error) {
    results.push({ file: run.file, ok: false, errors: [error.message] });
    continue;
  }
  const brief = db.tables.briefs[0];
  const items = db.tables.brief_items.map((row) => ({ ...row, dismissed_reason: null, dismissed_note: null, choice: null }));
  results.push({
    file: run.file,
    about,
    ok: true,
    code: saved.code,
    appended: saved.appended.map((entry) => `#${entry.n} ${entry.title}`),
    skipped: saved.skipped,
    counts: saved.counts,
    stored_work_digest_note_ids: brief.content.work_digest_note_ids ?? [],
    stored_citations: items.map((item) => item.source.work_digest),
    tiles: (brief.content.tiles ?? []).map((tile) => tile.label),
    footnote: brief.content.footnote ?? null,
    names_the_ai: /claude/i.test(text),
  });

  const ctx = {
    tasks: {}, briefDate: brief.brief_date, dueChoice: "tomorrow", setDueChoice: noop, pickedDate: "", setPickedDate: noop, acceptDue: "tomorrow",
    meetingColor: () => "var(--m-1)", meetingLabel: (meeting) => meeting.title, pending: false, focused: false, draft: null, showSource: true,
    act: noop, startDismiss: noop, cancelDismiss: noop, setDraft: noop, toggleSource: noop, focus: noop, openSheet: noop,
  };
  const cardHtml = items.map((item) => renderToStaticMarkup(h(cards.CARD_REGISTRY[item.kind].Card, { item, ctx }))).join("");
  const mailTiles = (brief.content.tiles ?? []).filter((tile) => tile.key === "mail" || tile.key === "waiting");
  const bento = mailTiles.length ? renderToStaticMarkup(h(tiles.RecapBento, { tiles: mailTiles, onOpen: noop })) : "";
  const sheets = mailTiles.map((tile) => `<section class="sec"><div class="sec-h"><h2>${tile.label}</h2></div>${renderToStaticMarkup(h(tiles.TILE_REGISTRY.list.Sheet, { tile, tasks: {} }))}</section>`).join("");
  sections.push(`<h1 style="font:600 18px system-ui;margin:32px 0 8px">${saved.code} (dry run: ${run.file})</h1>${bento}${items.length ? `<section class="sec"><div class="sec-h"><h2>${cards.proposalSectionTitle(items)}</h2></div>${cardHtml}</section>` : ""}${sheets}<p class="foot" style="font:13px system-ui;opacity:.7">${brief.content.footnote ?? ""}</p>`);
}

writeFileSync(here("dry-run-result.json"), JSON.stringify(results, null, 2) + "\n");
const css = readFileSync(new URL("../../../src/components/briefs/brief-page.css", import.meta.url), "utf8");
writeFileSync(here("dry-run-page.html"), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Work digest dry run</title><style>${css}</style><div class="brief-page"><main style="max-width:980px;margin:0 auto;padding:16px">${sections.join("")}</main></div>\n`);
for (const result of results) console.log(result.file, result.ok ? `ok ${result.code} appended=${result.appended.length} skipped=${result.skipped.length} ai_named=${result.names_the_ai}` : `FAILED ${result.errors.join("; ")}`);
if (results.some((result) => !result.ok || result.names_the_ai)) process.exit(1);
