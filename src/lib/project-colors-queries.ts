import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The colour list behind every project square and the "Edit colours" editor
 * (redesign S2, migration 069): each application and project with its stored
 * colour. Read once by the root layout (so the first paint has the right
 * squares) and again by GET /api/project-colors when the editor opens.
 */

export interface ProjectColorCatalogApp {
  id: string;
  name: string;
  color: string | null;
  portfolio_rank: number;
}

export interface ProjectColorCatalogProject {
  id: string;
  name: string;
  color: string | null;
  tags: string[];
  implementation_id: string | null;
  portfolio_rank: number;
  stage: string;
}

export interface ProjectColorCatalog {
  /** False when the database has no color column yet (069 not applied): squares show defaults and saving is off. */
  available: boolean;
  apps: ProjectColorCatalogApp[];
  projects: ProjectColorCatalogProject[];
}

export const EMPTY_PROJECT_COLOR_CATALOG: ProjectColorCatalog = { available: false, apps: [], projects: [] };

/** Postgres "undefined column" (and PostgREST's schema-cache miss): the column isn't there yet. */
function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204") return true;
  const message = error.message ?? "";
  return /color/i.test(message) && /does not exist|schema cache/i.test(message);
}

/** At most this many of each (Brent has tens); more would never fit the editor anyway. */
const CATALOG_LIMIT = 1000;

export async function loadProjectColorCatalog(
  // The layout passes the typed server client, routes the untyped route-auth one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  userId: string
): Promise<ProjectColorCatalog> {
  const [apps, projects] = await Promise.all([
    supabase
      .from("implementations")
      .select("id, name, color, portfolio_rank")
      .eq("user_id", userId)
      .order("portfolio_rank", { ascending: true })
      .order("name", { ascending: true })
      .limit(CATALOG_LIMIT),
    supabase
      .from("projects")
      .select("id, name, color, tags, implementation_id, portfolio_rank, stage")
      .eq("user_id", userId)
      .order("portfolio_rank", { ascending: true })
      .order("name", { ascending: true })
      .limit(CATALOG_LIMIT),
  ]);

  if (isMissingColumn(apps.error) || isMissingColumn(projects.error)) {
    // 069 isn't live yet: the app keeps working on defaults (deploy order says 069 first).
    const [plainApps, plainProjects] = await Promise.all([
      supabase.from("implementations").select("id, name, portfolio_rank").eq("user_id", userId).limit(CATALOG_LIMIT),
      supabase.from("projects").select("id, name, tags, implementation_id, portfolio_rank, stage").eq("user_id", userId).limit(CATALOG_LIMIT),
    ]);
    if (plainApps.error) throw plainApps.error;
    if (plainProjects.error) throw plainProjects.error;
    return {
      available: false,
      apps: ((plainApps.data ?? []) as Omit<ProjectColorCatalogApp, "color">[]).map((row) => ({ ...row, color: null })),
      projects: ((plainProjects.data ?? []) as Omit<ProjectColorCatalogProject, "color">[]).map((row) => ({ ...row, tags: row.tags ?? [], color: null })),
    };
  }
  if (apps.error) throw apps.error;
  if (projects.error) throw projects.error;

  return {
    available: true,
    apps: ((apps.data ?? []) as ProjectColorCatalogApp[]).map((row) => ({ ...row })),
    projects: ((projects.data ?? []) as ProjectColorCatalogProject[]).map((row) => ({ ...row, tags: row.tags ?? [] })),
  };
}
