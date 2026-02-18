"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { ImplementationCard, type ImplementationCardData } from "@/components/implementations/ImplementationCard";
import { PhaseSelector } from "@/components/ui/PhaseSelector";
import { RagSelector } from "@/components/ui/RagSelector";
import type { ImplPhase, RagStatus } from "@/types/database";

interface ImplementationDraft {
  name: string;
  phase: ImplPhase;
  rag: RagStatus;
  targetDate: string;
  nextMilestone: string;
  statusSummary: string;
}

const INITIAL_DRAFT: ImplementationDraft = {
  name: "",
  phase: "Intake",
  rag: "Green",
  targetDate: "",
  nextMilestone: "",
  statusSummary: "",
};

interface ApiImplementation {
  id: string;
  name: string;
  phase: ImplPhase;
  rag: RagStatus;
  target_date: string | null;
  next_milestone: string;
  next_milestone_date: string | null;
  status_summary: string;
  blockers_count: number;
  next_action: { id: string; title: string } | null;
}

function apiToCardData(impl: ApiImplementation): ImplementationCardData {
  return {
    id: impl.id,
    name: impl.name,
    phase: impl.phase,
    rag: impl.rag,
    targetDate: impl.target_date,
    nextMilestone: impl.next_milestone || "Not set",
    nextMilestoneDate: impl.next_milestone_date,
    statusSummary: impl.status_summary || "No status summary available.",
    blockersCount: impl.blockers_count,
    nextAction: impl.next_action?.title || "No pending tasks",
  };
}

async function fetchImplementations(): Promise<ImplementationCardData[]> {
  const response = await fetch("/api/applications?with_stats=true", { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch applications");
  }

  const data: ApiImplementation[] = await response.json();
  return data.map(apiToCardData);
}

function LoadingSkeleton() {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {[1, 2].map((i) => (
        <div key={i} className="animate-pulse space-y-2">
          <div className="rounded-card border border-stroke bg-panel p-5">
            <div className="flex justify-between">
              <div className="h-5 w-48 rounded bg-panel-muted" />
              <div className="flex gap-2">
                <div className="h-6 w-16 rounded-full bg-panel-muted" />
                <div className="h-6 w-16 rounded-full bg-panel-muted" />
              </div>
            </div>
            <div className="mt-4 space-y-3">
              <div className="h-4 w-3/4 rounded bg-panel-muted" />
              <div className="h-4 w-1/2 rounded bg-panel-muted" />
              <div className="h-4 w-2/3 rounded bg-panel-muted" />
            </div>
          </div>
          <div className="h-8 w-24 rounded bg-panel-muted" />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-stroke bg-panel py-16 text-center">
      <p className="text-lg font-medium text-foreground">No applications</p>
      <p className="mt-1 text-sm text-muted-foreground">Create your first application using the form above.</p>
    </div>
  );
}

export default function ImplementationsPage() {
  const [implementations, setImplementations] = useState<ImplementationCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [draft, setDraft] = useState<ImplementationDraft>(INITIAL_DRAFT);

  useEffect(() => {
    let isMounted = true;

    async function loadData() {
      setLoading(true);
      setError(null);

      try {
        const data = await fetchImplementations();
        if (isMounted) {
          setImplementations(data);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : "Failed to load applications");
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    loadData();

    return () => {
      isMounted = false;
    };
  }, []);

  async function handleCopyUpdate(implementationId: string): Promise<string> {
    const response = await fetch(`/api/applications/${implementationId}/copy-update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ saveToLog: true }),
    });

    if (!response.ok) {
      throw new Error("Failed to generate status update");
    }

    const data = await response.json();
    return data.snippet;
  }

  async function createImplementation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const name = draft.name.trim();
    if (!name) {
      setError("Application name is required");
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const response = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          phase: draft.phase,
          rag: draft.rag,
          target_date: draft.targetDate || null,
          next_milestone: draft.nextMilestone,
          status_summary: draft.statusSummary,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Create failed" }));
        throw new Error(typeof data.error === "string" ? data.error : "Create failed");
      }

      // Refresh the list
      const updatedList = await fetchImplementations();
      setImplementations(updatedList);
      setDraft(INITIAL_DRAFT);
      setIsCreateOpen(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Failed to create application");
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Applications"
        description="Portfolio snapshot for execution health, milestones, blockers, and ready-to-send status updates."
      />

      {/* Create Implementation Form */}
      <section className="rounded-card border border-stroke bg-panel p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Add Application</h2>
            <p className="text-xs text-muted-foreground">Track a new app, project, or initiative.</p>
          </div>
          <button
            type="button"
            onClick={() => setIsCreateOpen((open) => !open)}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
          >
            {isCreateOpen ? "Close" : "+ New"}
          </button>
        </div>

        {isCreateOpen && (
          <form onSubmit={createImplementation} className="mt-4 space-y-4 border-t border-stroke pt-4">
            <label className="block space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Name</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="e.g., Workday Recruiting, ServiceNow ITSM..."
                disabled={isCreating}
                className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Phase</span>
                <PhaseSelector
                  value={draft.phase}
                  onChange={(phase) => setDraft((d) => ({ ...d, phase }))}
                  disabled={isCreating}
                />
              </label>

              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">RAG Status</span>
                <RagSelector
                  value={draft.rag}
                  onChange={(rag) => setDraft((d) => ({ ...d, rag }))}
                  disabled={isCreating}
                />
              </label>

              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Target Date</span>
                <input
                  type="date"
                  value={draft.targetDate}
                  onChange={(e) => setDraft((d) => ({ ...d, targetDate: e.target.value }))}
                  disabled={isCreating}
                  className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>

              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Next Milestone</span>
                <input
                  type="text"
                  value={draft.nextMilestone}
                  onChange={(e) => setDraft((d) => ({ ...d, nextMilestone: e.target.value }))}
                  placeholder="e.g., UAT Complete"
                  disabled={isCreating}
                  className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>
            </div>

            <label className="block space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status Summary</span>
              <input
                value={draft.statusSummary}
                onChange={(e) => setDraft((d) => ({ ...d, statusSummary: e.target.value }))}
                placeholder="Brief status for stakeholders..."
                disabled={isCreating}
                className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setDraft(INITIAL_DRAFT);
                  setIsCreateOpen(false);
                }}
                disabled={isCreating}
                className="rounded-lg border border-stroke bg-panel px-3 py-2 text-sm font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isCreating}
                className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isCreating ? "Creating..." : "Create"}
              </button>
            </div>
          </form>
        )}
      </section>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <LoadingSkeleton />
      ) : implementations.length === 0 ? (
        <EmptyState />
      ) : (
        <section className="grid gap-4 xl:grid-cols-2">
          {implementations.map((implementation) => (
            <div key={implementation.id} className="space-y-2">
              <ImplementationCard implementation={implementation} onCopyUpdate={handleCopyUpdate} />
              <Link
                href={`/applications/${implementation.id}`}
                className="inline-flex rounded-lg border border-stroke bg-panel px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
              >
                Open details
              </Link>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
