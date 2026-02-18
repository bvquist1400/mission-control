/**
 * Prep task identification for Daily Briefing EOD mode
 * Identifies tasks that should be worked on today to prepare for tomorrow
 */

import type { Task, TaskType } from "@/types/database";
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
  implementation_name?: string | null;
}

/** Input type for prep task functions - compatible with TaskWithImplementation */
export type TaskInput = Task & { implementation?: { name: string } | null };

/**
 * Extract keywords from a string for matching
 * Removes common words and returns significant terms
 */
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "as", "is", "was", "are", "were", "been",
    "be", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "must", "shall", "can", "need",
    "meeting", "call", "sync", "review", "update", "status", "weekly",
    "daily", "monthly", "prep", "preparation", "prepare",
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word));
}

/**
 * Check if a task title matches a calendar event
 * Returns true if there's significant keyword overlap
 */
function titleMatchesEvent(taskTitle: string, eventTitle: string): boolean {
  const taskKeywords = extractKeywords(taskTitle);
  const eventKeywords = extractKeywords(eventTitle);

  if (taskKeywords.length === 0 || eventKeywords.length === 0) {
    return false;
  }

  // Count matching keywords
  const matches = taskKeywords.filter((kw) => eventKeywords.includes(kw));

  // Require at least 1 significant keyword match
  // and at least 30% of task keywords to match
  return matches.length >= 1 && matches.length / taskKeywords.length >= 0.3;
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
  implementationName?: string | null
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
    implementation_name: implementationName,
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
  tomorrowDateET: string
): PrepTask[] {
  const prepTasks: PrepTask[] = [];
  const tomorrowStart = `${tomorrowDateET}T00:00:00`;
  const tomorrowEnd = `${tomorrowDateET}T23:59:59`;

  // Sort events by start time for matching
  const sortedEvents = [...tomorrowEvents].sort((a, b) =>
    a.start_at.localeCompare(b.start_at)
  );

  for (const task of tasks) {
    // Skip completed tasks
    if (task.status === "Done") continue;

    // 1. MeetingPrep tasks
    if (task.task_type === "MeetingPrep") {
      // Try to find a matching event
      const matchingEvent = sortedEvents.find((event) =>
        titleMatchesEvent(task.title, event.title)
      );

      prepTasks.push({
        task: taskToSummary(task, task.implementation?.name),
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
        task: taskToSummary(task, task.implementation?.name),
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
          task: taskToSummary(task, task.implementation?.name),
          reason: `Due tomorrow (${task.estimated_minutes} min) - consider starting today`,
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
      if (task.status === "Done") return false;
      // Was due today or earlier
      if (task.due_at && task.due_at <= todayEnd) return true;
      // Or has high priority and is actionable
      if (task.priority_score >= 70 && (task.status === "Planned" || task.status === "In Progress")) return true;
      return false;
    })
    .map((task) => taskToSummary(task, task.implementation?.name))
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
    .map((task) => taskToSummary(task, task.implementation?.name));
}
