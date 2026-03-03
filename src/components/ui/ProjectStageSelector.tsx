"use client";

import { PROJECT_STAGE_LABELS, PROJECT_STAGE_VALUES } from "@/lib/project-stage";
import type { ProjectStage } from "@/types/database";

interface ProjectStageSelectorProps {
  value: ProjectStage;
  onChange: (stage: ProjectStage) => void;
  disabled?: boolean;
}

export function ProjectStageSelector({ value, onChange, disabled }: ProjectStageSelectorProps) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as ProjectStage)}
      disabled={disabled}
      className="rounded-lg border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {PROJECT_STAGE_VALUES.map((stage) => (
        <option key={stage} value={stage}>
          {PROJECT_STAGE_LABELS[stage]}
        </option>
      ))}
    </select>
  );
}
