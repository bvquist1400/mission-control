import { PROJECT_STAGE_LABELS } from "@/lib/project-stage";
import type { ProjectStage } from "@/types/database";

interface ProjectStageBadgeProps {
  stage: ProjectStage;
}

const stageStyles: Record<ProjectStage, string> = {
  Proposed: "bg-slate-500/15 text-slate-400",
  Planned: "bg-sky-500/15 text-sky-400",
  Ready: "bg-indigo-500/15 text-indigo-400",
  "In Progress": "bg-cyan-500/15 text-cyan-400",
  Blocked: "bg-rose-500/15 text-rose-400",
  Review: "bg-amber-500/15 text-amber-400",
  Done: "bg-emerald-500/15 text-emerald-400",
  "On Hold": "bg-slate-500/20 text-slate-300",
  Cancelled: "bg-orange-500/15 text-orange-300",
};

export function ProjectStageBadge({ stage }: ProjectStageBadgeProps) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${stageStyles[stage]}`}>
      {PROJECT_STAGE_LABELS[stage]}
    </span>
  );
}
