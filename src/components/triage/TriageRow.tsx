"use client";

import { EstimateButtons } from "@/components/ui/EstimateButtons";
import { StatusSelector } from "@/components/ui/StatusSelector";
import { TriageActions } from "@/components/triage/TriageActions";
import type { ImplementationSummary, TaskUpdatePayload, TaskWithImplementation } from "@/types/database";

interface TriageRowProps {
  task: TaskWithImplementation;
  implementations: ImplementationSummary[];
  isSaving?: boolean;
  onUpdate: (taskId: string, updates: TaskUpdatePayload) => Promise<void>;
  onDismiss: (taskId: string) => Promise<void>;
}

function isoToDate(isoString: string | null): string {
  if (!isoString) {
    return "";
  }
  return isoString.split("T")[0];
}

function dateToIso(dateString: string): string {
  const date = new Date(`${dateString}T23:59:59`);
  return date.toISOString();
}

export function TriageRow({ task, implementations, isSaving = false, onUpdate, onDismiss }: TriageRowProps) {
  return (
    <article className="rounded-card border border-stroke bg-panel p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="max-w-3xl text-sm font-semibold leading-relaxed text-foreground">{task.title}</h3>
        <TriageActions
          blocker={task.blocker}
          isSaving={isSaving}
          onToggleBlocker={() => onUpdate(task.id, { blocker: !task.blocker })}
          onDismiss={() => onDismiss(task.id)}
        />
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Application</span>
          <select
            value={task.implementation_id ?? ""}
            onChange={(event) =>
              onUpdate(task.id, {
                implementation_id: event.target.value || null,
              })
            }
            disabled={isSaving}
            className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="">Unassigned</option>
            {implementations.map((implementation) => (
              <option key={implementation.id} value={implementation.id}>
                {implementation.name}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Estimate (min)</span>
          <EstimateButtons
            value={task.estimated_minutes}
            onChange={(minutes) => onUpdate(task.id, { estimated_minutes: minutes, estimate_source: "manual" })}
          />
        </label>

        <label className="space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</span>
          <StatusSelector value={task.status} onChange={(status) => onUpdate(task.id, { status })} />
        </label>

        <label className="space-y-1 md:col-span-2 xl:col-span-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Due Date</span>
          <input
            type="date"
            value={isoToDate(task.due_at)}
            onChange={(event) => {
              const { value } = event.target;
              onUpdate(task.id, { due_at: value ? dateToIso(value) : null });
            }}
            disabled={isSaving}
            className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>
      </div>
    </article>
  );
}
