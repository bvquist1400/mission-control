"use client";

import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { ProjectCard, type ProjectCardData } from "@/components/projects/ProjectCard";
import { ProjectTable } from "@/components/projects/ProjectTable";
import { ProjectTemplateCatalogModal } from "@/components/projects/ProjectTemplateCatalogModal";
import { DEFAULT_PROJECT_STAGE, normalizeProjectStage } from "@/lib/project-stage";
import { ProjectStageSelector } from "@/components/ui/ProjectStageSelector";
import { RagSelector } from "@/components/ui/RagSelector";
import type { ImplPhase, ProjectStage, RagStatus } from "@/types/database";
import { hasPersonalTag, PERSONAL_TAG } from "@/lib/personal-exclusion";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea } from "@/components/ui/Field";

// ─── API response shape ───────────────────────────────────────────────────────

interface ApiProject {
  id: string;
  name: string;
  description: string | null;
  stage: ProjectStage;
  rag: RagStatus;
  target_date: string | null;
  updated_at: string;
  servicenow_spm_id: string | null;
  status_summary: string;
  portfolio_rank: number;
  tags: string[];
  open_task_count: number;
  completed_task_count: number;
  total_task_count: number;
  completion_pct: number;
  blockers_count?: number;
  implementation: {
    id: string;
    name: string;
    phase: ImplPhase;
    rag: RagStatus;
  } | null;
}

interface ApiImplementation {
  id: string;
  name: string;
  phase: ImplPhase;
  rag: RagStatus;
}

type ProjectsViewMode = "table" | "cards";

// ─── Draft state for create form ─────────────────────────────────────────────

interface ProjectDraft {
  name: string;
  description: string;
  stage: ProjectStage;
  rag: RagStatus;
  targetDate: string;
  spmId: string;
  statusSummary: string;
  implementationId: string;
  personal: boolean;
}

const INITIAL_DRAFT: ProjectDraft = {
  name: "",
  description: "",
  stage: DEFAULT_PROJECT_STAGE,
  rag: "Green",
  targetDate: "",
  spmId: "",
  statusSummary: "",
  implementationId: "",
  personal: false,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function apiToCardData(project: ApiProject): ProjectCardData {
  const stage = normalizeProjectStage(project.stage) ?? DEFAULT_PROJECT_STAGE;
  return {
    id: project.id,
    name: project.name,
    stage,
    rag: project.rag,
    portfolioRank: project.portfolio_rank,
    targetDate: project.target_date,
    updatedAt: project.updated_at,
    statusSummary: project.status_summary || "",
    description: project.description,
    servicenowSpmId: project.servicenow_spm_id,
    openTaskCount: project.open_task_count,
    completedTaskCount: project.completed_task_count,
    totalTaskCount: project.total_task_count,
    completionPct: project.completion_pct,
    blockersCount: project.blockers_count ?? 0,
    implementationName: project.implementation?.name ?? null,
    implementationId: project.implementation?.id ?? null,
    isPersonal: hasPersonalTag(project),
  };
}

// ─── Component ───────────────────────────────────────────────────────────────

interface ProjectsListProps {
  /** If provided, restricts view to projects for one application */
  implementationId?: string;
  /** If in embedded mode (inside an application page), suppress the PageHeader */
  embedded?: boolean;
  /** Initial projects view mode */
  defaultView?: ProjectsViewMode;
}

function buildProjectsRequestPath(implementationId: string): string {
  const params = new URLSearchParams({ with_stats: "true" });
  if (implementationId) {
    params.set("implementation_id", implementationId);
  }
  return `/api/projects?${params.toString()}`;
}

export function ProjectsList({
  implementationId,
  embedded = false,
  defaultView,
}: ProjectsListProps) {
  const [projects, setProjects] = useState<ProjectCardData[]>([]);
  const [implementations, setImplementations] = useState<ApiImplementation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [draft, setDraft] = useState<ProjectDraft>(INITIAL_DRAFT);
  const [saving, setSaving] = useState(false);
  const [filterImplId, setFilterImplId] = useState(implementationId ?? "");
  const [viewMode, setViewMode] = useState<ProjectsViewMode>(
    defaultView ?? (embedded ? "cards" : "table")
  );
  const [isTemplateCatalogOpen, setIsTemplateCatalogOpen] = useState(false);
  const [includeDoneProjects, setIncludeDoneProjects] = useState(false);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  useEffect(() => {
    setFilterImplId(implementationId ?? "");
  }, [implementationId]);

  // Fetch implementations for the dropdown (only when not embedded)
  useEffect(() => {
    if (embedded) return;
    fetch("/api/applications")
      .then((r) => r.json())
      .then((data: ApiImplementation[]) => {
        if (isMounted.current) setImplementations(data);
      })
      .catch(() => {/* non-critical */});
  }, [embedded]);

  // Fetch projects
  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(buildProjectsRequestPath(filterImplId))
      .then(async (res) => {
        if (res.status === 401) throw new Error("Authentication required.");
        if (!res.ok) throw new Error("Failed to fetch projects.");
        return res.json() as Promise<ApiProject[]>;
      })
      .then((data) => {
        if (!isMounted.current) return;
        setProjects(data.map(apiToCardData));
      })
      .catch((err: Error) => {
        if (!isMounted.current) return;
        setError(err.message);
      })
      .finally(() => {
        if (isMounted.current) setLoading(false);
      });
  }, [filterImplId]);

  // ─── Create handler ───────────────────────────────────────────────────────

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.name.trim()) return;

    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: draft.name.trim(),
        stage: draft.stage,
        rag: draft.rag,
        status_summary: draft.statusSummary,
      };
      if (draft.description.trim()) body.description = draft.description.trim();
      if (draft.targetDate) body.target_date = draft.targetDate;
      if (draft.spmId.trim()) body.servicenow_spm_id = draft.spmId.trim();
      if (draft.implementationId) body.implementation_id = draft.implementationId;
      else if (filterImplId) body.implementation_id = filterImplId;
      if (draft.personal) body.tags = [PERSONAL_TAG];

      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? "Failed to create project");
      }

      const created = await res.json() as ApiProject;
      // Optimistically prepend — re-fetch to get full stats
      const fullRes = await fetch(buildProjectsRequestPath(filterImplId));
      const all = await fullRes.json() as ApiProject[];
      if (isMounted.current) {
        setProjects(all.map(apiToCardData));
      }

      // Reset
      setDraft({ ...INITIAL_DRAFT, implementationId: draft.implementationId });
      setIsCreateOpen(false);
      void created;
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      if (isMounted.current) setSaving(false);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const nonCancelledProjects = projects.filter((project) => project.stage !== "Cancelled");
  const visibleProjects = includeDoneProjects
    ? nonCancelledProjects
    : nonCancelledProjects.filter((project) => project.stage !== "Done");

  const content = (
    <div className="space-y-6">
      {/* ── Create form ── */}
      <div className="rounded-card border border-stroke bg-panel p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">New Project</h2>
          <button
            type="button"
            onClick={() => setIsCreateOpen((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {isCreateOpen ? "Cancel" : "+ Add"}
          </button>
        </div>

        {isCreateOpen && (
          <form onSubmit={handleCreate} className="mt-4 space-y-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              <div className="xl:col-span-2">
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Name *</label>
                <Input
                  tone="muted"
                  type="text"
                  required
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  placeholder="Project name"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Stage</label>
                <ProjectStageSelector value={draft.stage} onChange={(stage) => setDraft((d) => ({ ...d, stage }))} />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">RAG Status</label>
                <RagSelector value={draft.rag} onChange={(r) => setDraft((d) => ({ ...d, rag: r }))} />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Target Date</label>
                <Input
                  tone="muted"
                  type="date"
                  value={draft.targetDate}
                  onChange={(e) => setDraft((d) => ({ ...d, targetDate: e.target.value }))}
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">SPM ID</label>
                <Input
                  tone="muted"
                  type="text"
                  value={draft.spmId}
                  onChange={(e) => setDraft((d) => ({ ...d, spmId: e.target.value }))}
                  placeholder="e.g. SPM-1234"
                />
              </div>

              {!embedded && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Application</label>
                  <Select
                    tone="muted"
                    value={draft.implementationId}
                    onChange={(e) => setDraft((d) => ({ ...d, implementationId: e.target.value }))}
                  >
                    <option value="">— None —</option>
                    {implementations.map((impl) => (
                      <option key={impl.id} value={impl.id}>{impl.name}</option>
                    ))}
                  </Select>
                </div>
              )}

              <label className="flex items-center gap-2 self-end rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={draft.personal}
                  onChange={(event) => setDraft((current) => ({ ...current, personal: event.target.checked }))}
                  className="h-4 w-4 accent-violet-500"
                />
                Personal project
              </label>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Description</label>
              <Textarea
                tone="muted"
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                rows={2}
                placeholder="What is this project about?"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Status Summary</label>
              <Textarea
                tone="muted"
                value={draft.statusSummary}
                onChange={(e) => setDraft((d) => ({ ...d, statusSummary: e.target.value }))}
                rows={2}
                placeholder="Current status in 1-2 sentences"
              />
            </div>

            <div className="flex justify-end gap-3">
              <Button
                variant="secondary"
                size="lg"
                onClick={() => { setIsCreateOpen(false); setDraft(INITIAL_DRAFT); }}
              >
                Cancel
              </Button>
              <Button variant="primary" size="lg" type="submit" disabled={saving || !draft.name.trim()}>
                {saving ? "Creating..." : "Create Project"}
              </Button>
            </div>
          </form>
        )}
      </div>

      {/* ── Filter bar ── */}
      {((!embedded && implementations.length > 0) || projects.length > 0) && (
        <div className="flex flex-wrap items-center gap-3">
          {!embedded && implementations.length > 0 ? (
            <>
              <label className="text-xs font-medium text-muted-foreground">Filter by Application:</label>
              <Select size="sm" value={filterImplId} onChange={(e) => setFilterImplId(e.target.value)}>
                <option value="">All Applications</option>
                {implementations.map((impl) => (
                  <option key={impl.id} value={impl.id}>{impl.name}</option>
                ))}
              </Select>
            </>
          ) : null}

          <div className="inline-flex rounded-lg border border-stroke bg-panel p-1">
            <Button variant="toggle" size="sm" active={viewMode === "table"}
              onClick={() => setViewMode("table")}>
              Table
            </Button>
            <Button variant="toggle" size="sm" active={viewMode === "cards"}
              onClick={() => setViewMode("cards")}>
              Cards
            </Button>
          </div>

          <label className="inline-flex items-center gap-2 rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={includeDoneProjects}
              onChange={(event) => setIncludeDoneProjects(event.target.checked)}
              className="h-4 w-4 accent-accent"
            />
            Include done projects
          </label>
        </div>
      )}

      {/* ── Loading / error / empty ── */}
      {loading && (
        <p className="text-sm text-muted-foreground">Loading projects…</p>
      )}
      {!loading && error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">{error}</div>
      )}
      {!loading && !error && projects.length === 0 && (
        <div className="rounded-card border border-stroke bg-panel p-8 text-center text-sm text-muted-foreground">
          No projects yet.{" "}
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="text-accent-text hover:underline"
          >
            Create one
          </button>
          {" "}to group tasks under an application.
        </div>
      )}
      {!loading && !error && projects.length > 0 && visibleProjects.length === 0 && !includeDoneProjects && (
        <div className="rounded-card border border-stroke bg-panel p-8 text-center text-sm text-muted-foreground">
          No active projects. Turn on <span className="font-medium text-foreground">Include done projects</span> to see completed items.
        </div>
      )}

      {/* ── Project views ── */}
      {!loading && !error && visibleProjects.length > 0 && (
        viewMode === "table" ? (
          <ProjectTable projects={visibleProjects} />
        ) : (
          <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
            {visibleProjects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )
      )}
    </div>
  );

  if (embedded) {
    return content;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        description="Track work items within applications. Each project has its own delivery stage, RAG status, and task list."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setIsTemplateCatalogOpen(true)}>
              From Template
            </Button>
            <Button variant="primary" size="lg" onClick={() => setIsCreateOpen(true)}>
              + New Project
            </Button>
          </div>
        }
      />
      {content}
      {isTemplateCatalogOpen ? (
        <ProjectTemplateCatalogModal
          open={isTemplateCatalogOpen}
          onClose={() => setIsTemplateCatalogOpen(false)}
          implementations={implementations.map((implementation) => ({
            id: implementation.id,
            name: implementation.name,
          }))}
          defaultImplementationId={filterImplId}
        />
      ) : null}
    </div>
  );
}
