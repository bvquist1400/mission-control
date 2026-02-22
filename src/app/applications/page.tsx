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
  portfolio_rank: number | null;
  priority_weight: number | null;
}

interface ApplicationListItem extends ImplementationCardData {
  portfolioRank: number;
  priorityWeight: number;
}

function apiToListItem(impl: ApiImplementation, fallbackRank: number): ApplicationListItem {
  const portfolioRank =
    typeof impl.portfolio_rank === "number" && Number.isFinite(impl.portfolio_rank)
      ? Math.max(1, Math.round(impl.portfolio_rank))
      : fallbackRank;
  const priorityWeight =
    typeof impl.priority_weight === "number" && Number.isFinite(impl.priority_weight)
      ? Math.max(0, Math.min(10, Math.round(impl.priority_weight)))
      : 5;

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
    portfolioRank,
    priorityWeight,
  };
}

function normalizeRankedList(items: ApplicationListItem[]): ApplicationListItem[] {
  const sorted = [...items].sort((a, b) => {
    if (a.portfolioRank !== b.portfolioRank) {
      return a.portfolioRank - b.portfolioRank;
    }
    return a.name.localeCompare(b.name);
  });

  return sorted.map((item, index) => ({
    ...item,
    portfolioRank: index + 1,
  }));
}

function moveBefore(
  items: ApplicationListItem[],
  sourceId: string,
  targetId: string
): ApplicationListItem[] {
  const sourceIndex = items.findIndex((item) => item.id === sourceId);
  const targetIndex = items.findIndex((item) => item.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return items;
  }

  const next = [...items];
  const [moved] = next.splice(sourceIndex, 1);
  const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  next.splice(adjustedTargetIndex, 0, moved);
  return next.map((item, index) => ({ ...item, portfolioRank: index + 1 }));
}

function moveToBottom(items: ApplicationListItem[], sourceId: string): ApplicationListItem[] {
  const sourceIndex = items.findIndex((item) => item.id === sourceId);
  if (sourceIndex < 0 || sourceIndex === items.length - 1) {
    return items;
  }

  const next = [...items];
  const [moved] = next.splice(sourceIndex, 1);
  next.push(moved);
  return next.map((item, index) => ({ ...item, portfolioRank: index + 1 }));
}

function moveByOffset(
  items: ApplicationListItem[],
  sourceId: string,
  offset: number
): ApplicationListItem[] {
  const sourceIndex = items.findIndex((item) => item.id === sourceId);
  if (sourceIndex < 0) {
    return items;
  }

  const targetIndex = Math.max(0, Math.min(items.length - 1, sourceIndex + offset));
  if (sourceIndex === targetIndex) {
    return items;
  }

  const next = [...items];
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, moved);
  return next.map((item, index) => ({ ...item, portfolioRank: index + 1 }));
}

async function fetchImplementations(): Promise<ApplicationListItem[]> {
  const response = await fetch("/api/applications?with_stats=true", { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch applications");
  }

  const data: ApiImplementation[] = await response.json();
  const mapped = data.map((impl, index) => apiToListItem(impl, index + 1));
  return normalizeRankedList(mapped);
}

async function saveImplementationOrder(orderedIds: string[]): Promise<void> {
  const response = await fetch("/api/applications/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ordered_ids: orderedIds }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "Failed to save order" }));
    throw new Error(typeof data.error === "string" ? data.error : "Failed to save order");
  }
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
  const [implementations, setImplementations] = useState<ApplicationListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isReordering, setIsReordering] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
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

    void loadData();

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

  async function applyOrderChange(nextOrder: ApplicationListItem[], previousOrder: ApplicationListItem[]) {
    const unchanged =
      nextOrder.length === previousOrder.length &&
      nextOrder.every((item, index) => item.id === previousOrder[index]?.id);

    if (unchanged) {
      return;
    }

    setImplementations(nextOrder);
    setIsReordering(true);
    setError(null);

    try {
      await saveImplementationOrder(nextOrder.map((item) => item.id));
    } catch (orderError) {
      setImplementations(previousOrder);
      setError(orderError instanceof Error ? orderError.message : "Failed to save application ranking");
    } finally {
      setIsReordering(false);
    }
  }

  function handleDragStart(event: React.DragEvent<HTMLTableRowElement>, id: string) {
    if (isReordering) {
      event.preventDefault();
      return;
    }

    event.dataTransfer.effectAllowed = "move";
    setDraggingId(id);
    setDragOverId(null);
  }

  function handleDragOver(event: React.DragEvent<HTMLTableRowElement>, id: string) {
    if (isReordering || !draggingId) {
      return;
    }

    event.preventDefault();
    if (draggingId !== id) {
      setDragOverId(id);
    }
  }

  async function handleDrop(event: React.DragEvent<HTMLTableRowElement>, targetId: string) {
    event.preventDefault();

    if (isReordering || !draggingId) {
      return;
    }

    const previous = implementations;
    const next = moveBefore(previous, draggingId, targetId);
    setDraggingId(null);
    setDragOverId(null);
    await applyOrderChange(next, previous);
  }

  async function handleDropToBottom(event: React.DragEvent<HTMLTableRowElement>) {
    event.preventDefault();

    if (isReordering || !draggingId) {
      return;
    }

    const previous = implementations;
    const next = moveToBottom(previous, draggingId);
    setDraggingId(null);
    setDragOverId(null);
    await applyOrderChange(next, previous);
  }

  function handleDragEnd() {
    setDraggingId(null);
    setDragOverId(null);
  }

  async function handleMoveByOffset(implementationId: string, offset: number) {
    if (isReordering) {
      return;
    }

    const previous = implementations;
    const next = moveByOffset(previous, implementationId, offset);
    await applyOrderChange(next, previous);
  }

  const sundownImplementations = implementations.filter((implementation) => implementation.phase === "Sundown");
  const activeImplementations = implementations.filter((implementation) => implementation.phase !== "Sundown");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Applications"
        description="Portfolio snapshot for execution health, milestones, blockers, and ready-to-send status updates."
      />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}

      {!loading && implementations.length > 0 ? (
        <section className="rounded-card border border-stroke bg-panel p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Priority Ranking</h2>
              <p className="text-xs text-muted-foreground">
                Drag rows to rank applications. Top rows are treated as higher priority.
              </p>
            </div>
            <span className="text-xs text-muted-foreground">{isReordering ? "Saving rank..." : `${implementations.length} applications`}</span>
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[860px] border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  <th className="w-[70px] border-b border-stroke px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Rank</th>
                  <th className="border-b border-stroke px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Application</th>
                  <th className="w-[140px] border-b border-stroke px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Phase</th>
                  <th className="w-[90px] border-b border-stroke px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">RAG</th>
                  <th className="w-[90px] border-b border-stroke px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Blockers</th>
                  <th className="w-[340px] border-b border-stroke px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Next action</th>
                  <th className="w-[100px] border-b border-stroke px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Move</th>
                </tr>
              </thead>
              <tbody>
                {implementations.map((implementation, index) => {
                  const rowIsDragging = draggingId === implementation.id;
                  const rowIsDropTarget = dragOverId === implementation.id && draggingId !== implementation.id;
                  return (
                    <tr
                      key={implementation.id}
                      draggable={!isReordering}
                      onDragStart={(event) => handleDragStart(event, implementation.id)}
                      onDragOver={(event) => handleDragOver(event, implementation.id)}
                      onDrop={(event) => void handleDrop(event, implementation.id)}
                      onDragEnd={handleDragEnd}
                      className={`transition ${rowIsDragging ? "opacity-40" : ""} ${rowIsDropTarget ? "bg-accent-soft/35" : ""}`}
                    >
                      <td className="border-b border-stroke/70 px-3 py-2 text-sm font-semibold text-foreground">{index + 1}</td>
                      <td className="border-b border-stroke/70 px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={`select-none rounded border border-stroke px-1.5 py-0.5 text-[10px] text-muted-foreground ${
                              isReordering ? "cursor-not-allowed opacity-60" : "cursor-grab"
                            }`}
                          >
                            DRAG
                          </span>
                          <Link href={`/applications/${implementation.id}`} className="font-medium text-foreground hover:underline">
                            {implementation.name}
                          </Link>
                        </div>
                      </td>
                      <td className="border-b border-stroke/70 px-3 py-2 text-muted-foreground">{implementation.phase}</td>
                      <td className="border-b border-stroke/70 px-3 py-2 text-muted-foreground">{implementation.rag}</td>
                      <td className="border-b border-stroke/70 px-3 py-2">
                        {implementation.blockersCount > 0 ? (
                          <span className="font-semibold text-red-400">{implementation.blockersCount}</span>
                        ) : (
                          <span className="text-green-400">0</span>
                        )}
                      </td>
                      <td className="border-b border-stroke/70 px-3 py-2 text-muted-foreground">
                        <span className="block max-w-[340px] truncate">{implementation.nextAction}</span>
                      </td>
                      <td className="border-b border-stroke/70 px-3 py-2">
                        <div className="flex justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => void handleMoveByOffset(implementation.id, -1)}
                            disabled={isReordering || index === 0}
                            className="rounded border border-stroke px-2 py-1 text-xs text-muted-foreground transition hover:bg-panel-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label={`Move ${implementation.name} up`}
                          >
                            Up
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleMoveByOffset(implementation.id, 1)}
                            disabled={isReordering || index === implementations.length - 1}
                            className="rounded border border-stroke px-2 py-1 text-xs text-muted-foreground transition hover:bg-panel-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label={`Move ${implementation.name} down`}
                          >
                            Down
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                <tr onDragOver={(event) => event.preventDefault()} onDrop={(event) => void handleDropToBottom(event)}>
                  <td colSpan={7} className="px-3 py-2 text-center text-xs text-muted-foreground">
                    Drop here to move an application to the bottom
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

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

      {loading ? (
        <LoadingSkeleton />
      ) : implementations.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-6">
          {activeImplementations.length > 0 && (
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground">Active Portfolio</h2>
                <span className="text-xs text-muted-foreground">{activeImplementations.length} applications</span>
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                {activeImplementations.map((implementation) => (
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
              </div>
            </section>
          )}

          {sundownImplementations.length > 0 && (
            <section className="rounded-card border border-orange-500/30 bg-orange-500/5 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-orange-300">Sundown Track</h2>
                <span className="text-xs text-orange-200/80">{sundownImplementations.length} applications</span>
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                {sundownImplementations.map((implementation) => (
                  <div key={implementation.id} className="space-y-2">
                    <ImplementationCard implementation={implementation} onCopyUpdate={handleCopyUpdate} />
                    <Link
                      href={`/applications/${implementation.id}`}
                      className="inline-flex rounded-lg border border-orange-400/40 bg-panel px-3 py-1.5 text-xs font-semibold text-orange-200 transition hover:bg-panel-muted"
                    >
                      Open details
                    </Link>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
