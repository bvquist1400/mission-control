// Craft S4 fixtures: the shapes of the One Row Scarf and the Sophie Hood (structure, counts and row labels as
// planned; the pattern text is made up, no personal text). Each builder returns a plain description:
//   { project: { name, tags }, sections: [{ key, name }], tasks: [{ key, section, title, unit_count, work_type, created, items: [text] }] }
// `created` is a minute offset, so tests can make the scarf's later tasks older than its first ones.

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** One Row Scarf: one section, four row tasks made out of order (201+ before 1–200), a cast-on before Row 1, checks. */
export function oneRowScarf() {
  const row = (n, arrow = true) => `Row ${n} · (k2, k1tbl, p1) ×7, k2${arrow ? " → 30" : ""}`;
  const first = ["Cast on 30", ...range(1, 28).map((n) => row(n)), "Check: gauge at about 4\" wide; measure before going on",
    ...range(29, 100).map((n) => row(n)), "Check: still 30 sts; edges look even"];
  return {
    project: { name: "Fake One Row Scarf", tags: ["personal", "knitting"] },
    sections: [{ key: "scarf", name: "1. Scarf" }, { key: "finish", name: "2. Finishing" }],
    tasks: [
      // Made first: the later rows (the "earlier break" in the live project).
      { key: "r201", section: "scarf", title: "Rows 201–300", unit_count: 3000, work_type: "one-row", created: 0, items: range(201, 300).map((n) => row(n, n % 10 === 1)) },
      { key: "r301", section: "scarf", title: "Rows 301–385 + bind off (provisional)", unit_count: 2550, work_type: "one-row", created: 1,
        items: [...range(301, 385).map((n) => row(n, n % 5 === 1)), "Bind off (provisional), leave a long tail"] },
      { key: "r1", section: "scarf", title: "Cast on 30 + rows 1–100", unit_count: 3030, work_type: "one-row", created: 2, items: first },
      { key: "r101", section: "scarf", title: "Rows 101–200", unit_count: 3000, work_type: "one-row", created: 3, items: range(101, 200).map((n) => row(n)) },
      { key: "fin", section: "finish", title: "Finishing", unit_count: null, work_type: null, created: 4, items: ["Weave in ends", "Block flat"] },
    ],
  };
}

/** Sophie Hood: four sections; labels restart per task and every 8 rows inside the rep tasks; holder rows; checks. */
export function sophieHood() {
  const reps = (kind, start) => range(1, 5).flatMap((rep) => {
    const before = kind === "inc" ? start + rep - 1 : start - rep + 1;
    const after = kind === "inc" ? before + 1 : before - 1;
    return [
      `Row 1 (rep ${rep}) · ${kind === "inc" ? "WS inc: k2, kfb, k to end" : "RS dec: k2, k2tog, k to end"} → ${after}`,
      ...range(2, 8).map((n) => `Row ${n} (rep ${rep}) · knit${n === 8 ? ` → ${after}` : ""}`),
    ];
  });
  return {
    project: { name: "Fake Sophie Hood", tags: ["personal", "knitting"] },
    sections: [
      { key: "s1", name: "1. Scarf 1 (increases)" }, { key: "hood", name: "2. Hood" },
      { key: "s2", name: "3. Scarf 2 (decreases)" }, { key: "fin", name: "4. Finishing" },
    ],
    tasks: [
      { key: "prep", section: "s1", title: "Scarf 1 · Prep: wind yarn, swatch", unit_count: null, work_type: null, created: 0, items: ["Wind the yarn", "Knit a swatch"] },
      { key: "tip", section: "s1", title: "Scarf 1 · Tip: cast on + rows 1–6 (6 sts)", unit_count: 42, work_type: "garter", created: 1,
        items: ["Cast on 6", ...range(1, 6).map((n) => `Row ${n} · WS: k6${n === 1 ? " → 6" : ""}`)] },
      { key: "inc", section: "s1", title: "Increases reps 1–5", unit_count: 355, work_type: "garter", created: 2, items: [...reps("inc", 6), "Check: 11 sts"] },
      { key: "s1st", section: "s1", title: "Scarf 1 · Straight: rows 1–272 (11 sts)", unit_count: 2992, work_type: "garter", created: 3,
        items: range(1, 272).map((n) => `Row ${n} · knit${n === 1 ? " → 11" : ""}`) },
      { key: "right", section: "hood", title: "Hood · Right side straight: rows 1–33 (42 sts)", unit_count: 1386, work_type: "garter", created: 4,
        items: ["Row 1 · RS: 3 sts to holder, k to last 3, k3 → 42", ...range(2, 33).map((n) => `Row ${n} · knit`), "Check: 42 sts"] },
      { key: "left", section: "hood", title: "Hood · Left side straight: rows 1–33 (42 sts)", unit_count: 1386, work_type: "garter", created: 5,
        items: ["Row 1 · WS: slip 3 sts to a holder, k to end → 42", ...range(2, 33).map((n) => `Row ${n} · knit`)] },
      { key: "top", section: "hood", title: "Hood · Top: rows 1–69", unit_count: 2898, work_type: "garter", created: 6,
        items: range(1, 69).map((n) => `Row ${n} · knit${n === 69 ? " → 42" : ""}`) },
      { key: "rejoin", section: "s2", title: "Scarf 2 · Rejoin: rows 1–7", unit_count: 312, work_type: "garter", created: 7,
        items: ["Row 1 · knit to end, put the 3 held i-cord sts back → 45", ...range(2, 7).map((n) => `Row ${n} · knit`)] },
      { key: "dec", section: "s2", title: "Scarf 2 · Decreases reps 1–5", unit_count: 1685, work_type: "garter", created: 8, items: reps("dec", 45) },
      { key: "s2st", section: "s2", title: "Scarf 2 · Straight: rows 1–270 (40 sts)", unit_count: 10800, work_type: "garter", created: 9,
        items: [...range(1, 270).map((n) => `Row ${n} · knit`), "Check: 40 sts; ends woven"] },
      { key: "fin", section: "fin", title: "Finishing", unit_count: null, work_type: null, created: 10, items: ["Block", "Weave in ends"] },
    ],
  };
}

/** A plain SetupSnapshot (the shape loadSetupSnapshot returns) from a description, with stable fake ids. */
export function snapshotOf(desc, { projectId = "00000000-0000-4000-8000-0000000000aa", onCraftScreen = false } = {}) {
  let n = 0;
  const id = (prefix) => `${prefix}${String(++n).padStart(12, "0")}`;
  const sectionIds = new Map(desc.sections.map((s) => [s.key, id("10000000-0000-4000-8000-")]));
  const out = {
    project: { id: projectId, name: desc.project.name, tags: desc.project.tags },
    on_craft_screen: onCraftScreen,
    sections: desc.sections.map((s, i) => ({ id: sectionIds.get(s.key), sort_order: i, created_at: "2026-11-01T00:00:00.000Z", name: s.name })),
    tasks: [], items: [],
  };
  for (const t of desc.tasks) {
    const taskId = id("20000000-0000-4000-8000-");
    out.tasks.push({ id: taskId, section_id: sectionIds.get(t.section) ?? null, title: t.title, is_sample: false,
      created_at: new Date(Date.UTC(2026, 10, 2, 0, t.created)).toISOString(), unit_count: t.unit_count === null ? null : String(t.unit_count), work_type: t.work_type });
    t.items.forEach((text, j) => out.items.push({ id: id("30000000-0000-4000-8000-"), task_id: taskId, text, is_done: false, sort_order: j, unit_count: null, craft_part_id: null, work_type: null }));
  }
  return out;
}

/** SQL that inserts a description for a user (fresh uuids), returning { projectId, sql, taskIds: { key: id } } ids made in JS. */
export function insertSql(desc, owner, randomUUID) {
  const lit = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
  const projectId = randomUUID();
  const sectionIds = Object.fromEntries(desc.sections.map((s) => [s.key, randomUUID()]));
  const taskIds = Object.fromEntries(desc.tasks.map((t) => [t.key, randomUUID()]));
  const lines = [`INSERT INTO projects (id, user_id, name, tags) VALUES ('${projectId}','${owner}',${lit(desc.project.name)}, ARRAY[${desc.project.tags.map(lit).join(",")}]::text[]);`];
  desc.sections.forEach((s, i) => lines.push(`INSERT INTO project_sections (id, user_id, project_id, name, sort_order, created_at) VALUES ('${sectionIds[s.key]}','${owner}','${projectId}',${lit(s.name)},${i},'2026-11-01T00:00:00Z');`));
  for (const t of desc.tasks) {
    lines.push(`INSERT INTO tasks (id, user_id, project_id, section_id, title, status, unit_count, work_type, created_at) VALUES ('${taskIds[t.key]}','${owner}','${projectId}',${t.section ? `'${sectionIds[t.section]}'` : "NULL"},${lit(t.title)},'Planned',${t.unit_count ?? "NULL"},${lit(t.work_type)},'${new Date(Date.UTC(2026, 10, 2, 0, t.created)).toISOString()}');`);
    if (t.items.length) lines.push(`INSERT INTO task_checklist_items (user_id, task_id, text, sort_order) VALUES ${t.items.map((text, j) => `('${owner}','${taskIds[t.key]}',${lit(text)},${j})`).join(",")};`);
  }
  return { projectId, sectionIds, taskIds, sql: lines.join("\n") };
}
