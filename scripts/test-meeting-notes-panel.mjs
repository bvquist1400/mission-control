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
const calendarIdentityModule = await import(
  pathToFileURL(path.join(cwd, "src/lib/calendar-event-identity.ts")).href
);

const { DEFAULT_MEETING_NOTE_TYPE } = utilitiesModule;
const { buildMeetingNoteEntityId, createMeetingNote, listMeetingNotes } = notesClientModule;
const { parseCalendarEntityId } = calendarIdentityModule;

const meetingEvent = {
  source: "graph",
  externalEventId: "evt-123",
  startAt: "2026-03-25T14:00:00.000Z",
};

assert.equal(DEFAULT_MEETING_NOTE_TYPE, "meeting_note");

const canonicalEntityId = buildMeetingNoteEntityId(meetingEvent);
assert.equal(canonicalEntityId, "calendar:Z3JhcGh8ZXZ0LTEyM3wyMDI2LTAzLTI1VDE0OjAwOjAwLjAwMFo");
assert.deepEqual(parseCalendarEntityId(canonicalEntityId), meetingEvent);

const originalBuffer = globalThis.Buffer;
if (typeof globalThis.btoa === "function" && typeof globalThis.atob === "function") {
  globalThis.Buffer = undefined;
  try {
    assert.equal(buildMeetingNoteEntityId(meetingEvent), canonicalEntityId);
    assert.deepEqual(parseCalendarEntityId(canonicalEntityId), meetingEvent);
  } finally {
    globalThis.Buffer = originalBuffer;
  }
}

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

  await listMeetingNotes(meetingEvent);
  assert.equal(listCalls.length, 1);
  const listUrl = new URL(listCalls[0].input, "https://mission-control.test");
  assert.equal(listUrl.pathname, "/api/notes");
  assert.equal(listUrl.searchParams.get("entity_type"), "calendar_event");
  assert.equal(listUrl.searchParams.get("entity_id"), canonicalEntityId);

  const createCalls = [];
  global.fetch = async (input, init = {}) => {
    createCalls.push({ input: String(input), init });

    if (createCalls.length === 1) {
      return new Response(
        JSON.stringify({
          id: "note-1",
          user_id: "user-1",
          title: "Quarterly planning sync",
          body_markdown: "",
          note_type: "meeting_note",
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
        title: "Quarterly planning sync",
        body_markdown: "Prep notes",
        note_type: "meeting_note",
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

  await createMeetingNote(meetingEvent, {
    title: "Quarterly planning sync",
    body_markdown: "Prep notes",
    note_type: DEFAULT_MEETING_NOTE_TYPE,
    pinned: false,
  });

  assert.equal(createCalls.length, 3);
  assert.equal(createCalls[0].input, "/api/notes");
  assert.equal(createCalls[1].input, "/api/notes/note-1/links");
  assert.equal(createCalls[2].input, "/api/notes/note-1");

  const createPayload = JSON.parse(createCalls[0].init.body);
  assert.equal(createPayload.note_type, "meeting_note");
  assert.equal(createPayload.title, "Quarterly planning sync");

  const linkPayload = JSON.parse(createCalls[1].init.body);
  assert.deepEqual(linkPayload, {
    entity_type: "calendar_event",
    entity_id: canonicalEntityId,
    link_role: "primary_context",
  });
} finally {
  global.fetch = originalFetch;
}

console.log("Meeting notes panel client tests passed.");
