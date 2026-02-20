import type { SupabaseClient } from "@supabase/supabase-js";
import { generateTextWithLlm } from "@/lib/llm";
import { LlmExtraction, TaskType } from "@/types/database";

// LLM Extraction service for processing Action Intake emails

interface ExtractionInput {
  supabase: SupabaseClient;
  userId: string;
  subject: string;
  from_name: string | null;
  from_email: string | null;
  received_at: string;
  body_snippet: string; // Transient, not stored
  implementation_names: string[];
  implementation_keywords: Record<string, string[]>;
}

interface ExtractionResult {
  extraction: LlmExtraction;
  model: string;
  confidence: number;
}

// Default time estimates by task type
export const DEFAULT_ESTIMATES: Record<TaskType, number> = {
  Task: 30,
  Ticket: 30,
  MeetingPrep: 60,
  FollowUp: 30,
  Admin: 15,
  Build: 90,
};

// System prompt for LLM extraction (from spec Section 12)
const SYSTEM_PROMPT = `You are extracting task metadata from an Action Intake email for a personal work dashboard.

ENTERPRISE-SAFETY RULES:
- Do NOT copy/paste or quote the email body.
- Output must be paraphrased and minimal.
- Extract only metadata: actions, checklist steps, IDs/URLs, due hints, stakeholders.
- If unsure, set confidence low and set needs_review=true.

EMAIL PARSING RULES:
- Emails may be FORWARDED. Look for "From:", "Sent:", or "---Original Message---" in the body to find the ORIGINAL sender.
- If subject starts with "Fw:" or "Fwd:", parse the original subject from the forwarded content.
- Ignore email signatures, confidentiality disclaimers, and boilerplate footers.

SERVICENOW TICKET RULES:
- Extract the ticket ID (e.g., IMS0101522, INC0012345).
- Use the "Short description:" field as the BASIS for the title, NOT the subject line.
- Title format: "[TICKET_ID] Short description summary" (e.g., "IMS0101522: Reset Epic login for Dr. Martinez")
- The "Opened for:" field contains the requester - add them to stakeholder_mentions.
- Generate checklist items SPECIFIC to the ticket's short description (e.g., for a login issue: "Verify user account status", "Reset credentials", "Confirm access restored").
- If short description says "validation" or "test", set task_type to Admin and priority_score to 20 or lower.

TASK TYPE HINTS:
- ServiceNow Interactions/Incidents → Ticket (unless it's validation/test → Admin)
- "Please review" or approval requests → Task
- Calendar invites or meeting prep → MeetingPrep
- "Following up" or reminders → FollowUp
- Routine admin (close ticket, validation) → Admin with LOW priority (20 or less)

Return ONLY valid JSON with this exact schema:
{
  "title": "string (for tickets: '[ID]: brief description from Short description field', for others: verb phrase)",
  "suggested_checklist": ["string array - SPECIFIC action items based on the actual request, not generic steps"],
  "task_type": "Task|Ticket|MeetingPrep|FollowUp|Admin|Build",
  "estimated_minutes": 15|30|60|90|120,
  "due_guess_iso": "YYYY-MM-DD or null",
  "due_confidence": 0.0-1.0,
  "implementation_guess": "string or null",
  "implementation_confidence": 0.0-1.0,
  "stakeholder_mentions": ["string array - include original sender and any mentioned people"],
  "priority_score": 0-100,
  "needs_review": true|false,
  "blocker": true|false,
  "waiting_on": "string or null"
}`;

/**
 * Build the extraction prompt for the LLM
 */
function buildExtractionPrompt(input: ExtractionInput): string {
  const keywordsText = Object.entries(input.implementation_keywords)
    .map(([name, keywords]) => `${name}: ${keywords.join(", ")}`)
    .join("\n");

  return `INPUT:
Subject: ${input.subject}
From: ${input.from_name || "Unknown"} <${input.from_email || "unknown"}>
Received: ${input.received_at}
Body snippet (transient, do not quote): ${input.body_snippet.slice(0, 2000)}

Known implementations: ${input.implementation_names.join(", ") || "None"}
Known keywords per implementation:
${keywordsText || "None"}`;
}

/**
 * Parse LLM response into structured extraction
 */
function parseExtractionResponse(responseText: string): LlmExtraction {
  // Try to extract JSON from the response
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON found in response");
  }

  const parsed = JSON.parse(jsonMatch[0]);

  // Validate and normalize the response
  const taskType = ["Task", "Ticket", "MeetingPrep", "FollowUp", "Admin", "Build"].includes(parsed.task_type)
    ? parsed.task_type
    : "Admin";

  return {
    title: String(parsed.title || "Untitled task"),
    suggested_tasks: Array.isArray(parsed.suggested_tasks)
      ? parsed.suggested_tasks.map(String)
      : [],
    suggested_checklist: Array.isArray(parsed.suggested_checklist)
      ? parsed.suggested_checklist.map(String)
      : [],
    task_type: taskType as TaskType,
    estimated_minutes: [15, 30, 60, 90, 120].includes(parsed.estimated_minutes)
      ? parsed.estimated_minutes
      : DEFAULT_ESTIMATES[taskType as TaskType],
    due_guess_iso: parsed.due_guess_iso || null,
    due_confidence: Math.min(1, Math.max(0, Number(parsed.due_confidence) || 0)),
    implementation_guess: parsed.implementation_guess || null,
    implementation_confidence: Math.min(1, Math.max(0, Number(parsed.implementation_confidence) || 0)),
    stakeholder_mentions: Array.isArray(parsed.stakeholder_mentions)
      ? parsed.stakeholder_mentions.map(String)
      : [],
    priority_score: Math.min(100, Math.max(0, Number(parsed.priority_score) || 50)),
    needs_review: Boolean(parsed.needs_review),
    blocker: Boolean(parsed.blocker),
    waiting_on: parsed.waiting_on || null,
  };
}

/**
 * Main extraction function - uses the shared LLM provider layer with per-user model selection
 */
export async function extractTaskMetadata(input: ExtractionInput): Promise<ExtractionResult> {
  try {
    const generation = await generateTextWithLlm({
      supabase: input.supabase,
      userId: input.userId,
      feature: "intake_extraction",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildExtractionPrompt(input),
      temperature: 0.3,
      maxTokens: 1000,
      timeoutMs: 9000,
    });

    if (generation.text && generation.runMeta) {
      const extraction = parseExtractionResponse(generation.text);

      const confidence = Math.min(
        extraction.due_confidence > 0 ? extraction.due_confidence : 1,
        extraction.implementation_confidence > 0 ? extraction.implementation_confidence : 1
      );

      return {
        extraction,
        model: generation.runMeta.modelId,
        confidence: extraction.needs_review ? Math.min(confidence, 0.5) : confidence,
      };
    }
  } catch (error) {
    console.error("LLM extraction failed:", error);
  }

  // Fallback: Create basic extraction from subject line
  console.warn("No LLM extraction output available, using fallback extraction");
  return createFallbackExtraction(input);
}

/**
 * Fallback extraction when no LLM is available
 */
function createFallbackExtraction(input: ExtractionInput): ExtractionResult {
  const subject = input.subject;

  // Try to guess task type from subject
  let taskType: TaskType = "Admin";
  if (/ticket|incident|issue|bug/i.test(subject)) {
    taskType = "Ticket";
  } else if (/meeting|agenda|review|call/i.test(subject)) {
    taskType = "MeetingPrep";
  } else if (/follow.?up|reminder|checking/i.test(subject)) {
    taskType = "FollowUp";
  } else if (/build|develop|implement|create/i.test(subject)) {
    taskType = "Build";
  }

  // Try to match implementation from keywords
  const implementationGuess: string | null = null;
  const implementationConfidence = 0;

  // Check stakeholder mentions
  const stakeholders: string[] = [];
  if (/nancy/i.test(subject) || /nancy/i.test(input.body_snippet)) {
    stakeholders.push("Nancy");
  }
  if (/heath/i.test(subject) || /heath/i.test(input.body_snippet)) {
    stakeholders.push("Heath");
  }

  return {
    extraction: {
      title: subject,
      suggested_tasks: [],
      suggested_checklist: [],
      task_type: taskType,
      estimated_minutes: DEFAULT_ESTIMATES[taskType],
      due_guess_iso: null,
      due_confidence: 0,
      implementation_guess: implementationGuess,
      implementation_confidence: implementationConfidence,
      stakeholder_mentions: stakeholders,
      priority_score: 50,
      needs_review: true, // Always needs review for fallback
      blocker: false,
      waiting_on: null,
    },
    model: "fallback",
    confidence: 0.3,
  };
}

export { buildExtractionPrompt, parseExtractionResponse };
