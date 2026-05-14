"use client";

import Link from "next/link";
import { formatDateOnly } from "@/components/utils/dates";
import { ProjectStageBadge } from "@/components/ui/ProjectStageBadge";
import { RagBadge } from "@/components/ui/RagBadge";
import type { ProjectCardData } from "@/components/projects/ProjectCard";

interface ProjectTableProps {
  projects: ProjectCardData[];
}

export function ProjectTable({ projects }: ProjectTableProps) {
  return (
    <section className="rounded-card border border-stroke bg-panel shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1240px] text-sm">
          <thead className="border-b border-stroke bg-panel-muted/50">
            <tr>
              <th className="w-[300px] px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Name</th>
              <th className="w-[130px] px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Stage</th>
              <th className="w-[90px] px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">RAG</th>
              <th className="w-[70px] px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Rank</th>
              <th className="w-[190px] px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Application</th>
              <th className="w-[120px] px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Target date</th>
              <th className="w-[160px] px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Progress</th>
              <th className="w-[90px] px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Open tasks</th>
              <th className="w-[80px] px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Blockers</th>
              <th className="w-[120px] px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Last updated</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.id} className="border-b border-stroke/60 last:border-b-0 hover:bg-panel-muted/30">
                <td className="px-3 py-2.5 align-top">
                  <Link
                    href={`/projects/${project.id}`}
                    title={project.name}
                    className="block max-w-[300px] truncate font-medium text-foreground hover:text-accent hover:underline"
                  >
                    {project.name}
                  </Link>
                </td>
                <td className="px-3 py-2.5 align-top">
                  <ProjectStageBadge stage={project.stage} />
                </td>
                <td className="px-3 py-2.5 align-top">
                  <RagBadge status={project.rag} />
                </td>
                <td className="px-3 py-2.5 text-right align-top font-medium text-foreground">{project.portfolioRank}</td>
                <td className="px-3 py-2.5 align-top text-muted-foreground">
                  {project.implementationName && project.implementationId ? (
                    <Link href={`/applications/${project.implementationId}`} className="text-accent hover:underline">
                      {project.implementationName}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2.5 align-top text-muted-foreground">{formatDateOnly(project.targetDate)}</td>
                <td className="px-3 py-2.5 align-top">
                  <div className="flex items-center justify-end gap-2">
                    <span className="text-xs font-semibold tabular-nums text-foreground">{project.completionPct}%</span>
                    <div
                      role="progressbar"
                      aria-label={`${project.name} progress`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={project.completionPct}
                      className="h-1.5 w-20 overflow-hidden rounded-full bg-panel-muted"
                    >
                      <div
                        className="h-full rounded-full bg-green-500 transition-all duration-500"
                        style={{ width: `${Math.max(0, Math.min(100, project.completionPct))}%` }}
                      />
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right align-top font-medium text-foreground">{project.openTaskCount}</td>
                <td className="px-3 py-2.5 text-right align-top">
                  {project.blockersCount > 0 ? (
                    <span className="font-semibold text-red-400">{project.blockersCount}</span>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </td>
                <td className="px-3 py-2.5 align-top text-muted-foreground">{formatDateOnly(project.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
