"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { CommitmentRow, type CommitmentRowData } from "@/components/stakeholders/CommitmentRow";
import type { CommitmentStatus, CommitmentDirection } from "@/types/database";

interface StakeholderDetail {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  organization: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  commitments: CommitmentRowData[];
}

interface CommitmentDraft {
  title: string;
  direction: CommitmentDirection;
  due_at: string;
  notes: string;
}

const INITIAL_COMMITMENT_DRAFT: CommitmentDraft = {
  title: "",
  direction: "ours",
  due_at: "",
  notes: "",
};

async function fetchStakeholder(id: string): Promise<StakeholderDetail> {
  const response = await fetch(`/api/stakeholders/${id}`, { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (response.status === 404) {
    throw new Error("Stakeholder not found");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch stakeholder");
  }

  return response.json();
}

function InfoField({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm text-foreground">{value}</dd>
    </div>
  );
}

export default function StakeholderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [stakeholder, setStakeholder] = useState<StakeholderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Editing state
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState({ name: "", email: "", role: "", organization: "", notes: "" });
  const [isSaving, setIsSaving] = useState(false);

  // Commitment form
  const [isAddingCommitment, setIsAddingCommitment] = useState(false);
  const [commitmentDraft, setCommitmentDraft] = useState<CommitmentDraft>(INITIAL_COMMITMENT_DRAFT);
  const [isCreatingCommitment, setIsCreatingCommitment] = useState(false);

  // Show done filter
  const [showDone, setShowDone] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await fetchStakeholder(id);
      setStakeholder(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load stakeholder");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleSaveEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!stakeholder) return;

    setIsSaving(true);
    setError(null);

    try {
      const response = await fetch(`/api/stakeholders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editDraft.name,
          email: editDraft.email || null,
          role: editDraft.role || null,
          organization: editDraft.organization || null,
          notes: editDraft.notes || null,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Update failed" }));
        throw new Error(typeof data.error === "string" ? data.error : "Update failed");
      }

      await loadData();
      setIsEditing(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this stakeholder? All associated commitments will also be deleted.")) return;

    try {
      const response = await fetch(`/api/stakeholders/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Delete failed");
      router.push("/stakeholders");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete");
    }
  }

  async function handleCreateCommitment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const title = commitmentDraft.title.trim();
    if (!title) {
      setError("Commitment title is required");
      return;
    }

    setIsCreatingCommitment(true);
    setError(null);

    try {
      const response = await fetch(`/api/stakeholders/${id}/commitments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          direction: commitmentDraft.direction,
          due_at: commitmentDraft.due_at || null,
          notes: commitmentDraft.notes || null,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: "Create failed" }));
        throw new Error(typeof data.error === "string" ? data.error : "Create failed");
      }

      await loadData();
      setCommitmentDraft(INITIAL_COMMITMENT_DRAFT);
      setIsAddingCommitment(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Failed to create commitment");
    } finally {
      setIsCreatingCommitment(false);
    }
  }

  async function handleCommitmentStatusChange(commitmentId: string, newStatus: CommitmentStatus) {
    try {
      const response = await fetch(`/api/commitments/${commitmentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });

      if (!response.ok) throw new Error("Update failed");
      await loadData();
    } catch {
      setError("Failed to update commitment");
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 rounded bg-panel-muted" />
          <div className="h-4 w-64 rounded bg-panel-muted" />
          <div className="h-32 rounded-card border border-stroke bg-panel" />
        </div>
      </div>
    );
  }

  if (!stakeholder) {
    return (
      <div className="space-y-6">
        <PageHeader title="Stakeholder not found" />
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}
        <Link href="/stakeholders" className="text-sm text-accent hover:underline">
          Back to stakeholders
        </Link>
      </div>
    );
  }

  const openCommitments = stakeholder.commitments.filter((c) => c.status === "Open");
  const closedCommitments = stakeholder.commitments.filter((c) => c.status !== "Open");

  return (
    <div className="space-y-6">
      <PageHeader
        title={stakeholder.name}
        description={[stakeholder.role, stakeholder.organization].filter(Boolean).join(" at ") || undefined}
        actions={
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setEditDraft({
                  name: stakeholder.name,
                  email: stakeholder.email || "",
                  role: stakeholder.role || "",
                  organization: stakeholder.organization || "",
                  notes: stakeholder.notes || "",
                });
                setIsEditing(true);
              }}
              className="rounded-lg border border-stroke bg-panel px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={handleDelete}
              className="rounded-lg border border-red-200 bg-panel px-3 py-1.5 text-xs font-semibold text-red-600 transition hover:bg-red-50"
            >
              Delete
            </button>
          </div>
        }
      />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}

      {/* Edit Form */}
      {isEditing && (
        <section className="rounded-card border border-accent/30 bg-panel p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-foreground">Edit Stakeholder</h2>
          <form onSubmit={handleSaveEdit} className="mt-3 space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Name *</span>
                <input
                  value={editDraft.name}
                  onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
                  disabled={isSaving}
                  className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Email</span>
                <input
                  type="email"
                  value={editDraft.email}
                  onChange={(e) => setEditDraft((d) => ({ ...d, email: e.target.value }))}
                  disabled={isSaving}
                  className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Role</span>
                <input
                  value={editDraft.role}
                  onChange={(e) => setEditDraft((d) => ({ ...d, role: e.target.value }))}
                  disabled={isSaving}
                  className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Organization</span>
                <input
                  value={editDraft.organization}
                  onChange={(e) => setEditDraft((d) => ({ ...d, organization: e.target.value }))}
                  disabled={isSaving}
                  className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>
            </div>
            <label className="block space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notes</span>
              <textarea
                value={editDraft.notes}
                onChange={(e) => setEditDraft((d) => ({ ...d, notes: e.target.value }))}
                rows={3}
                disabled={isSaving}
                placeholder="Context, preferences, relationship notes..."
                className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsEditing(false)}
                disabled={isSaving}
                className="rounded-lg border border-stroke bg-panel px-3 py-2 text-sm font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Info Panel */}
      {!isEditing && (
        <section className="rounded-card border border-stroke bg-panel p-4 shadow-sm">
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <InfoField label="Email" value={stakeholder.email} />
            <InfoField label="Role" value={stakeholder.role} />
            <InfoField label="Organization" value={stakeholder.organization} />
            <InfoField label="Notes" value={stakeholder.notes} />
          </dl>
          {!stakeholder.email && !stakeholder.role && !stakeholder.organization && !stakeholder.notes && (
            <p className="text-xs text-muted-foreground italic">No additional details. Click Edit to add context.</p>
          )}
        </section>
      )}

      {/* Commitments Section */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Commitments</h2>
            <p className="text-xs text-muted-foreground">
              {openCommitments.length} open{closedCommitments.length > 0 ? `, ${closedCommitments.length} closed` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setIsAddingCommitment((open) => !open)}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
          >
            {isAddingCommitment ? "Close" : "+ Commitment"}
          </button>
        </div>

        {/* Add Commitment Form */}
        {isAddingCommitment && (
          <form onSubmit={handleCreateCommitment} className="rounded-card border border-stroke bg-panel p-4 shadow-sm space-y-3">
            <label className="block space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What was committed? *</span>
              <input
                value={commitmentDraft.title}
                onChange={(e) => setCommitmentDraft((d) => ({ ...d, title: e.target.value }))}
                placeholder="e.g., Deliver UAT results by Friday"
                disabled={isCreatingCommitment}
                className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <div className="grid gap-3 md:grid-cols-3">
              <label className="block space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Direction</span>
                <select
                  value={commitmentDraft.direction}
                  onChange={(e) => setCommitmentDraft((d) => ({ ...d, direction: e.target.value as CommitmentDirection }))}
                  disabled={isCreatingCommitment}
                  className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <option value="ours">We owe them</option>
                  <option value="theirs">They owe us</option>
                </select>
              </label>

              <label className="block space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Due Date</span>
                <input
                  type="date"
                  value={commitmentDraft.due_at}
                  onChange={(e) => setCommitmentDraft((d) => ({ ...d, due_at: e.target.value }))}
                  disabled={isCreatingCommitment}
                  className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notes</span>
                <input
                  value={commitmentDraft.notes}
                  onChange={(e) => setCommitmentDraft((d) => ({ ...d, notes: e.target.value }))}
                  placeholder="Optional context"
                  disabled={isCreatingCommitment}
                  className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setCommitmentDraft(INITIAL_COMMITMENT_DRAFT);
                  setIsAddingCommitment(false);
                }}
                disabled={isCreatingCommitment}
                className="rounded-lg border border-stroke bg-panel px-3 py-2 text-sm font-semibold text-muted-foreground transition hover:bg-panel-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isCreatingCommitment}
                className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isCreatingCommitment ? "Adding..." : "Add"}
              </button>
            </div>
          </form>
        )}

        {/* Open Commitments */}
        {openCommitments.length > 0 ? (
          <div className="space-y-2">
            {openCommitments.map((c) => (
              <CommitmentRow key={c.id} commitment={c} onStatusChange={handleCommitmentStatusChange} />
            ))}
          </div>
        ) : (
          <div className="rounded-card border border-dashed border-stroke bg-panel py-8 text-center">
            <p className="text-sm text-muted-foreground">No open commitments</p>
          </div>
        )}

        {/* Closed Commitments Toggle */}
        {closedCommitments.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowDone((v) => !v)}
              className="text-xs font-semibold text-muted-foreground transition hover:text-foreground"
            >
              {showDone ? "Hide" : "Show"} {closedCommitments.length} closed commitment{closedCommitments.length !== 1 ? "s" : ""}
            </button>
            {showDone && (
              <div className="mt-2 space-y-2">
                {closedCommitments.map((c) => (
                  <CommitmentRow key={c.id} commitment={c} onStatusChange={handleCommitmentStatusChange} />
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <Link href="/stakeholders" className="inline-block text-sm text-accent hover:underline">
        Back to all stakeholders
      </Link>
    </div>
  );
}
