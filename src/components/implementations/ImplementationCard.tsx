"use client";

import { useState } from "react";
import { formatDateOnly } from "@/components/utils/dates";
import type { HealthLabel, HealthTrend, ImplPhase, RagStatus } from "@/types/database";
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
  healthScore?: number | null;
  healthLabel?: HealthLabel | null;
  healthTrend?: HealthTrend;
  healthSignals?: string[];
}

interface ImplementationCardProps {
  implementation: ImplementationCardData;
  onCopyUpdate?: (implementationId: string) => Promise<string>;
}

type CopyState = "idle" | "loading" | "copied" | "error";

function healthTone(label: HealthLabel | null | undefined): string {
  switch (label) {
    case "Healthy":
      return "text-emerald-400";
    case "Watch":
      return "text-amber-300";
    case "At Risk":
      return "text-orange-300";
    case "Critical":
      return "text-red-400";
    default:
      return "text-muted-foreground";
  }
}

function trendLabel(trend: HealthTrend | undefined): string {
  switch (trend) {
    case "improving":
      return "Improving";
    case "degrading":
      return "Degrading";
    case "stable":
      return "Stable";
    default:
      return "No baseline";
  }
}

export function ImplementationCard({ implementation, onCopyUpdate }: ImplementationCardProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const isSundown = implementation.phase === "Sundown";

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
    <article
      className={`rounded-card border p-5 shadow-sm ${
        isSundown ? "border-orange-500/35 bg-orange-500/5" : "border-stroke bg-panel"
      }`}
    >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-foreground">{implementation.name}</h3>
            <p className="mt-1 text-xs text-muted-foreground">Target: {formatDateOnly(implementation.targetDate)}</p>
          </div>
        <div className="flex items-center gap-2">
          <PhaseBadge phase={implementation.phase} />
          <RagBadge status={implementation.rag} />
        </div>
      </div>

      <div className="mt-4 space-y-2 text-sm">
        <p className="text-muted-foreground">
          <span className="font-semibold text-foreground">Next milestone:</span> {implementation.nextMilestone} ({formatDateOnly(implementation.nextMilestoneDate)})
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
        {typeof implementation.healthScore === "number" ? (
          <p className="text-muted-foreground">
            <span className="font-semibold text-foreground">Execution health:</span>{" "}
            <span className={healthTone(implementation.healthLabel)}>
              {implementation.healthLabel || "Unknown"} ({implementation.healthScore})
            </span>{" "}
            · {trendLabel(implementation.healthTrend)}
          </p>
        ) : null}
        {implementation.healthSignals && implementation.healthSignals.length > 0 ? (
          <p className="text-xs text-muted-foreground">{implementation.healthSignals.slice(0, 2).join(" · ")}</p>
        ) : null}
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
