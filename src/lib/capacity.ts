import { Task, CapacityConfig, CapacityResult, RagStatus } from '@/types/database';
import { DEFAULT_WORKDAY_CONFIG } from '@/lib/workday';

export const CAPACITY_TIMEZONE = DEFAULT_WORKDAY_CONFIG.timezone;

// Default capacity configuration from spec Section B
export const DEFAULT_CAPACITY_CONFIG: CapacityConfig = {
  work_minutes: 510, // 8:00 AM - 4:30 PM
  lunch_minutes: 30,
  daily_overhead_minutes: 90, // Context switching, pings, admin
  max_buffer_minutes: 60, // Cap on buffer time
  buffer_per_task: 10, // 10 minutes between focus blocks
};

/**
 * Calculate buffer minutes based on number of focus tasks
 * Buffer = 10 * (focus_task_count - 1), capped at 60
 */
export function calculateBufferMinutes(
  focusTaskCount: number,
  config: CapacityConfig = DEFAULT_CAPACITY_CONFIG
): number {
  if (focusTaskCount <= 1) return 0;

  const buffer = config.buffer_per_task * (focusTaskCount - 1);
  return Math.min(buffer, config.max_buffer_minutes);
}

/**
 * Calculate available focus minutes for the day
 * available = work - lunch - overhead - buffers - meetings
 */
export function calculateAvailableMinutes(
  focusTaskCount: number,
  meetingMinutes: number = 0,
  config: CapacityConfig = DEFAULT_CAPACITY_CONFIG
): number {
  const bufferMinutes = calculateBufferMinutes(focusTaskCount, config);

  return (
    config.work_minutes -
    config.lunch_minutes -
    config.daily_overhead_minutes -
    bufferMinutes -
    meetingMinutes
  );
}

/**
 * Calculate required minutes from tasks
 * Sum of estimated_minutes for:
 * - Tasks due today
 * - Top 3 priority tasks (even if not due today)
 */
export function calculateRequiredMinutes(
  tasks: Task[],
  topTaskIds: Set<string> = new Set()
): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  return tasks
    .filter((task) => {
      if (task.status === 'Done') return false;

      // Include if in top 3
      if (topTaskIds.has(task.id)) return true;

      // Include if due today
      if (task.due_at) {
        const dueDate = new Date(task.due_at);
        return dueDate >= today && dueDate < tomorrow;
      }

      return false;
    })
    .reduce((sum, task) => sum + task.estimated_minutes, 0);
}

/**
 * Determine RAG status based on capacity
 * Green: required <= available
 * Yellow: 1-60 minutes over
 * Red: >60 minutes over
 */
export function determineRagStatus(
  requiredMinutes: number,
  availableMinutes: number
): RagStatus {
  const overage = requiredMinutes - availableMinutes;

  if (overage <= 0) {
    return 'Green';
  } else if (overage <= 60) {
    return 'Yellow';
  } else {
    return 'Red';
  }
}

/**
 * Calculate full capacity result for Today view
 */
export function calculateCapacity(
  tasks: Task[],
  topTaskIds: Set<string>,
  meetingMinutes: number = 0,
  config: CapacityConfig = DEFAULT_CAPACITY_CONFIG
): CapacityResult {
  // Count focus tasks (planned/in-progress tasks for today)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const focusTasks = tasks.filter((task) => {
    if (task.status !== 'Planned' && task.status !== 'In Progress') return false;
    if (topTaskIds.has(task.id)) return true;
    if (task.due_at) {
      const dueDate = new Date(task.due_at);
      return dueDate >= today && dueDate < tomorrow;
    }
    return false;
  });

  const focusTaskCount = focusTasks.length;
  const bufferMinutes = calculateBufferMinutes(focusTaskCount, config);
  const availableMinutes = calculateAvailableMinutes(focusTaskCount, meetingMinutes, config);
  const requiredMinutes = calculateRequiredMinutes(tasks, topTaskIds);
  const rag = determineRagStatus(requiredMinutes, availableMinutes);

  return {
    available_minutes: availableMinutes,
    required_minutes: requiredMinutes,
    rag,
    breakdown: {
      work_minutes: config.work_minutes,
      lunch_minutes: config.lunch_minutes,
      daily_overhead_minutes: config.daily_overhead_minutes,
      buffer_minutes: bufferMinutes,
      meeting_minutes: meetingMinutes,
    },
  };
}

/**
 * Format capacity for display
 */
export function formatCapacityDisplay(result: CapacityResult): string {
  const { available_minutes, required_minutes } = result;
  const diff = available_minutes - required_minutes;

  if (diff >= 0) {
    return `${required_minutes}/${available_minutes} min (${diff} min buffer)`;
  } else {
    return `${required_minutes}/${available_minutes} min (${Math.abs(diff)} min over)`;
  }
}

/**
 * Get capacity breakdown as human-readable lines
 * For tooltip/expandable display
 */
export function getCapacityBreakdown(result: CapacityResult): string[] {
  const { breakdown, available_minutes, required_minutes } = result;

  return [
    `Work day: ${breakdown.work_minutes} min`,
    `Lunch: -${breakdown.lunch_minutes} min`,
    `Overhead: -${breakdown.daily_overhead_minutes} min`,
    `Buffers: -${breakdown.buffer_minutes} min`,
    breakdown.meeting_minutes > 0 ? `Meetings: -${breakdown.meeting_minutes} min` : null,
    `= Available: ${available_minutes} min`,
    `Required: ${required_minutes} min`,
  ].filter(Boolean) as string[];
}

/**
 * Calculate capacity for multiple days (future use)
 */
export function calculateWeekCapacity(
  tasksByDay: Map<string, Task[]>,
  config: CapacityConfig = DEFAULT_CAPACITY_CONFIG
): Map<string, CapacityResult> {
  const results = new Map<string, CapacityResult>();

  for (const [dateStr, tasks] of tasksByDay) {
    // For weekly view, use top 3 from each day's tasks
    const sortedTasks = [...tasks]
      .filter((task) => task.status === 'Planned' || task.status === 'In Progress')
      .sort((a, b) => b.priority_score - a.priority_score);
    const topTaskIds = new Set(sortedTasks.slice(0, 3).map((t) => t.id));

    results.set(dateStr, calculateCapacity(tasks, topTaskIds, 0, config));
  }

  return results;
}
