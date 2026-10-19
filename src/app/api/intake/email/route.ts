import { NextRequest, NextResponse } from 'next/server';
import { SupabaseClient, createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { extractTaskMetadata } from '@/lib/extraction';
import {
  calculatePriorityBoosts,
  calculateFinalPriorityScore,
  getHighPriorityStakeholderNames,
} from '@/lib/priority';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

// API key authentication for n8n/external integrations
function validateApiKey(request: NextRequest): { valid: boolean; userId: string | null } {
  const apiKey = request.headers.get('x-api-key');
  const expectedKey = process.env.N8N_INTAKE_API_KEY;
  const defaultUserId = process.env.DEFAULT_USER_ID;

  if (!apiKey || !expectedKey) {
    return { valid: false, userId: null };
  }

  // Constant-time comparison to prevent timing attacks
  if (apiKey.length !== expectedKey.length) {
    return { valid: false, userId: null };
  }

  let mismatch = 0;
  for (let i = 0; i < apiKey.length; i++) {
    mismatch |= apiKey.charCodeAt(i) ^ expectedKey.charCodeAt(i);
  }

  if (mismatch !== 0) {
    return { valid: false, userId: null };
  }

  return { valid: true, userId: defaultUserId || null };
}

function createServiceClient(): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(supabaseUrl, serviceRoleKey);
}

interface EmailIntakePayload {
  subject: string;
  from_email: string;
  received_at: string;

  from_name?: string;
  message_id?: string;
  source_url?: string;
  body_snippet?: string;
  mode?: unknown;
}

// Opt-in "inbox only" mode (mode: "inbox_only"): store the inbox row with the
// trimmed excerpt so it can be triaged later, and skip the AI extraction and the
// task. Leaving `mode` out keeps the original behaviour (extraction + task).
type IntakeMode = 'default' | 'inbox_only';
const INBOX_ONLY_EXCERPT_MAX_CHARS = 2000;

function parseIntakeMode(value: unknown): IntakeMode | null {
  if (value === undefined) return 'default';
  if (value === 'inbox_only') return 'inbox_only';
  return null;
}

// Cut to at most INBOX_ONLY_EXCERPT_MAX_CHARS characters (whole code points) and
// drop what Postgres JSON cannot store (NUL; lone surrogates become U+FFFD), so a
// malformed excerpt can never make the insert fail on every retry.
function prepareInboxOnlyExcerpt(value: string | undefined | null): { text: string | null; truncated: boolean } {
  if (value === undefined || value === null) return { text: null, truncated: false };
  const cleaned = value
    .replace(/\u0000/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
  const chars = Array.from(cleaned);
  if (chars.length <= INBOX_ONLY_EXCERPT_MAX_CHARS) return { text: cleaned, truncated: false };
  return { text: chars.slice(0, INBOX_ONLY_EXCERPT_MAX_CHARS).join(''), truncated: true };
}

function generateDedupeKey(payload: EmailIntakePayload, userId: string): string {
  if (payload.message_id) {
    return createHash('sha256').update(`${userId}|${payload.message_id}`).digest('hex');
  }

  const key = `${userId}|${payload.subject}|${payload.from_email}|${payload.received_at}`;
  return createHash('sha256').update(key).digest('hex');
}

async function logIngestionEvent(
  supabase: SupabaseClient,
  userId: string,
  inboxItemId: string | null,
  stage: string,
  ok: boolean,
  detail?: string
) {
  try {
    await supabase.from('ingestion_events').insert({
      user_id: userId,
      inbox_item_id: inboxItemId,
      stage,
      ok,
      detail,
    });
  } catch (error) {
    console.error('Failed to log ingestion event:', error);
  }
}

// POST /api/intake/email - Process incoming Action Intake email
// Supports two auth methods:
// 1. Supabase session (browser auth)
// 2. X-API-Key header (n8n/external integrations)
export async function POST(request: NextRequest) {
  let supabase: SupabaseClient;
  let userId: string;

  // Try session auth first
  const auth = await requireAuthenticatedRoute(request);
  if (auth.context) {
    supabase = auth.context.supabase;
    userId = auth.context.userId;
  } else {
    // Fall back to API key auth for n8n
    const apiKeyAuth = validateApiKey(request);
    if (!apiKeyAuth.valid || !apiKeyAuth.userId) {
      return NextResponse.json(
        { error: 'Authentication required. Provide session cookie or X-API-Key header.' },
        { status: 401 }
      );
    }
    supabase = createServiceClient();
    userId = apiKeyAuth.userId;
  }

  let inboxItemId: string | null = null;

  try {
    const payload = (await request.json()) as EmailIntakePayload;

    if (!payload.subject || !payload.from_email || !payload.received_at) {
      return NextResponse.json(
        { error: 'Missing required fields: subject, from_email, received_at' },
        { status: 400 }
      );
    }

    const mode = parseIntakeMode(payload.mode);
    if (!mode) {
      return NextResponse.json(
        { error: 'Invalid mode. Leave it out, or send "inbox_only".' },
        { status: 400 }
      );
    }

    if (
      mode === 'inbox_only'
      && payload.body_snippet !== undefined
      && payload.body_snippet !== null
      && typeof payload.body_snippet !== 'string'
    ) {
      return NextResponse.json(
        { error: 'body_snippet must be a string' },
        { status: 400 }
      );
    }

    const dedupeKey = generateDedupeKey(payload, userId);

    const { data: existing, error: existingError } = await supabase
      .from('inbox_items')
      .select('id')
      .eq('user_id', userId)
      .eq('dedupe_key', dedupeKey)
      .maybeSingle();

    if (existingError) {
      throw existingError;
    }

    if (existing) {
      await logIngestionEvent(supabase, userId, existing.id, 'deduped', true, 'Duplicate email ignored');
      return NextResponse.json(
        { message: 'Duplicate email, already processed', inbox_item_id: existing.id },
        { status: 200 }
      );
    }

    if (mode === 'inbox_only') {
      const excerpt = prepareInboxOnlyExcerpt(payload.body_snippet);
      const { data: storedItem, error: storeError } = await supabase
        .from('inbox_items')
        .insert({
          user_id: userId,
          received_at: payload.received_at,
          from_name: payload.from_name || null,
          from_email: payload.from_email,
          subject: payload.subject,
          source: 'ActionIntakeEmail',
          source_message_id: payload.message_id || null,
          source_url: payload.source_url || null,
          dedupe_key: dedupeKey,
          triage_state: 'New',
          extraction_version: 1,
          // inbox_items has no body column; this mode keeps the excerpt in the
          // row's JSON field, marked so readers can tell it from an AI extraction.
          llm_extraction_json: {
            intake_mode: 'inbox_only',
            body_snippet: excerpt.text,
            body_snippet_truncated: excerpt.truncated,
          },
        })
        .select()
        .single();

      if (storeError || !storedItem) {
        throw new Error(`Failed to create inbox_item: ${storeError?.message}`);
      }

      inboxItemId = storedItem.id;
      await logIngestionEvent(supabase, userId, inboxItemId, 'received', true, 'Inbox only: no extraction, no task');

      return NextResponse.json(
        { success: true, mode: 'inbox_only', inbox_item_id: inboxItemId, task_id: null },
        { status: 201 }
      );
    }

    const { data: inboxItem, error: insertError } = await supabase
      .from('inbox_items')
      .insert({
        user_id: userId,
        received_at: payload.received_at,
        from_name: payload.from_name || null,
        from_email: payload.from_email,
        subject: payload.subject,
        source: 'ActionIntakeEmail',
        source_message_id: payload.message_id || null,
        source_url: payload.source_url || null,
        dedupe_key: dedupeKey,
        triage_state: 'New',
        extraction_version: 1,
      })
      .select()
      .single();

    if (insertError || !inboxItem) {
      throw new Error(`Failed to create inbox_item: ${insertError?.message}`);
    }

    inboxItemId = inboxItem.id;
    await logIngestionEvent(supabase, userId, inboxItemId, 'received', true);

    const { data: implementations } = await supabase
      .from('implementations')
      .select('name, keywords')
      .eq('user_id', userId);

    const implementationNames = implementations?.map((i) => i.name) || [];
    const implementationKeywords: Record<string, string[]> = {};
    implementations?.forEach((i) => {
      implementationKeywords[i.name] = i.keywords || [];
    });

    let extractionResult;
    try {
      extractionResult = await extractTaskMetadata({
        supabase,
        userId,
        subject: payload.subject,
        from_name: payload.from_name || null,
        from_email: payload.from_email,
        received_at: payload.received_at,
        body_snippet: payload.body_snippet || '',
        implementation_names: implementationNames,
        implementation_keywords: implementationKeywords,
      });

      await logIngestionEvent(supabase, userId, inboxItemId, 'extracted', true, `Model: ${extractionResult.model}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await logIngestionEvent(supabase, userId, inboxItemId, 'extracted', false, errorMessage);

      await supabase
        .from('inbox_items')
        .update({ processing_error: errorMessage })
        .eq('id', inboxItemId);

      return NextResponse.json(
        { error: 'Extraction failed', detail: errorMessage, inbox_item_id: inboxItemId },
        { status: 500 }
      );
    }

    const { extraction, model, confidence } = extractionResult;

    await supabase
      .from('inbox_items')
      .update({
        llm_extraction_json: extraction,
        extraction_model: model,
        extraction_confidence: confidence,
        triage_state: 'Processed',
      })
      .eq('id', inboxItemId);

    let implementationId: string | null = null;
    if (extraction.implementation_guess && extraction.implementation_confidence >= 0.7) {
      // First try exact match
      let { data: impl } = await supabase
        .from('implementations')
        .select('id, name')
        .eq('user_id', userId)
        .ilike('name', `%${extraction.implementation_guess}%`)
        .maybeSingle();

      // If no match, try reverse: check if guess contains any implementation name
      if (!impl) {
        const { data: allImpls } = await supabase
          .from('implementations')
          .select('id, name')
          .eq('user_id', userId);

        const guessLower = extraction.implementation_guess.toLowerCase();
        impl = allImpls?.find((i) => guessLower.includes(i.name.toLowerCase())) || null;
      }

      implementationId = impl?.id || null;
    }

    const highPriorityStakeholderNames = await getHighPriorityStakeholderNames(supabase, userId);
    const boosts = calculatePriorityBoosts(
      extraction.stakeholder_mentions,
      extraction.due_guess_iso,
      extraction.title,
      'Backlog',
      highPriorityStakeholderNames
    );
    const finalPriority = calculateFinalPriorityScore(extraction.priority_score, boosts);

    const { data: task, error: taskError } = await supabase
      .from('tasks')
      .insert({
        user_id: userId,
        title: extraction.title,
        implementation_id: implementationId,
        status: 'Backlog',
        task_type: extraction.task_type,
        base_priority: Math.max(0, Math.min(100, Math.round(extraction.priority_score))),
        priority_score: finalPriority,
        estimated_minutes: extraction.estimated_minutes,
        estimate_source: 'llm',
        due_at: extraction.due_guess_iso || null,
        needs_review: extraction.needs_review || confidence < 0.7,
        blocker: extraction.blocker,
        waiting_on: extraction.waiting_on,
        stakeholder_mentions: extraction.stakeholder_mentions,
        source_type: 'Email',
        source_url: payload.source_url || null,
        inbox_item_id: inboxItemId,
      })
      .select()
      .single();

    if (taskError || !task) {
      throw new Error(`Failed to create task: ${taskError?.message}`);
    }

    await logIngestionEvent(supabase, userId, inboxItemId, 'task_created', true, `Task ID: ${task.id}`);

    if (extraction.suggested_checklist.length > 0) {
      const checklistItems = extraction.suggested_checklist.map((text: string, index: number) => ({
        user_id: userId,
        task_id: task.id,
        text,
        is_done: false,
        sort_order: index,
      }));

      const { error: checklistError } = await supabase
        .from('task_checklist_items')
        .insert(checklistItems);

      if (checklistError) {
        console.error('Failed to create checklist items:', checklistError);
      }
    }

    return NextResponse.json({
      success: true,
      inbox_item_id: inboxItemId,
      task_id: task.id,
      needs_review: task.needs_review,
      extraction: {
        title: extraction.title,
        task_type: extraction.task_type,
        estimated_minutes: extraction.estimated_minutes,
        priority_score: finalPriority,
        implementation_guess: extraction.implementation_guess,
        confidence,
      },
    });
  } catch (error) {
    console.error('Email intake error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (inboxItemId) {
      await logIngestionEvent(supabase, userId, inboxItemId, 'error', false, errorMessage);
    }

    return NextResponse.json({ error: 'Internal server error', detail: errorMessage }, { status: 500 });
  }
}
