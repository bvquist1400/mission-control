"use client";

interface TriageActionsProps {
  blocker: boolean;
  isSaving?: boolean;
  onToggleBlocker: () => void;
  onDismiss: () => void;
}

export function TriageActions({ blocker, isSaving = false, onToggleBlocker, onDismiss }: TriageActionsProps) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onToggleBlocker}
        disabled={isSaving}
        className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
          blocker
            ? "border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
            : "border-stroke bg-panel text-muted-foreground hover:bg-panel-muted hover:text-foreground"
        }`}
      >
        {blocker ? "Blocker: On" : "Blocker: Off"}
      </button>

      <button
        type="button"
        onClick={onDismiss}
        disabled={isSaving}
        className="rounded-lg border border-stroke bg-panel px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
      >
        Dismiss
      </button>
    </div>
  );
}
