"use client";

import type { RagStatus } from "@/types/database";
import { Select } from "@/components/ui/Field";

const ragStatuses: RagStatus[] = ["Green", "Yellow", "Red"];

interface RagSelectorProps {
  value: RagStatus;
  onChange: (status: RagStatus) => void;
  disabled?: boolean;
}

export function RagSelector({ value, onChange, disabled }: RagSelectorProps) {
  return (
    <Select
      size="sm"
      value={value}
      onChange={(event) => onChange(event.target.value as RagStatus)}
      disabled={disabled}
    >
      {ragStatuses.map((status) => (
        <option key={status} value={status}>
          {status}
        </option>
      ))}
    </Select>
  );
}
