import { NextRequest, NextResponse } from "next/server";
import {
  isProjectSectionUniqueViolation,
  normalizeProjectSectionName,
  normalizeProjectSectionSortOrder,
  ProjectSectionServiceError,
} from "@/lib/project-sections";
import { requireAuthenticatedRoute } from "@/lib/supabase/route-auth";

// PATCH /api/sections/[id] - Rename or reorder a project section
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;

    const updates: Record<string, unknown> = {};

    if ("name" in body) {
      const name = normalizeProjectSectionName(body.name);
      if (!name) {
        return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
      }
      updates.name = name;
    }

    if ("sort_order" in body) {
      try {
        updates.sort_order = normalizeProjectSectionSortOrder(body.sort_order);
      } catch (error) {
        if (error instanceof ProjectSectionServiceError) {
          return NextResponse.json({ error: error.message }, { status: error.status });
        }
        throw error;
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("project_sections")
      .update(updates)
      .eq("id", id)
      .eq("user_id", userId)
      .select("id, user_id, project_id, name, sort_order, created_at, updated_at")
      .single();

    if (error) {
      if (isProjectSectionUniqueViolation(error)) {
        return NextResponse.json(
          { error: "A section with that name already exists on this project" },
          { status: 409 }
        );
      }

      if (error.code === "PGRST116") {
        return NextResponse.json({ error: "Section not found" }, { status: 404 });
      }

      throw error;
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Error updating project section:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/sections/[id] - Delete a project section
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { id } = await params;

    const { error, count } = await supabase
      .from("project_sections")
      .delete({ count: "exact" })
      .eq("id", id)
      .eq("user_id", userId);

    if (error) {
      throw error;
    }

    if (!count) {
      return NextResponse.json({ error: "Section not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting project section:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
