/**
 * Prep task identification for Daily Briefing EOD mode
 * Identifies tasks that should be worked on today to prepare for tomorrow
 */

import type { ImplPhase, RagStatus, Task, TaskType } from "@/types/database";
import type { ApiCalendarEvent } from "@/lib/calendar";

export interface PrepTask {
  task: TaskSummary;
  reason: string;
  targetMeetingTitle?: string;
  targetMeetingTime?: string;
}

export interface TaskSummary {
  id: string;
  title: string;
  task_type: TaskType;
  estimated_minutes: number;
  priority_score: number;
  due_at: string | null;
  status: string;
  blocker: boolean;
  waiting_on: string | null;
  project_id?: string | null;
  project_name?: string | null;
  section_id?: string | null;
  section_name?: string | null;
  implementation_name?: string | null;
  implementation_phase?: ImplPhase | null;
  implementation_rag?: RagStatus | null;
}

/** Input type for prep task functions - compatible with TaskWithImplementation */
export type TaskInput = Task & {
  implementation?: { name: string; phase?: ImplPhase | null; rag?: RagStatus | null } | null;
  project?: { id: string; name: string } | null;
  section_name?: string | null;
};

/**
 * Words too generic to link a task to a meeting on their own: task verbs and
 * meeting/ritual words that appear in many unrelated titles ("Check for REDCap
 * Upgrade" vs "BOS calendar and budget build weekly check in" only share
 * "check"; two Google IT cert modules only shared one topic word with the
 * day's meetings). They are dropped before matching: they never count as a
 * shared word and never count toward a title's keyword total, and a title
 * made only of them cannot match at all.
 */
const GENERIC_WORDS = [
  // Articles, prepositions, auxiliaries
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "is", "was", "are", "were", "been",
  "be", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "must", "shall", "can", "need",
  // Meeting and ritual words
  "meeting", "call", "sync", "review", "update", "updates", "status", "weekly",
  "daily", "monthly", "prep", "preparation", "prepare", "check", "checkin",
  "follow", "followup", "team", "notes", "note", "standup", "agenda", "touchbase",
  // Generic task verbs and nouns
  "verify", "test", "run", "build", "add", "create", "apply", "fix", "idea",
  "project", "module", "task", "work", "item", "items", "action",
];
const STOP_WORDS = new Set(GENERIC_WORDS);

/** A task links to an event only when at least this many significant words are shared. */
const MIN_SHARED_KEYWORDS = 2;
/** ...and those shared words are at least this share of the task title's significant words... */
const MIN_KEYWORD_OVERLAP = 0.3;
/**
 * ...or at least this share of the meeting title's significant words. A long task title
 * ("Present the ECL security class change at Change Control before the prod push") shares
 * few words in proportion to its length with a short meeting title ("Bi-Weekly Change
 * Control Meeting"), but it covers nearly all of the meeting's words.
 */
const MIN_EVENT_COVERAGE = 0.6;

/**
 * Extract keywords from a string for matching
 * Removes common words and returns significant terms
 */
function extractKeywords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
    ),
  ];
}

/**
 * Check if a task title matches a calendar event.
 * Needs at least two shared significant keywords (one shared word, however
 * distinctive, is how unrelated tasks got linked to meetings) and the shared
 * words must be at least 30% of the task's significant keywords or at least
 * 60% of the meeting's significant keywords.
 */
function titleMatchesEvent(taskTitle: string, eventTitle: string): boolean {
  const taskKeywords = extractKeywords(taskTitle);
  const eventKeywords = extractKeywords(eventTitle);

  if (taskKeywords.length === 0 || eventKeywords.length === 0) {
    return false;
  }

  const matches = taskKeywords.filter((kw) => eventKeywords.includes(kw));

  return (
    matches.length >= MIN_SHARED_KEYWORDS &&
    (matches.length / taskKeywords.length >= MIN_KEYWORD_OVERLAP || matches.length / eventKeywords.length >= MIN_EVENT_COVERAGE)
  );
}

/**
 * Format time for display (e.g., "9:00 AM")
 */
function formatEventTime(isoTime: string, timezone = "America/New_York"): string {
  return new Date(isoTime).toLocaleTimeString("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Convert a Task to TaskSummary
 */
export function taskToSummary(
  task: Task,
  projectName?: string | null,
  sectionName?: string | null,
  implementationName?: string | null,
  implementationPhase?: ImplPhase | null,
  implementationRag?: RagStatus | null
): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    task_type: task.task_type,
    estimated_minutes: task.estimated_minutes,
    priority_score: task.priority_score,
    due_at: task.due_at,
    status: task.status,
    blocker: task.blocker,
    waiting_on: task.waiting_on,
    project_id: task.project_id ?? null,
    project_name: projectName ?? null,
    section_id: task.section_id ?? null,
    section_name: sectionName ?? null,
    implementation_name: implementationName,
    implementation_phase: implementationPhase ?? null,
    implementation_rag: implementationRag ?? null,
  };
}

/**
 * Identify prep tasks for tomorrow
 *
 * A task is a prep task if:
 * 1. task_type === 'MeetingPrep' AND not done
 * 2. Title contains keywords matching tomorrow's meeting titles
 * 3. Due tomorrow AND estimated_minutes >= 60 (benefits from starting today)
 */
export function identifyPrepTasks(
  tasks: TaskInput[],
  tomorrowEvents: ApiCalendarEvent[],
  tomorrowDateET: string,
  /** Which day the events are on, for the reason text. EOD passes tomorrow's; the morning passes today's. */
  options: { day?: "tomorrow" | "today" } = {}
): PrepTask[] {
  const day = options.day ?? "tomorrow";
  const prepTasks: PrepTask[] = [];
  const tomorrowStart = `${tomorrowDateET}T00:00:00`;
  const tomorrowEnd = `${tomorrowDateET}T23:59:59`;

  // Sort events by start time for matching
  const sortedEvents = [...tomorrowEvents].sort((a, b) =>
    a.start_at.localeCompare(b.start_at)
  );

  for (const task of tasks) {
    // Skip completed tasks
    if (task.status === "Done" || task.status === "Parked" || task.status === "Missed") continue;

    // 1. MeetingPrep tasks
    if (task.task_type === "MeetingPrep") {
      // Try to find a matching event
      const matchingEvent = sortedEvents.find((event) =>
        titleMatchesEvent(task.title, event.title)
      );

      prepTasks.push({
        task: taskToSummary(
          task,
          task.project?.name,
          task.section_name ?? null,
          task.implementation?.name,
          task.implementation?.phase,
          task.implementation?.rag
        ),
        reason: matchingEvent
          ? `Prep for: ${matchingEvent.title} at ${formatEventTime(matchingEvent.start_at)}`
          : "Meeting preparation task",
        targetMeetingTitle: matchingEvent?.title,
        targetMeetingTime: matchingEvent?.start_at,
      });
      continue;
    }

    // 2. Tasks with title matching tomorrow's meetings
    const matchingEvent = sortedEvents.find((event) =>
      titleMatchesEvent(task.title, event.title)
    );

    if (matchingEvent) {
      prepTasks.push({
        task: taskToSummary(
          task,
          task.project?.name,
          task.section_name ?? null,
          task.implementation?.name,
          task.implementation?.phase,
          task.implementation?.rag
        ),
        reason: `Related to: ${matchingEvent.title} at ${formatEventTime(matchingEvent.start_at)}`,
        targetMeetingTitle: matchingEvent.title,
        targetMeetingTime: matchingEvent.start_at,
      });
      continue;
    }

    // 3. Large tasks due tomorrow
    if (task.due_at && task.due_at >= tomorrowStart && task.due_at <= tomorrowEnd) {
      if (task.estimated_minutes >= 60) {
        prepTasks.push({
          task: taskToSummary(
            task,
            task.project?.name,
            task.section_name ?? null,
            task.implementation?.name,
            task.implementation?.phase,
            task.implementation?.rag
          ),
          reason:
            day === "tomorrow"
              ? `Due tomorrow (${task.estimated_minutes} min) - consider starting today`
              : `Due today (${task.estimated_minutes} min) - block time for it early`,
        });
      }
    }
  }

  // Sort by target meeting time (earliest first), then by priority
  return prepTasks.sort((a, b) => {
    if (a.targetMeetingTime && b.targetMeetingTime) {
      return a.targetMeetingTime.localeCompare(b.targetMeetingTime);
    }
    if (a.targetMeetingTime && !b.targetMeetingTime) return -1;
    if (!a.targetMeetingTime && b.targetMeetingTime) return 1;
    return (b.task.priority_score ?? 0) - (a.task.priority_score ?? 0);
  });
}

/**
 * Find tasks that were planned for today but not completed (rolled over)
 */
export function findRolledOverTasks(
  tasks: TaskInput[],
  todayDateET: string
): TaskSummary[] {
  const todayEnd = `${todayDateET}T23:59:59`;

  return tasks
    .filter((task) => {
      // Not completed
      if (task.status === "Done" || task.status === "Parked" || task.status === "Missed") return false;
      // Was due today or earlier
      if (task.due_at && task.due_at <= todayEnd) return true;
      // Or has high priority and is actionable
      if (task.priority_score >= 70 && (task.status === "Planned" || task.status === "In Progress")) return true;
      return false;
    })
    .map((task) => taskToSummary(
      task,
      task.project?.name,
      task.section_name ?? null,
      task.implementation?.name,
      task.implementation?.phase,
      task.implementation?.rag
    ))
    .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0));
}

/**
 * Find tasks completed today
 */
export function findCompletedTodayTasks(
  tasks: TaskInput[],
  todayDateET: string
): TaskSummary[] {
  const todayStart = `${todayDateET}T00:00:00`;
  const todayEnd = `${todayDateET}T23:59:59`;

  return tasks
    .filter((task) => {
      if (task.status !== "Done") return false;
      // Check if updated_at is today (assumes completion updates the timestamp)
      return task.updated_at >= todayStart && task.updated_at <= todayEnd;
    })
    .map((task) => taskToSummary(
      task,
      task.project?.name,
      task.section_name ?? null,
      task.implementation?.name,
      task.implementation?.phase,
      task.implementation?.rag
    ));
}
