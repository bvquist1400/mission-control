"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ProjectTaskSectionsPanel } from "@/components/projects/ProjectTaskSectionsPanel";
import { DEFAULT_PROJECT_STAGE, normalizeProjectStage } from "@/lib/project-stage";
import { dateOnlyToInputValue, formatDateOnly } from "@/components/utils/dates";
import { ProjectStageBadge } from "@/components/ui/ProjectStageBadge";
import { ProjectStageSelector } from "@/components/ui/ProjectStageSelector";
import { RagBadge } from "@/components/ui/RagBadge";
import { RagSelector } from "@/components/ui/RagSelector";
import type {
  ProjectDetail as ProjectDetailType,
  ProjectUpdatePayload,
} from "@/types/database";

interface ProjectDetailProps {
  id: string;
}

function normalizeProject(project: ProjectDetailType): ProjectDetailType {
  return {
    ...project,
    stage: normalizeProjectStage(project.stage) ?? DEFAULT_PROJECT_STAGE,
  };
}

function LoadingSkeleton() {
  return (
    <div className="min-w-0 space-y-6">
      <div className="animate-pulse rounded-card border border-stroke bg-panel p-5">
        <div className="h-7 w-48 rounded bg-panel-muted" />
        <div className="mt-4 flex gap-2">
          <div className="h-6 w-20 rounded bg-panel-muted" />
          <div className="h-6 w-16 rounded bg-panel-muted" />
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {[1, 2, 3, 4].map((item) => (
            <div key={item} className="rounded-lg bg-panel-muted p-3">
              <div className="h-3 w-20 rounded bg-stroke" />
              <div className="mt-2 h-4 w-32 rounded bg-stroke" />
            </div>
          ))}
        </div>
      </div>
      <div className="animate-pulse rounded-card border border-stroke bg-panel p-5">
        <div className="h-4 w-24 rounded bg-panel-muted" />
        <div className="mt-3 space-y-2">
          {[1, 2, 3].map((item) => (
            <div key={item} className="h-10 rounded bg-panel-muted" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function ProjectDetail({ id }: ProjectDetailProps) {
  const [project, setProject] = useState<ProjectDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [targetDateDraft, setTargetDateDraft] = useState("");
  const [spmIdDraft, setSpmIdDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [statusSummaryDraft, setStatusSummaryDraft] = useState("");

  useEffect(() => {
    let isMounted = true;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(`/api/projects/${id}`, { cache: "no-store" });
        if (!res.ok) throw new Error("Failed to fetch project");
        const data = await res.json() as ProjectDetailType;
        if (!isMounted) return;
        setProject(normalizeProject(data));
      } catch (err) {
        if (!isMounted) return;
        setError(err instanceof Error ? err.message : "Failed to load project");
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    load();
    return () => { isMounted = false; };
  }, [id]);

  async function updateField(updates: ProjectUpdatePayload) {
    if (!project) return;

    const previous = project;
    setSaving(true);
    setError(null);
    setProject({ ...project, ...updates });

    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Update failed" }));
        throw new Error(typeof data.error === "string" ? data.error : "Update failed");
      }

      const updated = normalizeProject(await res.json() as ProjectDetailType);
      setProject((current) => current ? { ...current, ...updated } : current);
    } catch (err) {
      setProject(previous);
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setSaving(false);
    }
  }

  function loadDrafts(nextProject: ProjectDetailType) {
    setNameDraft(nextProject.name);
    setTargetDateDraft(dateOnlyToInputValue(nextProject.target_date));
    setSpmIdDraft(nextProject.servicenow_spm_id ?? "");
    setDescriptionDraft(nextProject.description ?? "");
    setStatusSummaryDraft(nextProject.status_summary ?? "");
  }

  function commitNameEdit() {
    if (!project) {
      return;
    }

    const normalizedName = nameDraft.trim();
    if (!normalizedName) {
      setNameDraft(project.name);
      return;
    }

    if (normalizedName !== project.name) {
      void updateField({ name: normalizedName });
    }
  }

  if (loading) return <LoadingSkeleton />;

  if (error && !project) {
    return (
      <div className="rounded-card border border-red-200 bg-red-50 p-5 text-center">
        <p className="text-sm text-red-700">{error}</p>
        <Link href="/projects" className="mt-3 inline-block text-sm font-medium text-accent hover:underline">
          Back to Projects
        </Link>
      </div>
    );
  }

  if (!project) return null;

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      {/* ── Header Section ── */}
      <section className="min-w-0 rounded-card border border-stroke bg-panel p-5 shadow-sm">
        {isEditing ? (
          <input
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={commitNameEdit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitNameEdit();
                event.currentTarget.blur();
              }

              if (event.key === "Escape") {
                setNameDraft(project.name);
                event.currentTarget.blur();
              }
            }}
            disabled={saving}
            placeholder="Project name"
            className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-lg font-semibold text-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
          />
        ) : (
          <h2 className="text-lg font-semibold text-foreground">{project.name}</h2>
        )}

        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            {isEditing ? (
              <>
                <ProjectStageSelector
                  value={project.stage}
                  onChange={(stage) => updateField({ stage })}
                  disabled={saving}
                />
                <RagSelector value={project.rag} onChange={(rag) => updateField({ rag })} disabled={saving} />
              </>
            ) : (
              <>
                <ProjectStageBadge stage={project.stage} />
                <RagBadge status={project.rag} />
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              setIsEditing((current) => {
                const next = !current;
                if (next && project) {
                  loadDrafts(project);
                }
                return next;
              });
            }}
            className="rounded-lg border border-stroke bg-panel px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
          >
            {isEditing ? "Done Editing" : "Edit"}
          </button>
        </div>

        {/* Detail grid */}
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <article className="rounded-lg bg-panel-muted p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Application</p>
            {project.implementation ? (
              <Link
                href={`/applications/${project.implementation.id}`}
                className="mt-1 block text-sm font-medium text-accent hover:underline"
              >
                {project.implementation.name}
              </Link>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">Not linked</p>
            )}
          </article>

          <article className="rounded-lg bg-panel-muted p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Target Date</p>
            {isEditing ? (
              <input
                type="date"
                value={targetDateDraft}
                onChange={(e) => setTargetDateDraft(e.target.value)}
                onBlur={() => {
                  if (!project) {
                    return;
                  }

                  const currentTargetDate = dateOnlyToInputValue(project.target_date);
                  if (targetDateDraft !== currentTargetDate) {
                    void updateField({ target_date: targetDateDraft || null });
                  }
                }}
                disabled={saving}
                className="mt-1 w-full rounded border border-stroke bg-panel px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
              />
            ) : (
              <p className="mt-1 text-sm font-medium text-foreground">{formatDateOnly(project.target_date)}</p>
            )}
          </article>

          <article className="rounded-lg bg-panel-muted p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">SPM ID</p>
            {isEditing ? (
              <input
                type="text"
                value={spmIdDraft}
                onChange={(e) => setSpmIdDraft(e.target.value)}
                onBlur={() => {
                  if (!project) {
                    return;
                  }

                  const currentSpmId = project.servicenow_spm_id ?? "";
                  if (spmIdDraft !== currentSpmId) {
                    void updateField({ servicenow_spm_id: spmIdDraft || null });
                  }
                }}
                disabled={saving}
                placeholder="e.g. SPM-1234"
                className="mt-1 w-full rounded border border-stroke bg-panel px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
              />
            ) : (
              <p className="mt-1 text-sm font-medium text-foreground">
                {project.servicenow_spm_id || <span className="text-muted-foreground">Not set</span>}
              </p>
            )}
          </article>

          <article className="rounded-lg bg-panel-muted p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Open Blockers</p>
            <p className="mt-1 text-sm font-medium text-foreground">
              {project.blockers_count > 0 ? (
                <span className="text-red-400">{project.blockers_count}</span>
              ) : (
                <span className="text-green-400">None</span>
              )}
            </p>
          </article>
        </div>

        {/* Description */}
        <div className="mt-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Description</p>
          {isEditing ? (
            <textarea
              value={descriptionDraft}
              onChange={(e) => setDescriptionDraft(e.target.value)}
              onBlur={() => {
                if (!project) {
                  return;
                }

                const currentDescription = project.description ?? "";
                if (descriptionDraft !== currentDescription) {
                  void updateField({ description: descriptionDraft || null });
                }
              }}
              disabled={saving}
              rows={2}
              placeholder="What is this project about?"
              className="mt-1 w-full rounded border border-stroke bg-panel px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
            />
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">{project.description || "No description set."}</p>
          )}
        </div>

        {/* Status Summary */}
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status Summary</p>
          {isEditing ? (
            <textarea
              value={statusSummaryDraft}
              onChange={(e) => setStatusSummaryDraft(e.target.value)}
              onBlur={() => {
                if (!project) {
                  return;
                }

                const currentStatusSummary = project.status_summary ?? "";
                if (statusSummaryDraft !== currentStatusSummary) {
                  void updateField({ status_summary: statusSummaryDraft });
                }
              }}
              disabled={saving}
              rows={2}
              placeholder="Current status in 1-2 sentences"
              className="mt-1 w-full rounded border border-stroke bg-panel px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
            />
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">{project.status_summary || "No status summary set."}</p>
          )}
        </div>
      </section>

      {/* ── Tasks Section ── */}
      <section className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-foreground">Tasks</h2>

        <div className="mt-4">
          <ProjectTaskSectionsPanel
            projectId={id}
            projectName={project.name}
            implementationId={project.implementation?.id ?? null}
          />
        </div>
      </section>
    </div>
  );
}
