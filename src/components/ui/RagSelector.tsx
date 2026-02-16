"use client";

import type { RagStatus } from "@/types/database";

const ragStatuses: RagStatus[] = ["Green", "Yellow", "Red"];

interface RagSelectorProps {
  value: RagStatus;
  onChange: (status: RagStatus) => void;
  disabled?: boolean;
}

export function RagSelector({ value, onChange, disabled }: RagSelectorProps) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as RagStatus)}
      disabled={disabled}
      className="rounded-lg border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {ragStatuses.map((status) => (
        <option key={status} value={status}>
          {status}
        </option>
      ))}
    </select>
  );
}
