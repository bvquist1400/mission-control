import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';

function asStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// GET /api/stakeholders - List stakeholders with optional commitment counts
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search');

    let query = supabase
      .from('stakeholders')
      .select('*')
      .eq('user_id', userId)
      .order('name');

    if (search) {
      query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%,organization.ilike.%${search}%`);
    }

    const { data: stakeholders, error } = await query;

    if (error) throw error;

    // Enrich with open commitment counts
    const enriched = await Promise.all(
      (stakeholders || []).map(async (s) => {
        const { count } = await supabase
          .from('commitments')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('stakeholder_id', s.id)
          .eq('status', 'Open');

        return { ...s, open_commitments_count: count || 0 };
      })
    );

    return NextResponse.json(enriched);
  } catch (error) {
    console.error('Error fetching stakeholders:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/stakeholders - Create a new stakeholder
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const body = (await request.json()) as Record<string, unknown>;

    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    if (body.name.length > 200) {
      return NextResponse.json({ error: 'name must be 200 characters or fewer' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('stakeholders')
      .insert({
        user_id: userId,
        name: body.name.trim(),
        email: asStringOrNull(body.email),
        role: asStringOrNull(body.role),
        organization: asStringOrNull(body.organization),
        notes: asStringOrNull(body.notes),
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error('Error creating stakeholder:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
