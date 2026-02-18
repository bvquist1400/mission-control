/**
 * Daily Briefing utilities
 */

// Time detection
export {
  type BriefingMode,
  detectBriefingMode,
  getBriefingModeLabel,
  getETTime,
  getETHour,
  formatETTime,
  getTodayET,
  getTomorrowET,
} from "./time-detection";

// Focus blocks
export {
  type FocusBlock,
  calculateFocusBlocks,
  getLargestFocusBlock,
  getTotalFocusMinutes,
  formatFocusBlock,
} from "./focus-blocks";

// Prep tasks
export {
  type PrepTask,
  type TaskSummary,
  type TaskInput,
  taskToSummary,
  identifyPrepTasks,
  findRolledOverTasks,
  findCompletedTodayTasks,
} from "./prep-tasks";

// Contracts
export type {
  BriefingCalendarData,
  BriefingTaskData,
  BriefingProgress,
  TodayBriefingData,
  TomorrowBriefingData,
  BriefingResponse,
  BriefingNarrativeRequest,
  BriefingNarrativeResponse,
} from "./contracts";
