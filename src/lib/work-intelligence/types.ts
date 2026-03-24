import type { CapacityResult, TaskWithImplementation } from "../../types/database";

export type WorkIntelligenceConfidence = "high" | "medium" | "low";

export interface WorkIntelligenceFreshnessSource {
  source: string;
  label?: string;
  latestAt: string | null;
  ageHours: number | null;
  stale: boolean;
  missing: boolean;
  required: boolean;
  note?: string | null;
}

export interface WorkIntelligenceFreshness {
  evaluatedAt: string;
  overall: "fresh" | "mixed" | "stale";
  sources: WorkIntelligenceFreshnessSource[];
}

export interface WorkIntelligenceSupportingSignal {
  kind: string;
  summary: string;
  detail?: string | null;
  relatedTaskIds?: string[];
}

export interface WorkIntelligenceMetadata<TRawSignals = Record<string, unknown>> {
  confidence: WorkIntelligenceConfidence;
  freshness: WorkIntelligenceFreshness;
  caveats: string[];
  supportingSignals: WorkIntelligenceSupportingSignal[];
  generatedAt: string;
  rawSignals?: TRawSignals;
}

export interface WorkIntelligenceWindow {
  requestedDate: string;
  since: string;
  dayStartIso: string;
  dayEndExclusiveIso: string;
  timezone: string;
}

export type WorkEventTemporalStatus = "past" | "in_progress" | "upcoming";

export interface WorkIntelligenceEvent {
  title: string;
  start_at: string;
  end_at: string;
  is_all_day: boolean;
  temporal_status?: WorkEventTemporalStatus | null;
}

export interface WorkIntelligenceCommentActivity {
  count: number;
  latestAt: string;
  latestSnippet: string | null;
}

export interface WorkIntelligenceCommentRow {
  id: string;
  task_id: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface WorkIntelligenceTask extends Omit<TaskWithImplementation, "sprint"> {
  sprint: { id: string; name: string; start_date: string; end_date: string; theme?: string | null } | null;
}

export interface WorkIntelligenceSprintRecord {
  id: string;
  name: string;
  theme: string | null;
  start_date: string;
  end_date: string;
}

export interface WorkSprintSummary {
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

export interface WorkTaskCounts {
  overdue: number;
  dueSoon: number;
  blocked: number;
  inProgress: number;
  doneToday: number;
  followUpRisks: number;
  statusUncertain: number;
  quietInProgress: number;
  waitingOnOthers: number;
}

export interface WorkIntelligenceSnapshot {
  generatedAt: string;
  now: Date;
  window: WorkIntelligenceWindow;
  tasks: WorkIntelligenceTask[];
  openTasks: WorkIntelligenceTask[];
  plannedTasks: WorkIntelligenceTask[];
  overdueTasks: WorkIntelligenceTask[];
  dueSoonTasks: WorkIntelligenceTask[];
  blockedTasks: WorkIntelligenceTask[];
  inProgressTasks: WorkIntelligenceTask[];
  completedTodayTasks: WorkIntelligenceTask[];
  rolledOverTasks: WorkIntelligenceTask[];
  followUpRiskTasks: WorkIntelligenceTask[];
  statusUncertainTasks: WorkIntelligenceTask[];
  quietInProgressTasks: WorkIntelligenceTask[];
  remainingEvents: WorkIntelligenceEvent[];
  remainingMeetingMinutes: number;
  meetingHeavyAfternoon: boolean;
  commentActivity: Map<string, WorkIntelligenceCommentActivity>;
  currentSprint: WorkIntelligenceSprintRecord | null;
  sprintSummary: WorkSprintSummary | null;
  topTaskIdsForCapacity: Set<string>;
  capacity: CapacityResult;
  coreCounts: WorkTaskCounts;
}
