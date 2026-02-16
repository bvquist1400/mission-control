"use client";

import type { ImplPhase } from "@/types/database";

const phases: ImplPhase[] = ["Intake", "Discovery", "Design", "Build", "Test", "Training", "GoLive", "Hypercare"];

const phaseLabels: Record<ImplPhase, string> = {
  Intake: "Intake",
  Discovery: "Discovery",
  Design: "Design",
  Build: "Build",
  Test: "Test",
  Training: "Training",
  GoLive: "Go-Live",
  Hypercare: "Hypercare",
};

interface PhaseSelectorProps {
  value: ImplPhase;
  onChange: (phase: ImplPhase) => void;
  disabled?: boolean;
}

export function PhaseSelector({ value, onChange, disabled }: PhaseSelectorProps) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as ImplPhase)}
      disabled={disabled}
      className="rounded-lg border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {phases.map((phase) => (
        <option key={phase} value={phase}>
          {phaseLabels[phase]}
        </option>
      ))}
    </select>
  );
}
