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
  type FocusDirectiveRow,
} from '@/lib/focus-directives';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

interface FocusPatchBody {
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

function hasOwn<T extends object>(value: T, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseRequiredText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

function parseOptionalBoolean(
  value: unknown,
  fieldName: string
): { value: boolean; error: string | null } {
  if (typeof value !== 'boolean') {
    return { value: false, error: `${fieldName} must be true or false` };
  }

  return { value, error: null };
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

async function clearOtherActiveDirectives(
  supabase: SupabaseClient,
  userId: string,
  directiveId: string,
  endedAtIso: string
): Promise<{ fallbackNote?: string }> {
  const clearResult = await supabase
    .from('focus_directives')
    .update({ is_active: false, ends_at: endedAtIso })
    .eq('created_by', userId)
    .eq('is_active', true)
    .neq('id', directiveId);

  if (clearResult.error) {
    if (isMissingRelationError(clearResult.error)) {
      return { fallbackNote: 'focus_directives table not found' };
    }
    throw clearResult.error;
  }

  return {};
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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { id } = await params;
    const { supabase, userId } = auth.context;

    let body: FocusPatchBody = {};
    try {
      body = (await request.json()) as FocusPatchBody;
    } catch {
      body = {};
    }

    const allowedFields = new Set([
      'text',
      'scope_type',
      'scope_id',
      'scope_value',
      'strength',
      'starts_at',
      'ends_at',
      'reason',
      'is_active',
    ]);

    const hasAnyAllowedField = Object.keys(body).some((key) => allowedFields.has(key));
    if (!hasAnyAllowedField) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const currentResult = await supabase
      .from('focus_directives')
      .select(FOCUS_DIRECTIVE_SELECT)
      .eq('id', id)
      .eq('created_by', userId)
      .single();

    if (currentResult.error) {
      if (isMissingRelationError(currentResult.error)) {
        return NextResponse.json({
          updated: false,
          directive: null,
          active: null,
          note: 'focus_directives table not found',
        });
      }

      if (currentResult.error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Focus directive not found' }, { status: 404 });
      }

      throw currentResult.error;
    }

    const current = currentResult.data as FocusDirectiveRow;
    const updates: Record<string, unknown> = {};

    if (hasOwn(body, 'text')) {
      const text = parseRequiredText(body.text);
      if (!text) {
        return NextResponse.json({ error: 'text cannot be empty' }, { status: 400 });
      }
      updates.text = text;
    }

    if (hasOwn(body, 'scope_type')) {
      if (typeof body.scope_type !== 'string' || !isValidDirectiveScopeType(body.scope_type)) {
        return NextResponse.json(
          { error: 'scope_type must be one of: implementation, stakeholder, task_type, query' },
          { status: 400 }
        );
      }
      updates.scope_type = body.scope_type;
    }

    if (hasOwn(body, 'scope_id')) {
      if (body.scope_id !== null && typeof body.scope_id !== 'string') {
        return NextResponse.json({ error: 'scope_id must be a string or null' }, { status: 400 });
      }
      updates.scope_id = asTrimmedStringOrNull(body.scope_id);
    }

    if (hasOwn(body, 'scope_value')) {
      const scopeValue = parseOptionalNullableText(body.scope_value, 'scope_value');
      if (scopeValue.error) {
        return NextResponse.json({ error: scopeValue.error }, { status: 400 });
      }
      updates.scope_value = scopeValue.value;
    }

    if (hasOwn(body, 'strength')) {
      if (typeof body.strength !== 'string' || !isValidDirectiveStrength(body.strength)) {
        return NextResponse.json(
          { error: 'strength must be one of: nudge, strong, hard' },
          { status: 400 }
        );
      }
      updates.strength = body.strength;
    }

    if (hasOwn(body, 'starts_at')) {
      const startsAt = parseOptionalIsoTimestamp(body.starts_at, 'starts_at');
      if (startsAt.error) {
        return NextResponse.json({ error: startsAt.error }, { status: 400 });
      }
      updates.starts_at = startsAt.value;
    }

    if (hasOwn(body, 'ends_at')) {
      const endsAt = parseOptionalIsoTimestamp(body.ends_at, 'ends_at');
      if (endsAt.error) {
        return NextResponse.json({ error: endsAt.error }, { status: 400 });
      }
      updates.ends_at = endsAt.value;
    }

    if (hasOwn(body, 'reason')) {
      const reason = parseOptionalNullableText(body.reason, 'reason');
      if (reason.error) {
        return NextResponse.json({ error: reason.error }, { status: 400 });
      }
      updates.reason = reason.value;
    }

    if (hasOwn(body, 'is_active')) {
      const isActive = parseOptionalBoolean(body.is_active, 'is_active');
      if (isActive.error) {
        return NextResponse.json({ error: isActive.error }, { status: 400 });
      }
      updates.is_active = isActive.value;
    }

    const nextScopeType = (updates.scope_type as DirectiveScopeType | undefined) ?? current.scope_type;
    const nextScopeId = hasOwn(updates, 'scope_id') ? (updates.scope_id as string | null) : current.scope_id;
    const nextScopeValue = hasOwn(updates, 'scope_value')
      ? (updates.scope_value as string | null)
      : current.scope_value;

    if (nextScopeType === 'implementation') {
      if (!nextScopeId) {
        return NextResponse.json({ error: 'scope_id is required for implementation scope' }, { status: 400 });
      }

      const implementationOwned = await ensureImplementationOwnership(supabase, userId, nextScopeId);
      if (!implementationOwned) {
        return NextResponse.json({ error: 'scope_id must reference one of your implementations' }, { status: 400 });
      }

      updates.scope_value = null;
    } else {
      if (!nextScopeValue) {
        return NextResponse.json(
          { error: 'scope_value is required for stakeholder, task_type, and query scopes' },
          { status: 400 }
        );
      }
      updates.scope_id = null;
    }

    const nextStartsAt = hasOwn(updates, 'starts_at') ? (updates.starts_at as string | null) : current.starts_at;
    const nextEndsAt = hasOwn(updates, 'ends_at') ? (updates.ends_at as string | null) : current.ends_at;
    const startsAtMs = parseTimestampMs(nextStartsAt);
    const endsAtMs = parseTimestampMs(nextEndsAt);

    if (startsAtMs !== null && endsAtMs !== null && endsAtMs <= startsAtMs) {
      return NextResponse.json({ error: 'ends_at must be after starts_at' }, { status: 400 });
    }

    const nextIsActive = hasOwn(updates, 'is_active') ? Boolean(updates.is_active) : current.is_active;
    const nowIso = new Date().toISOString();

    if (nextIsActive && !current.is_active) {
      const clearActiveResult = await clearOtherActiveDirectives(supabase, userId, id, nowIso);
      if (clearActiveResult.fallbackNote) {
        return NextResponse.json({
          updated: false,
          directive: null,
          active: null,
          note: clearActiveResult.fallbackNote,
        });
      }
    }

    if (!nextIsActive && current.is_active && !hasOwn(updates, 'ends_at')) {
      updates.ends_at = nowIso;
    }

    if (Object.keys(updates).length === 0) {
      const activeDirectiveResult = await fetchActiveDirective(supabase, userId, Date.now());
      return NextResponse.json({
        updated: true,
        directive: current,
        active: activeDirectiveResult.active,
        note: activeDirectiveResult.fallbackNote,
      });
    }

    const updateResult = await supabase
      .from('focus_directives')
      .update(updates)
      .eq('id', id)
      .eq('created_by', userId)
      .select(FOCUS_DIRECTIVE_SELECT)
      .single();

    if (updateResult.error) {
      if (isMissingRelationError(updateResult.error)) {
        return NextResponse.json({
          updated: false,
          directive: null,
          active: null,
          note: 'focus_directives table not found',
        });
      }

      if (updateResult.error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Focus directive not found' }, { status: 404 });
      }

      if (updateResult.error.code === '23505') {
        return NextResponse.json(
          { error: 'An active focus directive already exists. Clear or deactivate it first.' },
          { status: 409 }
        );
      }

      throw updateResult.error;
    }

    const activeDirectiveResult = await fetchActiveDirective(supabase, userId, Date.now());

    return NextResponse.json({
      updated: true,
      directive: updateResult.data as FocusDirectiveRow,
      active: activeDirectiveResult.active,
      note: activeDirectiveResult.fallbackNote,
    });
  } catch (error) {
    console.error('Error updating focus directive:', error);
    return NextResponse.json({ error: 'Failed to update focus directive' }, { status: 500 });
  }
}
