import type { ApiCalendarEvent, BusyBlock, BusyStats } from "@/lib/calendar";
import type { CapacityResult, CommitmentDirection, RiskLevel } from "@/types/database";
import type { BriefingMode } from "./time-detection";
import type { FocusBlock } from "./focus-blocks";
import type { PrepTask, TaskSummary } from "./prep-tasks";
import type { LlmRunMeta } from "@/lib/llm/types";

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
