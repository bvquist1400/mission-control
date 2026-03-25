#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const helpersModule = await import(
  pathToFileURL(path.join(cwd, "src/components/notes/note-panel-utils.ts")).href
);

const {
  IMPLEMENTATION_NOTE_LINK_ROLE,
  buildNotePreview,
  filterNotesForPanel,
  formatDecisionStatusLabel,
  formatNoteTypeLabel,
  sortNotesForPanel,
} = helpersModule;

function createNote(id, overrides = {}) {
  return {
    id,
    user_id: "user-1",
    title: `Note ${id}`,
    body_markdown: "",
    note_type: "application_note",
    status: "active",
    pinned: false,
    last_reviewed_at: null,
    created_at: "2026-03-01T09:00:00.000Z",
    updated_at: "2026-03-01T09:00:00.000Z",
    links: [],
    task_links: [],
    decisions: [],
    ...overrides,
  };
}

assert.equal(IMPLEMENTATION_NOTE_LINK_ROLE, "primary_context");
assert.equal(formatNoteTypeLabel("application_note"), "Implementation note");
assert.equal(formatDecisionStatusLabel("superseded"), "Superseded");

const sorted = sortNotesForPanel([
  createNote("older-pinned", {
    pinned: true,
    updated_at: "2026-03-10T10:00:00.000Z",
  }),
  createNote("recent-active", {
    updated_at: "2026-03-18T10:00:00.000Z",
  }),
  createNote("newest-pinned", {
    pinned: true,
    updated_at: "2026-03-20T10:00:00.000Z",
  }),
  createNote("archived", {
    status: "archived",
    updated_at: "2026-03-19T10:00:00.000Z",
  }),
]);

assert.deepEqual(sorted.map((note) => note.id), [
  "newest-pinned",
  "older-pinned",
  "archived",
  "recent-active",
]);

assert.deepEqual(
  filterNotesForPanel(sorted, false).map((note) => note.id),
  ["newest-pinned", "older-pinned", "recent-active"]
);
assert.deepEqual(
  filterNotesForPanel(sorted, true).map((note) => note.id),
  ["newest-pinned", "older-pinned", "archived", "recent-active"]
);

const preview = buildNotePreview(
  "## Heading\n- Review [launch plan](https://example.com)\n- Confirm `cutover` checklist and next steps",
  60
);
assert(!preview.includes("["));
assert(!preview.includes("]("));
assert(preview.includes("launch plan"));
assert(preview.endsWith("…"));
assert.equal(buildNotePreview("   "), "No details yet.");

console.log("Implementation notes panel helper tests passed.");
