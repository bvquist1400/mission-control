"use client";

import type { TaskStatus } from "@/types/database";

const statuses: TaskStatus[] = ["Next", "Scheduled", "Waiting", "Done"];

interface StatusSelectorProps {
  value: TaskStatus;
  onChange: (status: TaskStatus) => void;
}

export function StatusSelector({ value, onChange }: StatusSelectorProps) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as TaskStatus)}
      className="rounded-lg border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
    >
      {statuses.map((status) => (
        <option key={status} value={status}>
          {status}
        </option>
      ))}
    </select>
  );
}
