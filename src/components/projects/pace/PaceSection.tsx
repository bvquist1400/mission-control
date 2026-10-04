"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { PacePanel, type ActionResult, type LogSittingInput, type PacePanelActions, type PacePanelData } from "@/components/projects/pace/PacePanel";

async function errorFrom(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : fallback;
}

/**
 * The Pace section of a project that counts units: loads `/api/projects/[id]/pace`, logs a sitting through
 * `/api/work-sessions` (the same service as the log_work_session tool), and edits one through its PATCH/DELETE.
 * Time and row fixes stay in chat.
 */
export function PaceSection({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const [data, setData] = useState<PacePanelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/pace`, { cache: "no-store" });
      if (!res.ok) throw new Error(await errorFrom(res, "Couldn't load the pace section"));
      setData((await res.json()) as PacePanelData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the pace section");
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const actions = useMemo<PacePanelActions>(
    () => ({
      async logSitting(input: LogSittingInput): Promise<ActionResult> {
        const body: Record<string, unknown> = {
          date: input.date,
          exclude_from_stats: input.exclude_from_stats,
          idempotency_key: input.idempotency_key,
        };
        if (input.task_id) body.task_id = input.task_id;
        else body.project_id = projectId;
        if (input.start && input.end) {
          body.start = input.start;
          body.end = input.end;
        }
        if (input.minutes.trim()) body.minutes = Number(input.minutes.trim());
        if (input.rows.trim()) body.rows = input.rows.trim();
        if (input.note.trim()) body.note = input.note.trim();
        try {
          const res = await fetch("/api/work-sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!res.ok) return { ok: false, error: await errorFrom(res, "Couldn't save the sitting") };
          const result = (await res.json()) as { forecast_line?: string };
          toast({ message: result.forecast_line ? `Sitting saved. ${result.forecast_line}` : "Sitting saved.", tone: "success" });
          await load();
          return { ok: true };
        } catch {
          return { ok: false, error: "Couldn't reach the server. Nothing was saved; try again." };
        }
      },
      async setExcluded(sessionId: string, excluded: boolean): Promise<ActionResult> {
        try {
          const res = await fetch(`/api/work-sessions/${sessionId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(excluded ? { exclude_from_stats: true } : { exclude_from_stats: false, exclude_reason: null }),
          });
          if (!res.ok) return { ok: false, error: await errorFrom(res, "Couldn't change the sitting") };
          await load();
          return { ok: true };
        } catch {
          return { ok: false, error: "Couldn't reach the server. Nothing was changed." };
        }
      },
      async deleteSession(sessionId: string): Promise<ActionResult> {
        try {
          const res = await fetch(`/api/work-sessions/${sessionId}`, { method: "DELETE" });
          if (!res.ok) return { ok: false, error: await errorFrom(res, "Couldn't delete the sitting") };
          toast({ message: "Sitting deleted. The rows it ticked stay ticked.", tone: "success" });
          await load();
          return { ok: true };
        } catch {
          return { ok: false, error: "Couldn't reach the server. Nothing was deleted." };
        }
      },
    }),
    [load, projectId, toast]
  );

  if (error && !data) {
    return (
      <section className="rounded-card border border-danger-border bg-danger-soft p-4 text-sm text-danger" role="alert">
        {error}{" "}
        <button type="button" className="font-medium underline" onClick={() => void load()}>
          Try again
        </button>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="rounded-card border border-stroke bg-panel p-5 text-sm text-muted-foreground" aria-busy="true">
        Loading pace…
      </section>
    );
  }
  return <PacePanel data={data} actions={actions} busy={busy} />;
}
