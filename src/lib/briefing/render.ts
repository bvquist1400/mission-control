import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  generateTextWithLlm,
  recordLlmUsageEvent,
  resolveModelForFeature,
  type LlmRunMeta,
} from "@/lib/llm";
import type {
  DailyBriefDigestCommitmentGroup,
  DailyBriefDigestMeetingItem,
  DailyBriefOpenReviewItem,
  DailyBriefDigestResponse,
  DailyBriefStatusUpdateRecommendation,
  DailyBriefDigestTaskItem,
} from "@/lib/briefing/digest";

const RENDER_CACHE_TTL_MS = 30 * 60 * 1000;
const RENDER_LLM_TIMEOUT_MS = 15000;

interface RenderCacheEntry {
  copy: DailyBriefRenderCopy;
  runMeta: LlmRunMeta;
  expiresAtMs: number;
}

const renderCache = new Map<string, RenderCacheEntry>();

const CHIEF_OF_STAFF_SYSTEM_PROMPT = `You are a sharp chief of staff briefing a busy operator.
Write like a candid human assistant, not a generic executive assistant.
Tone rules:
- candid
- concise
- slightly opinionated
- willing to say "this is slipping" or "don't touch this yet" when the digest supports it
- not cheerful
- not corporate
- not robotic

Content rules:
- prioritize judgment over summary
- do not restate obvious facts
- no invented facts
- do not mention anything not present in the digest
- recommendations must map to provided task IDs, meeting titles, stakeholders, or named risks
- output valid JSON only

Return exactly this shape:
{
  "opening_narrative": "4-6 sentences",
  "what_matters_most": "1-2 sentences",
  "guidance": ["...", "...", "..."],
  "watchout": "..." or null
}`;

export interface DailyBriefRenderCopy {
  opening_narrative: string;
  what_matters_most: string;
  guidance_title: DailyBriefDigestResponse["guidance_title"];
  guidance: string[];
  watchout: string | null;
}

export interface DailyBriefRenderResponse {
  requestedDate: string;
  mode: DailyBriefDigestResponse["mode"];
  modeLabel: string;
  generatedAt: string;
  subject: string;
  preheader: string;
  syncApprovalText: string | null;
  html: string;
  text: string;
  digest: DailyBriefDigestResponse;
  copy: DailyBriefRenderCopy;
  llm: LlmRunMeta | null;
}

function pruneRenderCache(nowMs: number): void {
  for (const [key, entry] of renderCache.entries()) {
    if (entry.expiresAtMs <= nowMs) {
      renderCache.delete(key);
    }
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncatePromptValue(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return null;
  }

  if (normalized.length <= max) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
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

function normalizeSentenceLimitedText(value: string, minSentences: number, maxSentences: number): string {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return "";
  }

  const sentences = splitSentences(normalized);
  if (sentences.length < minSentences) {
    return "";
  }

  if (sentences.length > maxSentences) {
    return sentences.slice(0, maxSentences).join(" ").trim();
  }

  return normalized;
}

function normalizeSingleParagraph(value: string): string {
  return normalizeWhitespace(value.replace(/\r?\n+/g, " "));
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function formatPromptTask(task: DailyBriefDigestTaskItem): Record<string, string | null> {
  return {
    id: task.id,
    title: task.title,
    due: task.due_label,
    reason: truncatePromptValue(task.reason, 160),
    recent_update: truncatePromptValue(task.recent_update, 120),
    context: truncatePromptValue(task.context, 120),
  };
}

function formatPromptMeeting(meeting: DailyBriefDigestMeetingItem): Record<string, unknown> {
  return {
    title: meeting.title,
    time: meeting.time_range_et,
    notes: truncatePromptValue(meeting.notes, 160),
    commitments: meeting.open_commitments.map((item) => `${item.stakeholder_name}: ${item.title}`),
    related_tasks: meeting.related_tasks.map((task) => `${task.title} [${task.id}]`),
  };
}

function formatPromptCommitment(group: DailyBriefDigestCommitmentGroup): Record<string, unknown> {
  return {
    stakeholder: group.stakeholder_name,
    items: group.commitments.map((item) => ({
      title: truncatePromptValue(item.title, 120),
      due_at: item.due_at,
      task_title: truncatePromptValue(item.task_title, 120),
    })),
  };
}

function buildRenderPromptContext(digest: DailyBriefDigestResponse): Record<string, unknown> {
  return {
    mode: digest.mode,
    requestedDate: digest.requestedDate,
    currentTimeET: digest.currentTimeET,
    guidanceTitle: digest.guidance_title,
    counts: digest.counts,
    signals: digest.signals,
    sprint: digest.sprint
      ? {
          name: digest.sprint.name,
          theme: digest.sprint.theme,
          progress: `${digest.sprint.completed_tasks}/${digest.sprint.total_tasks} (${digest.sprint.completion_pct}%)`,
          health: truncatePromptValue(digest.sprint.health_assessment, 140),
        }
      : null,
    tasks: {
      due_soon: digest.tasks.due_soon.slice(0, 3).map(formatPromptTask),
      blocked: digest.tasks.blocked.slice(0, 2).map(formatPromptTask),
      in_progress: digest.tasks.in_progress.slice(0, 2).map(formatPromptTask),
      completed_today: digest.tasks.completed_today.slice(0, 2).map(formatPromptTask),
      stale_followups: digest.tasks.stale_followups.slice(0, 2).map(formatPromptTask),
      rolled_to_tomorrow: digest.tasks.rolled_to_tomorrow.slice(0, 3).map(formatPromptTask),
      tomorrow_prep: digest.tasks.tomorrow_prep.slice(0, 3).map(formatPromptTask),
    },
    meetings: digest.meetings.slice(0, 3).map(formatPromptMeeting),
    commitments: {
      theirs: digest.commitments.theirs.slice(0, 3).map(formatPromptCommitment),
      ours: digest.commitments.ours.slice(0, 1).map(formatPromptCommitment),
    },
    status_update_recommendations: digest.status_update_recommendations.slice(0, 3).map((item) => ({
      entity: `${item.entity_type}:${item.entity_name}`,
      reason: truncatePromptValue(item.reason, 160),
      related_tasks: item.related_tasks.map((task) => `${task.title} [${task.id}]`),
    })),
    suggested_sync_today: digest.suggested_sync_today.slice(0, 3),
  };
}

function buildModeInstruction(mode: DailyBriefDigestResponse["mode"]): string {
  if (mode === "morning") {
    return "Frame the day: what matters first, where drift could start, and what should not be touched yet.";
  }

  if (mode === "midday") {
    return "Take stock of the day honestly: what moved, what still matters, and what the afternoon should actually do.";
  }

  return "Close the day with judgment: what really moved, what is slipping, and what tomorrow needs first.";
}

function buildFallbackWhatMattersMost(digest: DailyBriefDigestResponse): string {
  if (digest.signals.top_risk) {
    return digest.signals.top_risk;
  }

  const firstDueSoon = digest.tasks.due_soon[0];
  if (firstDueSoon) {
    return `${firstDueSoon.title} [${firstDueSoon.id}] is the item most likely to cause drift if it sits.`;
  }

  const firstInProgress = digest.tasks.in_progress[0];
  if (firstInProgress) {
    return `${firstInProgress.title} [${firstInProgress.id}] is the strongest active thread to keep moving.`;
  }

  return "There is no single screaming fire, so the brief should bias toward finishing one real thing instead of spreading out.";
}

function buildFallbackWatchout(digest: DailyBriefDigestResponse): string | null {
  if (
    digest.signals.is_day_overloaded ||
    digest.counts.stale_followups > 0 ||
    digest.counts.overdue > 0 ||
    digest.signals.momentum_score < 40
  ) {
    return digest.signals.top_risk;
  }

  return null;
}

function buildFallbackCopy(digest: DailyBriefDigestResponse): DailyBriefRenderCopy {
  return {
    opening_narrative: digest.narrative,
    what_matters_most: buildFallbackWhatMattersMost(digest),
    guidance_title: digest.guidance_title,
    guidance: digest.guidance.slice(0, 3),
    watchout: buildFallbackWatchout(digest),
  };
}

function buildReferencePool(digest: DailyBriefDigestResponse): string[] {
  const taskRefs = [
    ...digest.tasks.due_soon,
    ...digest.tasks.blocked,
    ...digest.tasks.in_progress,
    ...digest.tasks.completed_today,
    ...digest.tasks.stale_followups,
    ...digest.tasks.rolled_to_tomorrow,
  ].flatMap((task) => [task.id, task.title]);
  const meetingRefs = digest.meetings.flatMap((meeting) => [meeting.title, ...meeting.stakeholder_names]);
  const commitmentRefs = [...digest.commitments.theirs, ...digest.commitments.ours].flatMap((group) => [
    group.stakeholder_name,
    ...group.commitments.map((item) => item.title),
  ]);
  const statusUpdateRefs = digest.status_update_recommendations.flatMap((item) => [
    item.entity_name,
    ...item.related_tasks.map((task) => task.title),
  ]);
  const riskRefs = digest.signals.top_risk ? [digest.signals.top_risk] : [];

  return [...taskRefs, ...meetingRefs, ...commitmentRefs, ...statusUpdateRefs, ...riskRefs]
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length >= 4);
}

function lineReferencesDigest(line: string, referencePool: string[]): boolean {
  const normalized = line.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return referencePool.some((reference) => normalized.includes(reference));
}

function normalizeGuidance(
  guidanceRaw: unknown,
  fallback: string[],
  referencePool: string[]
): string[] {
  const rawLines = Array.isArray(guidanceRaw)
    ? guidanceRaw.filter((item): item is string => typeof item === "string")
    : [];
  const normalized = rawLines
    .map((line) => normalizeSingleParagraph(line))
    .filter(Boolean)
    .filter((line) => lineReferencesDigest(line, referencePool))
    .slice(0, 3);

  if (normalized.length > 0) {
    return normalized;
  }

  return fallback.slice(0, 3);
}

function normalizeWatchout(
  watchoutRaw: unknown,
  fallback: string | null,
  referencePool: string[]
): string | null {
  if (watchoutRaw === null) {
    return null;
  }

  if (typeof watchoutRaw !== "string") {
    return fallback;
  }

  const normalized = normalizeSingleParagraph(watchoutRaw);
  if (!normalized) {
    return fallback;
  }

  if (!lineReferencesDigest(normalized, referencePool) && fallback) {
    return fallback;
  }

  return normalized;
}

function normalizeLlmCopy(
  parsed: Record<string, unknown> | null,
  digest: DailyBriefDigestResponse
): DailyBriefRenderCopy {
  const fallback = buildFallbackCopy(digest);
  if (!parsed) {
    return fallback;
  }

  const referencePool = buildReferencePool(digest);
  const opening = typeof parsed.opening_narrative === "string"
    ? normalizeSentenceLimitedText(parsed.opening_narrative, 3, 6)
    : "";
  const matters = typeof parsed.what_matters_most === "string"
    ? normalizeSentenceLimitedText(parsed.what_matters_most, 1, 2)
    : "";

  return {
    opening_narrative: opening || fallback.opening_narrative,
    what_matters_most: matters || fallback.what_matters_most,
    guidance_title: digest.guidance_title,
    guidance: normalizeGuidance(parsed.guidance, fallback.guidance, referencePool),
    watchout: normalizeWatchout(parsed.watchout, fallback.watchout, referencePool),
  };
}

async function generateChiefOfStaffCopy(
  supabase: SupabaseClient,
  userId: string,
  digest: DailyBriefDigestResponse
): Promise<{ copy: DailyBriefRenderCopy; llm: LlmRunMeta | null }> {
  const promptContext = buildRenderPromptContext(digest);
  const contextJson = JSON.stringify(promptContext);
  const contextHash = createHash("sha256").update(contextJson).digest("hex");
  const resolvedModel = await resolveModelForFeature(supabase, userId, "briefing_narrative");
  const modelScope = resolvedModel ? `${resolvedModel.provider}:${resolvedModel.model_id}` : "default";
  const cacheKey = `${userId}:${digest.requestedDate}:${digest.mode}:render:${modelScope}:${contextHash}`;
  const requestFingerprint = createHash("sha256")
    .update(`briefing_render\n${digest.mode}\n${contextHash}\n${modelScope}`)
    .digest("hex");
  const nowMs = Date.now();

  pruneRenderCache(nowMs);
  const cached = renderCache.get(cacheKey);
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
      modelCatalogId: resolvedModel?.source === "default" ? null : resolvedModel?.id ?? null,
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

    return {
      copy: cached.copy,
      llm: cacheMeta,
    };
  }

  const userPrompt = `${buildModeInstruction(digest.mode)}

Use this digest as the complete source of truth.

Digest:
${JSON.stringify(promptContext, null, 2)}`;

  const generation = await generateTextWithLlm({
    supabase,
    userId,
    feature: "briefing_narrative",
    systemPrompt: CHIEF_OF_STAFF_SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.35,
    maxTokens: 320,
    timeoutMs: RENDER_LLM_TIMEOUT_MS,
    requestFingerprint,
  });

  if (!generation.text || !generation.runMeta) {
    return {
      copy: buildFallbackCopy(digest),
      llm: null,
    };
  }

  const copy = normalizeLlmCopy(extractJsonObject(generation.text), digest);
  const llmMeta: LlmRunMeta = {
    ...generation.runMeta,
    cacheStatus: "miss",
  };

  renderCache.set(cacheKey, {
    copy,
    runMeta: llmMeta,
    expiresAtMs: nowMs + RENDER_CACHE_TTL_MS,
  });

  return { copy, llm: llmMeta };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateOnlyLabel(dateOnly: string): string {
  return new Date(`${dateOnly}T12:00:00.000Z`).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatEtDateTimeLabel(iso: string): string {
  return `${new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })} ET`;
}

function truncatePreview(value: string, max = 140): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= max) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

const EMAIL_COLORS = {
  page: "#0d1117",
  panel: "#161b22",
  panelMuted: "#21262d",
  stroke: "#30363d",
  text: "#e6edf3",
  muted: "#7d8590",
  accent: "#c41e3a",
  accentSoft: "rgba(196, 30, 58, 0.15)",
  accentText: "#ff9fb0",
  blueSoft: "rgba(59, 130, 246, 0.16)",
  blueBorder: "rgba(96, 165, 250, 0.28)",
  blueText: "#93c5fd",
  amberSoft: "rgba(245, 158, 11, 0.14)",
  amberBorder: "rgba(251, 191, 36, 0.28)",
  amberText: "#fcd34d",
  greenSoft: "rgba(34, 197, 94, 0.14)",
  greenBorder: "rgba(74, 222, 128, 0.28)",
  greenText: "#86efac",
  roseSoft: "rgba(244, 63, 94, 0.16)",
  roseBorder: "rgba(251, 113, 133, 0.32)",
  roseText: "#fda4af",
};

function getModeLabel(mode: DailyBriefDigestResponse["mode"]): string {
  return mode === "eod" ? "EOD Brief" : `${mode[0].toUpperCase()}${mode.slice(1)} Brief`;
}

function buildHeaderSubtitle(digest: DailyBriefDigestResponse, copy: DailyBriefRenderCopy): string {
  if (digest.sprint?.health_assessment) {
    return digest.sprint.health_assessment;
  }

  if (digest.signals.top_risk) {
    return digest.signals.top_risk;
  }

  return copy.what_matters_most;
}

function buildPreheader(digest: DailyBriefDigestResponse, copy: DailyBriefRenderCopy): string {
  const summary = [
    copy.watchout ?? digest.signals.top_risk ?? copy.what_matters_most,
    `${digest.counts.overdue} overdue`,
    `${digest.counts.blocked} blocked`,
    `${digest.counts.remaining_meetings} meetings left`,
  ].filter(Boolean).join(" • ");

  return truncatePreview(summary, 160);
}

function buildSyncApprovalText(digest: DailyBriefDigestResponse): string | null {
  if (digest.suggested_sync_today.length === 0) {
    return null;
  }

  const lines = [
    "Apply this sync_today recommendation exactly as written. Do not add or remove items.",
    ...digest.suggested_sync_today.slice(0, 3).map(
      (item) => `${item.action.toUpperCase()} ${item.title} [${item.task_id}]`
    ),
  ];

  return lines.join("\n");
}

function metricCard(
  label: string,
  value: string,
  subtext: string,
  background: string,
  border: string,
  labelColor: string,
  valueColor: string
): string {
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:${background};border:1px solid ${border};border-radius:14px;">
      <tr>
        <td style="padding:14px;">
          <div style="font-family:'Avenir Next','Trebuchet MS','Segoe UI',sans-serif;font-size:11px;line-height:16px;color:${labelColor};text-transform:uppercase;letter-spacing:1px;font-weight:700;">${escapeHtml(label)}</div>
          <div style="font-family:'Avenir Next','Trebuchet MS','Segoe UI',sans-serif;font-size:22px;line-height:28px;color:${valueColor};font-weight:700;padding-top:6px;">${escapeHtml(value)}</div>
          <div style="font-family:'Avenir Next','Trebuchet MS','Segoe UI',sans-serif;font-size:13px;line-height:20px;color:${labelColor};padding-top:2px;">${escapeHtml(subtext)}</div>
        </td>
      </tr>
    </table>`;
}

function sectionFrame(title: string, body: string): string {
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:${EMAIL_COLORS.panel};border:1px solid ${EMAIL_COLORS.stroke};border-radius:16px;">
      <tr>
        <td style="padding:18px 20px;background-color:${EMAIL_COLORS.panelMuted};border-bottom:1px solid ${EMAIL_COLORS.stroke};font-family:'Avenir Next','Trebuchet MS','Segoe UI',sans-serif;font-size:18px;line-height:24px;color:${EMAIL_COLORS.text};font-weight:700;">
          ${escapeHtml(title)}
        </td>
      </tr>
      <tr>
        <td style="padding:18px 20px;font-family:'Avenir Next','Trebuchet MS','Segoe UI',sans-serif;font-size:14px;line-height:24px;color:${EMAIL_COLORS.text};">
          ${body}
        </td>
      </tr>
    </table>`;
}

function statusPill(label: string, background: string, border: string, color: string): string {
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0">
      <tr>
        <td style="background-color:${background};border:1px solid ${border};border-radius:999px;padding:4px 10px;font-family:'Avenir Next','Trebuchet MS','Segoe UI',sans-serif;font-size:11px;line-height:14px;color:${color};font-weight:700;text-transform:uppercase;letter-spacing:1px;">
          ${escapeHtml(label)}
        </td>
      </tr>
    </table>`;
}

function taskTone(label: string): { background: string; border: string; color: string } {
  if (label === "Overdue") {
    return { background: EMAIL_COLORS.roseSoft, border: EMAIL_COLORS.roseBorder, color: EMAIL_COLORS.roseText };
  }
  if (label === "Blocked") {
    return { background: EMAIL_COLORS.amberSoft, border: EMAIL_COLORS.amberBorder, color: EMAIL_COLORS.amberText };
  }
  if (label === "In Progress") {
    return { background: EMAIL_COLORS.blueSoft, border: EMAIL_COLORS.blueBorder, color: EMAIL_COLORS.blueText };
  }
  if (label === "Stale") {
    return { background: EMAIL_COLORS.accentSoft, border: "rgba(196, 30, 58, 0.32)", color: EMAIL_COLORS.accentText };
  }

  return { background: EMAIL_COLORS.panelMuted, border: EMAIL_COLORS.stroke, color: EMAIL_COLORS.muted };
}

function renderPriorityTaskContext(task: DailyBriefDigestTaskItem): string {
  return [
    task.due_label,
    task.reason,
    task.context ? `Context: ${task.context}` : null,
    task.recent_update,
  ].filter((value): value is string => Boolean(value)).join(". ");
}

function buildPriorityTaskRows(digest: DailyBriefDigestResponse): Array<{ label: string; task: DailyBriefDigestTaskItem }> {
  const rows: Array<{ label: string; task: DailyBriefDigestTaskItem }> = [];
  const seen = new Set<string>();
  const push = (label: string, task?: DailyBriefDigestTaskItem) => {
    if (!task || seen.has(task.id)) {
      return;
    }
    seen.add(task.id);
    rows.push({ label, task });
  };

  if (digest.mode === "eod") {
    push("Stale", digest.tasks.stale_followups[0]);
    push("Blocked", digest.tasks.blocked[0]);
    push("Overdue", digest.tasks.due_soon.find((task) => task.due_label?.startsWith("Overdue")) ?? digest.tasks.rolled_to_tomorrow[0]);
  } else {
    push(
      digest.tasks.due_soon.find((task) => task.due_label?.startsWith("Overdue")) ? "Overdue" : "Due Soon",
      digest.tasks.due_soon.find((task) => task.due_label?.startsWith("Overdue")) ?? digest.tasks.due_soon[0]
    );
    push("Blocked", digest.tasks.blocked[0]);
    push("In Progress", digest.tasks.in_progress[0]);
  }

  if (rows.length === 0 && digest.tasks.completed_today[0]) {
    push("Done", digest.tasks.completed_today[0]);
  }

  return rows.slice(0, 3);
}

function renderPriorityTasks(digest: DailyBriefDigestResponse): string {
  const rows = buildPriorityTaskRows(digest);
  if (rows.length === 0) {
    return sectionFrame("⚡ Priority tasks", `<div style="color:${EMAIL_COLORS.muted};">No obvious priority tasks surfaced.</div>`);
  }

  const body = rows
    .map(({ label, task }, index) => {
      const tone = taskTone(label);
      const divider = index < rows.length - 1 ? `border-bottom:1px solid ${EMAIL_COLORS.stroke};` : "";
      return `
        <tr>
          <td style="padding:18px 20px;${divider}">
            ${statusPill(label, tone.background, tone.border, tone.color)}
            <div style="font-family:'Avenir Next','Trebuchet MS','Segoe UI',sans-serif;font-size:16px;line-height:24px;color:${EMAIL_COLORS.text};font-weight:700;padding-top:10px;">
              ${escapeHtml(task.title)}
            </div>
            <div style="font-family:'Avenir Next','Trebuchet MS','Segoe UI',sans-serif;font-size:14px;line-height:24px;color:${EMAIL_COLORS.muted};padding-top:6px;">
              ${escapeHtml(renderPriorityTaskContext(task))}
            </div>
          </td>
        </tr>`;
    })
    .join("");

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:${EMAIL_COLORS.panel};border:1px solid ${EMAIL_COLORS.stroke};border-radius:16px;">
      <tr>
        <td style="padding:18px 20px;background-color:${EMAIL_COLORS.panelMuted};border-bottom:1px solid ${EMAIL_COLORS.stroke};font-family:'Avenir Next','Trebuchet MS','Segoe UI',sans-serif;font-size:18px;line-height:24px;color:${EMAIL_COLORS.text};font-weight:700;">
          ⚡ Priority tasks
        </td>
      </tr>
      ${body}
    </table>`;
}

function renderMeetingsCard(meetings: DailyBriefDigestMeetingItem[]): string {
  if (meetings.length === 0) {
    return sectionFrame("📅 Remaining meetings", `<div style="color:${EMAIL_COLORS.muted};">No remaining meetings today.</div>`);
  }

  const body = meetings.slice(0, 4).map((meeting, index) => {
    const divider = index < meetings.slice(0, 4).length - 1 ? `border-bottom:1px solid ${EMAIL_COLORS.stroke};` : "";
    const context = [
      meeting.notes,
      meeting.open_commitments.length > 0 ? `Commitments: ${meeting.open_commitments.map((item) => `${item.stakeholder_name}: ${item.title}`).join("; ")}` : null,
      meeting.related_tasks.length > 0 ? `Related tasks: ${meeting.related_tasks.map((item) => `${item.title} [${item.id}]`).join("; ")}` : null,
    ].filter((value): value is string => Boolean(value)).join(". ");

    return `
      <tr>
        <td style="padding:18px 20px;${divider}">
          <div style="font-family:'Avenir Next','Trebuchet MS','Segoe UI',sans-serif;font-size:16px;line-height:24px;color:${EMAIL_COLORS.text};font-weight:700;">${escapeHtml(meeting.title)}</div>
          <div style="font-family:'Avenir Next','Trebuchet MS','Segoe UI',sans-serif;font-size:13px;line-height:20px;color:${EMAIL_COLORS.muted};padding-top:4px;">${escapeHtml(meeting.time_range_et)}</div>
          <div style="font-family:'Avenir Next','Trebuchet MS','Segoe UI',sans-serif;font-size:14px;line-height:24px;color:${EMAIL_COLORS.muted};padding-top:8px;">${escapeHtml(context || "No extra context attached.")}</div>
        </td>
      </tr>`;
  }).join("");

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:${EMAIL_COLORS.panel};border:1px solid ${EMAIL_COLORS.stroke};border-radius:16px;">
      <tr>
        <td style="padding:18px 20px;background-color:${EMAIL_COLORS.panelMuted};border-bottom:1px solid ${EMAIL_COLORS.stroke};font-family:'Avenir Next','Trebuchet MS','Segoe UI',sans-serif;font-size:18px;line-height:24px;color:${EMAIL_COLORS.text};font-weight:700;">
          📅 Remaining meetings
        </td>
      </tr>
      ${body}
    </table>`;
}

function renderCommitmentsCard(digest: DailyBriefDigestResponse): string {
  const theirLines = digest.commitments.theirs.slice(0, 4).map((group) => {
    const text = group.commitments.map((item) => [item.title, item.due_at ? `due ${item.due_at.slice(0, 10)}` : null].filter(Boolean).join(" • ")).join("; ");
    return `<strong>${escapeHtml(group.stakeholder_name)}</strong> — ${escapeHtml(text)}`;
  });
  const ourLines = digest.commitments.ours.slice(0, 2).map((group) => {
    const text = group.commitments.map((item) => [item.title, item.due_at ? `due ${item.due_at.slice(0, 10)}` : null].filter(Boolean).join(" • ")).join("; ");
    return `<strong>${escapeHtml(group.stakeholder_name)}</strong> — ${escapeHtml(text)}`;
  });

  const blocks = [
    theirLines.length > 0 ? theirLines.join("<br />") : "<span style=\"color:#7d8590;\">No open commitments owed to you.</span>",
    ourLines.length > 0
      ? `<div style="padding-top:12px;color:${EMAIL_COLORS.muted};font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:700;">Ours</div><div style="padding-top:8px;">${ourLines.join("<br />")}</div>`
      : "",
  ].join("");

  return sectionFrame("🤝 Open commitments", `<div style="font-size:14px;line-height:26px;color:${EMAIL_COLORS.text};">${blocks}</div>`);
}

function renderGuidanceCard(copy: DailyBriefRenderCopy): string {
  const rows = copy.guidance.slice(0, 3).map((line, index) => {
    return `<div style="padding-top:${index === 0 ? "0" : "10px"};"><strong>${index + 1}.</strong> ${escapeHtml(line)}</div>`;
  }).join("");

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:${EMAIL_COLORS.panelMuted};border:1px solid ${EMAIL_COLORS.stroke};border-radius:16px;">
      <tr>
        <td style="padding:20px 22px;font-family:'Avenir Next','Trebuchet MS','Segoe UI',sans-serif;">
          <div style="font-size:18px;line-height:24px;color:${EMAIL_COLORS.text};font-weight:700;padding-bottom:10px;">
            💡 ${escapeHtml(copy.guidance_title)}
          </div>
          <div style="font-size:14px;line-height:24px;color:${EMAIL_COLORS.text};padding-bottom:10px;">
            <strong>What matters most:</strong> ${escapeHtml(copy.what_matters_most)}
          </div>
          <div style="font-size:14px;line-height:26px;color:${EMAIL_COLORS.muted};">
            ${rows}
          </div>
        </td>
      </tr>
    </table>`;
}

function renderWatchoutCard(watchout: string | null): string {
  if (!watchout) {
    return "";
  }

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:${EMAIL_COLORS.accentSoft};border:1px solid rgba(196, 30, 58, 0.35);border-radius:16px;">
      <tr>
        <td style="padding:18px 20px;font-family:'Avenir Next','Trebuchet MS','Segoe UI',sans-serif;">
          <div style="font-size:12px;line-height:18px;color:${EMAIL_COLORS.accentText};text-transform:uppercase;letter-spacing:1px;font-weight:700;padding-bottom:6px;">Watchout</div>
          <div style="font-size:15px;line-height:24px;color:${EMAIL_COLORS.text};font-weight:700;">${escapeHtml(watchout)}</div>
        </td>
      </tr>
    </table>`;
}

function renderSyncCard(digest: DailyBriefDigestResponse, syncApprovalText: string | null): string {
  if (digest.suggested_sync_today.length === 0 || !syncApprovalText) {
    return "";
  }

  const lines = digest.suggested_sync_today.slice(0, 3).map((item, index) => {
    return `<div style="padding-top:${index === 0 ? "0" : "8px"};"><strong>${index + 1}.</strong> ${escapeHtml(`${item.title} [${item.task_id}]`)} — ${escapeHtml(item.reason)}</div>`;
  }).join("");

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:${EMAIL_COLORS.greenSoft};border:1px solid ${EMAIL_COLORS.greenBorder};border-radius:16px;">
      <tr>
        <td style="padding:20px 22px;font-family:'Avenir Next','Trebuchet MS','Segoe UI',sans-serif;">
          <div style="font-size:18px;line-height:24px;color:${EMAIL_COLORS.greenText};font-weight:700;padding-bottom:10px;">
            Suggested sync_today
          </div>
          <div style="font-size:14px;line-height:26px;color:${EMAIL_COLORS.text};">
            ${lines}
          </div>
          <div style="font-size:12px;line-height:18px;color:${EMAIL_COLORS.greenText};padding-top:12px;">
            Recommendation only — no statuses were changed.
          </div>
          <div style="padding-top:14px;">
            <div style="font-size:12px;line-height:18px;color:${EMAIL_COLORS.greenText};text-transform:uppercase;letter-spacing:1px;font-weight:700;padding-bottom:8px;">
              Copy into chat
            </div>
            <div style="background-color:${EMAIL_COLORS.panel};border:1px solid ${EMAIL_COLORS.stroke};border-radius:12px;padding:14px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:20px;color:${EMAIL_COLORS.text};white-space:pre-wrap;">
              ${escapeHtml(syncApprovalText)}
            </div>
          </div>
        </td>
      </tr>
    </table>`;
}

function renderStaleFollowupsCard(digest: DailyBriefDigestResponse): string {
  if (digest.tasks.stale_followups.length === 0) {
    return "";
  }

  const body = digest.tasks.stale_followups.slice(0, 3).map((task, index) => {
    const divider = index < Math.min(digest.tasks.stale_followups.length, 3) - 1 ? `border-bottom:1px solid ${EMAIL_COLORS.stroke};` : "";
    return `
      <tr>
        <td style="padding:16px 20px;${divider}">
          <div style="font-size:16px;line-height:24px;color:${EMAIL_COLORS.text};font-weight:700;">${escapeHtml(task.title)}</div>
          <div style="font-size:14px;line-height:24px;color:${EMAIL_COLORS.muted};padding-top:6px;">${escapeHtml(task.reason)}</div>
        </td>
      </tr>`;
  }).join("");

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:${EMAIL_COLORS.panel};border:1px solid ${EMAIL_COLORS.stroke};border-radius:16px;">
      <tr>
        <td style="padding:18px 20px;background-color:${EMAIL_COLORS.panelMuted};border-bottom:1px solid ${EMAIL_COLORS.stroke};font-family:'Avenir Next','Trebuchet MS','Segoe UI',sans-serif;font-size:18px;line-height:24px;color:${EMAIL_COLORS.text};font-weight:700;">
          Stale follow-ups
        </td>
      </tr>
      ${body}
    </table>`;
}

function renderOpenReviewItemsCard(items: DailyBriefOpenReviewItem[]): string {
  if (items.length === 0) {
    return "";
  }

  const body = items.map((item, index) => {
    return `<div style="padding-top:${index === 0 ? "0" : "12px"};"><strong>${escapeHtml(item.artifact_type)}</strong> — ${escapeHtml(item.task_title)} [${escapeHtml(item.task_id)}] — <span style="color:${EMAIL_COLORS.muted};">${escapeHtml(item.suggested_action)}</span></div>`;
  }).join("");

  return sectionFrame("⚠️ Open Review Items", body);
}

function renderDigestTaskListCard(
  title: string,
  items: DailyBriefDigestTaskItem[],
  emptyMessage: string
): string {
  if (items.length === 0) {
    return sectionFrame(title, `<div style="color:${EMAIL_COLORS.muted};">${escapeHtml(emptyMessage)}</div>`);
  }

  const body = items.slice(0, 3).map((task, index) => {
    return `<div style="padding-top:${index === 0 ? "0" : "12px"};"><strong>${escapeHtml(task.title)}</strong><div style="color:${EMAIL_COLORS.muted};padding-top:4px;">${escapeHtml(renderPriorityTaskContext(task))}</div></div>`;
  }).join("");

  return sectionFrame(title, body);
}

function renderStatusUpdateRecommendationsCard(items: DailyBriefStatusUpdateRecommendation[]): string {
  if (items.length === 0) {
    return "";
  }

  const body = items.slice(0, 3).map((item, index) => {
    const relatedTasks =
      item.related_tasks.length > 0
        ? `Related threads: ${item.related_tasks.map((task) => `${task.title} [${task.id}]`).join("; ")}`
        : null;
    const staleText = item.last_status_artifact_at
      ? `Last status artifact: ${formatEtDateTimeLabel(item.last_status_artifact_at)}`
      : "No current status artifact";
    const detail = [item.reason, staleText, relatedTasks].filter((value): value is string => Boolean(value)).join(". ");

    return `<div style="padding-top:${index === 0 ? "0" : "12px"};"><strong>${escapeHtml(`${item.entity_type === "project" ? "Project" : "Implementation"}: ${item.entity_name}`)}</strong><div style="color:${EMAIL_COLORS.muted};padding-top:4px;">${escapeHtml(detail)}</div></div>`;
  }).join("");

  return sectionFrame("Status update reminders", body);
}

function renderBriefHtml(
  digest: DailyBriefDigestResponse,
  copy: DailyBriefRenderCopy,
  preheader: string,
  syncApprovalText: string | null
): string {
  const modeLabel = getModeLabel(digest.mode);
  const headline = modeLabel;
  const headerSubtitle = buildHeaderSubtitle(digest, copy);
  const summaryStrip = `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:${EMAIL_COLORS.panelMuted};border-top:1px solid ${EMAIL_COLORS.stroke};border-bottom:1px solid ${EMAIL_COLORS.stroke};">
      <tr>
        <td style="padding:18px 20px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr>
              <td width="25%" valign="top" style="padding:6px;">${metricCard("Sprint", digest.sprint?.name ?? "No active sprint", digest.sprint ? `${digest.sprint.completed_tasks}/${digest.sprint.total_tasks} • ${digest.sprint.completion_pct}%` : "No sprint window", EMAIL_COLORS.panel, EMAIL_COLORS.stroke, EMAIL_COLORS.muted, EMAIL_COLORS.text)}</td>
              <td width="25%" valign="top" style="padding:6px;">${metricCard("Overdue", String(digest.counts.overdue), "Needs action", EMAIL_COLORS.accentSoft, "rgba(196, 30, 58, 0.28)", EMAIL_COLORS.accentText, EMAIL_COLORS.text)}</td>
              <td width="25%" valign="top" style="padding:6px;">${metricCard("Blocked", String(digest.counts.blocked), "Waiting on others", EMAIL_COLORS.amberSoft, EMAIL_COLORS.amberBorder, EMAIL_COLORS.amberText, EMAIL_COLORS.text)}</td>
              <td width="25%" valign="top" style="padding:6px;">${metricCard("Meetings Left", String(digest.counts.remaining_meetings), "Remaining today", EMAIL_COLORS.blueSoft, EMAIL_COLORS.blueBorder, EMAIL_COLORS.blueText, EMAIL_COLORS.text)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="x-ua-compatible" content="ie=edge" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark" />
    <meta name="supported-color-schemes" content="dark" />
    <title>${escapeHtml(digest.subject)}</title>
  </head>
  <body style="margin:0; padding:0; background-color:${EMAIL_COLORS.page}; font-family:'Avenir Next','Trebuchet MS','Segoe UI',sans-serif; color:${EMAIL_COLORS.text};">
    <div style="display:none; max-height:0; overflow:hidden; opacity:0; mso-hide:all;">
      ${escapeHtml(preheader)}
    </div>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; background-color:${EMAIL_COLORS.page}; margin:0; padding:0;">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" width="680" cellspacing="0" cellpadding="0" border="0" style="width:680px; max-width:680px;">
            <tr>
              <td style="padding:0 0 12px 0; font-size:12px; line-height:18px; color:${EMAIL_COLORS.muted}; text-transform:uppercase; letter-spacing:1px;">
                Mission Control • Daily Brief
              </td>
            </tr>
            <tr>
              <td style="background-color:${EMAIL_COLORS.panel}; border:1px solid ${EMAIL_COLORS.stroke}; border-radius:18px; overflow:hidden;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="background-color:${EMAIL_COLORS.page}; padding:28px 32px 24px 32px; border-bottom:1px solid ${EMAIL_COLORS.stroke}; border-top:3px solid ${EMAIL_COLORS.accent};">
                      <div style="font-size:12px; line-height:18px; color:${EMAIL_COLORS.muted}; text-transform:uppercase; letter-spacing:1px; font-weight:700; margin-bottom:8px;">
                        ${escapeHtml(modeLabel)}
                      </div>
                      <div style="font-size:30px; line-height:36px; color:${EMAIL_COLORS.text}; font-weight:700; margin-bottom:8px;">
                        ${escapeHtml(headline)}
                      </div>
                      <div style="font-size:15px; line-height:24px; color:${EMAIL_COLORS.muted};">
                        ${escapeHtml(headerSubtitle)}
                      </div>
                    </td>
                  </tr>
                </table>

                ${summaryStrip}

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding:28px 32px 12px 32px;">
                      <div style="font-size:20px; line-height:28px; color:${EMAIL_COLORS.text}; font-weight:700; padding-bottom:10px;">
                        Today’s read
                      </div>
                      <div style="font-size:15px; line-height:26px; color:${EMAIL_COLORS.text};">
                        ${escapeHtml(copy.opening_narrative)}
                      </div>
                    </td>
                  </tr>
                </table>

                ${copy.watchout ? `
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding:6px 32px 0 32px;">
                      ${renderWatchoutCard(copy.watchout)}
                    </td>
                  </tr>
                </table>` : ""}

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding:18px 32px 0 32px;">
                      ${renderPriorityTasks(digest)}
                    </td>
                  </tr>
                </table>

                ${digest.mode === "morning" && digest.open_review_items.length > 0 ? `
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding:18px 32px 0 32px;">
                      ${renderOpenReviewItemsCard(digest.open_review_items)}
                    </td>
                  </tr>
                </table>` : ""}

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding:18px 32px 0 32px;">
                      ${renderMeetingsCard(digest.meetings)}
                    </td>
                  </tr>
                </table>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding:18px 32px 0 32px;">
                      ${renderCommitmentsCard(digest)}
                    </td>
                  </tr>
                </table>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding:18px 32px 0 32px;">
                      ${renderGuidanceCard(copy)}
                    </td>
                  </tr>
                </table>

                ${digest.mode === "eod" ? `
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding:18px 32px 0 32px;">
                      ${renderDigestTaskListCard("Tomorrow prep", digest.tasks.tomorrow_prep, "No special tomorrow-prep items surfaced.")}
                    </td>
                  </tr>
                </table>` : ""}

                ${digest.mode === "eod" && digest.status_update_recommendations.length > 0 ? `
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding:18px 32px 0 32px;">
                      ${renderStatusUpdateRecommendationsCard(digest.status_update_recommendations)}
                    </td>
                  </tr>
                </table>` : ""}

                ${digest.tasks.stale_followups.length > 0 ? `
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding:18px 32px 0 32px;">
                      ${renderStaleFollowupsCard(digest)}
                    </td>
                  </tr>
                </table>` : ""}

                ${digest.suggested_sync_today.length > 0 ? `
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding:18px 32px 0 32px;">
                      ${renderSyncCard(digest, syncApprovalText)}
                    </td>
                  </tr>
                </table>` : ""}

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding:22px 32px 28px 32px;">
                      <div style="font-size:12px; line-height:20px; color:${EMAIL_COLORS.muted}; text-align:center;">
                        Generated ${escapeHtml(digest.generatedAt)} • Timezone: ET • Baseline digest-backed summary
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function renderTextTaskItems(items: DailyBriefDigestTaskItem[], emptyMessage: string): string[] {
  if (items.length === 0) {
    return [`- ${emptyMessage}`];
  }

  return items.map((item) => {
    const parts = [
      `${item.title} [${item.id}]`,
      item.due_label,
      item.reason,
      item.context ? `Context: ${item.context}` : null,
      item.recent_update,
    ].filter((value): value is string => Boolean(value));
    return `- ${parts.join(". ")}`;
  });
}

function renderTextMeetingItems(meetings: DailyBriefDigestMeetingItem[]): string[] {
  if (meetings.length === 0) {
    return ["- No remaining meetings today."];
  }

  return meetings.map((meeting) => {
    const parts = [
      `${meeting.time_range_et} - ${meeting.title}`,
      meeting.with_display.length > 0 ? `With ${meeting.with_display.join(", ")}` : null,
      meeting.notes ? `Notes: ${meeting.notes}` : null,
    ].filter((value): value is string => Boolean(value));
    return `- ${parts.join(". ")}`;
  });
}

function renderTextStatusUpdateItems(items: DailyBriefStatusUpdateRecommendation[]): string[] {
  if (items.length === 0) {
    return ["- No status update reminders surfaced."];
  }

  return items.map((item) => {
    const relatedTasks =
      item.related_tasks.length > 0
        ? `Related threads: ${item.related_tasks.map((task) => `${task.title} [${task.id}]`).join("; ")}`
        : null;
    const staleText = item.last_status_artifact_at
      ? `Last status artifact: ${formatEtDateTimeLabel(item.last_status_artifact_at)}`
      : "No current status artifact";
    return `- ${item.entity_type === "project" ? "Project" : "Implementation"}: ${item.entity_name}. ${[item.reason, staleText, relatedTasks].filter((value): value is string => Boolean(value)).join(". ")}`;
  });
}

function renderTextCommitmentGroups(groups: DailyBriefDigestCommitmentGroup[], emptyMessage: string): string[] {
  if (groups.length === 0) {
    return [`- ${emptyMessage}`];
  }

  return groups.map((group) => `- ${group.stakeholder_name}: ${group.commitments.map((item) => item.title).join("; ")}`);
}

function renderBriefText(
  digest: DailyBriefDigestResponse,
  copy: DailyBriefRenderCopy,
  syncApprovalText: string | null
): string {
  const lines: string[] = [
    `${digest.subject}`,
    `${formatDateOnlyLabel(digest.requestedDate)} · Generated ${digest.currentTimeET}`,
    "",
    copy.opening_narrative,
    "",
    `What matters most: ${copy.what_matters_most}`,
  ];

  if (copy.watchout) {
    lines.push("", `Watchout: ${copy.watchout}`);
  }

  lines.push("", `${copy.guidance_title}:`, ...copy.guidance.map((line) => `- ${line}`));

  if (digest.mode === "morning") {
    lines.push("", "Tasks Due Soon:", ...renderTextTaskItems(digest.tasks.due_soon, "No overdue or due-soon tasks."));
    lines.push("", "Blocked:", ...renderTextTaskItems(digest.tasks.blocked, "No blocked work."));
    lines.push("", "In Progress:", ...renderTextTaskItems(digest.tasks.in_progress, "Nothing is marked In Progress."));
    if (digest.open_review_items.length > 0) {
      lines.push(
        "",
        "⚠️ Open Review Items:",
        ...digest.open_review_items.map((item) => `- ${item.artifact_type} — ${item.task_title} [${item.task_id}] — ${item.suggested_action}`)
      );
    }
  } else if (digest.mode === "midday") {
    lines.push("", "Done Today:", ...renderTextTaskItems(digest.tasks.completed_today, "Nothing is marked done today."));
    lines.push("", "Still In Progress:", ...renderTextTaskItems(digest.tasks.in_progress, "Nothing is marked In Progress."));
    lines.push("", "Still Blocked:", ...renderTextTaskItems(digest.tasks.blocked, "No blocked work."));
  } else {
    lines.push("", "Done Today:", ...renderTextTaskItems(digest.tasks.completed_today, "Nothing is marked done today."));
    lines.push("", "Rolls to Tomorrow:", ...renderTextTaskItems(digest.tasks.rolled_to_tomorrow, "No obvious rollover items."));
    lines.push("", "Tomorrow Prep:", ...renderTextTaskItems(digest.tasks.tomorrow_prep, "No special tomorrow-prep items surfaced."));
    if (digest.status_update_recommendations.length > 0) {
      lines.push("", "Status Update Reminders:", ...renderTextStatusUpdateItems(digest.status_update_recommendations));
    }
  }

  lines.push("", digest.mode === "morning" ? "Meetings:" : "Remaining Meetings:", ...renderTextMeetingItems(digest.meetings));
  lines.push("", "Open Commitments (Theirs):", ...renderTextCommitmentGroups(digest.commitments.theirs, "No open commitments owed to you."));
  if (digest.commitments.ours.length > 0) {
    lines.push("", "Open Commitments (Ours):", ...renderTextCommitmentGroups(digest.commitments.ours, "No open commitments owed by you."));
  }
  if (digest.tasks.stale_followups.length > 0) {
    lines.push("", "Stale Follow-ups:", ...renderTextTaskItems(digest.tasks.stale_followups, ""));
  }
  if (digest.suggested_sync_today.length > 0) {
    lines.push(
      "",
      "Suggested sync_today (recommendation only):",
      ...digest.suggested_sync_today.map((item) => `- ${item.action.toUpperCase()} ${item.title} [${item.task_id}] - ${item.reason}`)
    );
  }

  if (syncApprovalText) {
    lines.push("", "Copy/paste into chat:", ...syncApprovalText.split("\n"));
  }

  lines.push(
    "",
    `Signals: overloaded=${digest.signals.is_day_overloaded ? "yes" : "no"}, top_risk=${digest.signals.top_risk ?? "none"}, waiting_on_others=${digest.signals.waiting_on_others_count}, momentum=${digest.signals.momentum_score}, meeting_heavy_afternoon=${digest.signals.meeting_heavy_afternoon ? "yes" : "no"}`
  );

  return lines.join("\n");
}

export async function renderDailyBrief(
  supabase: SupabaseClient,
  userId: string,
  digest: DailyBriefDigestResponse
): Promise<DailyBriefRenderResponse> {
  const { copy, llm } = await generateChiefOfStaffCopy(supabase, userId, digest);
  const modeLabel = getModeLabel(digest.mode);
  const preheader = buildPreheader(digest, copy);
  const syncApprovalText = buildSyncApprovalText(digest);

  return {
    requestedDate: digest.requestedDate,
    mode: digest.mode,
    modeLabel,
    generatedAt: new Date().toISOString(),
    subject: digest.subject,
    preheader,
    syncApprovalText,
    html: renderBriefHtml(digest, copy, preheader, syncApprovalText),
    text: renderBriefText(digest, copy, syncApprovalText),
    digest,
    copy,
    llm,
  };
}
