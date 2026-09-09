"use client";

import type { ImplPhase } from "@/types/database";
import { Select } from "@/components/ui/Field";

const phases: ImplPhase[] = [
  "Intake",
  "Discovery",
  "Design",
  "Build",
  "Test",
  "Training",
  "GoLive",
  "Hypercare",
  "Steady State",
  "Sundown",
];

const phaseLabels: Record<ImplPhase, string> = {
  Intake: "Intake",
  Discovery: "Discovery",
  Design: "Design",
  Build: "Build",
  Test: "Test",
  Training: "Training",
  GoLive: "Go-Live",
  Hypercare: "Hypercare",
  "Steady State": "Steady State",
  Sundown: "Sundown",
};

interface PhaseSelectorProps {
  value: ImplPhase;
  onChange: (phase: ImplPhase) => void;
  disabled?: boolean;
}

export function PhaseSelector({ value, onChange, disabled }: PhaseSelectorProps) {
  return (
    <Select
      size="sm"
      value={value}
      onChange={(event) => onChange(event.target.value as ImplPhase)}
      disabled={disabled}
    >
      {phases.map((phase) => (
        <option key={phase} value={phase}>
          {phaseLabels[phase]}
        </option>
      ))}
    </Select>
  );
}
