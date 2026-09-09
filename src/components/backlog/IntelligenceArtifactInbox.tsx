"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatRelativeDate } from "@/components/utils/dates";
import type {
  IntelligenceArtifactInboxItem,
  IntelligenceArtifactInboxPayload,
} from "@/lib/intelligence-layer/inbox";
import { Button } from "@/components/ui/Button";
import { cardClasses } from "@/components/ui/Card";
import { badgeClasses } from "@/components/ui/Badge";

const EMPTY_INBOX: IntelligenceArtifactInboxPayload = {
  open: [],
  accepted: [],
  applied: [],
  dismissed: [],
  counts: {
    open: 0,
    accepted: 0,
    applied: 0,
    dismissed: 0,
  },
};

async function fetchInbox(): Promise<IntelligenceArtifactInboxPayload> {
  const response = await fetch("/api/intelligence/artifacts", { cache: "no-store" });
  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to load artifact inbox");
  }

  return response.json();
}

async function postArtifactAction(artifactId: string, action: "accept" | "dismiss" | "apply"): Promise<void> {
  const response = await fetch(
    action === "apply"
      ? `/api/intelligence/artifacts/${artifactId}/apply`
      : `/api/intelligence/artifacts/${artifactId}/status`,
    {
      method: "POST",
      headers: action === "apply" ? undefined : { "Content-Type": "application/json" },
      body: action === "apply" ? undefined : JSON.stringify({ action }),
    }
  );

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error || "Failed to update artifact");
  }
}

function severityClasses(severity: IntelligenceArtifactInboxItem["severity"]): string {
  switch (severity) {
    case "high":
      return "border-danger-border bg-danger-soft text-danger";
    case "medium":
      return "border-warning-border bg-warning-soft text-warning";
    case "low":
      return "border-success-border bg-success-soft text-success";
  }
}

function confidenceClasses(confidence: IntelligenceArtifactInboxItem["confidence"]): string {
  switch (confidence) {
    case "high":
      return "border-stroke bg-panel-muted text-foreground";
    case "medium":
      return "border-stroke bg-panel-muted/60 text-muted-foreground";
    case "low":
      return "border-stroke bg-panel text-muted-foreground";
  }
}

function formatTransitionLabel(item: IntelligenceArtifactInboxItem): string | null {
  const transition = item.latest_transition;
  if (!transition) {
    return null;
  }

  const actor = transition.triggered_by === "user" ? "you" : "system";
  const action = transition.to_status.replace("_", " ");
  const relative = formatRelativeDate(transition.created_at);

  return `${action} by ${actor} ${relative}`;
}

function SectionHeader({
  title,
  description,
  count,
}: {
  title: string;
  description: string;
  count: number;
}) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <span className={badgeClasses({ className: "tracking-wide uppercase" })}>
        {count}
      </span>
    </div>
  );
}

function ArtifactCard({
  item,
  acting,
  onAction,
}: {
  item: IntelligenceArtifactInboxItem;
  acting: boolean;
  onAction?: (artifactId: string, action: "accept" | "dismiss" | "apply") => void;
}) {
  const transitionLabel = formatTransitionLabel(item);
  const canAccept = item.available_actions.includes("accept");
  const canDismiss = item.available_actions.includes("dismiss");
  const canApply = item.available_actions.includes("apply");

  return (
    <article className={cardClasses({ padding: "sm" })}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={badgeClasses({ className: "tracking-wide uppercase" })}>
              {item.artifact_type}
            </span>
            <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${severityClasses(item.severity)}`}>
              {item.severity}
            </span>
            <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${confidenceClasses(item.confidence)}`}>
              {item.confidence} confidence
            </span>
            <span className={badgeClasses({ className: "tracking-wide uppercase" })}>
              {item.status_label}
            </span>
          </div>

          <p className="mt-3 text-base font-semibold text-foreground">{item.summary}</p>

          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            {item.task_href ? (
              <Link href={item.task_href} className="font-medium text-accent-text hover:underline">
                {item.task_title}
              </Link>
            ) : (
              <span className="font-medium text-foreground">{item.task_title}</span>
            )}
            {item.task_status ? <span>· {item.task_status}</span> : null}
            <span>· {item.suggested_action}</span>
          </div>
        </div>

        {onAction ? (
          <div className="flex shrink-0 gap-2">
            {canAccept ? (
              <Button
                variant="primary"
                onClick={() => onAction(item.artifact_id, "accept")}
                disabled={acting}
              >
                {acting ? "Saving..." : "Accept"}
              </Button>
            ) : null}
            {canDismiss ? (
              <Button
                variant="secondary"
                onClick={() => onAction(item.artifact_id, "dismiss")}
                disabled={acting}
              >
                {acting ? "Saving..." : "Dismiss"}
              </Button>
            ) : null}
            {canApply ? (
              <Button variant="success"
                onClick={() => onAction(item.artifact_id, "apply")}
                disabled={acting}>
                {acting ? "Saving..." : "Mark handled"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <p className="mt-3 text-sm text-foreground">{item.reason}</p>

      {item.artifact_evidence.length > 0 ? (
        <ul className="mt-3 space-y-2 rounded-lg border border-stroke bg-panel-muted/60 p-3">
          {item.artifact_evidence.map((evidence, index) => (
            <li key={`${item.artifact_id}-${evidence.code}-${index}`} className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{evidence.code.replaceAll("_", " ")}</span>
              {": "}
              {evidence.summary}
            </li>
          ))}
        </ul>
      ) : null}

      {transitionLabel || item.latest_transition?.note ? (
        <div className="mt-3 text-xs text-muted-foreground">
          {transitionLabel ? <p>{transitionLabel}</p> : null}
          {item.latest_transition?.note ? <p className="mt-1">{item.latest_transition.note}</p> : null}
        </div>
      ) : null}
    </article>
  );
}

function QueueSection({
  title,
  description,
  emptyLabel,
  items,
  actingById,
  onAction,
}: {
  title: string;
  description: string;
  emptyLabel: string;
  items: IntelligenceArtifactInboxItem[];
  actingById: Record<string, boolean>;
  onAction?: (artifactId: string, action: "accept" | "dismiss" | "apply") => void;
}) {
  return (
    <section className="space-y-3">
      <SectionHeader title={title} description={description} count={items.length} />
      {items.length === 0 ? (
        <div className="rounded-card border border-dashed border-stroke bg-panel py-8 text-center text-sm text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <ArtifactCard
              key={item.artifact_id}
              item={item}
              acting={Boolean(actingById[item.artifact_id])}
              onAction={onAction}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function IntelligenceArtifactInbox() {
  const [payload, setPayload] = useState<IntelligenceArtifactInboxPayload>(EMPTY_INBOX);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actingById, setActingById] = useState<Record<string, boolean>>({});
  const [showApplied, setShowApplied] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);

  useEffect(() => {
    let isMounted = true;

    async function loadInbox(silent = false) {
      if (!silent) {
        setLoading(true);
      }

      try {
        const nextPayload = await fetchInbox();
        if (!isMounted) {
          return;
        }

        setPayload(nextPayload);
        setError(null);
      } catch (loadError) {
        if (!isMounted) {
          return;
        }

        setError(loadError instanceof Error ? loadError.message : "Failed to load artifact inbox");
      } finally {
        if (isMounted && !silent) {
          setLoading(false);
        }
      }
    }

    void loadInbox();

    const intervalId = window.setInterval(() => {
      void loadInbox(true);
    }, 15000);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
    };
  }, []);

  async function handleAction(artifactId: string, action: "accept" | "dismiss" | "apply") {
    setActingById((current) => ({ ...current, [artifactId]: true }));
    setError(null);

    try {
      await postArtifactAction(artifactId, action);
      const nextPayload = await fetchInbox();
      setPayload(nextPayload);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Failed to update artifact");
    } finally {
      setActingById((current) => {
        const next = { ...current };
        delete next[artifactId];
        return next;
      });
    }
  }

  return (
    <div className="space-y-4">
      <section className={cardClasses()}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Artifact Inbox</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Review intelligence artifacts without collapsing them into task-level review flags or tags.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <span className={badgeClasses()}>Open {payload.counts.open}</span>
            <span className={badgeClasses()}>Accepted {payload.counts.accepted}</span>
            <span className={badgeClasses()}>Applied {payload.counts.applied}</span>
            <span className={badgeClasses()}>Dismissed {payload.counts.dismissed}</span>
          </div>
        </div>
      </section>

      {error ? (
        <p className="rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((item) => (
            <div key={item} className="animate-pulse rounded-card border border-stroke bg-panel p-4 shadow-sm">
              <div className="h-4 w-40 rounded bg-panel-muted" />
              <div className="mt-3 h-5 w-3/4 rounded bg-panel-muted" />
              <div className="mt-3 h-16 rounded bg-panel-muted" />
            </div>
          ))}
        </div>
      ) : (
        <>
          <QueueSection
            title="Open Artifacts"
            description="Items that still need a decision."
            emptyLabel="No open artifacts need a decision."
            items={payload.open}
            actingById={actingById}
            onAction={handleAction}
          />

          <QueueSection
            title="Accepted / Awaiting Action"
            description="Committed items waiting for the underlying work or reminder path to play out."
            emptyLabel="No accepted artifacts are waiting on action."
            items={payload.accepted}
            actingById={actingById}
            onAction={handleAction}
          />

          <section className="space-y-3">
            <div className="flex flex-col gap-3 rounded-card border border-stroke bg-panel p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Recently Applied</h2>
                <p className="text-sm text-muted-foreground">
                  Hidden by default to keep the inbox focused. Expand when you need recent handled-item context.
                </p>
              </div>
              <Button
                variant="secondary"
                onClick={() => setShowApplied((current) => !current)}
                aria-expanded={showApplied}
              >
                {showApplied ? "Hide applied" : `Show applied (${payload.applied.length})`}
              </Button>
            </div>

            {showApplied ? (
              <QueueSection
                title="Applied History"
                description="Recent completions for context."
                emptyLabel="No recently applied artifacts yet."
                items={payload.applied}
                actingById={actingById}
              />
            ) : null}
          </section>

          <section className="space-y-3">
            <div className="flex flex-col gap-3 rounded-card border border-stroke bg-panel p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Recently Dismissed</h2>
                <p className="text-sm text-muted-foreground">
                  Hidden by default to keep the inbox focused. Expand when you need recent dismissal context.
                </p>
              </div>
              <Button
                variant="secondary"
                onClick={() => setShowDismissed((current) => !current)}
                aria-expanded={showDismissed}
              >
                {showDismissed ? "Hide dismissed" : `Show dismissed (${payload.dismissed.length})`}
              </Button>
            </div>

            {showDismissed ? (
              <QueueSection
                title="Dismissed History"
                description="Recent dismissals for context."
                emptyLabel="No recently dismissed artifacts yet."
                items={payload.dismissed}
                actingById={actingById}
              />
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
