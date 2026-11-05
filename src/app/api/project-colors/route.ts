import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import { loadProjectColorCatalog } from '@/lib/project-colors-queries';

// GET /api/project-colors - every application and project with its square colour
// (redesign S2, migration 069). Read by the "Edit colours" editor when it opens.
// Colours are written through PATCH /api/applications/[id] and /api/projects/[id].
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const catalog = await loadProjectColorCatalog(supabase, userId);
    return NextResponse.json(catalog);
  } catch (error) {
    console.error('Error loading project colours:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
