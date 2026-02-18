import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  generateTextWithLlm,
  resolveModelForFeature,
  recordLlmUsageEvent,
  type LlmRunMeta,
} from "@/lib/llm";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";
import type {
  BriefingMode,
  BriefingNarrativeRequest,
  BriefingNarrativeResponse,
  BriefingResponse,
  TaskSummary,
} from "@/lib/briefing";

const CACHE_TTL_MS = 30 * 60 * 1000;
const ET_TIMEZONE = "America/New_York";

interface NarrativeCacheEntry {
  narrative: string;
  runMeta: LlmRunMeta;
  expiresAtMs: number;
}

const narrativeCache = new Map<string, NarrativeCacheEntry>();

const NARRATIVE_SYSTEM_PROMPT = `You are a concise executive assistant.
Write exactly 2-3 sentences.
Be direct and specific, mentioning concrete task names, meeting titles, and times.
Do not use bullet points.
Do not use motivational language.
Only use details present in the provided context.`;

function isValidBriefingMode(value: unknown): value is BriefingMode {
  return value === "morning" || value === "midday" || value === "eod";
}

function formatETTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleTimeString("en-US", {
    timeZone: ET_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDueDateShort(iso: string | null): string | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleDateString("en-US", {
    timeZone: ET_TIMEZONE,
    month: "short",
    day: "numeric",
  });
}

function summarizeTask(task: TaskSummary): string {
  const due = formatDueDateShort(task.due_at);
  if (due) {
    return `${task.title} (${task.estimated_minutes} min, due ${due})`;
  }
  return `${task.title} (${task.estimated_minutes} min)`;
}

function nextUpcomingMeeting(briefing: BriefingResponse): { title: string; at: string } | null {
  const nowMs = Date.now();
  const event = briefing.today.calendar.events
    .filter((item) => {
      const startMs = Date.parse(item.start_at);
      return Number.isFinite(startMs) && startMs > nowMs;
    })
    .sort((left, right) => left.start_at.localeCompare(right.start_at))[0];

  if (!event) {
    return null;
  }

  return {
    title: event.title,
    at: formatETTime(event.start_at),
  };
}

function summarizeRollReason(task: TaskSummary): string {
  if (task.blocker) {
    return "blocked";
  }
  if (task.waiting_on && task.waiting_on.trim().length > 0) {
    return `waiting on ${task.waiting_on.trim()}`;
  }
  if (task.due_at) {
    const dueShort = formatDueDateShort(task.due_at);
    return dueShort ? `due ${dueShort}` : "remaining";
  }
  return "remaining";
}

function buildMorningContext(briefing: BriefingResponse) {
  return {
    mode: "morning",
    date: briefing.requestedDate,
    currentTimeET: briefing.currentTimeET,
    focusBlocks: briefing.today.calendar.focusBlocks.slice(0, 4).map((block) => ({
      window: `${formatETTime(block.start_at)}-${formatETTime(block.end_at)}`,
      minutes: block.minutes,
      suitableFor: block.suitableFor,
    })),
    topTasks: briefing.today.tasks.remaining.slice(0, 5).map((task) => summarizeTask(task)),
    meetings: briefing.today.calendar.events.slice(0, 6).map((event) => ({
      title: event.title,
      at: formatETTime(event.start_at),
    })),
    capacity: {
      rag: briefing.today.capacity.rag,
      requiredMinutes: briefing.today.capacity.required_minutes,
      availableMinutes: briefing.today.capacity.available_minutes,
    },
  };
}

function buildMiddayContext(briefing: BriefingResponse) {
  const nextMeeting = nextUpcomingMeeting(briefing);
  return {
    mode: "midday",
    date: briefing.requestedDate,
    currentTimeET: briefing.currentTimeET,
    progress: briefing.today.progress,
    remainingTasks: briefing.today.tasks.remaining.slice(0, 6).map((task) => summarizeTask(task)),
    completedTasks: briefing.today.tasks.completed.slice(0, 5).map((task) => task.title),
    nextMeeting,
    blockerNotes: briefing.today.tasks.remaining
      .filter((task) => task.blocker || (task.waiting_on && task.waiting_on.trim().length > 0))
      .slice(0, 4)
      .map((task) => `${task.title}: ${summarizeRollReason(task)}`),
  };
}

function buildEodContext(briefing: BriefingResponse) {
  return {
    mode: "eod",
    date: briefing.requestedDate,
    currentTimeET: briefing.currentTimeET,
    completedCount: briefing.today.tasks.completed.length,
    completedTasks: briefing.today.tasks.completed.slice(0, 8).map((task) => task.title),
    rolledItems: briefing.today.tasks.remaining.slice(0, 8).map((task) => ({
      title: task.title,
      reason: summarizeRollReason(task),
    })),
    tomorrow: briefing.tomorrow
      ? {
          date: briefing.tomorrow.date,
          meetingsCount: briefing.tomorrow.calendar.events.length,
          busyMinutes: briefing.tomorrow.calendar.stats.busyMinutes,
          meetings: briefing.tomorrow.calendar.events.slice(0, 6).map((event) => ({
            title: event.title,
            at: formatETTime(event.start_at),
          })),
          topPrepTask: briefing.tomorrow.prepTasks[0]
            ? {
                title: briefing.tomorrow.prepTasks[0].task.title,
                reason: briefing.tomorrow.prepTasks[0].reason,
              }
            : null,
        }
      : null,
  };
}

function buildModeInstruction(mode: BriefingMode): string {
  switch (mode) {
    case "morning":
      return "Summarize the morning plan: focus windows, highest priority tasks, meetings, and capacity risk.";
    case "midday":
      return "Summarize midday status: progress, what remains, the next meeting timing, and blockers.";
    case "eod":
      return "Summarize end-of-day status: what got done, what rolls, why it rolls, and tomorrow prep.";
  }
}

function buildContextForMode(briefing: BriefingResponse): Record<string, unknown> {
  if (briefing.mode === "morning") {
    return buildMorningContext(briefing);
  }
  if (briefing.mode === "midday") {
    return buildMiddayContext(briefing);
  }
  return buildEodContext(briefing);
}

function pruneNarrativeCache(nowMs: number): void {
  for (const [key, entry] of narrativeCache.entries()) {
    if (entry.expiresAtMs <= nowMs) {
      narrativeCache.delete(key);
    }
  }
}

function sentenceCount(value: string): number {
  return value
    .split(/[.!?]+/)
    .map((item) => item.trim())
    .filter(Boolean).length;
}

function hasBulletsOrNewlines(value: string): boolean {
  if (value.includes("\n") || value.includes("\r")) {
    return true;
  }
  return /^\s*[-*•]\s+/m.test(value);
}

function splitSentences(value: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    return Array.from(segmenter.segment(value), (entry) => entry.segment.trim()).filter(Boolean);
  }

  return (
    value
      .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
      ?.map((segment) => segment.trim())
      .filter(Boolean) || []
  );
}

function normalizeNarrativeOutput(rawNarrative: string): string {
  if (!rawNarrative.trim()) {
    return "";
  }

  const normalizedLineText = rawNarrative
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalizedLineText) {
    return "";
  }

  const sentences = splitSentences(normalizedLineText);
  if (sentences.length === 0) {
    return normalizedLineText;
  }

  if (sentences.length > 3) {
    return sentences.slice(0, 3).join(" ").trim();
  }

  return normalizedLineText;
}

export async function POST(request: NextRequest) {
  const auth = await requireAuthenticatedRoute(request);
  if (auth.response || !auth.context) {
    return auth.response as NextResponse;
  }

  const { supabase, userId } = auth.context;

  let body: BriefingNarrativeRequest;
  try {
    body = (await request.json()) as BriefingNarrativeRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const briefing = body?.briefing as BriefingResponse | undefined;
  if (!briefing || !isValidBriefingMode(briefing.mode)) {
    return NextResponse.json({ error: "Invalid briefing payload" }, { status: 400 });
  }

  const context = buildContextForMode(briefing);
  const contextJson = JSON.stringify(context);
  const contextHash = createHash("sha256").update(contextJson).digest("hex");
  const resolvedModel = await resolveModelForFeature(supabase, userId, "briefing_narrative");
  const modelScope = resolvedModel ? `${resolvedModel.provider}:${resolvedModel.model_id}` : "default";
  const cacheKey = `${userId}:${briefing.requestedDate}:${briefing.mode}:${modelScope}:${contextHash}`;
  const requestFingerprint = createHash("sha256")
    .update(`briefing_narrative\n${briefing.mode}\n${contextHash}\n${modelScope}`)
    .digest("hex");

  const nowMs = Date.now();
  pruneNarrativeCache(nowMs);
  const cached = narrativeCache.get(cacheKey);
  if (cached && cached.expiresAtMs > nowMs) {
    const cacheMeta: LlmRunMeta = {
      ...cached.runMeta,
      status: "cache_hit",
      cacheStatus: "hit",
      latencyMs: 0,
    };

    await recordLlmUsageEvent(supabase, {
      userId,
      feature: "briefing_narrative",
      provider: cacheMeta.provider,
      modelId: cacheMeta.modelId,
      modelCatalogId: resolvedModel?.id ?? null,
      modelSource: cacheMeta.source,
      status: "cache_hit",
      latencyMs: 0,
      inputTokens: cacheMeta.inputTokens,
      outputTokens: cacheMeta.outputTokens,
      estimatedCostUsd: cacheMeta.estimatedCostUsd,
      pricingIsPlaceholder: cacheMeta.pricingIsPlaceholder,
      pricingTier: cacheMeta.pricingTier,
      cacheStatus: "hit",
      requestFingerprint,
    });

    const response: BriefingNarrativeResponse = {
      mode: briefing.mode,
      narrative: cached.narrative,
      llm: cacheMeta,
    };
    return NextResponse.json(response);
  }

  const userPrompt = `${buildModeInstruction(briefing.mode)}

Context:
${JSON.stringify(context, null, 2)}`;

  const generation = await generateTextWithLlm({
    supabase,
    userId,
    feature: "briefing_narrative",
    systemPrompt: NARRATIVE_SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.2,
    maxTokens: 180,
    timeoutMs: 4500,
    requestFingerprint,
  });

  if (!generation.text || !generation.runMeta) {
    const response: BriefingNarrativeResponse = {
      mode: briefing.mode,
      narrative: "",
      llm: null,
    };
    return NextResponse.json(response);
  }

  const normalizedNarrative = normalizeNarrativeOutput(generation.text);
  if (!normalizedNarrative || hasBulletsOrNewlines(normalizedNarrative) || sentenceCount(normalizedNarrative) > 3) {
    const response: BriefingNarrativeResponse = {
      mode: briefing.mode,
      narrative: "",
      llm: null,
    };
    return NextResponse.json(response);
  }

  const llmMeta: LlmRunMeta = {
    ...generation.runMeta,
    cacheStatus: "miss",
  };

  narrativeCache.set(cacheKey, {
    narrative: normalizedNarrative,
    runMeta: llmMeta,
    expiresAtMs: nowMs + CACHE_TTL_MS,
  });

  const response: BriefingNarrativeResponse = {
    mode: briefing.mode,
    narrative: normalizedNarrative,
    llm: llmMeta,
  };
  return NextResponse.json(response);
}
