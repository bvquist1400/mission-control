"use client";

import Link from "next/link";
import { formatDateOnly } from "@/components/utils/dates";
import type { ProjectStage, RagStatus } from "@/types/database";
import { ProjectStageBadge } from "@/components/ui/ProjectStageBadge";
import { RagBadge } from "@/components/ui/RagBadge";

export interface ProjectCardData {
  id: string;
  name: string;
  stage: ProjectStage;
  rag: RagStatus;
  targetDate: string | null;
  statusSummary: string;
  description: string | null;
  servicenowSpmId: string | null;
  openTaskCount: number;
  blockersCount: number;
  implementationName: string | null;
  implementationId: string | null;
}

interface ProjectCardProps {
  project: ProjectCardData;
}

export function ProjectCard({ project }: ProjectCardProps) {
  return (
    <article className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">{project.name}</h3>
          <p className="mt-1 text-xs text-muted-foreground">Target: {formatDateOnly(project.targetDate)}</p>
        </div>
        <div className="flex items-center gap-2">
          <ProjectStageBadge stage={project.stage} />
          <RagBadge status={project.rag} />
        </div>
      </div>

      <div className="mt-4 space-y-2 text-sm">
        {project.implementationName && project.implementationId && (
          <p className="text-muted-foreground">
            <span className="font-semibold text-foreground">Application:</span>{" "}
            <Link
              href={`/applications/${project.implementationId}`}
              className="text-accent hover:underline"
            >
              {project.implementationName}
            </Link>
          </p>
        )}
        {project.servicenowSpmId && (
          <p className="text-muted-foreground">
            <span className="font-semibold text-foreground">SPM ID:</span> {project.servicenowSpmId}
          </p>
        )}
        <p className="text-muted-foreground">
          <span className="font-semibold text-foreground">Open tasks:</span>{" "}
          {project.openTaskCount}
          {project.blockersCount > 0 && (
            <span className="ml-2 text-red-400">({project.blockersCount} blocker{project.blockersCount !== 1 ? "s" : ""})</span>
          )}
        </p>
        {project.description && (
          <p className="line-clamp-2 text-muted-foreground">{project.description}</p>
        )}
      </div>

      <div className="mt-5 flex items-center justify-between gap-3">
        <p className="line-clamp-1 text-xs text-muted-foreground">{project.statusSummary}</p>
        <Link
          href={`/projects/${project.id}`}
          className="shrink-0 rounded-lg border border-stroke bg-panel px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-panel-muted"
        >
          Open
        </Link>
      </div>
    </article>
  );
}
