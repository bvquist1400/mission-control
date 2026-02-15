"use client";

import { useMemo, useState } from "react";
import type { ImplPhase, RagStatus } from "@/types/database";
import { PhaseBadge } from "@/components/ui/PhaseBadge";
import { RagBadge } from "@/components/ui/RagBadge";

export interface ImplementationCardData {
  id: string;
  name: string;
  phase: ImplPhase;
  rag: RagStatus;
  targetDate: string | null;
  nextMilestone: string;
  nextMilestoneDate: string | null;
  statusSummary: string;
  blockersCount: number;
  nextAction: string;
}

interface ImplementationCardProps {
  implementation: ImplementationCardData;
}

function formatDate(date: string | null): string {
  if (!date) {
    return "Not set";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(date));
}

export function ImplementationCard({ implementation }: ImplementationCardProps) {
  const [copied, setCopied] = useState(false);

  const updateText = useMemo(() => {
    const blockersText = implementation.blockersCount > 0 ? String(implementation.blockersCount) : "None";
    return `${implementation.name} — ${implementation.phase} (${implementation.rag}). ${implementation.statusSummary} Next: ${implementation.nextMilestone}. Blocker(s): ${blockersText}.`;
  }, [implementation]);

  async function handleCopyUpdate() {
    try {
      await navigator.clipboard.writeText(updateText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <article className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">{implementation.name}</h3>
          <p className="mt-1 text-xs text-muted-foreground">Target: {formatDate(implementation.targetDate)}</p>
        </div>
        <div className="flex items-center gap-2">
          <PhaseBadge phase={implementation.phase} />
          <RagBadge status={implementation.rag} />
        </div>
      </div>

      <div className="mt-4 space-y-2 text-sm">
        <p className="text-muted-foreground">
          <span className="font-semibold text-foreground">Next milestone:</span> {implementation.nextMilestone} ({formatDate(implementation.nextMilestoneDate)})
        </p>
        <p className="text-muted-foreground">
          <span className="font-semibold text-foreground">Blockers:</span> {implementation.blockersCount}
        </p>
        <p className="text-muted-foreground">
          <span className="font-semibold text-foreground">Your next action:</span> {implementation.nextAction}
        </p>
      </div>

      <div className="mt-5 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{implementation.statusSummary}</p>
        <button
          type="button"
          onClick={handleCopyUpdate}
          className={`shrink-0 rounded-lg px-3 py-2 text-xs font-semibold transition ${
            copied ? "bg-green-100 text-green-700" : "bg-accent text-white hover:opacity-90"
          }`}
        >
          {copied ? "Copied" : "Copy Update"}
        </button>
      </div>
    </article>
  );
}
