import type { ImplPhase } from "@/types/database";

interface PhaseBadgeProps {
  phase: ImplPhase;
}

const phaseStyles: Record<ImplPhase, string> = {
  Intake: "bg-slate-100 text-slate-700",
  Discovery: "bg-sky-100 text-sky-700",
  Design: "bg-indigo-100 text-indigo-700",
  Build: "bg-cyan-100 text-cyan-700",
  Test: "bg-amber-100 text-amber-700",
  Training: "bg-emerald-100 text-emerald-700",
  GoLive: "bg-teal-100 text-teal-700",
  Hypercare: "bg-rose-100 text-rose-700",
};

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

export function PhaseBadge({ phase }: PhaseBadgeProps) {
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${phaseStyles[phase]}`}>{phaseLabels[phase]}</span>;
}
