import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isProjectSectionUniqueViolation,
  normalizeProjectSectionName,
  normalizeProjectSectionSortOrder,
  sortProjectSections,
  ProjectSectionServiceError,
} from "@/lib/project-sections";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";

interface ProjectContextResult {
  response?: NextResponse;
  supabase?: SupabaseClient;
  userId?: string;
}

async function requireOwnedProject(
  request: NextRequest,
  projectId: string
): Promise<ProjectContextResult> {
  const auth = await requireAuthenticatedRoute(request);
  if (auth.response || !auth.context) {
    return { response: auth.response as NextResponse };
  }

  const { supabase, userId } = auth.context;
  const { data: project, error } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!project) {
    return { response: NextResponse.json({ error: "Project not found" }, { status: 404 }) };
  }

  return { supabase, userId };
}

// GET /api/projects/[id]/sections - List sections for a project
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const context = await requireOwnedProject(request, id);
    if (context.response || !context.supabase || !context.userId) {
      return context.response as NextResponse;
    }

    const { data, error } = await context.supabase
      .from("project_sections")
      .select("id, user_id, project_id, name, sort_order, created_at, updated_at")
      .eq("project_id", id)
      .eq("user_id", context.userId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) {
      throw error;
    }

    return NextResponse.json((data || []).sort(sortProjectSections));
  } catch (error) {
    console.error("Error fetching project sections:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/projects/[id]/sections - Create a section for a project
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const context = await requireOwnedProject(request, id);
    if (context.response || !context.supabase || !context.userId) {
      return context.response as NextResponse;
    }

    const body = (await request.json()) as Record<string, unknown>;
    const name = normalizeProjectSectionName(body.name);
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    let sortOrder: number;
    try {
      sortOrder = normalizeProjectSectionSortOrder(body.sort_order) ?? 0;
    } catch (error) {
      if (error instanceof ProjectSectionServiceError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    const { data, error } = await context.supabase
      .from("project_sections")
      .insert({
        user_id: context.userId,
        project_id: id,
        name,
        sort_order: sortOrder,
      })
      .select("id, user_id, project_id, name, sort_order, created_at, updated_at")
      .single();

    if (error) {
      if (isProjectSectionUniqueViolation(error)) {
        return NextResponse.json(
          { error: "A section with that name already exists on this project" },
          { status: 409 }
        );
      }
      throw error;
    }

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error("Error creating project section:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
