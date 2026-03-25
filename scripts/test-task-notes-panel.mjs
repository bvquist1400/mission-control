#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const utilitiesModule = await import(
  pathToFileURL(path.join(cwd, "src/components/notes/note-panel-utils.ts")).href
);
const notesClientModule = await import(
  pathToFileURL(path.join(cwd, "src/components/notes/notes-client.ts")).href
);

const { DEFAULT_TASK_NOTE_TYPE, TASK_NOTE_LINK_ROLE } = utilitiesModule;
const { createTaskNote, listTaskNotes } = notesClientModule;

assert.equal(DEFAULT_TASK_NOTE_TYPE, "working_note");
assert.equal(TASK_NOTE_LINK_ROLE, "primary_context");

const originalFetch = global.fetch;

try {
  const listCalls = [];
  global.fetch = async (input, init) => {
    listCalls.push({ input: String(input), init });
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await listTaskNotes("task-123");
  assert.equal(listCalls.length, 1);
  const listUrl = new URL(listCalls[0].input, "https://mission-control.test");
  assert.equal(listUrl.pathname, "/api/notes");
  assert.equal(listUrl.searchParams.get("entity_type"), "task");
  assert.equal(listUrl.searchParams.get("entity_id"), "task-123");

  const createCalls = [];
  global.fetch = async (input, init = {}) => {
    createCalls.push({ input: String(input), init });

    if (createCalls.length === 1) {
      return new Response(
        JSON.stringify({
          id: "note-1",
          user_id: "user-1",
          title: "Task execution context",
          body_markdown: "",
          note_type: "working_note",
          status: "active",
          pinned: false,
          last_reviewed_at: null,
          created_at: "2026-03-25T13:00:00.000Z",
          updated_at: "2026-03-25T13:00:00.000Z",
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (createCalls.length === 2) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        id: "note-1",
        user_id: "user-1",
        title: "Task execution context",
        body_markdown: "Track the exact next steps here.",
        note_type: "working_note",
        status: "active",
        pinned: false,
        last_reviewed_at: null,
        created_at: "2026-03-25T13:00:00.000Z",
        updated_at: "2026-03-25T13:05:00.000Z",
        links: [],
        task_links: [],
        decisions: [],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  };

  await createTaskNote("task-123", {
    title: "Task execution context",
    body_markdown: "Track the exact next steps here.",
    note_type: DEFAULT_TASK_NOTE_TYPE,
    pinned: false,
  });

  assert.equal(createCalls.length, 3);
  assert.equal(createCalls[0].input, "/api/notes");
  assert.equal(createCalls[1].input, "/api/notes/note-1/links");
  assert.equal(createCalls[2].input, "/api/notes/note-1");

  const createPayload = JSON.parse(createCalls[0].init.body);
  assert.equal(createPayload.note_type, "working_note");
  assert.equal(createPayload.title, "Task execution context");

  const linkPayload = JSON.parse(createCalls[1].init.body);
  assert.deepEqual(linkPayload, {
    entity_type: "task",
    entity_id: "task-123",
    link_role: "primary_context",
  });
} finally {
  global.fetch = originalFetch;
}

console.log("Task notes panel client tests passed.");
