"use client";

import { PROJECT_STAGE_LABELS, PROJECT_STAGE_VALUES } from "@/lib/project-stage";
import type { ProjectStage } from "@/types/database";
import { Select } from "@/components/ui/Field";

interface ProjectStageSelectorProps {
  value: ProjectStage;
  onChange: (stage: ProjectStage) => void;
  disabled?: boolean;
}

export function ProjectStageSelector({ value, onChange, disabled }: ProjectStageSelectorProps) {
  return (
    <Select
      size="sm"
      value={value}
      onChange={(event) => onChange(event.target.value as ProjectStage)}
      disabled={disabled}
    >
      {PROJECT_STAGE_VALUES.map((stage) => (
        <option key={stage} value={stage}>
          {PROJECT_STAGE_LABELS[stage]}
        </option>
      ))}
    </Select>
  );
}
