"use client";

import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { ProjectCard, type ProjectCardData } from "@/components/projects/ProjectCard";
import { PhaseSelector } from "@/components/ui/PhaseSelector";
import { RagSelector } from "@/components/ui/RagSelector";
import type { ImplPhase, RagStatus } from "@/types/database";

// ─── API response shape ───────────────────────────────────────────────────────

interface ApiProject {
  id: string;
  name: string;
  description: string | null;
  phase: ImplPhase;
  rag: RagStatus;
  target_date: string | null;
  servicenow_spm_id: string | null;
  status_summary: string;
  portfolio_rank: number;
  open_task_count: number;
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

// ─── Draft state for create form ─────────────────────────────────────────────

interface ProjectDraft {
  name: string;
  description: string;
  phase: ImplPhase;
  rag: RagStatus;
  targetDate: string;
  spmId: string;
  statusSummary: string;
  implementationId: string;
}

const INITIAL_DRAFT: ProjectDraft = {
  name: "",
  description: "",
  phase: "Intake",
  rag: "Green",
  targetDate: "",
  spmId: "",
  statusSummary: "",
  implementationId: "",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function apiToCardData(project: ApiProject): ProjectCardData {
  return {
    id: project.id,
    name: project.name,
    phase: project.phase,
    rag: project.rag,
    targetDate: project.target_date,
    statusSummary: project.status_summary || "",
    description: project.description,
    servicenowSpmId: project.servicenow_spm_id,
    openTaskCount: project.open_task_count,
    blockersCount: project.blockers_count ?? 0,
    implementationName: project.implementation?.name ?? null,
    implementationId: project.implementation?.id ?? null,
  };
}

// ─── Component ───────────────────────────────────────────────────────────────

interface ProjectsListProps {
  /** If provided, restricts view to projects for one application */
  implementationId?: string;
  /** If in embedded mode (inside an application page), suppress the PageHeader */
  embedded?: boolean;
}

export function ProjectsList({ implementationId, embedded = false }: ProjectsListProps) {
  const [projects, setProjects] = useState<ProjectCardData[]>([]);
  const [implementations, setImplementations] = useState<ApiImplementation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [draft, setDraft] = useState<ProjectDraft>(INITIAL_DRAFT);
  const [saving, setSaving] = useState(false);
  const [filterImplId, setFilterImplId] = useState(implementationId ?? "");
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

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

    const url = new URL("/api/projects", window.location.origin);
    url.searchParams.set("with_stats", "true");
    if (filterImplId) url.searchParams.set("implementation_id", filterImplId);

    fetch(url.toString())
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
        phase: draft.phase,
        rag: draft.rag,
        status_summary: draft.statusSummary,
      };
      if (draft.description.trim()) body.description = draft.description.trim();
      if (draft.targetDate) body.target_date = draft.targetDate;
      if (draft.spmId.trim()) body.servicenow_spm_id = draft.spmId.trim();
      if (draft.implementationId) body.implementation_id = draft.implementationId;
      else if (implementationId) body.implementation_id = implementationId;

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
      const fullRes = await fetch(`/api/projects?with_stats=true`);
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
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <div className="xl:col-span-2">
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Name *</label>
                <input
                  type="text"
                  required
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  placeholder="Project name"
                  className="w-full rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Phase</label>
                <PhaseSelector value={draft.phase} onChange={(p) => setDraft((d) => ({ ...d, phase: p }))} />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">RAG Status</label>
                <RagSelector value={draft.rag} onChange={(r) => setDraft((d) => ({ ...d, rag: r }))} />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Target Date</label>
                <input
                  type="date"
                  value={draft.targetDate}
                  onChange={(e) => setDraft((d) => ({ ...d, targetDate: e.target.value }))}
                  className="rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">SPM ID</label>
                <input
                  type="text"
                  value={draft.spmId}
                  onChange={(e) => setDraft((d) => ({ ...d, spmId: e.target.value }))}
                  placeholder="e.g. SPM-1234"
                  className="w-full rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
              </div>

              {!embedded && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Application</label>
                  <select
                    value={draft.implementationId}
                    onChange={(e) => setDraft((d) => ({ ...d, implementationId: e.target.value }))}
                    className="w-full rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                  >
                    <option value="">— None —</option>
                    {implementations.map((impl) => (
                      <option key={impl.id} value={impl.id}>{impl.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Description</label>
              <textarea
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                rows={2}
                placeholder="What is this project about?"
                className="w-full rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Status Summary</label>
              <textarea
                value={draft.statusSummary}
                onChange={(e) => setDraft((d) => ({ ...d, statusSummary: e.target.value }))}
                rows={2}
                placeholder="Current status in 1-2 sentences"
                className="w-full rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
            </div>

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => { setIsCreateOpen(false); setDraft(INITIAL_DRAFT); }}
                className="rounded-lg border border-stroke bg-panel px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-panel-muted"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || !draft.name.trim()}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? "Creating..." : "Create Project"}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* ── Filter bar (non-embedded only) ── */}
      {!embedded && implementations.length > 0 && (
        <div className="flex items-center gap-3">
          <label className="text-xs font-medium text-muted-foreground">Filter by Application:</label>
          <select
            value={filterImplId}
            onChange={(e) => setFilterImplId(e.target.value)}
            className="rounded-lg border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          >
            <option value="">All Applications</option>
            {implementations.map((impl) => (
              <option key={impl.id} value={impl.id}>{impl.name}</option>
            ))}
          </select>
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
            className="text-accent hover:underline"
          >
            Create one
          </button>
          {" "}to group tasks under an application.
        </div>
      )}

      {/* ── Project grid ── */}
      {!loading && !error && projects.length > 0 && (
        <div className="grid gap-4 xl:grid-cols-2">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
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
        description="Track work items within applications. Each project has its own phase, RAG status, and task list."
        actions={
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            + New Project
          </button>
        }
      />
      {content}
    </div>
  );
}
