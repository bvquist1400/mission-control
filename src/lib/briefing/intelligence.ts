import type {
  CommitmentDirection,
  CommitmentStatus,
  ImplPhase,
  RagStatus,
  RiskLevel,
  TaskStatus,
} from '@/types/database';
import { taskToSummary, type TaskInput, type TaskSummary } from './prep-tasks';
import type {
  BriefingColdCommitment,
  BriefingRiskRadarItem,
  BriefingTomorrowCommitmentItem,
  BriefingTomorrowContextItem,
} from './contracts';

const DEFAULT_COLD_COMMITMENT_DAYS = 5;
const STALL_WARNING_DAYS = 5;
const STALL_ELEVATED_DAYS = 8;
const STALL_CRITICAL_DAYS = 14;
const STALE_BLOCKER_DAYS = 7;
const RISK_LEVEL_ORDER: Record<RiskLevel, number> = { red: 0, yellow: 1, green: 2 };

export interface IntelligenceImplementation {
  id: string;
  name: string;
  keywords?: string[] | null;
}

export interface IntelligenceStakeholder {
  id: string;
  name: string;
}

export interface IntelligenceCommitment {
  id: string;
  title: string;
  direction: CommitmentDirection;
  status: CommitmentStatus;
  due_at: string | null;
  created_at: string;
  stakeholder: { id: string; name: string } | null;
  task: {
    id: string;
    title: string;
    status: TaskStatus;
    implementation_id: string | null;
  } | null;
}

export interface IntelligenceRiskTask {
  id: string;
  title: string;
  implementation_id: string | null;
  status: TaskStatus;
  blocker: boolean;
  created_at: string;
  updated_at: string;
}

export type IntelligenceTomorrowTask = TaskInput & {
  implementation?: {
    id?: string;
    name: string;
    phase?: ImplPhase | null;
    rag?: RagStatus | null;
  } | null;
};

export interface TomorrowContextEventInput {
  title: string;
  start_at: string;
  with_display?: string[];
  meeting_context?: string | null;
}

function firstJoinedRecord<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function toPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function normalizeText(value: string | null | undefined): string {
  if (!value) {
    return '';
  }

  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsNormalizedTerm(haystack: string, term: string): boolean {
  if (!haystack || !term) {
    return false;
  }

  if (haystack === term) {
    return true;
  }

  return ` ${haystack} `.includes(` ${term} `) || haystack.includes(term);
}

function daysSince(now: Date, iso: string | null | undefined): number {
  if (!iso) {
    return 0;
  }

  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) {
    return 0;
  }

  const diffMs = Math.max(0, now.getTime() - ts);
  return Math.floor(diffMs / 86400000);
}

function compareNullableIso(left: string | null, right: string | null): number {
  if (!left && !right) {
    return 0;
  }

  if (!left) {
    return 1;
  }

  if (!right) {
    return -1;
  }

  return left.localeCompare(right);
}

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  return date.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function buildStakeholderTermSet(name: string): string[] {
  const normalized = normalizeText(name);
  if (!normalized) {
    return [];
  }

  const tokens = normalized.split(' ').filter((token) => token.length > 2);
  return [normalized, ...tokens];
}

function stakeholderMatchesEvent(
  stakeholder: IntelligenceStakeholder,
  eventText: string,
  participantTerms: string[]
): boolean {
  const terms = buildStakeholderTermSet(stakeholder.name);
  if (terms.length === 0) {
    return false;
  }

  if (terms.some((term) => containsNormalizedTerm(eventText, term))) {
    return true;
  }

  return participantTerms.some((participant) =>
    terms.some((term) => participant === term || participant.includes(term) || term.includes(participant))
  );
}

function implementationMatchesEvent(implementation: IntelligenceImplementation, eventText: string): boolean {
  const terms = [implementation.name, ...(implementation.keywords || [])]
    .map((term) => normalizeText(term))
    .filter((term) => term.length > 2);

  return terms.some((term) => containsNormalizedTerm(eventText, term));
}

function taskMentionsStakeholder(task: IntelligenceTomorrowTask, stakeholderNames: string[]): boolean {
  if (!Array.isArray(task.stakeholder_mentions) || stakeholderNames.length === 0) {
    return false;
  }

  const mentions = task.stakeholder_mentions.map((item) => normalizeText(item)).filter(Boolean);
  return mentions.some((mention) =>
    stakeholderNames.some((name) => mention === name || mention.includes(name) || name.includes(mention))
  );
}

function summarizeTomorrowCommitment(commitment: IntelligenceCommitment): BriefingTomorrowCommitmentItem {
  return {
    id: commitment.id,
    title: commitment.title,
    direction: commitment.direction,
    due_at: commitment.due_at,
    stakeholder_name: commitment.stakeholder?.name ?? 'Unknown',
  };
}

function summarizeTomorrowTask(task: IntelligenceTomorrowTask): TaskSummary {
  return taskToSummary(
    task,
    task.implementation?.name ?? null,
    task.implementation?.phase ?? null,
    task.implementation?.rag ?? null
  );
}

export function getColdCommitmentThresholdDays(): number {
  return toPositiveInt(process.env.COMMITMENT_COLD_DAYS, DEFAULT_COLD_COMMITMENT_DAYS);
}

export function buildColdCommitments(
  commitments: IntelligenceCommitment[],
  now: Date,
  coldDays = getColdCommitmentThresholdDays()
): BriefingColdCommitment[] {
  return commitments
    .filter((commitment) => commitment.status === 'Open' && commitment.direction === 'theirs')
    .map((commitment) => ({
      commitment,
      days_open: daysSince(now, commitment.created_at),
    }))
    .filter((item) => item.days_open >= coldDays)
    .sort((left, right) => {
      if (right.days_open !== left.days_open) {
        return right.days_open - left.days_open;
      }

      return compareNullableIso(left.commitment.due_at, right.commitment.due_at);
    })
    .map(({ commitment, days_open }) => ({
      stakeholder_name: commitment.stakeholder?.name ?? 'Unknown',
      title: commitment.title,
      days_open,
      due_at: commitment.due_at,
    }));
}

export function normalizeCommitmentRows(rows: unknown[]): IntelligenceCommitment[] {
  return rows.map((row) => {
    const source = row as IntelligenceCommitment & {
      stakeholder?: IntelligenceCommitment["stakeholder"] | IntelligenceCommitment["stakeholder"][];
      task?: IntelligenceCommitment["task"] | IntelligenceCommitment["task"][];
    };

    return {
      id: source.id,
      title: source.title,
      direction: source.direction,
      status: source.status,
      due_at: source.due_at,
      created_at: source.created_at,
      stakeholder: firstJoinedRecord(source.stakeholder),
      task: firstJoinedRecord(source.task),
    };
  });
}

export function buildRiskRadar(
  implementations: IntelligenceImplementation[],
  tasks: IntelligenceRiskTask[],
  commitments: IntelligenceCommitment[],
  now: Date,
  coldDays = getColdCommitmentThresholdDays()
): BriefingRiskRadarItem[] {
  const coldCommitmentCounts = new Map<string, number>();

  for (const commitment of commitments) {
    if (
      commitment.status !== 'Open' ||
      commitment.direction !== 'theirs' ||
      !commitment.task?.implementation_id ||
      daysSince(now, commitment.created_at) < coldDays
    ) {
      continue;
    }

    const implementationId = commitment.task.implementation_id;
    coldCommitmentCounts.set(implementationId, (coldCommitmentCounts.get(implementationId) || 0) + 1);
  }

  return implementations
    .map((implementation) => {
      const implementationTasks = tasks.filter((task) => task.implementation_id === implementation.id);
      const openTasks = implementationTasks.filter((task) => task.status !== 'Done');
      const blockerTasks = openTasks.filter((task) => task.blocker);
      const blockedWaitingCount = openTasks.filter((task) => task.status === 'Blocked/Waiting').length;
      const mostRecentDoneTask = implementationTasks
        .filter((task) => task.status === 'Done')
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
      const stallDays = mostRecentDoneTask ? daysSince(now, mostRecentDoneTask.updated_at) : null;
      const coldCommitmentsCount = coldCommitmentCounts.get(implementation.id) || 0;
      const signals: string[] = [];
      let riskScore = 0;

      if (!mostRecentDoneTask && openTasks.length > 0) {
        signals.push('No completed tasks recorded');
        riskScore += 30;
      } else if (stallDays !== null && stallDays >= STALL_CRITICAL_DAYS) {
        signals.push(`No completed tasks in ${stallDays} days`);
        riskScore += 30;
      } else if (stallDays !== null && stallDays >= STALL_ELEVATED_DAYS) {
        signals.push(`No completed tasks in ${stallDays} days`);
        riskScore += 20;
      } else if (stallDays !== null && stallDays >= STALL_WARNING_DAYS) {
        signals.push(`No completed tasks in ${stallDays} days`);
        riskScore += 10;
      }

      if (blockerTasks.length > 0) {
        signals.push(`${blockerTasks.length} active blocker${blockerTasks.length === 1 ? '' : 's'}`);
        riskScore += Math.min(blockerTasks.length * 20, 40);
      }

      if (blockedWaitingCount > 0) {
        signals.push(`${blockedWaitingCount} Blocked/Waiting task${blockedWaitingCount === 1 ? '' : 's'}`);
        riskScore += Math.min(blockedWaitingCount * 10, 20);
      }

      if (coldCommitmentsCount > 0) {
        signals.push(`${coldCommitmentsCount} cold incoming commitment${coldCommitmentsCount === 1 ? '' : 's'}`);
        riskScore += Math.min(coldCommitmentsCount * 15, 30);
      }

      const hasStaleBlocker = blockerTasks.some((task) => daysSince(now, task.created_at) > STALE_BLOCKER_DAYS);
      const risk_level: RiskLevel = hasStaleBlocker || signals.length >= 3
        ? 'red'
        : signals.length >= 1
          ? 'yellow'
          : 'green';

      return {
        implementation_id: implementation.id,
        implementation_name: implementation.name,
        risk_level,
        risk_score: Math.min(riskScore, 100),
        signals,
      };
    })
    .sort((left, right) => {
      if (RISK_LEVEL_ORDER[left.risk_level] !== RISK_LEVEL_ORDER[right.risk_level]) {
        return RISK_LEVEL_ORDER[left.risk_level] - RISK_LEVEL_ORDER[right.risk_level];
      }

      if (right.risk_score !== left.risk_score) {
        return right.risk_score - left.risk_score;
      }

      return left.implementation_name.localeCompare(right.implementation_name);
    });
}

export function buildTomorrowContext(
  events: TomorrowContextEventInput[],
  tasks: IntelligenceTomorrowTask[],
  commitments: IntelligenceCommitment[],
  stakeholders: IntelligenceStakeholder[],
  implementations: IntelligenceImplementation[]
): BriefingTomorrowContextItem[] {
  return events.map((event) => {
    const eventText = normalizeText([event.title, event.meeting_context || ''].join(' '));
    const participantTerms = (event.with_display || []).map((item) => normalizeText(item)).filter(Boolean);
    const matchedStakeholders = stakeholders.filter((stakeholder) =>
      stakeholderMatchesEvent(stakeholder, eventText, participantTerms)
    );
    const matchedStakeholderIds = new Set(matchedStakeholders.map((stakeholder) => stakeholder.id));
    const matchedStakeholderNames = matchedStakeholders.map((stakeholder) => normalizeText(stakeholder.name));
    const matchedImplementationIds = new Set(
      implementations
        .filter((implementation) => implementationMatchesEvent(implementation, eventText))
        .map((implementation) => implementation.id)
    );

    const relatedTasks = tasks
      .filter((task) => task.status !== 'Done')
      .filter(
        (task) =>
          taskMentionsStakeholder(task, matchedStakeholderNames) ||
          (task.implementation_id !== null && matchedImplementationIds.has(task.implementation_id))
      )
      .sort((left, right) => {
        if (right.priority_score !== left.priority_score) {
          return right.priority_score - left.priority_score;
        }

        return compareNullableIso(left.due_at, right.due_at);
      })
      .map((task) => summarizeTomorrowTask(task));

    const openCommitments = commitments
      .filter(
        (commitment) =>
          commitment.status === 'Open' &&
          commitment.stakeholder?.id !== undefined &&
          commitment.stakeholder !== null &&
          matchedStakeholderIds.has(commitment.stakeholder.id)
      )
      .sort((left, right) => compareNullableIso(left.due_at, right.due_at))
      .map((commitment) => summarizeTomorrowCommitment(commitment));

    return {
      event_title: event.title,
      event_time: formatEventTime(event.start_at),
      related_tasks: relatedTasks,
      open_commitments: openCommitments,
    };
  });
}
