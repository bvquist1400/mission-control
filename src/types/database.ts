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
export type ReviewPeriod = "eod" | "weekly" | "monthly";
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
  section_id: string | null;
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
  resolved_at: string | null;
  is_resolved: boolean;
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
  resolved_at?: string | null;
  created_at: string;
}

export interface RecentlyResolvedTaskDependencySummary {
  id: string;
  task_id: string;
  depends_on_task_id: string | null;
  depends_on_commitment_id: string | null;
  type: TaskDependencyType;
  title: string;
  status: TaskDependencyStatus;
  resolved_at: string;
  created_at: string;
}

export interface TaskStatusTransition {
  id: string;
  user_id: string;
  task_id: string;
  from_status: string | null;
  to_status: string;
  transitioned_at: string;
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
  sprint: { id: string; name: string; start_date: string; end_date: string; theme?: string | null } | null;
  section_name?: string | null;
  dependencies?: TaskDependencySummary[];
  dependency_blocked?: boolean;
}

// Allowed fields for task updates via API
export interface TaskUpdatePayload {
  title?: string;
  description?: string | null;
  implementation_id?: string | null;
  project_id?: string | null;
  section_id?: string | null;
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
  project_id?: string | null;
  project_name?: string | null;
  section_id?: string | null;
  section_name?: string | null;
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

export interface ProjectSection {
  id: string;
  user_id: string;
  project_id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectWithStats extends Project {
  open_task_count: number;
  completed_task_count: number;
  total_task_count: number;
  blockers_count: number;
  completion_pct: number;
  implementation: ImplementationSummary | null;
}

export interface ProjectDetail extends Project {
  blockers_count: number;
  open_tasks: TaskSummary[];
  implementation: ImplementationSummary | null;
}

export interface ProjectStatusUpdate {
  id: string;
  user_id: string;
  project_id: string;
  implementation_id: string | null;
  captured_for_date: string;
  summary: string;
  rag: RagStatus | null;
  changes_today: string[];
  blockers: string[];
  next_step: string | null;
  needs_decision: string | null;
  related_task_ids: string[];
  source: string;
  model: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectStatusUpdateWithRelations extends ProjectStatusUpdate {
  project: { id: string; name: string } | null;
  implementation: ImplementationSummary | null;
}

export interface ProjectStatusUpdatePayload {
  project_id: string;
  captured_for_date?: string;
  summary: string;
  rag?: RagStatus | null;
  changes_today?: string[];
  blockers?: string[];
  next_step?: string | null;
  needs_decision?: string | null;
  related_task_ids?: string[];
  source?: string;
  model?: string | null;
  payload?: Record<string, unknown> | null;
  sync_project_status_summary?: boolean;
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

export interface ReviewSnapshot {
  id: string;
  user_id: string;
  review_type: ReviewPeriod;
  anchor_date: string;
  period_start: string;
  period_end: string;
  title: string;
  summary: string;
  source: string;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ReviewSnapshotPayload {
  review_type: ReviewPeriod;
  anchor_date?: string;
  period_start: string;
  period_end: string;
  title?: string;
  summary?: string;
  source?: string;
  payload: Record<string, unknown>;
}

export type NoteType =
  | "working_note"
  | "meeting_note"
  | "application_note"
  | "decision_note"
  | "prep_note"
  | "retrospective_note";
export type NoteStatus = "active" | "archived";
export type NoteLinkEntityType =
  | "task"
  | "calendar_event"
  | "implementation"
  | "project"
  | "stakeholder"
  | "commitment"
  | "sprint";
export type NoteLinkRole =
  | "primary_context"
  | "meeting_for"
  | "related_task"
  | "decision_about"
  | "prep_for"
  | "reference";
export type NoteTaskRelationshipType = "linked" | "created_from" | "discussed_in";
export type NoteDecisionStatus = "active" | "superseded" | "reversed";

export interface Note {
  id: string;
  user_id: string;
  title: string;
  body_markdown: string;
  note_type: NoteType;
  status: NoteStatus;
  pinned: boolean;
  last_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NoteLink {
  id: string;
  user_id: string;
  note_id: string;
  entity_type: NoteLinkEntityType;
  entity_id: string;
  link_role: NoteLinkRole;
  created_at: string;
}

export interface NoteTask {
  id: string;
  user_id: string;
  note_id: string;
  task_id: string;
  relationship_type: NoteTaskRelationshipType;
  created_at: string;
}

export interface NoteTaskWithTask extends NoteTask {
  task: TaskSummary | null;
}

export interface NoteDecision {
  id: string;
  user_id: string;
  note_id: string;
  title: string;
  summary: string;
  decision_status: NoteDecisionStatus;
  decided_at: string | null;
  decided_by_stakeholder_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface NoteWithDetails extends Note {
  links: NoteLink[];
  task_links: NoteTaskWithTask[];
  decisions: NoteDecision[];
}

export interface CreateNotePayload {
  title: string;
  body_markdown?: string;
  note_type?: NoteType;
  status?: NoteStatus;
  pinned?: boolean;
  last_reviewed_at?: string | null;
}

export interface UpdateNotePayload {
  title?: string;
  body_markdown?: string;
  note_type?: NoteType;
  status?: NoteStatus;
  pinned?: boolean;
  last_reviewed_at?: string | null;
}

export interface ListNotesOptions {
  note_type?: NoteType;
  status?: NoteStatus;
  pinned?: boolean;
  entity_type?: NoteLinkEntityType;
  entity_id?: string;
  link_role?: NoteLinkRole;
  limit?: number;
  offset?: number;
}

export interface LinkNoteToEntityPayload {
  entity_type: NoteLinkEntityType;
  entity_id: string;
  link_role?: NoteLinkRole;
}

export interface LinkTaskToNotePayload {
  task_id: string;
  relationship_type?: NoteTaskRelationshipType;
}

export interface CreateTaskFromNotePayload {
  title: string;
  description?: string | null;
  implementation_id?: string | null;
  project_id?: string | null;
  sprint_id?: string | null;
  status?: TaskStatus;
  task_type?: TaskType;
  estimated_minutes?: number;
  estimate_source?: EstimateSource;
  due_at?: string | null;
  priority_score?: number;
  blocker?: boolean;
  needs_review?: boolean;
  waiting_on?: string | null;
  relationship_type?: NoteTaskRelationshipType;
}

export interface CreateNoteDecisionPayload {
  title: string;
  summary: string;
  decision_status?: NoteDecisionStatus;
  decided_at?: string | null;
  decided_by_stakeholder_id?: string | null;
}

export interface UpdateNoteDecisionStatusPayload {
  decision_status: NoteDecisionStatus;
  decided_at?: string | null;
  decided_by_stakeholder_id?: string | null;
}

export interface CreateMeetingNotePayload {
  calendar_event: {
    source: "local" | "ical" | "graph";
    external_event_id: string;
    start_at: string;
  };
  implementation_id?: string | null;
  project_id?: string | null;
  body_markdown?: string;
  pinned?: boolean;
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
