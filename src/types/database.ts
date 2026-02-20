export type TaskStatus = "Backlog" | "Planned" | "In Progress" | "Blocked/Waiting" | "Done";
export type TaskType = "Task" | "Ticket" | "MeetingPrep" | "FollowUp" | "Admin" | "Build";
export type CommentSource = "manual" | "system" | "llm";
export type CommitmentStatus = "Open" | "Done" | "Dropped";
export type CommitmentDirection = "ours" | "theirs";
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
  description: string | null;
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

export interface TaskComment {
  id: string;
  user_id: string;
  task_id: string;
  content: string;
  source: CommentSource;
  created_at: string;
  updated_at: string;
}

export interface TaskDependency {
  id: string;
  user_id: string;
  blocker_task_id: string;
  blocked_task_id: string;
  created_at: string;
}

// Dependency with joined task info for display
export interface TaskDependencyWithTask extends TaskDependency {
  blocker_task?: {
    id: string;
    title: string;
    status: TaskStatus;
    blocker: boolean;
    implementation?: { id: string; name: string } | null;
  };
  blocked_task?: {
    id: string;
    title: string;
    status: TaskStatus;
    blocker: boolean;
    implementation?: { id: string; name: string } | null;
  };
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

export interface Stakeholder {
  id: string;
  user_id: string;
  name: string;
  email: string | null;
  role: string | null;
  organization: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Commitment {
  id: string;
  user_id: string;
  stakeholder_id: string;
  task_id: string | null;
  title: string;
  direction: CommitmentDirection;
  status: CommitmentStatus;
  due_at: string | null;
  done_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommitmentWithStakeholder extends Commitment {
  stakeholder: { id: string; name: string } | null;
}

export interface CommitmentWithTask extends Commitment {
  task: { id: string; title: string; status: TaskStatus } | null;
}

export interface StakeholderWithCounts extends Stakeholder {
  open_commitments_count: number;
}

// LLM Extraction JSON schema (stored in inbox_items.llm_extraction_json)
export interface LlmExtraction {
  title: string;
  suggested_tasks: string[];
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

// Task with joined implementation data (from API responses)
export interface TaskWithImplementation extends Task {
  implementation: { id: string; name: string } | null;
}

// Allowed fields for task updates via API
export interface TaskUpdatePayload {
  title?: string;
  description?: string | null;
  implementation_id?: string | null;
  status?: TaskStatus;
  task_type?: TaskType;
  estimated_minutes?: number;
  estimate_source?: EstimateSource;
  due_at?: string | null;
  needs_review?: boolean;
  blocker?: boolean;
  waiting_on?: string | null;
  follow_up_at?: string | null;
  pinned_excerpt?: string | null;
}

// Implementation summary for dropdowns
export interface ImplementationSummary {
  id: string;
  name: string;
  phase?: ImplPhase;
  rag?: RagStatus;
}

// Task summary for implementation detail
export interface TaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  estimated_minutes: number;
  due_at: string | null;
  blocker: boolean;
  priority_score?: number;
  updated_at?: string;
}

// Implementation detail with related data
export interface ImplementationDetail extends Implementation {
  blockers_count: number;
  open_tasks: TaskSummary[];
  recent_done_tasks: TaskSummary[];
}

// Allowed fields for implementation updates via API
export interface ImplementationUpdatePayload {
  name?: string;
  phase?: ImplPhase;
  rag?: RagStatus;
  target_date?: string | null;
  status_summary?: string;
  next_milestone?: string;
  next_milestone_date?: string | null;
  stakeholders?: string[];
  keywords?: string[];
}
