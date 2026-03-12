export type TaskStatus = "Backlog" | "Planned" | "In Progress" | "Blocked/Waiting" | "Parked" | "Done";
export type TaskType = "Task" | "Ticket" | "MeetingPrep" | "FollowUp" | "Admin" | "Build";
export type CommentSource = "manual" | "system" | "llm";
export type CommitmentStatus = "Open" | "Done" | "Dropped";
export type CommitmentDirection = "ours" | "theirs";
export type TaskDependencyType = "task" | "commitment";
export type TaskDependencyStatus = TaskStatus | CommitmentStatus;
export type RiskLevel = "green" | "yellow" | "red";
export type TaskRecurrenceFrequency = "daily" | "weekly" | "biweekly" | "monthly";
export type HealthTrend = "improving" | "stable" | "degrading" | "unknown";
export type HealthLabel = "Healthy" | "Watch" | "At Risk" | "Critical";
export type ImplPhase =
  | "Intake"
  | "Discovery"
  | "Design"
  | "Build"
  | "Test"
  | "Training"
  | "GoLive"
  | "Hypercare"
  | "Steady State"
  | "Sundown";
export type ProjectStage =
  | "Proposed"
  | "Planned"
  | "Ready"
  | "In Progress"
  | "Blocked"
  | "Review"
  | "Done"
  | "On Hold"
  | "Cancelled";
export type RagStatus = "Green" | "Yellow" | "Red";
export type EstimateSource = "default" | "llm" | "manual";

export interface TaskRecurrence {
  enabled: boolean;
  frequency: TaskRecurrenceFrequency;
  day_of_week: number | null;
  day_of_month: number | null;
  next_due: string;
  template_task_id: string | null;
}

export interface ImplementationHealthSnapshot {
  as_of: string;
  captured_at: string;
  health_score: number;
  blocker_count: number;
  blocked_waiting_task_count: number;
  cold_commitments_count: number;
  stall_days: number | null;
}

export interface ImplementationHealthScore {
  id: string;
  name: string;
  health_score: number;
  health_label: HealthLabel;
  signals: string[];
  trend: HealthTrend;
}

export interface Task {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  implementation_id: string | null;
  project_id: string | null;
  sprint_id: string | null;
  status: TaskStatus;
  task_type: TaskType;
  priority_score: number;
  estimated_minutes: number;
  actual_minutes: number | null;
  recurrence: TaskRecurrence | null;
  estimate_source: EstimateSource;
  due_at: string | null;
  needs_review: boolean;
  blocker: boolean;
  waiting_on: string | null;
  follow_up_at: string | null;
  stakeholder_mentions: string[];
  tags: string[];
  source_type: string;
  source_url: string | null;
  inbox_item_id: string | null;
  pinned_excerpt: string | null;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

export interface Implementation {
  id: string;
  user_id: string;
  name: string;
  phase: ImplPhase;
  rag: RagStatus;
  priority_weight: number;
  priority_note: string | null;
  portfolio_rank: number;
  health_snapshot: ImplementationHealthSnapshot | null;
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
  task_id: string;
  depends_on_task_id: string | null;
  depends_on_commitment_id: string | null;
  created_at: string;
}

export interface TaskDependencySummary {
  id: string;
  task_id: string;
  depends_on_task_id: string | null;
  depends_on_commitment_id: string | null;
  type: TaskDependencyType;
  title: string;
  status: TaskDependencyStatus;
  unresolved: boolean;
  created_at: string;
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
  estimation_accuracy: number | null;
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
  context: StakeholderContext;
  created_at: string;
  updated_at: string;
}

export interface StakeholderContext {
  last_contacted_at: string | null;
  preferred_contact: string | null;
  current_priorities: string | null;
  notes: string | null;
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

export interface CommitmentSummary {
  id: string;
  title: string;
  status: CommitmentStatus;
  due_at: string | null;
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

// Task with joined implementation and project data (from API responses)
export interface TaskWithImplementation extends Task {
  implementation: { id: string; name: string; phase?: ImplPhase; rag?: RagStatus } | null;
  project: { id: string; name: string; stage?: ProjectStage; rag?: RagStatus } | null;
  sprint: { id: string; name: string; start_date: string; end_date: string } | null;
  dependencies?: TaskDependencySummary[];
  dependency_blocked?: boolean;
}

// Allowed fields for task updates via API
export interface TaskUpdatePayload {
  title?: string;
  description?: string | null;
  implementation_id?: string | null;
  project_id?: string | null;
  sprint_id?: string | null;
  status?: TaskStatus;
  task_type?: TaskType;
  estimated_minutes?: number;
  actual_minutes?: number | null;
  estimate_source?: EstimateSource;
  due_at?: string | null;
  needs_review?: boolean;
  blocker?: boolean;
  waiting_on?: string | null;
  follow_up_at?: string | null;
  tags?: string[];
  pinned_excerpt?: string | null;
  pinned?: boolean;
}

// Implementation summary for dropdowns
export interface ImplementationSummary {
  id: string;
  name: string;
  phase?: ImplPhase;
  rag?: RagStatus;
  portfolio_rank?: number;
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

export interface Project {
  id: string;
  user_id: string;
  implementation_id: string | null;
  name: string;
  description: string | null;
  stage: ProjectStage;
  rag: RagStatus;
  target_date: string | null;
  servicenow_spm_id: string | null;
  status_summary: string;
  portfolio_rank: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectWithStats extends Project {
  open_task_count: number;
  completed_task_count: number;
  total_task_count: number;
  blockers_count: number;
  implementation: ImplementationSummary | null;
}

export interface ProjectDetail extends Project {
  blockers_count: number;
  open_tasks: TaskSummary[];
  implementation: ImplementationSummary | null;
}

export interface ProjectUpdatePayload {
  name?: string;
  description?: string | null;
  implementation_id?: string | null;
  stage?: ProjectStage;
  rag?: RagStatus;
  target_date?: string | null;
  servicenow_spm_id?: string | null;
  status_summary?: string;
  portfolio_rank?: number;
}

export interface Sprint {
  id: string;
  user_id: string;
  name: string;
  start_date: string;
  end_date: string;
  theme: string;
  focus_implementation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SprintWithImplementation extends Sprint {
  focus_implementation: ImplementationSummary | null;
}

export interface SprintDetail extends SprintWithImplementation {
  total_tasks: number;
  completed_tasks: number;
  completion_pct: number;
  tasks_by_status: Record<TaskStatus, TaskSummary[]>;
}

// Allowed fields for implementation updates via API
export interface ImplementationUpdatePayload {
  name?: string;
  phase?: ImplPhase;
  rag?: RagStatus;
  priority_weight?: number;
  priority_note?: string | null;
  portfolio_rank?: number;
  target_date?: string | null;
  status_summary?: string;
  next_milestone?: string;
  next_milestone_date?: string | null;
  stakeholders?: string[];
  keywords?: string[];
}
