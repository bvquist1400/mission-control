import { NextRequest, NextResponse } from 'next/server';
import {
  ProjectSectionServiceError,
  resolveTaskProjectSectionState,
  validateTaskSectionAssignment,
} from '@/lib/project-sections';
import { normalizeTaskTags } from '@/lib/task-tags';
import {
  normalizeTaskWithRelations,
  TASK_WITH_RELATIONS_SELECT,
} from '@/lib/task-relations';
import { queueTaskStatusTransition } from '@/lib/task-status-transitions';
import { getHighPriorityStakeholderNames, recalculateTaskPriority } from '@/lib/priority';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import {
  addFamcalTaskComment,
  checkFamcalStatusTransition,
  FAMCAL_ELIGIBLE_FIELD,
  FAMCAL_REQUIRED_TAG,
  fetchFamcalVisibleTask,
  isFamcalEligibleRow,
  parseFamcalTaskPatch,
  projectTaskForFamcal,
} from '@/lib/famcal-api-key';
import { validateOptionalTimestamp } from '@/lib/validate';
import { DependencyReadIncompleteError, fetchTaskDependencyLinks } from '@/lib/task-dependency-links';
import {
  applyTaskDateCascade,
  buildCascadeReply,
  CASCADE_CONFIRM_THRESHOLD,
  cascadeRootNotice,
  cascadeTrigger,
  DEFAULT_CASCADE_MODE,
  fetchCascadeProjects,
  loadCascadeGraph,
  parseCascadeOptions,
  planTaskDateCascade,
  prepareCascadeApplyMoves,
  projectFlagsForMoves,
  type CascadeApplyMove,
  type CascadeOptions,
  type CascadePlan,
  type CascadeReply,
} from '@/lib/task-date-cascade';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  externalSourceConflictPayload,
  isTaskExternalSourceUniqueViolation,
  normalizeExternalSourceId,
  normalizeExternalSourceValue,
} from '@/lib/task-external-source';
import type { Task, TaskStatus, TaskType, BlockedReason } from '@/types/database';
import { parseTaskOwnerFields } from '@/lib/task-owner';
import { normalizeUnitCount, normalizeWorkType } from '@/lib/pace';

const VALID_STATUSES: TaskStatus[] = ['Backlog', 'Planned', 'In Progress', 'Blocked/Waiting', 'Parked', 'Missed', 'Done'];
const VALID_TASK_TYPES: TaskType[] = ['Task', 'Ticket', 'MeetingPrep', 'FollowUp', 'Admin', 'Build'];
const VALID_BLOCKED_REASONS: BlockedReason[] = ['prerequisite', 'need_info', 'decision', 'approval', 'external', 'other'];
function isValidStatus(value: string): value is TaskStatus {
  return VALID_STATUSES.includes(value as TaskStatus);
}

function isValidBlockedReason(value: string): value is BlockedReason {
  return VALID_BLOCKED_REASONS.includes(value as BlockedReason);
}

function isValidTaskType(value: string): value is TaskType {
  return VALID_TASK_TYPES.includes(value as TaskType);
}

function asStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const TASK_MOVE_WITH_SESSIONS_ERROR =
  'This task has logged work sessions in its project, so it can\'t move to another project. Delete or move those sessions first (list_work_sessions / delete_work_session).';

// GET /api/tasks/[id] - Get a single task
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { id } = await params;

    const isFamcalKey = auth.context.authSource === 'famcal_api_key';
    let query = supabase
      .from('tasks')
      .select(TASK_WITH_RELATIONS_SELECT)
      .eq('id', id)
      .eq('user_id', userId);
    if (isFamcalKey) {
      // FamCal-eligible only (personal tag; standalone or in a personal project; no sprint).
      query = query.contains('tags', [FAMCAL_REQUIRED_TAG]).eq(FAMCAL_ELIGIBLE_FIELD, true);
    }
    const { data, error } = await query.single();

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }
      throw error;
    }

    // The FamCal key sees only eligible personal tasks; anything else looks missing.
    // What it does see is the FamCal projection: no work project, application,
    // sprint or section (src/lib/famcal-api-key.ts, projectTaskForFamcal).
    if (auth.context.authSource === 'famcal_api_key') {
      if (!isFamcalEligibleRow(data as Record<string, unknown>)) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }
      // Linked tasks the key can't read by id come back as "Another task" placeholders.
      const famcalLinks = await fetchTaskDependencyLinks(supabase, userId, id, { famcal: true });
      return NextResponse.json({ ...projectTaskForFamcal(data as Record<string, unknown>), ...famcalLinks });
    }

    const links = await fetchTaskDependencyLinks(supabase, userId, id, { famcal: false });
    return NextResponse.json({ ...normalizeTaskWithRelations(data as Record<string, unknown>), ...links });
  } catch (error) {
    if (error instanceof DependencyReadIncompleteError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    console.error('Error fetching task:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PATCH /api/tasks/[id] - Update a task
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;

    // The FamCal key may only close/reopen a personal task or move its dates.
    // A status change is validated against the status read here, and the UPDATE
    // below only lands while the task still has that status (else 409).
    const isFamcalKey = auth.context.authSource === 'famcal_api_key';
    let famcalExpectedStatus: TaskStatus | null = null;
    if (isFamcalKey) {
      const famcalPatch = parseFamcalTaskPatch(body);
      if (!famcalPatch.ok) {
        return NextResponse.json({ error: famcalPatch.error }, { status: 400 });
      }

      const visibleTask = await fetchFamcalVisibleTask(supabase, userId, id);
      if (!visibleTask) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }

      if (typeof famcalPatch.value.status === 'string') {
        const transitionError = checkFamcalStatusTransition(visibleTask.status, famcalPatch.value.status);
        if (transitionError) {
          return NextResponse.json({ error: transitionError }, { status: 400 });
        }
        famcalExpectedStatus = visibleTask.status;
      }
    }

    // Cascade due dates (S1): who waits on this task moves too when its due date
    // moves later. The FamCal key can't send these keys (its allowlist refuses
    // them); it always gets the default same-gap cascade over FamCal-eligible
    // tasks, and its reply stays projectTaskForFamcal.
    let cascadeOptions: CascadeOptions = { cascade: true, mode: DEFAULT_CASCADE_MODE, confirm: false };
    if (!isFamcalKey) {
      const parsedCascade = parseCascadeOptions(body);
      if (!parsedCascade.ok) {
        return NextResponse.json({ error: parsedCascade.error }, { status: 400 });
      }
      cascadeOptions = parsedCascade.value;
    }

    const allowedFields = [
      'title',
      'description',
      'implementation_id',
      'project_id',
      'section_id',
      'sprint_id',
      'status',
      'task_type',
      'estimated_minutes',
      'actual_minutes',
      'estimate_source',
      'due_at',
      'needs_review',
      'blocker',
      'waiting_on',
      'blocked_reason',
      'follow_up_at',
      'tags',
      'stakeholder_mentions',
      'priority_score',
      'pinned_excerpt',
      'pinned',
      'source_type',
      'source_url',
      'external_source_system',
      'external_source_id',
      'unit_count',
      'work_type',
      'is_sample',
    ];

    // owner / owner_label / status_line are validated together (migration 056).
    const ownerFields = parseTaskOwnerFields(body);
    if (!ownerFields.ok) {
      return NextResponse.json({ error: ownerFields.error }, { status: 400 });
    }

    const updates: Record<string, unknown> = { ...ownerFields.value };
    for (const field of allowedFields) {
      if (!(field in body)) {
        continue;
      }

      const value = body[field];
      if (field === 'implementation_id') {
        updates[field] = asStringOrNull(value);
      } else if (field === 'project_id') {
        updates[field] = asStringOrNull(value);
      } else if (field === 'section_id') {
        updates[field] = asStringOrNull(value);
      } else if (field === 'sprint_id') {
        updates[field] = asStringOrNull(value);
      } else if (field === 'waiting_on') {
        updates[field] = asStringOrNull(value);
      } else if (field === 'blocked_reason') {
        updates[field] = asStringOrNull(value);
      } else if (field === 'description') {
        updates[field] = asStringOrNull(value);
      } else if (field === 'source_type') {
        const sourceType = normalizeExternalSourceValue(value);
        if (!sourceType) {
          return NextResponse.json({ error: 'source_type cannot be empty' }, { status: 400 });
        }
        updates[field] = sourceType;
      } else if (
        field === 'source_url'
        || field === 'external_source_system'
      ) {
        updates[field] = normalizeExternalSourceValue(value);
      } else if (field === 'external_source_id') {
        updates[field] = normalizeExternalSourceId(value);
      } else if (field === 'due_at' || field === 'follow_up_at') {
        const result = validateOptionalTimestamp(value, field);
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: 400 });
        }
        updates[field] = result.value;
      } else if (field === 'unit_count') {
        const unitCount = normalizeUnitCount(value);
        if (!unitCount.ok) {
          return NextResponse.json({ error: unitCount.error }, { status: 400 });
        }
        updates[field] = unitCount.value;
      } else if (field === 'work_type') {
        const workType = normalizeWorkType(value);
        if (!workType.ok) {
          return NextResponse.json({ error: workType.error }, { status: 400 });
        }
        updates[field] = workType.value;
      } else if (field === 'is_sample') {
        if (typeof value !== 'boolean') {
          return NextResponse.json({ error: 'is_sample must be true or false' }, { status: 400 });
        }
        updates[field] = value;
      } else if (field === 'tags') {
        updates[field] = normalizeTaskTags(value);
      } else if (field === 'stakeholder_mentions') {
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
          return NextResponse.json({ error: 'stakeholder_mentions must be an array of strings' }, { status: 400 });
        }
        updates[field] = (value as string[]).map((item) => item.trim()).filter(Boolean);
      } else if (field === 'priority_score') {
        // Caller-supplied priority becomes the new un-boosted base; the stored
        // priority_score is recomputed below with boosts applied on top.
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
          return NextResponse.json({ error: 'priority_score must be a number from 0 to 100' }, { status: 400 });
        }
        updates.base_priority = Math.round(value);
      } else if (field === 'title' && typeof value === 'string') {
        updates[field] = value.trim();
      } else {
        updates[field] = value;
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    if ('title' in updates && (typeof updates.title !== 'string' || updates.title.length === 0)) {
      return NextResponse.json({ error: 'title cannot be empty' }, { status: 400 });
    }

    if ('description' in updates && typeof updates.description === 'string' && updates.description.length > 8000) {
      return NextResponse.json({ error: 'description must be 8000 characters or fewer' }, { status: 400 });
    }

    if ('status' in updates) {
      const status = updates.status;
      if (typeof status !== 'string' || !isValidStatus(status)) {
        return NextResponse.json(
          { error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` },
          { status: 400 }
        );
      }
    }

    if ('blocked_reason' in updates && updates.blocked_reason !== null) {
      const blockedReason = updates.blocked_reason;
      if (typeof blockedReason !== 'string' || !isValidBlockedReason(blockedReason)) {
        return NextResponse.json(
          { error: `Invalid blocked_reason. Must be one of: ${VALID_BLOCKED_REASONS.join(', ')}` },
          { status: 400 }
        );
      }
    }

    if ('task_type' in updates) {
      const taskType = updates.task_type;
      if (typeof taskType !== 'string' || !isValidTaskType(taskType)) {
        return NextResponse.json(
          { error: `Invalid task_type. Must be one of: ${VALID_TASK_TYPES.join(', ')}` },
          { status: 400 }
        );
      }
    }

    if ('actual_minutes' in updates) {
      const actualMinutes = updates.actual_minutes;
      if (
        actualMinutes !== null &&
        (typeof actualMinutes !== 'number' || !Number.isFinite(actualMinutes) || Math.round(actualMinutes) < 0)
      ) {
        return NextResponse.json({ error: 'actual_minutes must be a non-negative integer or null' }, { status: 400 });
      }

      if (typeof actualMinutes === 'number') {
        updates.actual_minutes = Math.round(actualMinutes);
      }
    }

    if ('pinned' in updates && typeof updates.pinned !== 'boolean') {
      return NextResponse.json({ error: 'pinned must be a boolean' }, { status: 400 });
    }

    let currentTask: Task | null = null;
    const needsCurrentTask =
      'project_id' in updates
      || 'section_id' in updates
      || 'status' in updates
      || 'due_at' in updates
      || 'base_priority' in updates
      || 'stakeholder_mentions' in updates
      || 'external_source_system' in updates
      || 'external_source_id' in updates;

    if (needsCurrentTask) {
      const { data: fetchedTask, error: fetchError } = await supabase
        .from('tasks')
        .select('*')
        .eq('id', id)
        .eq('user_id', userId)
        .single();

      if (fetchError) {
        if (fetchError.code === 'PGRST116') {
          return NextResponse.json({ error: 'Task not found' }, { status: 404 });
        }
        throw fetchError;
      }

      currentTask = fetchedTask as Task;
    }

    if (currentTask && ('external_source_system' in updates || 'external_source_id' in updates)) {
      const externalSourceSystem = ('external_source_system' in updates
        ? updates.external_source_system
        : currentTask.external_source_system) as string | null;
      const externalSourceId = ('external_source_id' in updates
        ? updates.external_source_id
        : currentTask.external_source_id) as string | null;

      if (externalSourceId && !externalSourceSystem) {
        return NextResponse.json(
          { error: 'external_source_system is required when external_source_id is provided' },
          { status: 400 }
        );
      }

      if (externalSourceSystem && externalSourceId) {
        const { data: conflictingTask, error: conflictLookupError } = await supabase
          .from('tasks')
          .select('id, title')
          .eq('user_id', userId)
          .eq('external_source_system', externalSourceSystem)
          .eq('external_source_id', externalSourceId)
          .neq('id', id)
          .maybeSingle();

        if (conflictLookupError) throw conflictLookupError;
        if (conflictingTask) {
          return NextResponse.json(
            externalSourceConflictPayload({
              external_source_system: externalSourceSystem,
              external_source_id: externalSourceId,
              task: conflictingTask,
            }),
            { status: 409 }
          );
        }
      }
    }

    const implementationId = updates.implementation_id;
    if (typeof implementationId === 'string') {
      const { data: implementation, error: implementationError } = await supabase
        .from('implementations')
        .select('id')
        .eq('id', implementationId)
        .eq('user_id', userId)
        .single();

      if (implementationError || !implementation) {
        return NextResponse.json({ error: 'application is invalid (implementation_id)' }, { status: 400 });
      }
    }

    const projectId = updates.project_id;
    if (typeof projectId === 'string') {
      const { data: project, error: projectError } = await supabase
        .from('projects')
        .select('id')
        .eq('id', projectId)
        .eq('user_id', userId)
        .single();

      if (projectError || !project) {
        return NextResponse.json({ error: 'project_id is invalid' }, { status: 400 });
      }
    }

    if (currentTask) {
      const hasProjectInput = 'project_id' in updates;
      const hasSectionInput = 'section_id' in updates;
      const nextTaskSectionState = resolveTaskProjectSectionState({
        current_project_id: typeof currentTask.project_id === 'string' ? currentTask.project_id : null,
        current_section_id: typeof currentTask.section_id === 'string' ? currentTask.section_id : null,
        has_project_input: hasProjectInput,
        project_id_input: (updates.project_id as string | null | undefined) ?? null,
        has_section_input: hasSectionInput,
        section_id_input: (updates.section_id as string | null | undefined) ?? null,
      });

      if (
        hasProjectInput
        && nextTaskSectionState.project_id !== (typeof currentTask.project_id === 'string' ? currentTask.project_id : null)
        && !hasSectionInput
      ) {
        updates.section_id = null;
      }

      try {
        await validateTaskSectionAssignment(supabase, userId, nextTaskSectionState);
      } catch (error) {
        if (error instanceof ProjectSectionServiceError) {
          return NextResponse.json({ error: error.message }, { status: error.status });
        }
        throw error;
      }
    }

    const sprintId = updates.sprint_id;
    if (typeof sprintId === 'string') {
      const { data: sprint, error: sprintError } = await supabase
        .from('sprints')
        .select('id')
        .eq('id', sprintId)
        .eq('user_id', userId)
        .single();

      if (sprintError || !sprint) {
        return NextResponse.json({ error: 'sprint_id is invalid' }, { status: 400 });
      }
    }

    // Plan the cascade before anything is written, so a preview or a refusal
    // (too many moves) leaves the task untouched.
    let cascadeReply: CascadeReply | null = null;
    let cascadePending: {
      plan: CascadePlan;
      moves: CascadeApplyMove[];
      rootTitle: string;
      rootWasVisible: boolean;
      plannedFromDueAt: string | null;
    } | null = null;
    let famcalRootNotice: Parameters<typeof cascadeRootNotice>[0] | null = null;
    if ('due_at' in updates && currentTask) {
      const mode = cascadeOptions.mode;
      if (cascadeOptions.cascade === false) {
        cascadeReply = buildCascadeReply({ status: 'off', mode, reason: 'off' });
      } else {
        const trigger = cascadeTrigger(currentTask, { ...currentTask, ...updates } as Task, mode);
        if (!trigger.run) {
          if (cascadeOptions.cascade === 'preview') {
            // A preview never saves, even when nothing would cascade.
            return NextResponse.json({
              preview: true,
              task_id: id,
              due_at: updates.due_at,
              cascade: buildCascadeReply({ status: 'preview', mode, reason: trigger.reason }),
            });
          }
          cascadeReply = buildCascadeReply({ status: 'not_applicable', mode, reason: trigger.reason });
        } else {
          let plan: CascadePlan | null = null;
          let graph: Awaited<ReturnType<typeof loadCascadeGraph>> | null = null;
          try {
            graph = await loadCascadeGraph(supabase, userId, id, { famcal: isFamcalKey });
            plan = planTaskDateCascade({
              graph,
              mode,
              deltaWorkdays: trigger.deltaWorkdays,
              rootOldDueAt: currentTask.due_at,
              rootNewDueAt: updates.due_at as string,
            });
          } catch (planError) {
            if (!isFamcalKey) {
              if (planError instanceof DependencyReadIncompleteError) {
                return NextResponse.json(
                  { error: "Couldn't read all the tasks that wait on this one, so nothing was saved. Try again, or send cascade: false to move only this task." },
                  { status: 503 }
                );
              }
              throw planError;
            }
            // FamCal: the date move itself still goes through; say so on the task.
            console.error('Cascade planning failed (FamCal key):', planError);
            famcalRootNotice = 'unreadable';
          }

          if (plan && graph) {
            const overCap = plan.moves.length > CASCADE_CONFIRM_THRESHOLD;
            if (cascadeOptions.cascade === 'preview' || ((plan.tooLarge || (overCap && !cascadeOptions.confirm)) && !isFamcalKey)) {
              const projects = await fetchCascadeProjects(supabase, userId, plan.moves.map((move) => move.project_id ?? ''));
              const status = cascadeOptions.cascade === 'preview' ? 'preview' : plan.tooLarge ? 'too_large' : 'needs_confirm';
              const reply = buildCascadeReply({ status, mode, plan, projectFlags: projectFlagsForMoves(plan.moves, projects) });
              if (status === 'preview') {
                return NextResponse.json({ preview: true, task_id: id, due_at: updates.due_at, cascade: reply });
              }
              return NextResponse.json({ error: reply.message, cascade: reply }, { status: 409 });
            }
            // Only the FamCal key gets here with tooLarge or over the cap (others
            // were refused above unless they confirmed).
            if (plan.tooLarge) {
              famcalRootNotice = 'too_large';
            } else if (overCap && !cascadeOptions.confirm) {
              // FamCal can't confirm: only the task it moved moves.
              famcalRootNotice = 'too_many';
            } else if (plan.moves.length > 0) {
              // Comments name the task as this PATCH saves it (a rename in the
              // same edit must never publish the old title).
              const rootTitle = String(('title' in updates ? updates.title : currentTask.title) ?? '');
              const moves = await prepareCascadeApplyMoves(supabase, userId, { rootTitle, plan, graph });
              // Could FamCal read this task BEFORE the edit? (Read before the
              // save; the function also checks it again under its locks.)
              const rootWasVisible = isFamcalKey ? true : await isFamcalVisibleNow(supabase, userId, id);
              cascadePending = { plan, moves, rootTitle, rootWasVisible, plannedFromDueAt: currentTask.due_at ?? null };
            } else {
              cascadeReply = buildCascadeReply({ status: 'nothing_to_move', mode, plan });
            }
          }
        }
      }
    } else if (cascadeOptions.cascade === 'preview') {
      return NextResponse.json({ error: 'cascade: "preview" needs a due_at to preview' }, { status: 400 });
    }

    const needsPriorityRecalc =
      'status' in updates
      || 'due_at' in updates
      || 'base_priority' in updates
      || 'stakeholder_mentions' in updates;

    if (needsPriorityRecalc && currentTask) {
      const mergedTask = { ...currentTask, ...updates };
      const highPriorityStakeholderNames = await getHighPriorityStakeholderNames(supabase, userId);
      updates.priority_score = recalculateTaskPriority(mergedTask, highPriorityStakeholderNames);
    }

    if ('estimated_minutes' in updates && !('estimate_source' in updates)) {
      updates.estimate_source = 'manual';
    }

    let updateQuery = supabase
      .from('tasks')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId);
    if (isFamcalKey) {
      // Re-assert the personal tag in the UPDATE itself: a tag removed after the
      // guard's read matches no row, which becomes the PGRST116 → 404 below.
      updateQuery = updateQuery.contains('tags', [FAMCAL_REQUIRED_TAG]).eq(FAMCAL_ELIGIBLE_FIELD, true);
      // Compare-and-set on the status the transition was validated against: a
      // status changed by someone else meanwhile matches no row (→ 409 below).
      if (famcalExpectedStatus) {
        updateQuery = updateQuery.eq('status', famcalExpectedStatus);
      }
    }
    if (cascadePending) {
      // Compare-and-set on the due date the cascade was planned from: if another
      // edit moved this task meanwhile, its later tasks may already have moved,
      // and this plan's gap would be applied on top (→ 409 below, nothing saved).
      const plannedFrom = cascadePending.plannedFromDueAt;
      updateQuery = plannedFrom ? updateQuery.eq('due_at', plannedFrom) : updateQuery.is('due_at', null);
    }
    const { data, error } = await updateQuery
      .select(TASK_WITH_RELATIONS_SELECT)
      .single();

    if (error) {
      // Pace tracking (migration 059): the DB guard trg_tasks_guard_project_move
      // rejects moving a task whose sessions or linked rows live in its project.
      // It runs under the task's row lock, so it also covers a session logged at
      // the same moment; no pre-check here (it would race and build long URLs).
      if (error.code === '55006') {
        return NextResponse.json({ error: TASK_MOVE_WITH_SESSIONS_ERROR }, { status: 409 });
      }
      if (isTaskExternalSourceUniqueViolation(error)) {
        const externalSourceSystem = (updates.external_source_system ?? currentTask?.external_source_system) as string | null;
        const externalSourceId = (updates.external_source_id ?? currentTask?.external_source_id) as string | null;
        if (externalSourceSystem && externalSourceId) {
          const { data: conflictingTask } = await supabase
            .from('tasks')
            .select('id, title')
            .eq('user_id', userId)
            .eq('external_source_system', externalSourceSystem)
            .eq('external_source_id', externalSourceId)
            .neq('id', id)
            .maybeSingle();

          if (conflictingTask) {
            return NextResponse.json(
              externalSourceConflictPayload({
                external_source_system: externalSourceSystem,
                external_source_id: externalSourceId,
                task: conflictingTask,
              }),
              { status: 409 }
            );
          }
        }
      }
      if (error.code === 'PGRST116' && cascadePending) {
        let dueQuery = supabase.from('tasks').select('id, due_at').eq('id', id).eq('user_id', userId);
        if (isFamcalKey) dueQuery = dueQuery.contains('tags', [FAMCAL_REQUIRED_TAG]).eq(FAMCAL_ELIGIBLE_FIELD, true);
        const { data: nowRow } = await dueQuery.maybeSingle();
        const nowDue = (nowRow as { due_at?: string | null } | null)?.due_at ?? null;
        const plannedFrom = cascadePending.plannedFromDueAt;
        const moved = nowRow && (nowDue === null || plannedFrom === null ? nowDue !== plannedFrom : Date.parse(nowDue) !== Date.parse(plannedFrom));
        if (moved) {
          return NextResponse.json(
            { error: "The task's due date changed since it was read, so nothing was saved; reload it and try again" },
            { status: 409 }
          );
        }
      }
      if (error.code === 'PGRST116') {
        // FamCal: nothing was written. Say 409 only when the task is still
        // personal and its status moved away from the one validated; a task that
        // lost `personal` (or is gone) stays an indistinguishable 404.
        if (isFamcalKey && famcalExpectedStatus) {
          const now = await fetchFamcalVisibleTask(supabase, userId, id);
          if (now && now.status !== famcalExpectedStatus) {
            return NextResponse.json(
              { error: 'The task changed since it was read; reload it and try again' },
              { status: 409 }
            );
          }
        }
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }
      throw error;
    }

    const fromStatus = famcalExpectedStatus ?? currentTask?.status;
    if (currentTask && fromStatus && typeof updates.status === 'string' && updates.status !== fromStatus) {
      queueTaskStatusTransition(supabase, {
        userId,
        taskId: id,
        fromStatus,
        toStatus: updates.status as typeof currentTask.status,
      });
    }

    // Apply the planned cascade now that the task's own date is saved. This is
    // a second statement: if it fails, the task's date stands, the reply says
    // cascade.status "failed" and a system comment on the task says the later
    // tasks were not moved.
    const savedDueAt = (data as { due_at?: string | null }).due_at ?? null;
    if (cascadePending && savedDueAt) {
      const { plan, moves, rootTitle, rootWasVisible } = cascadePending;
      try {
        const applied = await applyTaskDateCascade(supabase, {
          userId,
          rootTaskId: id,
          rootOldDueAt: plan.rootOldDueAt,
          rootNewDueAt: savedDueAt,
          mode: plan.mode,
          deltaWorkdays: plan.deltaWorkdays,
          scope: isFamcalKey ? 'famcal' : 'all',
          source: auth.context.authSource,
          moves,
          rootTitle,
          rootWasVisible,
        });
        cascadeReply = buildCascadeReply({
          status: applied.status === 'superseded' ? 'superseded' : 'moved',
          mode: plan.mode,
          plan,
          applied,
        });
      } catch (cascadeError) {
        console.error('Cascade apply failed after the task saved:', cascadeError);
        cascadeReply = {
          ...buildCascadeReply({ status: 'failed', mode: plan.mode, plan }),
          reason: cascadeError instanceof Error ? cascadeError.message : 'unknown error',
        };
        await postCascadeRootNotice(supabase, userId, id, isFamcalKey, cascadeRootNotice('failed'));
      }
    } else if (famcalRootNotice && isFamcalKey) {
      await postCascadeRootNotice(supabase, userId, id, true, cascadeRootNotice(famcalRootNotice));
    }

    if (isFamcalKey) {
      return NextResponse.json(projectTaskForFamcal(data as Record<string, unknown>));
    }

    const task = normalizeTaskWithRelations(data as Record<string, unknown>);
    return NextResponse.json(cascadeReply ? { ...task, cascade: cascadeReply } : task);
  } catch (error) {
    console.error('Error updating task:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** Whether the FamCal key could read this task right now (one eligibility-filtered read). */
async function isFamcalVisibleNow(supabase: SupabaseClient, userId: string, taskId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('tasks')
    .select('id')
    .eq('id', taskId)
    .eq('user_id', userId)
    .contains('tags', [FAMCAL_REQUIRED_TAG])
    .eq(FAMCAL_ELIGIBLE_FIELD, true)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

/**
 * A system comment on the edited task saying the later tasks did not move. For
 * the FamCal key it goes through the FamCal comment function (eligibility under
 * the row lock). A failure here is logged, never turned into an error: the
 * task's own date is already saved.
 */
async function postCascadeRootNotice(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  famcal: boolean,
  content: string
): Promise<void> {
  try {
    if (famcal) {
      await addFamcalTaskComment(supabase, userId, taskId, content, 'system');
      return;
    }
    const { error } = await supabase.from('task_comments').insert({ task_id: taskId, user_id: userId, content, source: 'system' });
    if (error) throw error;
  } catch (noticeError) {
    console.error('Failed to record the cascade notice on the task:', noticeError);
  }
}

// DELETE /api/tasks/[id] - Delete a task
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { id } = await params;

    const { data, error } = await supabase
      .from('tasks')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
      .select('id');

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting task:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
