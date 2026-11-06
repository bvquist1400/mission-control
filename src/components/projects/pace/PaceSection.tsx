"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { PacePanel, type ActionResult, type LogSittingInput, type PacePanelActions, type PacePanelData } from "@/components/projects/pace/PacePanel";
import { buildLogSittingBody, rowsProblemFrom, savedOnText } from "@/lib/pace-view";

async function errorBodyFrom(res: Response, fallback: string): Promise<{ error: string; body: unknown }> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return { error: typeof body?.error === "string" ? body.error : fallback, body };
}

async function errorFrom(res: Response, fallback: string): Promise<string> {
  return (await errorBodyFrom(res, fallback)).error;
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
        // An untouched date (today) is left to the server: a start later than now was yesterday (F0 r1).
        const body = buildLogSittingBody(input, projectId);
        try {
          const res = await fetch("/api/work-sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            // Rows that can't be ticked (F0): the form says why in plain words and offers "Save without rows".
            const { error: message, body: errorBody } = await errorBodyFrom(res, "Couldn't save the sitting");
            const rowsProblem = res.status === 400 ? rowsProblemFrom(errorBody, input.rows, input.task_id ? "task" : "project") : null;
            return { ok: false, error: message, ...(rowsProblem ? { rowsProblem } : {}) };
          }
          const result = (await res.json()) as { forecast_line?: string; session?: { session_date?: string } };
          const savedOn = savedOnText(input, result.session?.session_date);
          const saved = savedOn ? `Sitting saved. ${savedOn}` : "Sitting saved.";
          toast({ message: result.forecast_line ? `${saved} ${result.forecast_line}` : saved, tone: "success" });
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
