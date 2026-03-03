import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import { mergeStakeholderContext, normalizeStakeholderContext } from '@/lib/stakeholders';

function asStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// GET /api/stakeholders/[id] - Get stakeholder with commitments
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { id } = await params;

    const { data: stakeholder, error } = await supabase
      .from('stakeholders')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error || !stakeholder) {
      return NextResponse.json({ error: 'Stakeholder not found' }, { status: 404 });
    }

    // Fetch commitments for this stakeholder
    const { data: commitments } = await supabase
      .from('commitments')
      .select('*, task:tasks(id, title, status)')
      .eq('user_id', userId)
      .eq('stakeholder_id', id)
      .order('status', { ascending: true })
      .order('due_at', { ascending: true, nullsFirst: false });

    return NextResponse.json({
      ...stakeholder,
      context: normalizeStakeholderContext(stakeholder.context),
      commitments: commitments || [],
    });
  } catch (error) {
    console.error('Error fetching stakeholder:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PATCH /api/stakeholders/[id] - Update stakeholder
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    let currentContext: unknown;

    const updates: Record<string, unknown> = {};

    if ('name' in body) {
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 });
      }
      updates.name = body.name.trim();
    }

    if ('email' in body) updates.email = asStringOrNull(body.email);
    if ('role' in body) updates.role = asStringOrNull(body.role);
    if ('organization' in body) updates.organization = asStringOrNull(body.organization);
    if ('notes' in body) updates.notes = asStringOrNull(body.notes);

    if ('context' in body) {
      if (!body.context || typeof body.context !== 'object' || Array.isArray(body.context)) {
        return NextResponse.json({ error: 'context must be an object' }, { status: 400 });
      }

      const { data: stakeholder, error: fetchError } = await supabase
        .from('stakeholders')
        .select('context')
        .eq('id', id)
        .eq('user_id', userId)
        .single();

      if (fetchError || !stakeholder) {
        return NextResponse.json({ error: 'Stakeholder not found' }, { status: 404 });
      }

      currentContext = stakeholder.context;
      updates.context = mergeStakeholderContext(currentContext, body.context as Record<string, unknown>);
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('stakeholders')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw error;
    if (!data) {
      return NextResponse.json({ error: 'Stakeholder not found' }, { status: 404 });
    }

    return NextResponse.json({
      ...data,
      context: normalizeStakeholderContext(data.context),
    });
  } catch (error) {
    console.error('Error updating stakeholder:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/stakeholders/[id] - Delete stakeholder (cascades commitments)
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { id } = await params;

    const { error } = await supabase
      .from('stakeholders')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error deleting stakeholder:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
