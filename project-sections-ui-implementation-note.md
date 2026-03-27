# Project Sections UI V1

## V1 surface
- Added a project-specific sections panel at [`src/components/projects/ProjectTaskSectionsPanel.tsx`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/projects/ProjectTaskSectionsPanel.tsx).
- The project detail page now uses that panel in [`src/components/projects/ProjectDetail.tsx`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/projects/ProjectDetail.tsx) instead of the old flat project-scoped task grid.
- Sections are now visible directly in project view as ordered groups. Empty sections still render so they can be managed before tasks are assigned.
- Tasks without a section render in an explicit trailing `Unsectioned` group when a project has sections.

## V1 interactions
- Project view supports section creation with name and `sort_order`.
- Existing sections can be renamed, reordered, and deleted from the project page.
- Deleting a section leaves tasks intact and immediately moves affected tasks into the `Unsectioned` bucket in the client, matching backend behavior.
- The project page inline task add flow now accepts an optional section assignment.
- Existing task detail editing now supports changing `section_id` in [`src/components/tasks/TaskMetaEditor.tsx`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/tasks/TaskMetaEditor.tsx).
- Changing a task’s project in the editor clears its section selection in the UI before save so the client matches the backend invariant.

## Intentional V1 limits
- This is a project-view slice only. The global backlog and implementation views still use the flat task table.
- Section assignment is available through task details and project-page task creation, but there is no global project-plus-section create flow yet.
- There is no drag-and-drop between sections.
- There is no drag-and-drop section reordering.
- There are no collapse/expand controls for section groups.
- The shared [`TaskGrid`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/src/components/tasks/TaskGrid.tsx) remains flat. Project sections are implemented as a project-specific wrapper rather than a full task-table architecture rewrite.

## Future scope
- Add drag-and-drop task moves between sections, with immediate `section_id` updates and optimistic regrouping.
- Add drag-and-drop section reordering or lighter-weight move up/down controls instead of numeric `sort_order` editing.
- Add a compact section selector to row-level project task editing if task movement in the modal feels too slow.
- Decide whether implementation view should optionally preserve project-section grouping for project-linked tasks.
- Extend global task creation so a selected project can drive available section options in the create form.
- Evaluate collapsible section groups, per-section summaries, and counts by status once the grouped project view settles.
- If the shared table needs sections in more than one surface, extract the grouping shell into a reusable task-grid family rather than continuing to special-case project view.
