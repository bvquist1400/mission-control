"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { redditStats } from "@/lib/launch-metrics/format";

const KINDS = ["Release", "Tracking", "Users", "Marketing", "Feedback", "Other"] as const;

async function send(url: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.ok) return null;
    const data = (await response.json().catch(() => ({}))) as { error?: unknown };
    return typeof data.error === "string" ? data.error : `Could not save (${response.status})`;
  } catch {
    return "Could not reach Baseline";
  }
}

/** "Refresh now": runs a full sync for Brent's session, then re-reads the page. */
export function RefreshButton() {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      let response: Response;
      try {
        response = await fetch("/api/launch-metrics/sync", { method: "POST" });
      } catch {
        toast({ message: "Could not reach Baseline. Check the connection and try again.", tone: "danger" });
        return;
      }
      const data = (await response.json().catch(() => ({}))) as { status?: string; error?: string };
      if (response.status === 429) {
        toast({ message: "Updated less than a minute ago. Try again shortly.", tone: "warning" });
      } else if (response.status === 409) {
        toast({ message: "An update is already running.", tone: "warning" });
      } else if (!response.ok) {
        toast({ message: `Refresh failed (${data.error ?? response.status}).`, tone: "danger" });
      } else {
        toast({
          message: data.status === "ok" ? "Numbers updated." : "Updated, but some sources failed. See the bottom of the page.",
          tone: data.status === "ok" ? "success" : "warning",
        });
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="secondary" size="sm" onClick={refresh} disabled={busy}>
      {busy ? "Refreshing…" : "Refresh now"}
    </Button>
  );
}

/**
 * "Remove" that asks first: the first tap shows "Yes, remove" / "Keep" in place
 * (no browser dialog); only "Yes, remove" deletes.
 */
function ConfirmRemove({ label, disabled, onConfirm }: { label: string; disabled: boolean; onConfirm: () => Promise<void> | void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setAsking(true)} disabled={disabled} aria-label={`Remove ${label}`}>
        Remove
      </Button>
    );
  }
  return (
    <span role="group" aria-label={`Remove ${label}?`} className="inline-flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">Remove this?</span>
      <Button
        size="sm"
        variant="danger"
        disabled={disabled}
        onClick={async () => {
          await onConfirm();
          setAsking(false);
        }}
      >
        Yes, remove
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
        Keep
      </Button>
    </span>
  );
}

export interface RedditRow {
  id: string;
  label: string;
  subreddit: string;
  postedLabel: string;
  views: number | null;
  upvotes: number | null;
  comments: number | null;
  statsAsOfLabel: string | null;
}

function StatInput({ label, name, defaultValue }: { label: string; name: string; defaultValue: number | null }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <Input size="sm" name={name} inputMode="numeric" defaultValue={defaultValue ?? ""} className="w-20" />
    </label>
  );
}

export function RedditPanel({ posts, nowLocal }: { posts: RedditRow[]; nowLocal: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const body: Record<string, unknown> = {
      label: String(form.get("label") ?? ""),
      subreddit: String(form.get("subreddit") ?? ""),
      posted_at: String(form.get("posted_at") ?? ""),
    };
    for (const field of ["views", "upvotes", "comments"]) {
      const value = String(form.get(field) ?? "").trim();
      if (value !== "") body[field] = value;
    }
    setSaving(true);
    const error = await send("/api/launch-metrics/reddit", "POST", body);
    setSaving(false);
    if (error) {
      toast({ message: error, tone: "danger" });
      return;
    }
    formElement.reset();
    toast({ message: "Post added.", tone: "success" });
    router.refresh();
  }

  async function updateStats(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const body: Record<string, unknown> = {};
    for (const field of ["views", "upvotes", "comments"]) {
      body[field] = String(form.get(field) ?? "").trim();
    }
    setSaving(true);
    const error = await send(`/api/launch-metrics/reddit/${id}`, "PATCH", body);
    setSaving(false);
    if (error) {
      toast({ message: error, tone: "danger" });
      return;
    }
    setEditing(null);
    toast({ message: "Stats updated.", tone: "success" });
    router.refresh();
  }

  async function remove(id: string) {
    setSaving(true);
    const error = await send(`/api/launch-metrics/reddit/${id}`, "DELETE");
    setSaving(false);
    if (error) {
      toast({ message: error, tone: "danger" });
      return;
    }
    toast({ message: "Post removed.", tone: "success" });
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {posts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No posts yet.</p>
      ) : (
        <ul className="divide-y divide-stroke">
          {posts.map((post) => (
            <li key={post.id} className="py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{post.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {post.subreddit} · posted {post.postedLabel}
                  </p>
                </div>
                <p className="text-sm text-foreground">{redditStats(post.views, post.upvotes, post.comments)}</p>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {post.statsAsOfLabel ? `Stats as of ${post.statsAsOfLabel}` : "No stats yet"}
              </p>
              {editing === post.id ? (
                <form onSubmit={(event) => updateStats(event, post.id)} className="mt-2 flex flex-wrap items-end gap-2">
                  <StatInput label="Views" name="views" defaultValue={post.views} />
                  <StatInput label="Upvotes" name="upvotes" defaultValue={post.upvotes} />
                  <StatInput label="Comments" name="comments" defaultValue={post.comments} />
                  <Button type="submit" size="sm" variant="primary" disabled={saving}>
                    Save
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <Button size="sm" variant="secondary" onClick={() => setEditing(post.id)}>
                    Update stats
                  </Button>
                  <ConfirmRemove label={post.label} disabled={saving} onConfirm={() => remove(post.id)} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="grid grid-cols-1 gap-2 rounded-lg border border-stroke p-3 sm:grid-cols-2">
        <p className="text-sm font-medium text-foreground sm:col-span-2">Add a post</p>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Name
          <Input size="sm" name="label" required maxLength={200} placeholder="r/apps launch post" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Subreddit
          <Input size="sm" name="subreddit" required placeholder="r/apps" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Posted (New York time)
          <Input size="sm" type="datetime-local" name="posted_at" required defaultValue={nowLocal} />
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <StatInput label="Views" name="views" defaultValue={null} />
          <StatInput label="Upvotes" name="upvotes" defaultValue={null} />
          <StatInput label="Comments" name="comments" defaultValue={null} />
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" size="sm" variant="primary" disabled={saving}>
            Add post
          </Button>
        </div>
      </form>
    </div>
  );
}

export interface MilestoneRow {
  id: string;
  whenLabel: string;
  label: string;
  kind: string;
}

export function MilestonesPanel({ milestones, nowLocal }: { milestones: MilestoneRow[]; nowLocal: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setSaving(true);
    const error = await send("/api/launch-metrics/milestones", "POST", {
      happened_at: String(form.get("happened_at") ?? ""),
      label: String(form.get("label") ?? ""),
      kind: String(form.get("kind") ?? ""),
    });
    setSaving(false);
    if (error) {
      toast({ message: error, tone: "danger" });
      return;
    }
    formElement.reset();
    toast({ message: "Added to the timeline.", tone: "success" });
    router.refresh();
  }

  async function remove(id: string) {
    setSaving(true);
    const error = await send(`/api/launch-metrics/milestones/${id}`, "DELETE");
    setSaving(false);
    if (error) {
      toast({ message: error, tone: "danger" });
      return;
    }
    toast({ message: "Removed from the timeline.", tone: "success" });
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {milestones.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing on the timeline yet.</p>
      ) : (
        <ol className="divide-y divide-stroke">
          {milestones.map((milestone) => (
            <li key={milestone.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-foreground">{milestone.label}</p>
                <p className="text-xs text-muted-foreground">
                  {milestone.whenLabel} · {milestone.kind}
                </p>
              </div>
              <ConfirmRemove label={milestone.label} disabled={saving} onConfirm={() => remove(milestone.id)} />
            </li>
          ))}
        </ol>
      )}
      <form onSubmit={add} className="grid grid-cols-1 gap-2 rounded-lg border border-stroke p-3 sm:grid-cols-[1fr_auto_auto]">
        <p className="text-sm font-medium text-foreground sm:col-span-3">Add an event</p>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          What happened
          <Input size="sm" name="label" required maxLength={200} placeholder="Posted on r/apps" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          When (New York time)
          <Input size="sm" type="datetime-local" name="happened_at" required defaultValue={nowLocal} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Kind
          <Select size="sm" name="kind" defaultValue="Marketing">
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </Select>
        </label>
        <div className="sm:col-span-3">
          <Button type="submit" size="sm" variant="primary" disabled={saving}>
            Add event
          </Button>
        </div>
      </form>
    </div>
  );
}
