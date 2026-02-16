"use client";

import { useState } from "react";
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
  onCopyUpdate?: (implementationId: string) => Promise<string>;
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

type CopyState = "idle" | "loading" | "copied" | "error";

export function ImplementationCard({ implementation, onCopyUpdate }: ImplementationCardProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");

  async function handleCopyUpdate() {
    if (copyState === "loading") return;

    setCopyState("loading");

    try {
      let snippet: string;

      if (onCopyUpdate) {
        // Use API to generate snippet
        snippet = await onCopyUpdate(implementation.id);
      } else {
        // Fallback: generate locally
        const blockersText = implementation.blockersCount > 0 ? String(implementation.blockersCount) : "None";
        snippet = `${implementation.name} — ${implementation.phase} (${implementation.rag}). ${implementation.statusSummary} Next: ${implementation.nextMilestone}. Blocker(s): ${blockersText}.`;
      }

      await navigator.clipboard.writeText(snippet);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1600);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 2000);
    }
  }

  const buttonText = {
    idle: "Copy Update",
    loading: "Generating...",
    copied: "Copied",
    error: "Failed",
  }[copyState];

  const buttonClass = {
    idle: "bg-accent text-white hover:opacity-90",
    loading: "bg-accent/60 text-white cursor-wait",
    copied: "bg-green-500/15 text-green-400",
    error: "bg-red-500/15 text-red-400",
  }[copyState];

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
          <span className="font-semibold text-foreground">Blockers:</span>{" "}
          {implementation.blockersCount > 0 ? (
            <span className="text-red-400">{implementation.blockersCount}</span>
          ) : (
            <span className="text-green-400">None</span>
          )}
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
          disabled={copyState === "loading"}
          className={`shrink-0 rounded-lg px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed ${buttonClass}`}
        >
          {buttonText}
        </button>
      </div>
    </article>
  );
}
