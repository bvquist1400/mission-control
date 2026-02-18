import type { ApiCalendarEvent, BusyBlock, BusyStats } from "@/lib/calendar";
import type { CapacityResult } from "@/types/database";
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
  estimatedCapacity: CapacityResult;
}

export interface BriefingResponse {
  requestedDate: string;
  mode: BriefingMode;
  autoDetectedMode: BriefingMode;
  currentTimeET: string;
  today: TodayBriefingData;
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
