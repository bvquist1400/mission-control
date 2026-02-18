"use client";

import type { FocusBlock } from "@/lib/briefing";

interface FocusBlockDisplayProps {
  blocks: FocusBlock[];
  title?: string;
}

function formatBlockTime(isoTime: string): string {
  return new Date(isoTime).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

const suitabilityColors: Record<FocusBlock["suitableFor"], { bg: string; text: string; label: string }> = {
  deep: {
    bg: "bg-green-500/10",
    text: "text-green-400",
    label: "Deep work",
  },
  shallow: {
    bg: "bg-blue-500/10",
    text: "text-blue-400",
    label: "Shallow",
  },
  prep: {
    bg: "bg-yellow-500/10",
    text: "text-yellow-400",
    label: "Quick",
  },
};

export function FocusBlockDisplay({ blocks, title = "Focus Blocks" }: FocusBlockDisplayProps) {
  if (blocks.length === 0) {
    return (
      <div className="rounded-lg border border-stroke bg-panel p-4">
        <h3 className="mb-2 text-sm font-semibold text-foreground">{title}</h3>
        <p className="text-sm text-muted-foreground">No focus time available</p>
      </div>
    );
  }

  const totalMinutes = blocks.reduce((sum, b) => sum + b.minutes, 0);
  const deepBlocks = blocks.filter((b) => b.suitableFor === "deep");

  return (
    <div className="rounded-lg border border-stroke bg-panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <span className="text-xs text-muted-foreground">
          {totalMinutes} min total
          {deepBlocks.length > 0 && ` (${deepBlocks.length} deep)`}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        {blocks.map((block, index) => {
          const colors = suitabilityColors[block.suitableFor];
          return (
            <div
              key={index}
              className={`rounded-lg border border-stroke px-3 py-2 ${colors.bg}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">
                  {formatBlockTime(block.start_at)}-{formatBlockTime(block.end_at)}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${colors.bg} ${colors.text}`}>
                  {block.minutes}m
                </span>
              </div>
              <p className={`mt-0.5 text-xs ${colors.text}`}>{colors.label}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface FocusBlockInlineProps {
  blocks: FocusBlock[];
}

export function FocusBlockInline({ blocks }: FocusBlockInlineProps) {
  if (blocks.length === 0) {
    return <span className="text-muted-foreground">No focus time</span>;
  }

  const totalMinutes = blocks.reduce((sum, b) => sum + b.minutes, 0);
  const deepMinutes = blocks.filter((b) => b.suitableFor === "deep").reduce((sum, b) => sum + b.minutes, 0);

  return (
    <span className="text-sm">
      <span className="font-medium text-foreground">{totalMinutes} min</span>{" "}
      <span className="text-muted-foreground">focus time</span>
      {deepMinutes > 0 && (
        <>
          {" "}
          <span className="text-green-400">({deepMinutes} min deep)</span>
        </>
      )}
    </span>
  );
}
