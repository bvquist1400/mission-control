/**
 * Compile-time drift detection between the hand-written domain interfaces in
 * `database.ts` and the generated schema truth in `supabase.generated.ts`.
 *
 * If a migration adds/removes/renames a column — or makes a column nullable —
 * without `database.ts` being updated, `npx tsc --noEmit` fails here instead
 * of the mismatch surfacing as a runtime bug.
 *
 * Regenerate the schema types after every migration: `npm run gen:types`.
 *
 * Checks per table:
 *  1. Key parity — the domain interface has exactly the DB's columns.
 *  2. Dangerous nullability — a DB-nullable column must be nullable in the
 *     domain type too (the reverse is allowed; narrowing unions like
 *     TaskStatus over DB `string` is also allowed).
 */

import type { Database } from './supabase.generated';
import type {
  Commitment,
  Implementation,
  Project,
  ProjectSection,
  ProjectStatusUpdate,
  Sprint,
  Stakeholder,
  StatusUpdate,
  Task,
  TaskChecklistItem,
  TaskComment,
  TaskStatusTransition,
} from './database';

type Row<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row'];

/** Resolves to `true` only when both key sets are identical; otherwise the offending keys. */
type KeysMatch<Hand, DbRow> = [Exclude<keyof DbRow, keyof Hand>, Exclude<keyof Hand, keyof DbRow>] extends [
  never,
  never,
]
  ? true
  : { missing_in_hand_written_type: Exclude<keyof DbRow, keyof Hand>; not_in_database: Exclude<keyof Hand, keyof DbRow> };

/** Resolves to `true` unless a DB-nullable column is non-nullable in the hand-written type. */
type NullabilityMatches<Hand, DbRow> = Exclude<
  {
    [K in keyof DbRow & keyof Hand]: null extends DbRow[K] ? (null extends Hand[K] ? true : K) : true;
  }[keyof DbRow & keyof Hand],
  true
> extends never
  ? true
  : {
      db_nullable_but_hand_written_type_is_not: Exclude<
        { [K in keyof DbRow & keyof Hand]: null extends DbRow[K] ? (null extends Hand[K] ? true : K) : true }[keyof DbRow &
          keyof Hand],
        true
      >;
    };

type Assert<T extends true> = T;

/* eslint-disable @typescript-eslint/no-unused-vars */
type _TaskKeys = Assert<KeysMatch<Task, Row<'tasks'>>>;
type _TaskNulls = Assert<NullabilityMatches<Task, Row<'tasks'>>>;
type _ImplementationKeys = Assert<KeysMatch<Implementation, Row<'implementations'>>>;
type _ImplementationNulls = Assert<NullabilityMatches<Implementation, Row<'implementations'>>>;
type _ProjectKeys = Assert<KeysMatch<Project, Row<'projects'>>>;
type _ProjectNulls = Assert<NullabilityMatches<Project, Row<'projects'>>>;
type _ProjectSectionKeys = Assert<KeysMatch<ProjectSection, Row<'project_sections'>>>;
type _ProjectSectionNulls = Assert<NullabilityMatches<ProjectSection, Row<'project_sections'>>>;
type _SprintKeys = Assert<KeysMatch<Sprint, Row<'sprints'>>>;
type _SprintNulls = Assert<NullabilityMatches<Sprint, Row<'sprints'>>>;
type _StakeholderKeys = Assert<KeysMatch<Stakeholder, Row<'stakeholders'>>>;
type _StakeholderNulls = Assert<NullabilityMatches<Stakeholder, Row<'stakeholders'>>>;
type _CommitmentKeys = Assert<KeysMatch<Commitment, Row<'commitments'>>>;
type _CommitmentNulls = Assert<NullabilityMatches<Commitment, Row<'commitments'>>>;
type _StatusUpdateKeys = Assert<KeysMatch<StatusUpdate, Row<'status_updates'>>>;
type _StatusUpdateNulls = Assert<NullabilityMatches<StatusUpdate, Row<'status_updates'>>>;
type _TaskChecklistItemKeys = Assert<KeysMatch<TaskChecklistItem, Row<'task_checklist_items'>>>;
type _TaskChecklistItemNulls = Assert<NullabilityMatches<TaskChecklistItem, Row<'task_checklist_items'>>>;
type _TaskCommentKeys = Assert<KeysMatch<TaskComment, Row<'task_comments'>>>;
type _TaskCommentNulls = Assert<NullabilityMatches<TaskComment, Row<'task_comments'>>>;
type _TaskStatusTransitionKeys = Assert<KeysMatch<TaskStatusTransition, Row<'task_status_transitions'>>>;
type _TaskStatusTransitionNulls = Assert<NullabilityMatches<TaskStatusTransition, Row<'task_status_transitions'>>>;
type _ProjectStatusUpdateKeys = Assert<KeysMatch<ProjectStatusUpdate, Row<'project_status_updates'>>>;
type _ProjectStatusUpdateNulls = Assert<NullabilityMatches<ProjectStatusUpdate, Row<'project_status_updates'>>>;
/* eslint-enable @typescript-eslint/no-unused-vars */

export {};
