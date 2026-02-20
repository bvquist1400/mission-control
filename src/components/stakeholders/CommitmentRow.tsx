"use client";

import { useState } from "react";
import type { CommitmentStatus, CommitmentDirection } from "@/types/database";
import { formatRelativeDate } from "@/components/utils/dates";

export interface CommitmentRowData {
  id: string;
  title: string;
  direction: CommitmentDirection;
  status: CommitmentStatus;
  due_at: string | null;
  done_at: string | null;
  notes: string | null;
  task: { id: string; title: string; status: string } | null;
}

interface CommitmentRowProps {
  commitment: CommitmentRowData;
  onStatusChange: (id: string, status: CommitmentStatus) => Promise<void>;
}

export function CommitmentRow({ commitment, onStatusChange }: CommitmentRowProps) {
  const [updating, setUpdating] = useState(false);

  const isDone = commitment.status === "Done";
  const isDropped = commitment.status === "Dropped";

  const isOverdue =
    commitment.status === "Open" &&
    commitment.due_at &&
    new Date(commitment.due_at) < new Date();

  async function handleToggle() {
    setUpdating(true);
    try {
      await onStatusChange(commitment.id, isDone ? "Open" : "Done");
    } finally {
      setUpdating(false);
    }
  }

  return (
    <div
      className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 transition ${
        isDone || isDropped
          ? "border-stroke/50 bg-panel-muted/50 opacity-60"
          : isOverdue
            ? "border-red-200 bg-red-50/50"
            : "border-stroke bg-panel"
      }`}
    >
      <button
        type="button"
        onClick={handleToggle}
        disabled={updating || isDropped}
        aria-label={isDone ? "Mark as open" : "Mark as done"}
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
          isDone
            ? "border-green-500 bg-green-500 text-white"
            : "border-stroke hover:border-accent"
        } disabled:cursor-not-allowed disabled:opacity-50`}
      >
        {isDone && (
          <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2 6l3 3 5-5" />
          </svg>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={`text-sm ${isDone || isDropped ? "line-through text-muted-foreground" : "text-foreground"}`}
          >
            {commitment.title}
          </span>
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              commitment.direction === "ours"
                ? "bg-blue-100 text-blue-700"
                : "bg-purple-100 text-purple-700"
            }`}
          >
            {commitment.direction === "ours" ? "We owe" : "They owe"}
          </span>
          {isDropped && (
            <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-600">
              Dropped
            </span>
          )}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {commitment.due_at && (
            <span className={isOverdue ? "font-semibold text-red-600" : ""}>
              Due {formatRelativeDate(commitment.due_at)}
            </span>
          )}
          {commitment.task && (
            <span className="truncate">
              Task: {commitment.task.title}
            </span>
          )}
          {commitment.notes && (
            <span className="truncate italic">{commitment.notes}</span>
          )}
        </div>
      </div>
    </div>
  );
}
