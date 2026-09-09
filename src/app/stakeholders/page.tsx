"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { StakeholderCard, type StakeholderCardData } from "@/components/stakeholders/StakeholderCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { cardClasses } from "@/components/ui/Card";

interface StakeholderDraft {
  name: string;
  email: string;
  role: string;
  organization: string;
}

const INITIAL_DRAFT: StakeholderDraft = {
  name: "",
  email: "",
  role: "",
  organization: "",
};

async function fetchStakeholders(search?: string): Promise<StakeholderCardData[]> {
  const params = new URLSearchParams();
  if (search) params.set("search", search);

  const response = await fetch(`/api/stakeholders?${params}`, { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch stakeholders");
  }

  return response.json();
}

function LoadingSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {[1, 2, 3].map((i) => (
        <div key={i} className="animate-pulse rounded-card border border-stroke bg-panel p-4">
          <div className="h-4 w-32 rounded bg-panel-muted" />
          <div className="mt-2 h-3 w-24 rounded bg-panel-muted" />
          <div className="mt-1 h-3 w-40 rounded bg-panel-muted" />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-stroke bg-panel py-16 text-center">
      <p className="text-lg font-medium text-foreground">No stakeholders</p>
      <p className="mt-1 text-sm text-muted-foreground">Add your first stakeholder using the form above.</p>
    </div>
  );
}

export default function StakeholdersPage() {
  const [stakeholders, setStakeholders] = useState<StakeholderCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [draft, setDraft] = useState<StakeholderDraft>(INITIAL_DRAFT);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let isMounted = true;

    async function loadData() {
      setLoading(true);
      setError(null);

      try {
        const data = await fetchStakeholders(search || undefined);
        if (isMounted) {
          setStakeholders(data);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : "Failed to load stakeholders");
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
  }, [search]);

  async function createStakeholder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const name = draft.name.trim();
    if (!name) {
      setError("Name is required");
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const response = await fetch("/api/stakeholders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email: draft.email || null,
          role: draft.role || null,
          organization: draft.organization || null,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Create failed" }));
        throw new Error(typeof data.error === "string" ? data.error : "Create failed");
      }

      // Refresh the list
      const updatedList = await fetchStakeholders(search || undefined);
      setStakeholders(updatedList);
      setDraft(INITIAL_DRAFT);
      setIsCreateOpen(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Failed to create stakeholder");
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stakeholders"
        description="People you work with. Track commitments, follow-ups, and relationship context."
      />

      {/* Search */}
      <div className="flex items-center gap-3">
        <Input
          className="max-w-md"
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email, or organization..."
        />
      </div>

      {/* Create Form */}
      <section className={cardClasses({ padding: "sm" })}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Add Stakeholder</h2>
            <p className="text-xs text-muted-foreground">Track a person you work with.</p>
          </div>
          <Button variant="primary" size="sm" onClick={() => setIsCreateOpen((open) => !open)}>
            {isCreateOpen ? "Close" : "+ New"}
          </Button>
        </div>

        {isCreateOpen && (
          <form onSubmit={createStakeholder} className="mt-4 space-y-4 border-t border-stroke pt-4">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Name *</span>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  placeholder="e.g., Jane Smith"
                  disabled={isCreating}
                />
              </label>

              <label className="block space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Email</span>
                <Input
                  type="email"
                  value={draft.email}
                  onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
                  placeholder="e.g., jane@acme.com"
                  disabled={isCreating}
                />
              </label>

              <label className="block space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Role</span>
                <Input
                  value={draft.role}
                  onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value }))}
                  placeholder="e.g., Product Owner, VP Engineering"
                  disabled={isCreating}
                />
              </label>

              <label className="block space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Organization</span>
                <Input
                  value={draft.organization}
                  onChange={(e) => setDraft((d) => ({ ...d, organization: e.target.value }))}
                  placeholder="e.g., Acme Corp, Internal - Finance"
                  disabled={isCreating}
                />
              </label>
            </div>

            <div className="flex items-center justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => { setDraft(INITIAL_DRAFT); setIsCreateOpen(false); }}
                disabled={isCreating}
              >
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={isCreating}>
                {isCreating ? "Creating..." : "Create"}
              </Button>
            </div>
          </form>
        )}
      </section>

      {error && <ErrorBanner message={error} />}

      {loading ? (
        <LoadingSkeleton />
      ) : stakeholders.length === 0 ? (
        <EmptyState />
      ) : (
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {stakeholders.map((s) => (
            <StakeholderCard key={s.id} stakeholder={s} />
          ))}
        </section>
      )}
    </div>
  );
}
