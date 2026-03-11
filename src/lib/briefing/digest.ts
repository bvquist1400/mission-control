import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildDayWindows,
  decorateCalendarEvent,
  normalizeRequestedRange,
  parseEventPeople,
  type ApiCalendarEvent,
  type CalendarTemporalStatus,
} from "@/lib/calendar";
import { detectBriefingMode, formatETTime, getTodayET, getTomorrowET, type BriefingMode } from "@/lib/briefing";
import { identifyPrepTasks, type TaskInput } from "@/lib/briefing/prep-tasks";
import { calculateCapacity } from "@/lib/capacity";
import { normalizeDateOnly } from "@/lib/date-only";
import { calculateSprintProgressMetrics } from "@/lib/today/sprint-progress";
import { DEFAULT_WORKDAY_CONFIG } from "@/lib/workday";
import type { CommitmentDirection, TaskStatus, TaskWithImplementation } from "@/types/database";

const ET_TIMEZONE = DEFAULT_WORKDAY_CONFIG.timezone;
const TASK_SELECT =
  "*, implementation:implementations(id, name, phase, rag), project:projects(id, name, stage, rag), sprint:sprints(id, name, start_date, end_date, theme)";

export type DailyBriefMode = BriefingMode | "auto";

interface CalendarEventRow {
  source: CalendarEventSource;
  external_event_id: string;
  start_at: string;
  end_at: string;
  title: string;
  with_display: string[] | null;
  body_scrubbed_preview: string | null;
  is_all_day: boolean;
}

type CalendarEventSource = "local" | "ical" | "graph";

interface CalendarEventContextRow {
  source: CalendarEventSource;
  external_event_id: string;
  meeting_context: string | null;
}

interface TaskWithRelations extends Omit<TaskWithImplementation, "sprint"> {
  sprint: { id: string; name: string; start_date: string; end_date: string; theme?: string | null } | null;
}

interface OpenCommitmentRow {
  id: string;
  title: string;
  direction: CommitmentDirection;
  status: "Open";
  due_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  stakeholder: { id: string; name: string } | null;
  task: { id: string; title: string; status: TaskStatus } | null;
}

interface StakeholderNameRow {
  id: string;
  name: string;
}

interface TaskCommentRow {
  id: string;
  task_id: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface DailyBriefDigestTaskItem {
  id: string;
  title: string;
  status: TaskStatus;
  due_at: string | null;
  due_label: string | null;
  context: string | null;
  reason: string;
  recent_update: string | null;
}

export interface DailyBriefDigestMeetingItem {
  title: string;
  time_range_et: string;
  temporal_status: CalendarTemporalStatus;
  with_display: string[];
  notes: string | null;
  stakeholder_names: string[];
  open_commitments: Array<{
    id: string;
    title: string;
    direction: CommitmentDirection;
    stakeholder_name: string;
    due_at: string | null;
  }>;
  related_tasks: Array<{
    id: string;
    title: string;
    status: TaskStatus;
  }>;
}

export interface DailyBriefDigestCommitmentGroup {
  stakeholder_id: string;
  stakeholder_name: string;
  commitments: Array<{
    id: string;
    title: string;
    direction: CommitmentDirection;
    due_at: string | null;
    task_title: string | null;
  }>;
}

export interface DailyBriefSyncRecommendation {
  action: "add" | "keep" | "drop";
  task_id: string;
  title: string;
  reason: string;
}

export interface DailyBriefSprintSummary {
  id: string;
  name: string;
  theme: string | null;
  start_date: string;
  end_date: string;
  completed_tasks: number;
  total_tasks: number;
  completion_pct: number;
  blocked_tasks: number;
  in_progress_tasks: number;
  planned_tasks: number;
  on_track: boolean;
  tasks_behind_pace: number;
  health_assessment: string;
}

export interface DailyBriefDigestCounts {
  overdue: number;
  due_soon: number;
  blocked: number;
  in_progress: number;
  done_today: number;
  remaining_meetings: number;
  stale_followups: number;
  open_commitments_theirs: number;
  open_commitments_ours: number;
}

export interface DailyBriefComputedSignals {
  is_day_overloaded: boolean;
  top_risk: string | null;
  waiting_on_others_count: number;
  momentum_score: number;
  meeting_heavy_afternoon: boolean;
  capacity_rag: "Green" | "Yellow" | "Red";
  available_minutes: number;
  required_minutes: number;
}

export interface DailyBriefDigestResponse {
  requestedDate: string;
  mode: BriefingMode;
  currentTimeET: string;
  generatedAt: string;
  since: string | null;
  subject: string;
  markdown: string;
  narrative: string;
  sprint: DailyBriefSprintSummary | null;
  tasks: {
    due_soon: DailyBriefDigestTaskItem[];
    blocked: DailyBriefDigestTaskItem[];
    in_progress: DailyBriefDigestTaskItem[];
    completed_today: DailyBriefDigestTaskItem[];
    stale_followups: DailyBriefDigestTaskItem[];
    rolled_to_tomorrow: DailyBriefDigestTaskItem[];
  };
  counts: DailyBriefDigestCounts;
  signals: DailyBriefComputedSignals;
  meetings: DailyBriefDigestMeetingItem[];
  commitments: {
    theirs: DailyBriefDigestCommitmentGroup[];
    ours: DailyBriefDigestCommitmentGroup[];
  };
  guidance_title: "Where to Start" | "Afternoon Focus" | "Tomorrow Prep";
  guidance: string[];
  suggested_sync_today: DailyBriefSyncRecommendation[];
}

interface BuildDigestOptions {
  supabase: SupabaseClient;
  userId: string;
  mode?: DailyBriefMode;
  date?: string | null;
  since?: string | null;
}

interface CommentActivity {
  count: number;
  latestAt: string;
  latestSnippet: string | null;
}

function buildContextKey(source: CalendarEventSource, externalEventId: string): string {
  return `${source}::${externalEventId}`;
}

function truncate(value: string, max = 140): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function safeIso(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function formatDateOnlyLabel(dateOnly: string): string {
  return new Date(`${dateOnly}T12:00:00.000Z`).toLocaleDateString("en-US", {
    timeZone: ET_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatEtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: ET_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatEtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: ET_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }) + " ET";
}

function formatEtDueLabel(dueAt: string | null, now: Date, requestedDate: string): string | null {
  if (!dueAt) {
    return null;
  }

  const dueMs = new Date(dueAt).getTime();
  if (Number.isNaN(dueMs)) {
    return null;
  }

  const dateEt = new Date(dueAt).toLocaleDateString("en-CA", { timeZone: ET_TIMEZONE });
  const timeEt = new Date(dueAt).toLocaleTimeString("en-US", {
    timeZone: ET_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  if (dueMs < now.getTime()) {
    if (dateEt === requestedDate) {
      return `Overdue since ${timeEt} ET`;
    }
    return `Overdue since ${formatEtDateTime(dueAt)}`;
  }

  if (dateEt === requestedDate) {
    return `Due today at ${timeEt} ET`;
  }

  return `Due ${formatEtDateTime(dueAt)}`;
}

function getEtHour(iso: string): number | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIMEZONE,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hourPart = parts.find((part) => part.type === "hour")?.value;
  if (!hourPart) {
    return null;
  }

  const parsed = Number(hourPart);
  return Number.isFinite(parsed) ? parsed : null;
}

function getMeetingMinutes(events: ApiCalendarEvent[]): number {
  return events.reduce((sum, event) => {
    if (event.is_all_day) {
      return sum;
    }

    const startMs = new Date(event.start_at).getTime();
    const endMs = new Date(event.end_at).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return sum;
    }

    return sum + Math.round((endMs - startMs) / 60000);
  }, 0);
}

function buildStaleFollowupReason(task: TaskWithRelations, now: Date): string {
  if (task.follow_up_at) {
    return `Follow-up date passed at ${formatEtDateTime(task.follow_up_at)}`;
  }

  return `No follow-up set and it has been idle since ${formatEtDateTime(task.updated_at)}`;
}

function toTaskContext(task: TaskWithRelations): string | null {
  const parts = [
    task.implementation?.name ?? null,
    task.project?.name ?? null,
    task.sprint?.name ?? null,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  return parts.length > 0 ? parts.join(" / ") : null;
}

function compareByDueThenPriority(left: TaskWithRelations, right: TaskWithRelations): number {
  const leftDue = left.due_at ? new Date(left.due_at).getTime() : Number.POSITIVE_INFINITY;
  const rightDue = right.due_at ? new Date(right.due_at).getTime() : Number.POSITIVE_INFINITY;
  if (leftDue !== rightDue) {
    return leftDue - rightDue;
  }

  return right.priority_score - left.priority_score;
}

function compareByPriorityThenUpdate(left: TaskWithRelations, right: TaskWithRelations): number {
  if (left.priority_score !== right.priority_score) {
    return right.priority_score - left.priority_score;
  }

  return right.updated_at.localeCompare(left.updated_at);
}

function compareByUpdatedDesc<T extends { updated_at: string }>(left: T, right: T): number {
  return right.updated_at.localeCompare(left.updated_at);
}

function buildCommentActivityMap(rows: TaskCommentRow[], sinceIso: string | null): Map<string, CommentActivity> {
  const activity = new Map<string, CommentActivity>();

  for (const row of rows) {
    const createdAt = safeIso(row.created_at);
    const updatedAt = safeIso(row.updated_at);
    const latestAt = updatedAt ?? createdAt;
    if (!latestAt) {
      continue;
    }

    if (sinceIso && latestAt < sinceIso) {
      continue;
    }

    const existing = activity.get(row.task_id);
    const snippet = truncate(row.content, 120);
    if (!existing) {
      activity.set(row.task_id, {
        count: 1,
        latestAt,
        latestSnippet: snippet,
      });
      continue;
    }

    existing.count += 1;
    if (latestAt > existing.latestAt) {
      existing.latestAt = latestAt;
      existing.latestSnippet = snippet;
    }
  }

  return activity;
}

function buildRecentUpdate(task: TaskWithRelations, commentActivity: Map<string, CommentActivity>, sinceIso: string | null): string | null {
  const taskUpdatedAt = safeIso(task.updated_at);
  const comment = commentActivity.get(task.id);

  const taskWasUpdatedSinceWindow = Boolean(taskUpdatedAt && (!sinceIso || taskUpdatedAt >= sinceIso));
  if (task.status === "Done" && taskWasUpdatedSinceWindow) {
    return `Marked done at ${formatEtDateTime(task.updated_at)}`;
  }

  if (comment) {
    if (comment.count === 1 && comment.latestSnippet) {
      return `New comment: "${comment.latestSnippet}"`;
    }

    if (comment.latestSnippet) {
      return `${comment.count} new comments, latest: "${comment.latestSnippet}"`;
    }

    return `${comment.count} new comments`;
  }

  if (taskWasUpdatedSinceWindow) {
    return `Updated at ${formatEtDateTime(task.updated_at)}`;
  }

  return null;
}

function buildTaskReason(task: TaskWithRelations, now: Date, requestedDate: string): string {
  if (task.status === "Blocked/Waiting") {
    return task.waiting_on ? `Waiting on ${task.waiting_on}` : "Blocked and needs a clear next move";
  }

  if (task.due_at) {
    const dueMs = new Date(task.due_at).getTime();
    if (Number.isFinite(dueMs) && dueMs < now.getTime()) {
      return "Already past due";
    }

    const dueDateEt = new Date(task.due_at).toLocaleDateString("en-CA", { timeZone: ET_TIMEZONE });
    if (dueDateEt === requestedDate) {
      return "Needs attention today";
    }
  }

  if (task.status === "In Progress") {
    return "Active work already in motion";
  }

  if (task.blocker) {
    return "This is marked as a blocker";
  }

  return "High-leverage work to keep moving";
}

function toTaskDigestItem(
  task: TaskWithRelations,
  now: Date,
  requestedDate: string,
  commentActivity: Map<string, CommentActivity>,
  sinceIso: string | null
): DailyBriefDigestTaskItem {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    due_at: task.due_at,
    due_label: formatEtDueLabel(task.due_at, now, requestedDate),
    context: toTaskContext(task),
    reason: buildTaskReason(task, now, requestedDate),
    recent_update: buildRecentUpdate(task, commentActivity, sinceIso),
  };
}

function matchesStakeholderName(text: string, stakeholderName: string): boolean {
  return text.toLowerCase().includes(stakeholderName.trim().toLowerCase());
}

function findStakeholdersForEvent(event: ApiCalendarEvent, stakeholders: StakeholderNameRow[]): StakeholderNameRow[] {
  const searchable = [event.title, ...event.with_display].join(" | ");
  return stakeholders.filter((stakeholder) => matchesStakeholderName(searchable, stakeholder.name));
}

function findRelatedTasksForStakeholders(
  matchedStakeholders: StakeholderNameRow[],
  tasks: TaskWithRelations[]
): Array<{ id: string; title: string; status: TaskStatus }> {
  if (matchedStakeholders.length === 0) {
    return [];
  }

  const results = tasks.filter((task) => {
    const mentions = task.stakeholder_mentions.map((value) => value.toLowerCase());
    const waitingOn = task.waiting_on?.toLowerCase() ?? "";
    const title = task.title.toLowerCase();
    return matchedStakeholders.some((stakeholder) => {
      const name = stakeholder.name.toLowerCase();
      return mentions.some((mention) => name.includes(mention) || mention.includes(name)) ||
        waitingOn.includes(name) ||
        title.includes(name);
    });
  });

  return results
    .sort(compareByPriorityThenUpdate)
    .slice(0, 3)
    .map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
    }));
}

function buildCommitmentGroups(
  commitments: OpenCommitmentRow[],
  direction: CommitmentDirection
): DailyBriefDigestCommitmentGroup[] {
  const grouped = new Map<string, DailyBriefDigestCommitmentGroup>();

  for (const commitment of commitments) {
    if (commitment.direction !== direction || !commitment.stakeholder) {
      continue;
    }

    const existing = grouped.get(commitment.stakeholder.id);
    const item = {
      id: commitment.id,
      title: commitment.title,
      direction: commitment.direction,
      due_at: commitment.due_at,
      task_title: commitment.task?.title ?? null,
    };

    if (!existing) {
      grouped.set(commitment.stakeholder.id, {
        stakeholder_id: commitment.stakeholder.id,
        stakeholder_name: commitment.stakeholder.name,
        commitments: [item],
      });
      continue;
    }

    existing.commitments.push(item);
  }

  return [...grouped.values()]
    .map((group) => ({
      ...group,
      commitments: group.commitments.sort((left, right) => {
        const leftDue = left.due_at ? new Date(left.due_at).getTime() : Number.POSITIVE_INFINITY;
        const rightDue = right.due_at ? new Date(right.due_at).getTime() : Number.POSITIVE_INFINITY;
        return leftDue - rightDue;
      }),
    }))
    .sort((left, right) => left.stakeholder_name.localeCompare(right.stakeholder_name));
}

function buildMeetingDigestItems(
  meetings: ApiCalendarEvent[],
  stakeholders: StakeholderNameRow[],
  openCommitments: OpenCommitmentRow[],
  tasks: TaskWithRelations[]
): DailyBriefDigestMeetingItem[] {
  return meetings.map((event) => {
    const matchedStakeholders = findStakeholdersForEvent(event, stakeholders);
    const stakeholderIds = new Set(matchedStakeholders.map((stakeholder) => stakeholder.id));
    const relatedCommitments = openCommitments
      .filter((commitment) => commitment.stakeholder && stakeholderIds.has(commitment.stakeholder.id))
      .sort((left, right) => {
        const leftDue = left.due_at ? new Date(left.due_at).getTime() : Number.POSITIVE_INFINITY;
        const rightDue = right.due_at ? new Date(right.due_at).getTime() : Number.POSITIVE_INFINITY;
        return leftDue - rightDue;
      })
      .slice(0, 4)
      .map((commitment) => ({
        id: commitment.id,
        title: commitment.title,
        direction: commitment.direction,
        stakeholder_name: commitment.stakeholder?.name ?? "Unknown",
        due_at: commitment.due_at,
      }));

    const notes = [event.meeting_context, event.body_scrubbed_preview]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => truncate(value, 180))[0] ?? null;

    return {
      title: event.title,
      time_range_et: event.time_range_et ?? "All day",
      temporal_status: event.temporal_status ?? "upcoming",
      with_display: event.with_display,
      notes,
      stakeholder_names: matchedStakeholders.map((stakeholder) => stakeholder.name),
      open_commitments: relatedCommitments,
      related_tasks: findRelatedTasksForStakeholders(matchedStakeholders, tasks),
    };
  });
}

function buildGuidanceLine(task: DailyBriefDigestTaskItem, prefix: string): string {
  const parts = [
    `${prefix} ${task.title}`,
    task.reason,
    task.due_label,
    task.context ? `Context: ${task.context}` : null,
  ].filter((value): value is string => Boolean(value));

  return `${parts.join(". ")}. [${task.id}]`;
}

function buildMorningGuidance(
  dueSoon: DailyBriefDigestTaskItem[],
  blocked: DailyBriefDigestTaskItem[],
  inProgress: DailyBriefDigestTaskItem[]
): string[] {
  const guidance: string[] = [];

  if (dueSoon[0]) {
    guidance.push(buildGuidanceLine(dueSoon[0], "Do this first:"));
  }

  if (blocked[0]) {
    const waitingText = blocked[0].reason.startsWith("Waiting on") ? blocked[0].reason : `Unblock it: ${blocked[0].reason}`;
    guidance.push(`Send the follow-up on ${blocked[0].title}. ${waitingText}. [${blocked[0].id}]`);
  }

  if (inProgress[0]) {
    guidance.push(buildGuidanceLine(inProgress[0], "Protect time for:"));
  }

  return guidance.slice(0, 3);
}

function buildMiddayGuidance(
  dueSoon: DailyBriefDigestTaskItem[],
  blocked: DailyBriefDigestTaskItem[],
  inProgress: DailyBriefDigestTaskItem[]
): string[] {
  const guidance: string[] = [];

  if (inProgress[0]) {
    guidance.push(buildGuidanceLine(inProgress[0], "Finish the next meaningful chunk on:"));
  }

  if (dueSoon[0]) {
    guidance.push(buildGuidanceLine(dueSoon[0], "Make room for:"));
  }

  if (blocked[0]) {
    guidance.push(`Clear the wait state on ${blocked[0].title}. ${blocked[0].reason}. [${blocked[0].id}]`);
  }

  return guidance.slice(0, 3);
}

function buildEodGuidance(
  tomorrowPrep: DailyBriefDigestTaskItem[],
  rolledOver: DailyBriefDigestTaskItem[]
): string[] {
  const guidance: string[] = [];

  if (tomorrowPrep[0]) {
    guidance.push(buildGuidanceLine(tomorrowPrep[0], "Prep tonight or first thing tomorrow for:"));
  }

  if (rolledOver[0]) {
    guidance.push(buildGuidanceLine(rolledOver[0], "Queue up a clean restart on:"));
  }

  if (tomorrowPrep[1]) {
    guidance.push(buildGuidanceLine(tomorrowPrep[1], "Have this ready too:"));
  }

  return guidance.slice(0, 3);
}

function buildMorningSyncRecommendations(
  dueSoon: DailyBriefDigestTaskItem[],
  blocked: DailyBriefDigestTaskItem[],
  inProgress: DailyBriefDigestTaskItem[]
): DailyBriefSyncRecommendation[] {
  const recommendations = [...dueSoon.slice(0, 2), ...blocked.slice(0, 1), ...inProgress.slice(0, 2)];
  const seen = new Set<string>();

  return recommendations
    .filter((task) => {
      if (seen.has(task.id)) {
        return false;
      }
      seen.add(task.id);
      return true;
    })
    .slice(0, 5)
    .map((task) => ({
      action: "add",
      task_id: task.id,
      title: task.title,
      reason: task.due_label ?? task.reason,
    }));
}

function buildMiddaySyncRecommendations(
  plannedTasks: TaskWithRelations[],
  dueSoon: DailyBriefDigestTaskItem[],
  inProgress: DailyBriefDigestTaskItem[]
): DailyBriefSyncRecommendation[] {
  const recommendations: DailyBriefSyncRecommendation[] = [];
  const seen = new Set<string>();

  for (const task of inProgress.slice(0, 2)) {
    seen.add(task.id);
    recommendations.push({
      action: "keep",
      task_id: task.id,
      title: task.title,
      reason: task.reason,
    });
  }

  for (const task of dueSoon.slice(0, 2)) {
    if (seen.has(task.id)) {
      continue;
    }
    seen.add(task.id);
    recommendations.push({
      action: "add",
      task_id: task.id,
      title: task.title,
      reason: task.due_label ?? task.reason,
    });
  }

  const droppable = plannedTasks
    .filter((task) => !seen.has(task.id) && task.priority_score < 70 && task.status === "Planned")
    .sort(compareByPriorityThenUpdate)
    .reverse()
    .slice(0, 1);

  for (const task of droppable) {
    recommendations.push({
      action: "drop",
      task_id: task.id,
      title: task.title,
      reason: "Lower urgency than the current afternoon work",
    });
  }

  return recommendations.slice(0, 5);
}

function buildSprintHealthAssessment(
  sprintName: string,
  completionPct: number,
  blockedTasks: number,
  metrics: ReturnType<typeof calculateSprintProgressMetrics>
): string {
  if (completionPct === 0) {
    return `${sprintName} has not logged a completed task yet, so it needs an early win today.`;
  }

  if (metrics.onTrack && blockedTasks === 0) {
    return `${sprintName} is on track and the work mix is still healthy.`;
  }

  if (metrics.onTrack) {
    return `${sprintName} is still on track, but ${blockedTasks} blocked item${blockedTasks === 1 ? "" : "s"} need watching.`;
  }

  if (metrics.tasksBehindPace <= 1) {
    return `${sprintName} is only a little behind pace, but it needs focused execution to stay recoverable.`;
  }

  return `${sprintName} is off pace and needs active triage, not just more parallel work.`;
}

function clampScore(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function buildTopRisk(
  sprint: DailyBriefSprintSummary | null,
  overdueTasks: DailyBriefDigestTaskItem[],
  blockedTasks: DailyBriefDigestTaskItem[],
  staleFollowups: DailyBriefDigestTaskItem[],
  meetingHeavyAfternoon: boolean,
  isDayOverloaded: boolean
): string | null {
  if (overdueTasks[0]) {
    return `${overdueTasks.length} overdue task${overdueTasks.length === 1 ? "" : "s"} led by ${overdueTasks[0].title}.`;
  }

  if (sprint && !sprint.on_track) {
    return `${sprint.name} is slipping by ${sprint.tasks_behind_pace} task${sprint.tasks_behind_pace === 1 ? "" : "s"}.`;
  }

  if (staleFollowups[0]) {
    return `${staleFollowups.length} follow-up${staleFollowups.length === 1 ? "" : "s"} have gone stale, led by ${staleFollowups[0].title}.`;
  }

  if (blockedTasks[0]) {
    return `${blockedTasks.length} task${blockedTasks.length === 1 ? "" : "s"} are waiting on someone else, led by ${blockedTasks[0].title}.`;
  }

  if (meetingHeavyAfternoon) {
    return "The afternoon calendar is heavy enough to crowd out focused work.";
  }

  if (isDayOverloaded) {
    return "The remaining work is heavier than the time left in the day.";
  }

  return null;
}

function buildMomentumScore(
  completedTodayCount: number,
  overdueCount: number,
  blockedCount: number,
  staleFollowupCount: number,
  inProgressCount: number,
  meetingHeavyAfternoon: boolean
): number {
  const score =
    45 +
    (completedTodayCount * 14) +
    (Math.min(inProgressCount, 3) * 5) -
    (overdueCount * 12) -
    (blockedCount * 9) -
    (staleFollowupCount * 7) -
    (meetingHeavyAfternoon ? 8 : 0);

  return clampScore(score);
}

function buildSubject(
  mode: BriefingMode,
  requestedDate: string,
  dueSoonCount: number,
  completedTodayCount: number,
  meetingsCount: number,
  rolledOverCount: number
): string {
  const dateLabel = formatDateOnlyLabel(requestedDate);
  if (mode === "morning") {
    return `Morning Brief | ${dateLabel} | ${dueSoonCount} urgent task${dueSoonCount === 1 ? "" : "s"}, ${meetingsCount} meeting${meetingsCount === 1 ? "" : "s"} left`;
  }

  if (mode === "midday") {
    return `Midday Brief | ${dateLabel} | ${completedTodayCount} done, ${dueSoonCount} still urgent`;
  }

  return `EOD Brief | ${dateLabel} | ${completedTodayCount} done, ${rolledOverCount} rolling`;
}

function buildMorningNarrative(
  sprint: DailyBriefSprintSummary | null,
  dueSoon: DailyBriefDigestTaskItem[],
  blocked: DailyBriefDigestTaskItem[],
  inProgress: DailyBriefDigestTaskItem[],
  meetings: DailyBriefDigestMeetingItem[]
): string {
  const sentences: string[] = [];
  sentences.push(
    dueSoon.length > 0
      ? `You are starting the day with ${dueSoon.length} overdue or due-soon task${dueSoon.length === 1 ? "" : "s"} and ${inProgress.length} item${inProgress.length === 1 ? "" : "s"} already in motion.`
      : `The task load is manageable this morning, with ${inProgress.length} item${inProgress.length === 1 ? "" : "s"} already active and no immediate due-date fires.`
  );

  if (sprint) {
    sentences.push(`Sprint check: ${sprint.health_assessment}`);
  }

  if (blocked.length > 0) {
    sentences.push(`There are ${blocked.length} blocked or waiting item${blocked.length === 1 ? "" : "s"}, so you need at least one follow-up move early instead of letting them sit.`);
  } else {
    sentences.push("Nothing is formally blocked right now, which means you can concentrate on execution instead of cleanup.");
  }

  if (meetings.length > 0) {
    sentences.push(`You still have ${meetings.length} meeting${meetings.length === 1 ? "" : "s"} ahead today, so protect the first open block for the most urgent task before the calendar starts dictating the day.`);
  } else {
    sentences.push("The calendar is clear for the rest of the day, so the main risk is drift rather than interruption.");
  }

  return sentences.slice(0, 4).join(" ");
}

function buildMiddayNarrative(
  completedToday: DailyBriefDigestTaskItem[],
  dueSoon: DailyBriefDigestTaskItem[],
  blocked: DailyBriefDigestTaskItem[],
  inProgress: DailyBriefDigestTaskItem[],
  meetings: DailyBriefDigestMeetingItem[]
): string {
  const sentences: string[] = [];
  if (completedToday.length > 0) {
    sentences.push(`You have ${completedToday.length} task${completedToday.length === 1 ? "" : "s"} marked done so far, which means the day has real forward motion.`);
  } else {
    sentences.push("Nothing is marked done yet, so either the work is still in flight or statuses need cleanup before the afternoon gets away from you.");
  }

  sentences.push(`There are ${inProgress.length} item${inProgress.length === 1 ? "" : "s"} still active and ${blocked.length} blocker${blocked.length === 1 ? "" : "s"} still unresolved.`);

  if (dueSoon.length > 0) {
    sentences.push(`The remaining risk is mostly in the ${dueSoon.length} overdue or due-soon task${dueSoon.length === 1 ? "" : "s"}, so the afternoon needs a tighter priority cut than the morning.`);
  } else {
    sentences.push("There are no immediate due-date fires left, so the afternoon can focus on finishing the strongest active thread.");
  }

  if (meetings.length > 0) {
    sentences.push(`You still have ${meetings.length} meeting${meetings.length === 1 ? "" : "s"} left, so plan around the next one instead of pretending the rest of the day is wide open.`);
  } else {
    sentences.push("No meetings remain today, so you have a clean runway to close something meaningful.");
  }

  return sentences.slice(0, 4).join(" ");
}

function buildEodNarrative(
  completedToday: DailyBriefDigestTaskItem[],
  rolledOver: DailyBriefDigestTaskItem[],
  blocked: DailyBriefDigestTaskItem[],
  tomorrowPrepCount: number
): string {
  const sentences: string[] = [];
  if (completedToday.length > 0) {
    sentences.push(`You closed ${completedToday.length} task${completedToday.length === 1 ? "" : "s"} today, so the day produced visible output.`);
  } else {
    sentences.push("Nothing is marked done today, which usually means either the work fragmented or statuses are lagging reality.");
  }

  if (rolledOver.length > 0) {
    sentences.push(`${rolledOver.length} item${rolledOver.length === 1 ? "" : "s"} are rolling into tomorrow, so tomorrow needs a sharper opening move instead of a cold start.`);
  } else {
    sentences.push("There is very little obvious rollover pressure, which gives tomorrow some room if you preserve it.");
  }

  if (blocked.length > 0) {
    sentences.push(`The main drag is still ${blocked.length} blocked or waiting item${blocked.length === 1 ? "" : "s"}, so tomorrow should start with one follow-up that removes friction.`);
  }

  if (tomorrowPrepCount > 0) {
    sentences.push(`There are ${tomorrowPrepCount} obvious prep item${tomorrowPrepCount === 1 ? "" : "s"} for tomorrow, so doing a small amount of setup now will buy back time in the morning.`);
  }

  return sentences.slice(0, 4).join(" ");
}

function formatTaskLine(item: DailyBriefDigestTaskItem): string {
  const pieces = [
    `${item.title} [${item.id}]`,
    item.due_label,
    item.reason,
    item.context ? `Context: ${item.context}` : null,
    item.recent_update,
  ].filter((value): value is string => Boolean(value));

  return `- ${pieces.join(". ")}`;
}

function formatMeetingLine(item: DailyBriefDigestMeetingItem): string {
  const pieces = [
    `${item.time_range_et} - ${item.title}`,
    item.with_display.length > 0 ? `With ${item.with_display.join(", ")}` : null,
    item.notes ? `Notes: ${item.notes}` : null,
    item.open_commitments.length > 0
      ? `Open commitments: ${item.open_commitments
          .map((commitment) => `${commitment.stakeholder_name} (${commitment.direction}): ${commitment.title}`)
          .join("; ")}`
      : null,
    item.related_tasks.length > 0
      ? `Related tasks: ${item.related_tasks.map((task) => `${task.title} [${task.id}]`).join("; ")}`
      : null,
  ].filter((value): value is string => Boolean(value));

  return `- ${pieces.join(". ")}`;
}

function formatCommitmentGroupLine(group: DailyBriefDigestCommitmentGroup): string {
  const items = group.commitments.map((commitment) => {
    const due = commitment.due_at ? `due ${formatEtDate(commitment.due_at)}` : "no due date";
    const task = commitment.task_title ? `linked task: ${commitment.task_title}` : null;
    return [commitment.title, due, task].filter((value): value is string => Boolean(value)).join(" | ");
  });

  return `- ${group.stakeholder_name}: ${items.join("; ")}`;
}

function formatGuidanceLine(line: string): string {
  return `- ${line}`;
}

function formatSyncLine(item: DailyBriefSyncRecommendation): string {
  return `- ${item.action.toUpperCase()} ${item.title} [${item.task_id}] - ${item.reason}`;
}

function renderMarkdown(payload: {
  requestedDate: string;
  currentTimeET: string;
  mode: BriefingMode;
  narrative: string;
  sprint: DailyBriefSprintSummary | null;
  dueSoon: DailyBriefDigestTaskItem[];
  blocked: DailyBriefDigestTaskItem[];
  inProgress: DailyBriefDigestTaskItem[];
  completedToday: DailyBriefDigestTaskItem[];
  staleFollowups: DailyBriefDigestTaskItem[];
  rolledOver: DailyBriefDigestTaskItem[];
  meetings: DailyBriefDigestMeetingItem[];
  commitmentsTheirs: DailyBriefDigestCommitmentGroup[];
  guidanceTitle: "Where to Start" | "Afternoon Focus" | "Tomorrow Prep";
  guidance: string[];
  syncRecommendations: DailyBriefSyncRecommendation[];
}): string {
  const modeLabel = payload.mode === "eod" ? "EOD" : `${payload.mode[0].toUpperCase()}${payload.mode.slice(1)}`;
  const sections: string[] = [
    `# ${modeLabel} Brief`,
    `_For ${formatDateOnlyLabel(payload.requestedDate)} · Generated ${payload.currentTimeET}_`,
    payload.narrative,
  ];

  if (payload.sprint) {
    sections.push(
      [
        "## This Week's Sprint",
        `- ${payload.sprint.name}`,
        `- Theme: ${payload.sprint.theme && payload.sprint.theme.trim().length > 0 ? payload.sprint.theme : "Not set"}`,
        `- Progress: ${payload.sprint.completed_tasks}/${payload.sprint.total_tasks} tasks complete (${payload.sprint.completion_pct}%)`,
        `- ${payload.sprint.health_assessment}`,
      ].join("\n")
    );
  }

  if (payload.mode === "morning") {
    sections.push(
      [
        "## Tasks",
        ...(payload.dueSoon.length > 0 ? payload.dueSoon.map(formatTaskLine) : ["- No overdue or due-soon tasks."]),
        ...(payload.blocked.length > 0 ? payload.blocked.map(formatTaskLine) : []),
        ...(payload.inProgress.length > 0 ? payload.inProgress.map(formatTaskLine) : []),
      ].join("\n")
    );
  }

  if (payload.mode === "midday") {
    sections.push(
      [
        "## Completed Today",
        ...(payload.completedToday.length > 0
          ? payload.completedToday.map(formatTaskLine)
          : ["- Nothing is marked done today. Statuses may need updating."]),
      ].join("\n")
    );
    sections.push(
      [
        "## Still In Progress",
        ...(payload.inProgress.length > 0 ? payload.inProgress.map(formatTaskLine) : ["- No tasks are marked In Progress."]),
      ].join("\n")
    );
    sections.push(
      [
        "## Still Blocked",
        ...(payload.blocked.length > 0 ? payload.blocked.map(formatTaskLine) : ["- No tasks are currently blocked."]),
      ].join("\n")
    );
  }

  if (payload.mode === "eod") {
    sections.push(
      [
        "## Done Today",
        ...(payload.completedToday.length > 0
          ? payload.completedToday.map(formatTaskLine)
          : ["- Nothing is marked done today. Statuses may need updating."]),
      ].join("\n")
    );
    sections.push(
      [
        "## Rolls to Tomorrow",
        ...(payload.rolledOver.length > 0 ? payload.rolledOver.map(formatTaskLine) : ["- No obvious rollover items."]),
      ].join("\n")
    );
  }

  sections.push(
    [
      payload.mode === "midday" || payload.mode === "eod" ? "## Remaining Meetings" : "## Meetings",
      ...(payload.meetings.length > 0 ? payload.meetings.map(formatMeetingLine) : ["- No remaining meetings today."]),
    ].join("\n")
  );

  if (payload.mode === "morning") {
    sections.push(
      [
        "## Open Commitments (Theirs)",
        ...(payload.commitmentsTheirs.length > 0
          ? payload.commitmentsTheirs.map(formatCommitmentGroupLine)
          : ["- No open commitments owed to you right now."]),
      ].join("\n")
    );
  }

  if (payload.staleFollowups.length > 0) {
    sections.push(
      [
        "## Stale Follow-ups",
        ...payload.staleFollowups.map(formatTaskLine),
      ].join("\n")
    );
  }

  sections.push(
    [
      `## ${payload.guidanceTitle}`,
      ...(payload.guidance.length > 0 ? payload.guidance.map(formatGuidanceLine) : ["- No special focus adjustments needed."]),
    ].join("\n")
  );

  if (payload.syncRecommendations.length > 0) {
    sections.push(
      [
        "## Suggested sync_today",
        ...payload.syncRecommendations.map(formatSyncLine),
        "- Recommendation only. Do not apply automatically without explicit approval.",
      ].join("\n")
    );
  }

  return sections.join("\n\n").trim();
}

async function fetchCalendarEvents(
  supabase: SupabaseClient,
  userId: string,
  dateEt: string
): Promise<ApiCalendarEvent[]> {
  const range = normalizeRequestedRange(dateEt, dateEt);
  const windows = buildDayWindows(range, DEFAULT_WORKDAY_CONFIG);

  const { data: rows, error } = await supabase
    .from("calendar_events")
    .select("source, external_event_id, start_at, end_at, title, with_display, body_scrubbed_preview, is_all_day")
    .eq("user_id", userId)
    .gte("end_at", windows.utcRangeStart)
    .lt("start_at", windows.utcRangeEndExclusive)
    .order("start_at", { ascending: true });

  if (error) {
    throw error;
  }

  const calendarRows = (rows || []) as CalendarEventRow[];
  const eventIds = [...new Set(calendarRows.map((row) => row.external_event_id).filter(Boolean))];
  const contextByEvent = new Map<string, string>();

  if (eventIds.length > 0) {
    const { data: contextRows, error: contextError } = await supabase
      .from("calendar_event_context")
      .select("source, external_event_id, meeting_context")
      .eq("user_id", userId)
      .in("external_event_id", eventIds);

    if (contextError) {
      throw contextError;
    }

    for (const row of (contextRows || []) as CalendarEventContextRow[]) {
      const meetingContext = row.meeting_context?.trim();
      if (!meetingContext) {
        continue;
      }

      contextByEvent.set(buildContextKey(row.source, row.external_event_id), meetingContext);
    }
  }

  return calendarRows.map((row) => decorateCalendarEvent({
    start_at: row.start_at,
    end_at: row.end_at,
    title: row.title,
    with_display: parseEventPeople(row.with_display),
    body_scrubbed_preview: row.body_scrubbed_preview,
    is_all_day: row.is_all_day,
    external_event_id: row.external_event_id,
    meeting_context: contextByEvent.get(buildContextKey(row.source, row.external_event_id)) ?? null,
  }));
}

async function fetchTasks(supabase: SupabaseClient, userId: string): Promise<TaskWithRelations[]> {
  const { data, error } = await supabase
    .from("tasks")
    .select(TASK_SELECT)
    .eq("user_id", userId)
    .order("priority_score", { ascending: false })
    .order("updated_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data || []) as TaskWithRelations[];
}

async function fetchOpenCommitments(supabase: SupabaseClient, userId: string): Promise<OpenCommitmentRow[]> {
  const { data, error } = await supabase
    .from("commitments")
    .select("id, title, direction, status, due_at, notes, created_at, updated_at, stakeholder:stakeholders(id, name), task:tasks(id, title, status)")
    .eq("user_id", userId)
    .eq("status", "Open")
    .order("due_at", { ascending: true, nullsFirst: false });

  if (error) {
    throw error;
  }

  return ((data || []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    title: String(row.title),
    direction: row.direction as CommitmentDirection,
    status: "Open" as const,
    due_at: typeof row.due_at === "string" ? row.due_at : null,
    notes: typeof row.notes === "string" ? row.notes : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    stakeholder: Array.isArray(row.stakeholder)
      ? ((row.stakeholder[0] as { id?: string; name?: string } | undefined) ?? null)
      : ((row.stakeholder as { id?: string; name?: string } | null) ?? null),
    task: Array.isArray(row.task)
      ? ((row.task[0] as { id?: string; title?: string; status?: TaskStatus } | undefined) ?? null)
      : ((row.task as { id?: string; title?: string; status?: TaskStatus } | null) ?? null),
  })).map((row) => ({
    ...row,
    status: "Open" as const,
    stakeholder: row.stakeholder?.id && row.stakeholder?.name
      ? { id: row.stakeholder.id, name: row.stakeholder.name }
      : null,
    task: row.task?.id && row.task?.title && row.task?.status
      ? { id: row.task.id, title: row.task.title, status: row.task.status }
      : null,
  }));
}

async function fetchStakeholders(supabase: SupabaseClient, userId: string): Promise<StakeholderNameRow[]> {
  const { data, error } = await supabase
    .from("stakeholders")
    .select("id, name")
    .eq("user_id", userId)
    .order("name", { ascending: true });

  if (error) {
    throw error;
  }

  return (data || []) as StakeholderNameRow[];
}

async function fetchTaskCommentsForDay(
  supabase: SupabaseClient,
  userId: string,
  dayStartIso: string,
  dayEndExclusiveIso: string
): Promise<TaskCommentRow[]> {
  const { data, error } = await supabase
    .from("task_comments")
    .select("id, task_id, content, created_at, updated_at")
    .eq("user_id", userId)
    .gte("created_at", dayStartIso)
    .lt("created_at", dayEndExclusiveIso)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data || []) as TaskCommentRow[];
}

async function fetchCurrentSprint(
  supabase: SupabaseClient,
  userId: string,
  requestedDate: string
): Promise<{ id: string; name: string; theme: string | null; start_date: string; end_date: string } | null> {
  const { data, error } = await supabase
    .from("sprints")
    .select("id, name, theme, start_date, end_date")
    .eq("user_id", userId)
    .lte("start_date", requestedDate)
    .gte("end_date", requestedDate)
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ?? null;
}

function buildSprintSummary(
  currentSprint: { id: string; name: string; theme: string | null; start_date: string; end_date: string } | null,
  allTasks: TaskWithRelations[],
  requestedDate: string
): DailyBriefSprintSummary | null {
  if (!currentSprint) {
    return null;
  }

  const sprintTasks = allTasks.filter((task) => task.sprint_id === currentSprint.id);
  const totalTasks = sprintTasks.length;
  const completedTasks = sprintTasks.filter((task) => task.status === "Done").length;
  const completionPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const blockedTasks = sprintTasks.filter((task) => task.status === "Blocked/Waiting").length;
  const inProgressTasks = sprintTasks.filter((task) => task.status === "In Progress").length;
  const plannedTasks = sprintTasks.filter((task) => task.status === "Planned").length;
  const metrics = calculateSprintProgressMetrics({
    sprintStartDate: currentSprint.start_date,
    sprintEndDate: currentSprint.end_date,
    todayDate: requestedDate,
    totalTasks,
    completedTasks,
  });

  return {
    id: currentSprint.id,
    name: currentSprint.name,
    theme: currentSprint.theme,
    start_date: currentSprint.start_date,
    end_date: currentSprint.end_date,
    completed_tasks: completedTasks,
    total_tasks: totalTasks,
    completion_pct: completionPct,
    blocked_tasks: blockedTasks,
    in_progress_tasks: inProgressTasks,
    planned_tasks: plannedTasks,
    on_track: metrics.onTrack,
    tasks_behind_pace: metrics.tasksBehindPace,
    health_assessment: buildSprintHealthAssessment(currentSprint.name, completionPct, blockedTasks, metrics),
  };
}

function getRemainingMeetings(events: ApiCalendarEvent[]): ApiCalendarEvent[] {
  return events.filter((event) => event.temporal_status !== "past");
}

function toTaskInputs(tasks: TaskWithRelations[]): TaskInput[] {
  return tasks.map((task) => ({
    ...task,
    implementation: task.implementation
      ? {
          name: task.implementation.name,
          phase: task.implementation.phase ?? null,
          rag: task.implementation.rag ?? null,
        }
      : null,
  }));
}

function buildTomorrowPrepDigestItems(
  tomorrowPrep: ReturnType<typeof identifyPrepTasks>,
  allTasks: TaskWithRelations[],
  now: Date,
  requestedDate: string,
  commentActivity: Map<string, CommentActivity>,
  sinceIso: string | null
): DailyBriefDigestTaskItem[] {
  const byId = new Map(allTasks.map((task) => [task.id, task]));
  const items: DailyBriefDigestTaskItem[] = [];

  for (const prep of tomorrowPrep) {
    const task = byId.get(prep.task.id);
    if (!task) {
      continue;
    }

    const base = toTaskDigestItem(task, now, requestedDate, commentActivity, sinceIso);
    items.push({
      ...base,
      reason: prep.reason,
    });
  }

  return items.slice(0, 5);
}

export async function buildDailyBriefDigest({
  supabase,
  userId,
  mode = "auto",
  date = null,
  since = null,
}: BuildDigestOptions): Promise<DailyBriefDigestResponse> {
  const now = new Date();
  const requestedDate = normalizeDateOnly(date ?? getTodayET(now)) ?? getTodayET(now);
  const resolvedMode = mode === "auto" ? detectBriefingMode(now) : mode;
  const tomorrowDate = getTomorrowET(now);
  const currentTimeET = formatETTime(now);

  const dayRange = normalizeRequestedRange(requestedDate, requestedDate);
  const dayWindows = buildDayWindows(dayRange, DEFAULT_WORKDAY_CONFIG);
  const sinceIso = safeIso(since);
  const effectiveSince = sinceIso ?? dayWindows.utcRangeStart;

  const [todayEvents, tomorrowEvents, allTasks, openCommitments, stakeholders, commentsToday, currentSprint] = await Promise.all([
    fetchCalendarEvents(supabase, userId, requestedDate),
    resolvedMode === "eod" ? fetchCalendarEvents(supabase, userId, tomorrowDate) : Promise.resolve([]),
    fetchTasks(supabase, userId),
    fetchOpenCommitments(supabase, userId),
    fetchStakeholders(supabase, userId),
    fetchTaskCommentsForDay(supabase, userId, dayWindows.utcRangeStart, dayWindows.utcRangeEndExclusive),
    fetchCurrentSprint(supabase, userId, requestedDate),
  ]);

  const commentActivity = buildCommentActivityMap(commentsToday, effectiveSince);
  const openTasks = allTasks.filter((task) => task.status !== "Done" && task.status !== "Parked");
  const plannedTasks = openTasks.filter((task) => task.status === "Planned");
  const remainingEvents = getRemainingMeetings(todayEvents);
  const dueSoonTasks = openTasks
    .filter((task) => {
      if (!task.due_at) {
        return false;
      }

      const dueMs = new Date(task.due_at).getTime();
      return Number.isFinite(dueMs) && dueMs <= now.getTime() + (48 * 60 * 60 * 1000);
    })
    .sort(compareByDueThenPriority);
  const dueSoonTaskIds = new Set(dueSoonTasks.map((task) => task.id));
  const blockedTasks = openTasks
    .filter((task) => task.status === "Blocked/Waiting" && !dueSoonTaskIds.has(task.id))
    .sort(compareByPriorityThenUpdate);
  const inProgressTasks = openTasks
    .filter((task) => task.status === "In Progress" && !dueSoonTaskIds.has(task.id))
    .sort(compareByPriorityThenUpdate);
  const completedTodayTasks = allTasks
    .filter((task) => {
      if (task.status !== "Done") {
        return false;
      }

      const updatedAt = safeIso(task.updated_at);
      return Boolean(updatedAt && updatedAt >= dayWindows.utcRangeStart && updatedAt < dayWindows.utcRangeEndExclusive);
    })
    .sort(compareByUpdatedDesc);
  const rolledOverTasks = openTasks
    .filter((task) => {
      if (!task.due_at) {
        return false;
      }

      const dueMs = new Date(task.due_at).getTime();
      const dayEndMs = new Date(dayWindows.utcRangeEndExclusive).getTime();
      return Number.isFinite(dueMs) && Number.isFinite(dayEndMs) && dueMs < dayEndMs;
    })
    .sort(compareByDueThenPriority);
  const staleFollowupTasks = openTasks
    .filter((task) => {
      if (task.status !== "Blocked/Waiting") {
        return false;
      }
      if (!task.waiting_on || task.waiting_on.trim().length === 0) {
        return false;
      }

      const followUpMs = task.follow_up_at ? new Date(task.follow_up_at).getTime() : Number.NaN;
      if (Number.isFinite(followUpMs)) {
        return followUpMs <= now.getTime();
      }

      const updatedMs = new Date(task.updated_at).getTime();
      return Number.isFinite(updatedMs) && (now.getTime() - updatedMs) >= (72 * 60 * 60 * 1000);
    })
    .sort(compareByPriorityThenUpdate);
  const sprint = buildSprintSummary(currentSprint, allTasks, requestedDate);
  const meetings = buildMeetingDigestItems(remainingEvents, stakeholders, openCommitments, openTasks);
  const commitmentsTheirs = buildCommitmentGroups(openCommitments, "theirs");
  const commitmentsOurs = buildCommitmentGroups(openCommitments, "ours");

  const dueSoonDigest = dueSoonTasks.map((task) => toTaskDigestItem(task, now, requestedDate, commentActivity, effectiveSince));
  const blockedDigest = blockedTasks.map((task) => toTaskDigestItem(task, now, requestedDate, commentActivity, effectiveSince));
  const inProgressDigest = inProgressTasks.map((task) => toTaskDigestItem(task, now, requestedDate, commentActivity, effectiveSince));
  const completedTodayDigest = completedTodayTasks.map((task) => toTaskDigestItem(task, now, requestedDate, commentActivity, effectiveSince));
  const rolledOverDigest = rolledOverTasks.map((task) => toTaskDigestItem(task, now, requestedDate, commentActivity, effectiveSince));
  const staleFollowupDigest = staleFollowupTasks.map((task) => ({
    ...toTaskDigestItem(task, now, requestedDate, commentActivity, effectiveSince),
    reason: buildStaleFollowupReason(task, now),
  }));
  const tomorrowPrepDigest = resolvedMode === "eod"
    ? buildTomorrowPrepDigestItems(
        identifyPrepTasks(toTaskInputs(allTasks), tomorrowEvents, tomorrowDate),
        allTasks,
        now,
        requestedDate,
        commentActivity,
        effectiveSince
      )
    : [];
  const topTaskIds = new Set(
    openTasks
      .filter((task) => task.status === "Planned" || task.status === "In Progress")
      .slice(0, 3)
      .map((task) => task.id)
  );
  const remainingMeetingMinutes = getMeetingMinutes(remainingEvents);
  const afternoonEvents = remainingEvents.filter((event) => {
    const hour = getEtHour(event.start_at);
    return hour !== null && hour >= 12;
  });
  const meetingHeavyAfternoon = afternoonEvents.length >= 3 || getMeetingMinutes(afternoonEvents) >= 90;
  const capacity = calculateCapacity(allTasks, topTaskIds, remainingMeetingMinutes);
  const overdueDigest = dueSoonDigest.filter((task) => task.due_label?.startsWith("Overdue"));
  const counts: DailyBriefDigestCounts = {
    overdue: overdueDigest.length,
    due_soon: dueSoonDigest.length,
    blocked: openTasks.filter((task) => task.status === "Blocked/Waiting").length,
    in_progress: openTasks.filter((task) => task.status === "In Progress").length,
    done_today: completedTodayDigest.length,
    remaining_meetings: meetings.length,
    stale_followups: staleFollowupDigest.length,
    open_commitments_theirs: openCommitments.filter((item) => item.direction === "theirs").length,
    open_commitments_ours: openCommitments.filter((item) => item.direction === "ours").length,
  };
  const waitingOnOthersCount = openTasks.filter(
    (task) => task.status === "Blocked/Waiting" && Boolean(task.waiting_on && task.waiting_on.trim().length > 0)
  ).length;
  const isDayOverloaded =
    capacity.rag !== "Green" ||
    counts.overdue >= 3 ||
    (counts.due_soon + counts.in_progress >= 6) ||
    (meetingHeavyAfternoon && counts.due_soon >= 2);
  const signals: DailyBriefComputedSignals = {
    is_day_overloaded: isDayOverloaded,
    top_risk: buildTopRisk(sprint, overdueDigest, blockedDigest, staleFollowupDigest, meetingHeavyAfternoon, isDayOverloaded),
    waiting_on_others_count: waitingOnOthersCount,
    momentum_score: buildMomentumScore(
      counts.done_today,
      counts.overdue,
      counts.blocked,
      counts.stale_followups,
      counts.in_progress,
      meetingHeavyAfternoon
    ),
    meeting_heavy_afternoon: meetingHeavyAfternoon,
    capacity_rag: capacity.rag,
    available_minutes: capacity.available_minutes,
    required_minutes: capacity.required_minutes,
  };

  const narrative =
    resolvedMode === "morning"
      ? buildMorningNarrative(sprint, dueSoonDigest, blockedDigest, inProgressDigest, meetings)
      : resolvedMode === "midday"
        ? buildMiddayNarrative(completedTodayDigest, dueSoonDigest, blockedDigest, inProgressDigest, meetings)
        : buildEodNarrative(completedTodayDigest, rolledOverDigest, blockedDigest, tomorrowPrepDigest.length);

  const guidanceTitle: DailyBriefDigestResponse["guidance_title"] =
    resolvedMode === "morning"
      ? "Where to Start"
      : resolvedMode === "midday"
        ? "Afternoon Focus"
        : "Tomorrow Prep";
  const guidance =
    resolvedMode === "morning"
      ? buildMorningGuidance(dueSoonDigest, blockedDigest, inProgressDigest)
      : resolvedMode === "midday"
        ? buildMiddayGuidance(dueSoonDigest, blockedDigest, inProgressDigest)
        : buildEodGuidance(tomorrowPrepDigest, rolledOverDigest);
  const suggestedSyncToday =
    resolvedMode === "morning"
      ? buildMorningSyncRecommendations(dueSoonDigest, blockedDigest, inProgressDigest)
      : resolvedMode === "midday"
        ? buildMiddaySyncRecommendations(plannedTasks, dueSoonDigest, inProgressDigest)
        : [];

  const subject = buildSubject(
    resolvedMode,
    requestedDate,
    dueSoonDigest.length,
    completedTodayDigest.length,
    meetings.length,
    rolledOverDigest.length
  );

  const markdown = renderMarkdown({
    requestedDate,
    currentTimeET,
    mode: resolvedMode,
    narrative,
    sprint,
    dueSoon: dueSoonDigest,
    blocked: blockedDigest,
    inProgress: inProgressDigest,
    completedToday: completedTodayDigest,
    staleFollowups: staleFollowupDigest,
    rolledOver: resolvedMode === "eod" ? rolledOverDigest : [],
    meetings,
    commitmentsTheirs,
    guidanceTitle,
    guidance,
    syncRecommendations: suggestedSyncToday,
  });

  return {
    requestedDate,
    mode: resolvedMode,
    currentTimeET,
    generatedAt: now.toISOString(),
    since: effectiveSince,
    subject,
    markdown,
    narrative,
    sprint,
    tasks: {
      due_soon: dueSoonDigest,
      blocked: blockedDigest,
      in_progress: inProgressDigest,
      completed_today: completedTodayDigest,
      stale_followups: staleFollowupDigest,
      rolled_to_tomorrow: resolvedMode === "eod" ? rolledOverDigest : [],
    },
    counts,
    signals,
    meetings,
    commitments: {
      theirs: commitmentsTheirs,
      ours: commitmentsOurs,
    },
    guidance_title: guidanceTitle,
    guidance,
    suggested_sync_today: suggestedSyncToday,
  };
}
