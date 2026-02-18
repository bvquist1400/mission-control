const DAY_MS = 24 * 60 * 60 * 1000;

export interface PlannerExceptionsConfig {
  includeCritical: boolean;
  criticalThreshold: number;
}

export interface PlannerConfig {
  exceptions: PlannerExceptionsConfig;
}

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  exceptions: {
    includeCritical: false,
    criticalThreshold: 90,
  },
};

export interface PlannerTaskLike {
  priority_score?: number | null;
  due_at?: string | null;
  follow_up_at?: string | null;
  waiting_on?: string | null;
  blocked?: boolean | null;
  blocker?: boolean | null;
  waiting?: boolean | null;
  status?: string | null;
  updated_at?: string | null;
}

export interface StatusAdjustResult {
  statusAdjust: number;
  followUpDue: boolean;
  blocked: boolean;
  waiting: boolean;
}

export interface PlannerScoreInputs {
  stakeholderBoost?: number;
  urgencyBoost?: number;
  stalenessBoost?: number;
  fitBonus?: number;
  implementationMultiplier?: number;
  directiveMultiplier?: number;
  nowMs?: number;
}

export interface PlannerScoreBreakdown {
  priorityBlend: number;
  urgencyBoost: number;
  stakeholderBoost: number;
  stalenessBoost: number;
  fitBonus: number;
  statusAdjust: number;
  followUpDue: boolean;
  preMultiplierScore: number;
  finalScore: number;
}

function parseDateMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toFiniteOrDefault(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function isBlockedTask(task: PlannerTaskLike): boolean {
  return Boolean(task.blocked ?? task.blocker);
}

function isWaitingTask(task: PlannerTaskLike): boolean {
  if (typeof task.waiting === 'boolean') {
    return task.waiting;
  }

  if (task.status === 'Blocked/Waiting') {
    return true;
  }

  return typeof task.waiting_on === 'string' && task.waiting_on.trim().length > 0;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function calculatePriorityBlend(task: PlannerTaskLike): number {
  const ps = clamp(task.priority_score ?? 0, 0, 100);
  return ps * 0.15;
}

export function isFollowUpDue(task: PlannerTaskLike, nowMs: number = Date.now()): boolean {
  const followUpMs = parseDateMs(task.follow_up_at);
  return followUpMs !== null && followUpMs <= nowMs;
}

export function calculateStatusAdjust(task: PlannerTaskLike, nowMs: number = Date.now()): StatusAdjustResult {
  const blocked = isBlockedTask(task);
  const waiting = isWaitingTask(task);
  const followUpDue = isFollowUpDue(task, nowMs);

  let statusAdjust = 0;
  if (blocked) statusAdjust -= 25;
  if (waiting) statusAdjust -= 15;

  if (blocked && followUpDue) {
    statusAdjust += 25; // remove blocked penalty
    statusAdjust += 10; // follow-up-ready boost
  }

  return {
    statusAdjust,
    followUpDue,
    blocked,
    waiting,
  };
}

export function calculateStalenessBoost(
  updatedAt: string | null | undefined,
  nowMs: number = Date.now()
): number {
  const updatedMs = parseDateMs(updatedAt);
  if (updatedMs === null) {
    return 0;
  }

  return nowMs - updatedMs >= 5 * DAY_MS ? 5 : 0;
}

export function calculateUrgencyBoost(
  dueAt: string | null | undefined,
  nowMs: number = Date.now()
): number {
  const dueMs = parseDateMs(dueAt);
  if (dueMs === null) {
    return 0;
  }

  const hoursUntilDue = (dueMs - nowMs) / (60 * 60 * 1000);
  if (hoursUntilDue <= 24) {
    return 30;
  }
  if (hoursUntilDue <= 48) {
    return 20;
  }
  if (hoursUntilDue <= 7 * 24) {
    return 8;
  }

  return 0;
}

export function isDueWithinHours(
  dueAt: string | null | undefined,
  nowMs: number = Date.now(),
  hours: number = 24
): boolean {
  const dueMs = parseDateMs(dueAt);
  if (dueMs === null) {
    return false;
  }

  return dueMs - nowMs <= hours * 60 * 60 * 1000;
}

export function isExceptionTask(
  task: PlannerTaskLike,
  nowMs: number = Date.now(),
  config: PlannerConfig = DEFAULT_PLANNER_CONFIG
): boolean {
  const dueWithin24h = isDueWithinHours(task.due_at, nowMs, 24);
  const { blocked, followUpDue } = calculateStatusAdjust(task, nowMs);

  if (dueWithin24h || (blocked && followUpDue)) {
    return true;
  }

  if (!config.exceptions.includeCritical) {
    return false;
  }

  const threshold = toFiniteOrDefault(config.exceptions.criticalThreshold, 90);
  const ps = clamp(task.priority_score ?? 0, 0, 100);
  return ps >= threshold;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parseNumberEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getPlannerConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): PlannerConfig {
  return {
    exceptions: {
      includeCritical: parseBooleanEnv(
        env.PLANNER_ENABLE_CRITICAL_EXCEPTION,
        DEFAULT_PLANNER_CONFIG.exceptions.includeCritical
      ),
      criticalThreshold: clamp(
        parseNumberEnv(
          env.PLANNER_CRITICAL_EXCEPTION_THRESHOLD,
          DEFAULT_PLANNER_CONFIG.exceptions.criticalThreshold
        ),
        0,
        100
      ),
    },
  };
}

export function calculatePlannerScore(
  task: PlannerTaskLike,
  inputs: PlannerScoreInputs
): PlannerScoreBreakdown {
  const nowMs = inputs.nowMs ?? Date.now();
  const priorityBlend = calculatePriorityBlend(task);
  const { statusAdjust, followUpDue } = calculateStatusAdjust(task, nowMs);
  const urgencyBoost = inputs.urgencyBoost ?? calculateUrgencyBoost(task.due_at, nowMs);
  const stakeholderBoost = inputs.stakeholderBoost ?? 0;
  const stalenessBoost = inputs.stalenessBoost ?? calculateStalenessBoost(task.updated_at, nowMs);
  const fitBonus = inputs.fitBonus ?? 0;

  // Urgency is intentionally pre-multiplier in v1.1.
  const preMultiplierScore =
    priorityBlend +
    urgencyBoost +
    stakeholderBoost +
    statusAdjust +
    stalenessBoost +
    fitBonus;

  const implementationMultiplier = toFiniteOrDefault(inputs.implementationMultiplier ?? 1, 1);
  const directiveMultiplier = toFiniteOrDefault(inputs.directiveMultiplier ?? 1, 1);
  const finalScore = Math.max(0, preMultiplierScore * implementationMultiplier * directiveMultiplier);

  return {
    priorityBlend,
    urgencyBoost,
    stakeholderBoost,
    stalenessBoost,
    fitBonus,
    statusAdjust,
    followUpDue,
    preMultiplierScore,
    finalScore,
  };
}
