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
import { PersonalBadge } from "@/components/ui/PersonalBadge";
import { hasPersonalTag, setPersonalTag } from "@/lib/personal-exclusion";
import type {
  ProjectDetail as ProjectDetailType,
  ProjectUpdatePayload,
} from "@/types/database";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Field";
import { cardClasses } from "@/components/ui/Card";

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
      <div className="rounded-card border border-danger-border bg-danger-soft p-5 text-center">
        <p className="text-sm text-danger">{error}</p>
        <Link href="/projects" className="mt-3 inline-block text-sm font-medium text-accent-text hover:underline">
          Back to Projects
        </Link>
      </div>
    );
  }

  if (!project) return null;

  const isPersonal = hasPersonalTag(project);

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      {/* ── Header Section ── */}
      <section className={cardClasses({ className: "min-w-0" })}>
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
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">{project.name}</h2>
            {isPersonal ? <PersonalBadge /> : null}
          </div>
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
          {isEditing ? (
            <label className="flex items-center gap-2 rounded-lg border border-stroke bg-panel-muted px-3 py-1.5 text-sm font-medium text-foreground">
              <input
                type="checkbox"
                checked={isPersonal}
                onChange={(event) => void updateField({ tags: setPersonalTag(project.tags, event.target.checked) })}
                disabled={saving}
                className="h-4 w-4 accent-violet-500"
              />
              Personal project
            </label>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => { setIsEditing((current) => { const next = !current; if (next && project) { loadDrafts(project); } return next; }); }}
          >
            {isEditing ? "Done Editing" : "Edit"}
          </Button>
        </div>

        {/* Detail grid */}
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <article className="rounded-lg bg-panel-muted p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Application</p>
            {project.implementation ? (
              <Link
                href={`/applications/${project.implementation.id}`}
                className="mt-1 block text-sm font-medium text-accent-text hover:underline"
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
              <Input
                size="xs"
                className="mt-1"
                type="date"
                value={targetDateDraft}
                onChange={(e) => setTargetDateDraft(e.target.value)}
                onBlur={() => {
                  if (!project) { return; } const currentTargetDate = dateOnlyToInputValue(project.target_date);
                  if (targetDateDraft !== currentTargetDate) { void updateField({ target_date: targetDateDraft || null }); };
                }}
                disabled={saving}
              />
            ) : (
              <p className="mt-1 text-sm font-medium text-foreground">{formatDateOnly(project.target_date)}</p>
            )}
          </article>

          <article className="rounded-lg bg-panel-muted p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">SPM ID</p>
            {isEditing ? (
              <Input
                size="xs"
                className="mt-1"
                type="text"
                value={spmIdDraft}
                onChange={(e) => setSpmIdDraft(e.target.value)}
                onBlur={() => {
                  if (!project) { return; } const currentSpmId = project.servicenow_spm_id ?? "";
                  if (spmIdDraft !== currentSpmId) { void updateField({ servicenow_spm_id: spmIdDraft || null }); };
                }}
                disabled={saving}
                placeholder="e.g. SPM-1234"
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
            <Textarea
              size="xs"
              className="mt-1"
              value={descriptionDraft}
              onChange={(e) => setDescriptionDraft(e.target.value)}
              onBlur={() => {
                if (!project) { return; } const currentDescription = project.description ?? "";
                if (descriptionDraft !== currentDescription) { void updateField({ description: descriptionDraft || null }); };
              }}
              disabled={saving}
              rows={2}
              placeholder="What is this project about?"
            />
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">{project.description || "No description set."}</p>
          )}
        </div>

        {/* Status Summary */}
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status Summary</p>
          {isEditing ? (
            <Textarea
              size="xs"
              className="mt-1"
              value={statusSummaryDraft}
              onChange={(e) => setStatusSummaryDraft(e.target.value)}
              onBlur={() => {
                if (!project) { return; } const currentStatusSummary = project.status_summary ?? "";
                if (statusSummaryDraft !== currentStatusSummary) { void updateField({ status_summary: statusSummaryDraft }); };
              }}
              disabled={saving}
              rows={2}
              placeholder="Current status in 1-2 sentences"
            />
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">{project.status_summary || "No status summary set."}</p>
          )}
        </div>
      </section>

      {/* ── Tasks Section ── */}
      <section className={cardClasses()}>
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
