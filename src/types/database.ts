export type TaskStatus = "Next" | "Scheduled" | "Waiting" | "Done";
export type TaskType = "Ticket" | "MeetingPrep" | "FollowUp" | "Admin" | "Build";
export type ImplPhase =
  | "Intake"
  | "Discovery"
  | "Design"
  | "Build"
  | "Test"
  | "Training"
  | "GoLive"
  | "Hypercare";
export type RagStatus = "Green" | "Yellow" | "Red";
export type EstimateSource = "default" | "llm" | "manual";

export interface Task {
  id: string;
  user_id: string;
  title: string;
  implementation_id: string | null;
  status: TaskStatus;
  task_type: TaskType;
  priority_score: number;
  estimated_minutes: number;
  estimate_source: EstimateSource;
  due_at: string | null;
  needs_review: boolean;
  blocker: boolean;
  waiting_on: string | null;
  follow_up_at: string | null;
  stakeholder_mentions: string[];
  source_type: string;
  source_url: string | null;
  inbox_item_id: string | null;
  pinned_excerpt: string | null;
  created_at: string;
  updated_at: string;
}

export interface Implementation {
  id: string;
  user_id: string;
  name: string;
  phase: ImplPhase;
  rag: RagStatus;
  target_date: string | null;
  status_summary: string;
  next_milestone: string;
  next_milestone_date: string | null;
  stakeholders: string[];
  keywords: string[];
  created_at: string;
  updated_at: string;
}

export interface StatusUpdate {
  id: string;
  user_id: string;
  implementation_id: string;
  created_at: string;
  update_text: string;
  created_by: "Brent" | "Assistant";
  related_task_ids: string[];
}

export interface TaskChecklistItem {
  id: string;
  user_id: string;
  task_id: string;
  text: string;
  is_done: boolean;
  sort_order: number;
}

export interface CapacityConfig {
  work_minutes: number;
  lunch_minutes: number;
  daily_overhead_minutes: number;
  max_buffer_minutes: number;
  buffer_per_task: number;
}

export interface CapacityBreakdown {
  work_minutes: number;
  lunch_minutes: number;
  daily_overhead_minutes: number;
  buffer_minutes: number;
  meeting_minutes: number;
}

export interface CapacityResult {
  available_minutes: number;
  required_minutes: number;
  rag: RagStatus;
  breakdown: CapacityBreakdown;
}

// LLM Extraction JSON schema (stored in inbox_items.llm_extraction_json)
export interface LlmExtraction {
  title: string;
  suggested_checklist: string[];
  task_type: TaskType;
  estimated_minutes: number;
  due_guess_iso: string | null;
  due_confidence: number;
  implementation_guess: string | null;
  implementation_confidence: number;
  stakeholder_mentions: string[];
  priority_score: number;
  needs_review: boolean;
  blocker: boolean;
  waiting_on: string | null;
}
