"use client";

import type { TaskStatus } from "@/types/database";
import { Select } from "@/components/ui/Field";

const statuses: TaskStatus[] = ["Backlog", "Planned", "In Progress", "Blocked/Waiting", "Parked", "Missed", "Done"];

interface StatusSelectorProps {
  value: TaskStatus;
  onChange: (status: TaskStatus) => void;
}

export function StatusSelector({ value, onChange }: StatusSelectorProps) {
  return (
    <Select size="sm" value={value} onChange={(event) => onChange(event.target.value as TaskStatus)}>
      {statuses.map((status) => (
        <option key={status} value={status}>
          {status}
        </option>
      ))}
    </Select>
  );
}
