import type { SupabaseClient } from "@supabase/supabase-js";
import { INTELLIGENCE_PROMOTION_EVENT_TYPES, type IntelligencePromotionEventType, type IntelligencePromotionStore } from "./phase2-types";
import { promoteIntelligenceContracts } from "./promotion";
import { runIntelligencePhaseOne } from "./detectors";
import { INTELLIGENCE_V1_CONTRACT_TYPES, type IntelligenceV1ContractType, type ReadIntelligenceTaskContextsOptions } from "./types";

const INTELLIGENCE_SCHEDULE_TIME_ZONE = "America/New_York";
const INTELLIGENCE_SCHEDULE_WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);
const INTELLIGENCE_SCHEDULE_HOURS = new Set([5, 11]);
const INTELLIGENCE_SCHEDULE_MINUTE_WINDOW = 10;

export interface ExecuteIntelligencePipelineOptions extends ReadIntelligenceTaskContextsOptions {
  now?: Date;
  enableTaskStalenessClarityGrouping?: boolean;
}

export interface ScheduledIntelligenceCronWindow {
  shouldRun: boolean;
  timeZone: string;
  localDate: string;
  localTime: string;
  localWeekday: string;
  slotLabel: string | null;
  reason: string | null;
}

export interface ExecuteIntelligencePipelineResult {
  runAt: string;
  detectedAt: string;
  taskContextCount: number;
  contractCount: number;
  contractCounts: Record<IntelligenceV1ContractType, number>;
  contractSnapshotCount: number;
  touchedArtifactCount: number;
  touchedArtifactIds: string[];
  promotionEventCount: number;
  promotionEventCounts: Record<IntelligencePromotionEventType, number>;
}

function emptyContractCounts(): Record<IntelligenceV1ContractType, number> {
  return {
    follow_up_risk: 0,
    blocked_waiting_stale: 0,
    stale_task: 0,
    ambiguous_task: 0,
    recently_unblocked: 0,
  };
}

function emptyPromotionEventCounts(): Record<IntelligencePromotionEventType, number> {
  return {
    created: 0,
    updated: 0,
    noop: 0,
    grouped_created: 0,
    grouped_updated: 0,
    grouped_noop: 0,
  };
}

function readScheduledTimeZoneParts(now: Date): {
  weekday: string;
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: INTELLIGENCE_SCHEDULE_TIME_ZONE,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const values = new Map<string, string>();

  for (const part of formatter.formatToParts(now)) {
    if (part.type !== "literal") {
      values.set(part.type, part.value);
    }
  }

  return {
    weekday: values.get("weekday") ?? "",
    year: values.get("year") ?? "",
    month: values.get("month") ?? "",
    day: values.get("day") ?? "",
    hour: values.get("hour") ?? "",
    minute: values.get("minute") ?? "",
  };
}

export function describeScheduledIntelligenceCronWindow(now: Date = new Date()): ScheduledIntelligenceCronWindow {
  const parts = readScheduledTimeZoneParts(now);
  const localHour = Number.parseInt(parts.hour, 10);
  const localMinute = Number.parseInt(parts.minute, 10);
  const weekdayAllowed = INTELLIGENCE_SCHEDULE_WEEKDAYS.has(parts.weekday);
  const hourAllowed = INTELLIGENCE_SCHEDULE_HOURS.has(localHour);
  const minuteAllowed = Number.isFinite(localMinute) && localMinute >= 0 && localMinute < INTELLIGENCE_SCHEDULE_MINUTE_WINDOW;
  const shouldRun = weekdayAllowed && hourAllowed && minuteAllowed;

  let reason: string | null = null;
  if (!weekdayAllowed) {
    reason = "current America/New_York day is outside the weekday schedule";
  } else if (!hourAllowed) {
    reason = "current America/New_York time is outside the configured 05:00 and 11:00 execution hours";
  } else if (!minuteAllowed) {
    reason = "current America/New_York time is outside the first 10 minutes of the configured execution hour";
  }

  return {
    shouldRun,
    timeZone: INTELLIGENCE_SCHEDULE_TIME_ZONE,
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${parts.hour}:${parts.minute}`,
    localWeekday: parts.weekday,
    slotLabel: hourAllowed ? `${parts.hour}:00` : null,
    reason,
  };
}

export async function executeIntelligencePipeline(
  supabase: SupabaseClient,
  store: IntelligencePromotionStore,
  userId: string,
  options: ExecuteIntelligencePipelineOptions = {}
): Promise<ExecuteIntelligencePipelineResult> {
  const now = options.now ?? new Date();
  const phaseOneResult = await runIntelligencePhaseOne(supabase, userId, {
    now,
    taskIds: options.taskIds,
  });

  const promotionResult = await promoteIntelligenceContracts(store, userId, phaseOneResult.contracts, {
    now,
    enableTaskStalenessClarityGrouping: options.enableTaskStalenessClarityGrouping === true,
  });

  const contractCounts = emptyContractCounts();
  const promotionEventCounts = emptyPromotionEventCounts();

  for (const contractType of INTELLIGENCE_V1_CONTRACT_TYPES) {
    contractCounts[contractType] = phaseOneResult.contracts.filter((contract) => contract.contractType === contractType).length;
  }

  for (const eventType of INTELLIGENCE_PROMOTION_EVENT_TYPES) {
    promotionEventCounts[eventType] = promotionResult.promotionEvents.filter((event) => event.eventType === eventType).length;
  }

  return {
    runAt: now.toISOString(),
    detectedAt: phaseOneResult.detectedAt,
    taskContextCount: phaseOneResult.taskContexts.length,
    contractCount: phaseOneResult.contracts.length,
    contractCounts,
    contractSnapshotCount: promotionResult.contractSnapshots.length,
    touchedArtifactCount: promotionResult.artifacts.length,
    touchedArtifactIds: promotionResult.artifacts.map((artifact) => artifact.id),
    promotionEventCount: promotionResult.promotionEvents.length,
    promotionEventCounts,
  };
}
