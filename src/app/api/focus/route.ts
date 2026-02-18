import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  asTrimmedStringOrNull,
  FOCUS_DIRECTIVE_SELECT,
  isDirectiveCurrentlyActive,
  isMissingRelationError,
  isValidDirectiveScopeType,
  isValidDirectiveStrength,
  parseOptionalIsoTimestamp,
  parseTimestampMs,
  type DirectiveScopeType,
  type DirectiveStrength,
  type FocusDirectiveRow,
} from '@/lib/focus-directives';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

interface FocusCreateBody {
  text?: unknown;
  scope_type?: unknown;
  scope_id?: unknown;
  scope_value?: unknown;
  strength?: unknown;
  starts_at?: unknown;
  ends_at?: unknown;
  reason?: unknown;
  is_active?: unknown;
}

interface ParseBooleanResult {
  value: boolean | undefined;
  error: string | null;
}

function parseOptionalBoolean(value: unknown, fieldName: string): ParseBooleanResult {
  if (value === undefined) {
    return { value: undefined, error: null };
  }

  if (typeof value !== 'boolean') {
    return { value: undefined, error: `${fieldName} must be true or false` };
  }

  return { value, error: null };
}

function parseOptionalNullableText(
  value: unknown,
  fieldName: string
): { value: string | null | undefined; error: string | null } {
  if (value === undefined) {
    return { value: undefined, error: null };
  }

  if (value === null) {
    return { value: null, error: null };
  }

  if (typeof value !== 'string') {
    return { value: undefined, error: `${fieldName} must be a string or null` };
  }

  return { value: asTrimmedStringOrNull(value), error: null };
}

function parseRequiredText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function ensureImplementationOwnership(
  supabase: SupabaseClient,
  userId: string,
  implementationId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('implementations')
    .select('id')
    .eq('id', implementationId)
    .eq('user_id', userId)
    .single();

  return !error && Boolean(data?.id);
}

async function fetchActiveDirective(
  supabase: SupabaseClient,
  userId: string,
  nowMs: number
): Promise<{ active: FocusDirectiveRow | null; fallbackNote?: string }> {
  const activeResult = await supabase
    .from('focus_directives')
    .select(FOCUS_DIRECTIVE_SELECT)
    .eq('created_by', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(5);

  if (activeResult.error) {
    if (isMissingRelationError(activeResult.error)) {
      return { active: null, fallbackNote: 'focus_directives table not found' };
    }
    throw activeResult.error;
  }

  const active = ((activeResult.data || []) as FocusDirectiveRow[]).find((directive) =>
    isDirectiveCurrentlyActive(directive, nowMs)
  );
  return { active: active ?? null };
}

async function clearOtherActiveDirectives(
  supabase: SupabaseClient,
  userId: string,
  endedAtIso: string
): Promise<{ fallbackNote?: string }> {
  const clearResult = await supabase
    .from('focus_directives')
    .update({ is_active: false, ends_at: endedAtIso })
    .eq('created_by', userId)
    .eq('is_active', true);

  if (clearResult.error) {
    if (isMissingRelationError(clearResult.error)) {
      return { fallbackNote: 'focus_directives table not found' };
    }
    throw clearResult.error;
  }

  return {};
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { searchParams } = new URL(request.url);
    const includeHistory = searchParams.get('include_history') === 'true';
    const nowMs = Date.now();

    const activeDirectiveResult = await fetchActiveDirective(supabase, userId, nowMs);
    if (!includeHistory) {
      return NextResponse.json({
        active: activeDirectiveResult.active,
        note: activeDirectiveResult.fallbackNote,
      });
    }

    const listResult = await supabase
      .from('focus_directives')
      .select(FOCUS_DIRECTIVE_SELECT)
      .eq('created_by', userId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (listResult.error) {
      if (isMissingRelationError(listResult.error)) {
        return NextResponse.json({
          active: null,
          directives: [],
          note: 'focus_directives table not found',
        });
      }
      throw listResult.error;
    }

    return NextResponse.json({
      active: activeDirectiveResult.active,
      directives: (listResult.data || []) as FocusDirectiveRow[],
      note: activeDirectiveResult.fallbackNote,
    });
  } catch (error) {
    console.error('Error fetching focus directives:', error);
    return NextResponse.json({ error: 'Failed to fetch focus directives' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;

    let body: FocusCreateBody = {};
    try {
      body = (await request.json()) as FocusCreateBody;
    } catch {
      body = {};
    }

    const text = parseRequiredText(body.text);
    if (!text) {
      return NextResponse.json({ error: 'text is required' }, { status: 400 });
    }

    if (typeof body.scope_type !== 'string' || !isValidDirectiveScopeType(body.scope_type)) {
      return NextResponse.json(
        { error: 'scope_type must be one of: implementation, stakeholder, task_type, query' },
        { status: 400 }
      );
    }

    const scopeType: DirectiveScopeType = body.scope_type;
    const scopeId = asTrimmedStringOrNull(body.scope_id);
    const scopeValue = asTrimmedStringOrNull(body.scope_value);

    let strength: DirectiveStrength = 'strong';
    if (body.strength !== undefined) {
      if (typeof body.strength !== 'string' || !isValidDirectiveStrength(body.strength)) {
        return NextResponse.json(
          { error: 'strength must be one of: nudge, strong, hard' },
          { status: 400 }
        );
      }
      strength = body.strength;
    }

    const isActiveParsed = parseOptionalBoolean(body.is_active, 'is_active');
    if (isActiveParsed.error) {
      return NextResponse.json({ error: isActiveParsed.error }, { status: 400 });
    }
    const isActive = isActiveParsed.value ?? true;

    const startsAtParsed = parseOptionalIsoTimestamp(body.starts_at, 'starts_at');
    if (startsAtParsed.error) {
      return NextResponse.json({ error: startsAtParsed.error }, { status: 400 });
    }

    const endsAtParsed = parseOptionalIsoTimestamp(body.ends_at, 'ends_at');
    if (endsAtParsed.error) {
      return NextResponse.json({ error: endsAtParsed.error }, { status: 400 });
    }

    const reasonParsed = parseOptionalNullableText(body.reason, 'reason');
    if (reasonParsed.error) {
      return NextResponse.json({ error: reasonParsed.error }, { status: 400 });
    }

    let normalizedScopeId: string | null = null;
    let normalizedScopeValue: string | null = null;

    if (scopeType === 'implementation') {
      if (!scopeId) {
        return NextResponse.json({ error: 'scope_id is required for application scope' }, { status: 400 });
      }

      const implementationOwned = await ensureImplementationOwnership(supabase, userId, scopeId);
      if (!implementationOwned) {
        return NextResponse.json({ error: 'scope_id must reference one of your applications' }, { status: 400 });
      }

      normalizedScopeId = scopeId;
      normalizedScopeValue = null;
    } else {
      if (!scopeValue) {
        return NextResponse.json(
          { error: 'scope_value is required for stakeholder, task_type, and query scopes' },
          { status: 400 }
        );
      }
      normalizedScopeId = null;
      normalizedScopeValue = scopeValue;
    }

    const startsAtMs = parseTimestampMs(startsAtParsed.value ?? null);
    const endsAtMs = parseTimestampMs(endsAtParsed.value ?? null);
    if (startsAtMs !== null && endsAtMs !== null && endsAtMs <= startsAtMs) {
      return NextResponse.json({ error: 'ends_at must be after starts_at' }, { status: 400 });
    }

    const nowIso = new Date().toISOString();
    if (isActive) {
      const clearActiveResult = await clearOtherActiveDirectives(supabase, userId, nowIso);
      if (clearActiveResult.fallbackNote) {
        return NextResponse.json({
          created: false,
          directive: null,
          active: null,
          note: clearActiveResult.fallbackNote,
        });
      }
    }

    const insertPayload: Record<string, unknown> = {
      created_by: userId,
      is_active: isActive,
      text,
      scope_type: scopeType,
      scope_id: normalizedScopeId,
      scope_value: normalizedScopeValue,
      strength,
    };

    if (startsAtParsed.value !== undefined) {
      insertPayload.starts_at = startsAtParsed.value;
    }

    if (endsAtParsed.value !== undefined) {
      insertPayload.ends_at = endsAtParsed.value;
    }

    if (reasonParsed.value !== undefined) {
      insertPayload.reason = reasonParsed.value;
    }

    const createdResult = await supabase
      .from('focus_directives')
      .insert(insertPayload)
      .select(FOCUS_DIRECTIVE_SELECT)
      .single();

    if (createdResult.error) {
      if (isMissingRelationError(createdResult.error)) {
        return NextResponse.json({
          created: false,
          directive: null,
          active: null,
          note: 'focus_directives table not found',
        });
      }

      if (createdResult.error.code === '23505') {
        return NextResponse.json(
          { error: 'An active focus directive already exists. Clear or deactivate it first.' },
          { status: 409 }
        );
      }

      throw createdResult.error;
    }

    const directive = createdResult.data as FocusDirectiveRow;
    const activeDirectiveResult = await fetchActiveDirective(supabase, userId, Date.now());

    return NextResponse.json({
      created: true,
      directive,
      active: activeDirectiveResult.active,
      note: activeDirectiveResult.fallbackNote,
    });
  } catch (error) {
    console.error('Error creating focus directive:', error);
    return NextResponse.json({ error: 'Failed to create focus directive' }, { status: 500 });
  }
}
