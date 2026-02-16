import type { ImplPhase } from "@/types/database";

interface PhaseBadgeProps {
  phase: ImplPhase;
}

const phaseStyles: Record<ImplPhase, string> = {
  Intake: "bg-slate-500/15 text-slate-400",
  Discovery: "bg-sky-500/15 text-sky-400",
  Design: "bg-indigo-500/15 text-indigo-400",
  Build: "bg-cyan-500/15 text-cyan-400",
  Test: "bg-amber-500/15 text-amber-400",
  Training: "bg-emerald-500/15 text-emerald-400",
  GoLive: "bg-teal-500/15 text-teal-400",
  Hypercare: "bg-rose-500/15 text-rose-400",
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
