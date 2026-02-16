"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { ImplementationCard, type ImplementationCardData } from "@/components/implementations/ImplementationCard";
import type { ImplPhase, RagStatus } from "@/types/database";

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
  const response = await fetch("/api/implementations?with_stats=true", { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to fetch implementations");
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
      <p className="text-lg font-medium text-foreground">No implementations</p>
      <p className="mt-1 text-sm text-muted-foreground">Create your first implementation to get started.</p>
    </div>
  );
}

export default function ImplementationsPage() {
  const [implementations, setImplementations] = useState<ImplementationCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
          setError(err instanceof Error ? err.message : "Failed to load implementations");
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
    const response = await fetch(`/api/implementations/${implementationId}/copy-update`, {
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Implementations"
        description="Portfolio snapshot for execution health, milestones, blockers, and ready-to-send status updates."
      />

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
                href={`/implementations/${implementation.id}`}
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
