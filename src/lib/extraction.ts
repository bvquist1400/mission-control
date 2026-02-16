import { LlmExtraction, TaskType } from '@/types/database';

// LLM Extraction service for processing Action Intake emails
// Supports OpenAI and Anthropic APIs

interface ExtractionInput {
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
const DEFAULT_ESTIMATES: Record<TaskType, number> = {
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

Return ONLY valid JSON with this exact schema:
{
  "title": "string (verb phrase, e.g., 'Review module design for X')",
  "suggested_checklist": ["string array of action items"],
  "task_type": "Ticket|MeetingPrep|FollowUp|Admin|Build",
  "estimated_minutes": 15|30|60|90|120,
  "due_guess_iso": "YYYY-MM-DD or null",
  "due_confidence": 0.0-1.0,
  "implementation_guess": "string or null",
  "implementation_confidence": 0.0-1.0,
  "stakeholder_mentions": ["string array"],
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
    .map(([name, keywords]) => `${name}: ${keywords.join(', ')}`)
    .join('\n');

  return `INPUT:
Subject: ${input.subject}
From: ${input.from_name || 'Unknown'} <${input.from_email || 'unknown'}>
Received: ${input.received_at}
Body snippet (transient, do not quote): ${input.body_snippet.slice(0, 500)}

Known implementations: ${input.implementation_names.join(', ') || 'None'}
Known keywords per implementation:
${keywordsText || 'None'}`;
}

/**
 * Parse LLM response into structured extraction
 */
function parseExtractionResponse(responseText: string): LlmExtraction {
  // Try to extract JSON from the response
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in response');
  }

  const parsed = JSON.parse(jsonMatch[0]);

  // Validate and normalize the response
  const taskType = ['Ticket', 'MeetingPrep', 'FollowUp', 'Admin', 'Build'].includes(parsed.task_type)
    ? parsed.task_type
    : 'Admin';

  return {
    title: String(parsed.title || 'Untitled task'),
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
 * Extract task metadata using OpenAI API
 */
async function extractWithOpenAI(input: ExtractionInput): Promise<ExtractionResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildExtractionPrompt(input) },
      ],
      temperature: 0.3,
      max_tokens: 1000,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${error}`);
  }

  const data = await response.json();
  const content = data.choices[0]?.message?.content;

  if (!content) {
    throw new Error('No content in OpenAI response');
  }

  const extraction = parseExtractionResponse(content);

  // Calculate overall confidence based on individual confidences
  const confidence = Math.min(
    extraction.due_confidence > 0 ? extraction.due_confidence : 1,
    extraction.implementation_confidence > 0 ? extraction.implementation_confidence : 1
  );

  return {
    extraction,
    model: 'gpt-4o-mini',
    confidence: extraction.needs_review ? Math.min(confidence, 0.5) : confidence,
  };
}

/**
 * Extract task metadata using Anthropic API
 */
async function extractWithAnthropic(input: ExtractionInput): Promise<ExtractionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-haiku-20240307',
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildExtractionPrompt(input) }],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error: ${error}`);
  }

  const data = await response.json();
  const content = data.content[0]?.text;

  if (!content) {
    throw new Error('No content in Anthropic response');
  }

  const extraction = parseExtractionResponse(content);

  const confidence = Math.min(
    extraction.due_confidence > 0 ? extraction.due_confidence : 1,
    extraction.implementation_confidence > 0 ? extraction.implementation_confidence : 1
  );

  return {
    extraction,
    model: 'claude-3-haiku-20240307',
    confidence: extraction.needs_review ? Math.min(confidence, 0.5) : confidence,
  };
}

/**
 * Main extraction function - tries available providers
 */
export async function extractTaskMetadata(input: ExtractionInput): Promise<ExtractionResult> {
  // Try OpenAI first, fall back to Anthropic
  if (process.env.OPENAI_API_KEY) {
    try {
      return await extractWithOpenAI(input);
    } catch (error) {
      console.error('OpenAI extraction failed:', error);
    }
  }

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await extractWithAnthropic(input);
    } catch (error) {
      console.error('Anthropic extraction failed:', error);
    }
  }

  // Fallback: Create basic extraction from subject line
  console.warn('No LLM API available, using fallback extraction');
  return createFallbackExtraction(input);
}

/**
 * Fallback extraction when no LLM is available
 */
function createFallbackExtraction(input: ExtractionInput): ExtractionResult {
  const subject = input.subject;

  // Try to guess task type from subject
  let taskType: TaskType = 'Admin';
  if (/ticket|incident|issue|bug/i.test(subject)) {
    taskType = 'Ticket';
  } else if (/meeting|agenda|review|call/i.test(subject)) {
    taskType = 'MeetingPrep';
  } else if (/follow.?up|reminder|checking/i.test(subject)) {
    taskType = 'FollowUp';
  } else if (/build|develop|implement|create/i.test(subject)) {
    taskType = 'Build';
  }

  // Try to match implementation from keywords
  const implementationGuess: string | null = null;
  const implementationConfidence = 0;

  // Check stakeholder mentions
  const stakeholders: string[] = [];
  if (/nancy/i.test(subject) || /nancy/i.test(input.body_snippet)) {
    stakeholders.push('Nancy');
  }
  if (/heath/i.test(subject) || /heath/i.test(input.body_snippet)) {
    stakeholders.push('Heath');
  }

  return {
    extraction: {
      title: subject,
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
    model: 'fallback',
    confidence: 0.3,
  };
}

export { buildExtractionPrompt, parseExtractionResponse };
