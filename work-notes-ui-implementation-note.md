# Work Notes UI Slices

## Family cleanup
- Extracted the repeated panel lifecycle and state rendering into [`src/components/notes/useNotesPanelController.ts`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/notes/useNotesPanelController.ts) and [`src/components/notes/NotesPanelShell.tsx`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/notes/NotesPanelShell.tsx).
- The shared layer now owns the duplicated load/refresh glue, pin/archive inline actions, archived-toggle behavior, and the common loading/error/empty/archived-only shell.
- Context-specific behavior intentionally stays local in each panel: entity identity, note creation/linking defaults, empty-state wording, optional task creation, and panel placement/styling.
- This keeps the three panels aligned without flattening implementation, meeting, and task behavior into one generic component with hidden switches.

## Panel placement
- Added the first UI slice at [`src/components/implementations/ImplementationDetail.tsx`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/implementations/ImplementationDetail.tsx) by inserting [`ImplementationNotesPanel`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/implementations/ImplementationNotesPanel.tsx) into the existing stacked implementation detail flow.
- The panel lives between Projects and Status Update Log so it stays visible without taking over the page.

## Flows implemented
- List all notes linked to the current implementation, sorted pinned-first and then by most recent update.
- Hide archived notes by default with a simple toggle to reveal them.
- Create a new note from the panel and auto-link it to the implementation using `primary_context`.
- Edit note title, body, type, pinned state, and archived/active status.
- Quick pin/unpin and archive/restore actions on each note card.
- Show linked task chips and decision summaries on each note when present.
- Create a task from a note and create a simple decision from a note, then refresh the panel state.

## Replication points
- [`src/components/notes/notes-client.ts`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/notes/notes-client.ts) is the thin client integration seam for future meeting/task panels.
- [`src/components/notes/note-panel-utils.ts`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/notes/note-panel-utils.ts) holds the shared note ordering, preview, and label helpers.
- The dialog components under [`src/components/notes`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/notes) are reusable for future context-specific note panels without forcing a global notes UI yet.

## Meeting context slice

### Insertion point
- Added the second slice to the existing calendar event context surface in [`src/app/calendar/page.tsx`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/app/calendar/page.tsx), directly under each event’s existing planner-context editor.
- Notes mount on demand through a simple Show Notes / Hide Notes toggle so the calendar page does not eagerly fetch notes for every event in the visible range.

### Reuse from the implementation slice
- [`src/components/calendar/MeetingNotesPanel.tsx`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/calendar/MeetingNotesPanel.tsx) mirrors the implementation panel flow instead of creating a new notes architecture.
- It reuses [`ImplementationNoteCard`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/implementations/ImplementationNoteCard.tsx), [`NoteEditorDialog`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/notes/NoteEditorDialog.tsx), [`CreateTaskFromNoteDialog`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/notes/CreateTaskFromNoteDialog.tsx), [`CreateDecisionFromNoteDialog`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/notes/CreateDecisionFromNoteDialog.tsx), and the shared helpers in [`notes-client.ts`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/notes/notes-client.ts) and [`note-panel-utils.ts`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/notes/note-panel-utils.ts).

### Meeting-specific differences
- The calendar API now returns the event `source` so the UI can build the canonical calendar event note entity ID through the shared helper, rather than assembling ad hoc strings.
- New notes default to `meeting_note`.
- Meeting-created tasks no longer force an implementation link when the meeting has no implementation context available.

### Next reuse seam
- The next slice should likely be task-context notes, reusing the same note card and dialogs again while deciding whether task detail deserves its own panel wrapper or can live inside the existing task modal flow.

## Task context slice

### Insertion point
- Added the third slice inside the existing task detail surface: [`src/components/tasks/TaskDetailModal.tsx`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/tasks/TaskDetailModal.tsx).
- The notes panel lives after the existing checklist / dependencies / comments grid so core task execution controls stay higher in the modal.

### Reuse from the existing notes slices
- [`src/components/tasks/TaskNotesPanel.tsx`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/tasks/TaskNotesPanel.tsx) mirrors the same loading, empty, archived, create, edit, pin, archive, and decision flows used in the implementation and meeting panels.
- It reuses [`ImplementationNoteCard`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/implementations/ImplementationNoteCard.tsx), [`NoteEditorDialog`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/notes/NoteEditorDialog.tsx), [`CreateDecisionFromNoteDialog`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/notes/CreateDecisionFromNoteDialog.tsx), and the shared client/util helpers under [`src/components/notes`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/notes).

### Task-specific defaults and differences
- New task notes default to `working_note`.
- Task context uses the task entity as the `primary_context` note link.
- The panel deliberately does **not** expose “Create Task” from a task note. In task-detail UX that action felt too recursive alongside the existing checklist and dependency surfaces, so task notes keep decision capture and linked-task display without implying a subtasks model.
- Task-context note creation intentionally uses only the polymorphic task note link, not a redundant `note_tasks` row for the current task itself.

### Shared-panel signal
- After three slices, there is now a clear family resemblance, and the shared controller/shell now absorb the repeated mechanics. The panel wrappers still differ mainly by entity identity, default note type, optional actions, and embedding surface, and those differences should stay local.
- A future notes surface should follow the same split: put loading/action plumbing in the shared layer only when it is truly identical, and keep context defaults explicit at the panel boundary.
