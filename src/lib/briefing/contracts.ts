import type { ApiCalendarEvent, BusyBlock, BusyStats } from "@/lib/calendar";
import type { CapacityResult, CommitmentDirection, ImplementationHealthScore, RiskLevel } from "@/types/database";
import type { BriefingMode } from "./time-detection";
import type { FocusBlock } from "./focus-blocks";
import type { PrepTask, TaskSummary } from "./prep-tasks";
import type { LlmRunMeta } from "@/lib/llm/types";

export interface BriefingSectionGroup<TItem> {
  section_id: string | null;
  section_name: string | null;
  tasks: TItem[];
}

export interface BriefingProjectGroup<TItem> {
  project_id: string;
  project_name: string;
  has_sections: boolean;
  groups: BriefingSectionGroup<TItem>[];
}

export interface BriefingGroupedProjectTasks<TItem> {
  projects: BriefingProjectGroup<TItem>[];
  unassigned: TItem[];
}

export interface BriefingCalendarData {
  events: ApiCalendarEvent[];
  busyBlocks: BusyBlock[];
  stats: BusyStats;
  focusBlocks: FocusBlock[];
}

export interface BriefingTaskData {
  planned: TaskSummary[];
  completed: TaskSummary[];
  remaining: TaskSummary[];
  planned_by_project?: BriefingGroupedProjectTasks<TaskSummary>;
  completed_by_project?: BriefingGroupedProjectTasks<TaskSummary>;
  remaining_by_project?: BriefingGroupedProjectTasks<TaskSummary>;
}

export interface BriefingProgress {
  completedCount: number;
  totalCount: number;
  completedMinutes: number;
  remainingMinutes: number;
  percentComplete: number;
}

export interface BriefingColdCommitment {
  stakeholder_name: string;
  title: string;
  days_open: number;
  due_at: string | null;
}

export interface BriefingCommitmentData {
  cold_commitments: BriefingColdCommitment[];
}

export interface BriefingRiskRadarItem {
  implementation_id: string;
  implementation_name: string;
  risk_level: RiskLevel;
  risk_score: number;
  signals: string[];
}

export interface BriefingTomorrowCommitmentItem {
  id: string;
  title: string;
  direction: CommitmentDirection;
  due_at: string | null;
  stakeholder_name: string;
}

export interface BriefingTomorrowContextItem {
  event_title: string;
  event_time: string;
  related_tasks: TaskSummary[];
  open_commitments: BriefingTomorrowCommitmentItem[];
}

export interface BriefingOpenReviewItem {
  artifact_id: string;
  artifact_type: string;
  task_id: string;
  task_title: string;
  suggested_action: string;
}

export interface TodayBriefingData {
  calendar: BriefingCalendarData;
  tasks: BriefingTaskData;
  capacity: CapacityResult;
  progress: BriefingProgress;
}

export interface TomorrowBriefingData {
  date: string;
  calendar: Omit<BriefingCalendarData, "focusBlocks">;
  prepTasks: PrepTask[];
  rolledOver: TaskSummary[];
  prepTasks_by_project?: BriefingGroupedProjectTasks<PrepTask>;
  rolledOver_by_project?: BriefingGroupedProjectTasks<TaskSummary>;
  tomorrow_context: BriefingTomorrowContextItem[];
  estimatedCapacity: CapacityResult;
}

export interface BriefingResponse {
  requestedDate: string;
  mode: BriefingMode;
  autoDetectedMode: BriefingMode;
  currentTimeET: string;
  today: TodayBriefingData;
  commitments: BriefingCommitmentData;
  risk_radar: BriefingRiskRadarItem[];
  health_scores: ImplementationHealthScore[];
  open_review_items: BriefingOpenReviewItem[];
  tomorrow?: TomorrowBriefingData;
}

export interface BriefingNarrativeRequest {
  briefing: BriefingResponse;
}

export interface BriefingNarrativeResponse {
  mode: BriefingMode;
  narrative: string;
  llm: LlmRunMeta | null;
}
