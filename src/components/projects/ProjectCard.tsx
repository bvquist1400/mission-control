"use client";

import Link from "next/link";
import type { ImplPhase, RagStatus } from "@/types/database";
import { PhaseBadge } from "@/components/ui/PhaseBadge";
import { RagBadge } from "@/components/ui/RagBadge";

export interface ProjectCardData {
  id: string;
  name: string;
  phase: ImplPhase;
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

function formatDate(date: string | null): string {
  if (!date) return "Not set";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(date + "T12:00:00")); // noon to avoid timezone off-by-one
}

export function ProjectCard({ project }: ProjectCardProps) {
  return (
    <article className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">{project.name}</h3>
          <p className="mt-1 text-xs text-muted-foreground">Target: {formatDate(project.targetDate)}</p>
        </div>
        <div className="flex items-center gap-2">
          <PhaseBadge phase={project.phase} />
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
