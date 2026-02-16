import { NextRequest, NextResponse } from 'next/server';
import { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { extractTaskMetadata } from '@/lib/extraction';
import {
  calculatePriorityBoosts,
  calculateFinalPriorityScore,
} from '@/lib/priority';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

interface EmailIntakePayload {
  subject: string;
  from_email: string;
  received_at: string;

  from_name?: string;
  message_id?: string;
  source_url?: string;
  body_snippet?: string;
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
export async function POST(request: NextRequest) {
  const auth = await requireAuthenticatedRoute(request);
  if (auth.response || !auth.context) {
    return auth.response as NextResponse;
  }

  const { supabase, userId } = auth.context;
  let inboxItemId: string | null = null;

  try {
    const payload = (await request.json()) as EmailIntakePayload;

    if (!payload.subject || !payload.from_email || !payload.received_at) {
      return NextResponse.json(
        { error: 'Missing required fields: subject, from_email, received_at' },
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
      const { data: impl } = await supabase
        .from('implementations')
        .select('id')
        .eq('user_id', userId)
        .ilike('name', `%${extraction.implementation_guess}%`)
        .single();

      implementationId = impl?.id || null;
    }

    const boosts = calculatePriorityBoosts(
      extraction.stakeholder_mentions,
      extraction.due_guess_iso,
      extraction.title,
      'Next'
    );
    const finalPriority = calculateFinalPriorityScore(extraction.priority_score, boosts);

    const { data: task, error: taskError } = await supabase
      .from('tasks')
      .insert({
        user_id: userId,
        title: extraction.title,
        implementation_id: implementationId,
        status: 'Next',
        task_type: extraction.task_type,
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
