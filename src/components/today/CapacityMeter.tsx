"use client";

import { useState } from "react";
import type { CapacityResult, RagStatus } from "@/types/database";
import { formatCapacityDisplay, getCapacityBreakdown } from "@/lib/capacity";

interface CapacityMeterProps {
  capacity: CapacityResult;
}

const ragColors: Record<RagStatus, { bg: string; text: string; border: string; bar: string }> = {
  Green: {
    bg: "bg-green-500/10",
    text: "text-green-400",
    border: "border-green-500/30",
    bar: "bg-green-500",
  },
  Yellow: {
    bg: "bg-yellow-500/10",
    text: "text-yellow-400",
    border: "border-yellow-500/30",
    bar: "bg-yellow-500",
  },
  Red: {
    bg: "bg-red-500/10",
    text: "text-red-400",
    border: "border-red-500/30",
    bar: "bg-red-500",
  },
};

export function CapacityMeter({ capacity }: CapacityMeterProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const colors = ragColors[capacity.rag];
  const breakdown = getCapacityBreakdown(capacity);
  const displayText = formatCapacityDisplay(capacity);

  // Calculate fill percentage (capped at 100% for display)
  const fillPercent = Math.min(
    100,
    (capacity.required_minutes / capacity.available_minutes) * 100
  );

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-label={isExpanded ? "Hide capacity breakdown" : "Show capacity breakdown"}
        className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition hover:opacity-80 ${colors.bg} ${colors.border} ${colors.text}`}
        title="Click to see capacity breakdown"
      >
        {/* Mini progress bar */}
        <div className="relative h-2 w-12 overflow-hidden rounded-full bg-panel-muted">
          <div
            className={`absolute inset-y-0 left-0 rounded-full ${colors.bar}`}
            style={{ width: `${fillPercent}%` }}
          />
        </div>
        <span>{displayText}</span>
        <svg
          className={`h-3 w-3 transition-transform ${isExpanded ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isExpanded && (
        <div className={`absolute right-0 top-full z-10 mt-2 w-64 rounded-lg border bg-panel p-4 shadow-lg ${colors.border}`}>
          <div className="mb-3 flex items-center justify-between">
            <h4 className="text-sm font-semibold text-foreground">Capacity Breakdown</h4>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${colors.bg} ${colors.text}`}>
              {capacity.rag}
            </span>
          </div>

          <ul className="space-y-1.5 text-xs">
            {breakdown.map((line, index) => {
              const isTotal = line.startsWith("=");
              const isRequired = line.startsWith("Required:");

              return (
                <li
                  key={index}
                  className={`flex justify-between ${
                    isTotal || isRequired
                      ? "mt-2 border-t border-stroke pt-2 font-semibold text-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  <span>{line.replace(/^= /, "")}</span>
                </li>
              );
            })}
          </ul>

          {capacity.rag !== "Green" && (
            <p className={`mt-3 text-xs ${colors.text}`}>
              {capacity.rag === "Yellow"
                ? "Slightly over capacity. Consider rescheduling or reducing estimates."
                : "Significantly over capacity. Some tasks will need to be moved."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
