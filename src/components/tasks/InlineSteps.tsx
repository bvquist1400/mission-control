"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { RangeCardView } from "@/lib/task-range-view";
import type { TaskChecklistItem } from "@/types/database";

/**
 * Multi-day tasks S2: a card's steps, opened from its "3/5 steps" pill and
 * ticked in place through the existing checklist route
 * (`GET`/`PATCH /api/tasks/[id]/checklist`). Rows load when the pill opens
 * (one request per open card, never per card at page load). Every tick is
 * optimistic and reported up (`onRowsChange`) so the fill moves at once. A row
 * is disabled while its save is in flight (one save per row at a time, so two
 * quick clicks can't race or roll back over each other); a saved row takes the
 * value from the reply, a failed save puts back the last value the server
 * confirmed. Ticking the last step only lights up Done: the task closes when
 * Done is pressed (`onDone`), never on its own.
 */
export function InlineSteps({
  id,
  taskId,
  view,
  compact = false,
  onRowsChange,
  onSaved,
  onDone,
  doneDisabled = false,
}: {
  id: string;
  taskId: string;
  view: RangeCardView;
  compact?: boolean;
  onRowsChange: (rows: Array<Pick<TaskChecklistItem, "is_done" | "unit_count">>) => void;
  onSaved?: () => void;
  onDone: () => void;
  doneDisabled?: boolean;
}) {
  const [items, setItemsState] = useState<TaskChecklistItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The latest rows, so two quick ticks never apply to a stale list.
  const itemsRef = useRef<TaskChecklistItem[] | null>(null);
  const setItems = (next: TaskChecklistItem[]) => {
    itemsRef.current = next;
    setItemsState(next);
  };
  // Rows with a save in flight (disabled until it answers).
  const [pending, setPendingState] = useState<ReadonlySet<string>>(() => new Set());
  const pendingRef = useRef<Set<string>>(new Set());
  const setPending = (itemId: string, on: boolean) => {
    const next = new Set(pendingRef.current);
    if (on) next.add(itemId);
    else next.delete(itemId);
    pendingRef.current = next;
    setPendingState(next);
  };
  // Each row's last value the server confirmed (the load, then each saved reply).
  const ackedRef = useRef<Map<string, boolean>>(new Map());

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/tasks/${taskId}/checklist`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("load");
        return (await response.json()) as TaskChecklistItem[];
      })
      .then((rows) => {
        const loaded = Array.isArray(rows) ? rows : [];
        ackedRef.current = new Map(loaded.map((row) => [row.id, row.is_done]));
        setItems(loaded);
      })
      .catch((loadError: unknown) => {
        if ((loadError as { name?: string }).name !== "AbortError") {
          setError("Couldn't load the steps.");
        }
      });
    return () => controller.abort();
  }, [taskId]);

  async function toggle(itemId: string) {
    const current = itemsRef.current?.find((row) => row.id === itemId);
    // One save per row at a time: a click while it is saving does nothing.
    if (!current || pendingRef.current.has(itemId)) return;
    const nextDone = !current.is_done;
    const replaceRow = (patch: Partial<TaskChecklistItem>) => {
      const next = (itemsRef.current ?? []).map((row) => (row.id === itemId ? { ...row, ...patch, id: row.id } : row));
      setItems(next);
      onRowsChange(next.map((row) => ({ is_done: row.is_done, unit_count: row.unit_count })));
    };
    setPending(itemId, true);
    replaceRow({ is_done: nextDone });
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${taskId}/checklist`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ id: itemId, is_done: nextDone }] }),
      });
      if (!response.ok) throw new Error("save");
      const saved = savedRowFromReply(await readReply(response), itemId);
      if (saved === "failed") throw new Error("save");
      const savedDone = typeof saved?.is_done === "boolean" ? saved.is_done : nextDone;
      ackedRef.current.set(itemId, savedDone);
      replaceRow(saved ? { ...saved, is_done: savedDone } : { is_done: savedDone });
      onSaved?.();
    } catch {
      replaceRow({ is_done: ackedRef.current.get(itemId) ?? current.is_done });
      setError("Couldn't save that step. Try again.");
    } finally {
      setPending(itemId, false);
    }
  }

  return (
    <div
      id={id}
      className={`relative border-t border-stroke bg-panel ${compact ? "-mx-2.5 -mb-2.5 mt-2 px-2.5 pb-2.5 pt-1.5" : "-mx-3 -mb-3 mt-2.5 px-3 pb-3 pt-2"}`}
    >
      {items === null && !error ? (
        <p className="px-1.5 py-1 text-xs text-muted-foreground" role="status">
          Loading steps…
        </p>
      ) : null}
      {items ? (
        <ul className="space-y-0.5">
          {items.map((item) => (
            <li key={item.id}>
              <label className="flex cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1.5 hover:bg-panel-muted/70">
                <input
                  type="checkbox"
                  checked={item.is_done}
                  disabled={pending.has(item.id)}
                  aria-busy={pending.has(item.id) ? true : undefined}
                  onChange={() => toggle(item.id)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
                />
                <span className={`text-sm ${item.is_done ? "text-muted-foreground line-through" : "text-foreground"}`}>
                  {item.text}
                </span>
                {item.unit_count ? (
                  <span className="ml-auto whitespace-nowrap pl-1.5 text-xs text-muted-foreground">{item.unit_count}</span>
                ) : null}
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="mx-1.5 mt-1.5 text-xs text-amber-200" role="alert">
          {error}
        </p>
      ) : null}
      {view.allStepsDone ? (
        <div className="mx-1.5 mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-success-border bg-success-soft px-2.5 py-2 text-sm text-success">
          <span>All steps done. Mark the task done?</span>
          <Button variant="ready" size="sm" onClick={onDone} disabled={doneDisabled} aria-label="Mark task complete">
            ✓ Done
          </Button>
        </div>
      ) : view.note ? (
        <p className={`mx-1.5 mt-1.5 text-xs ${view.behindPace ? "text-amber-200" : "text-muted-foreground"}`}>{view.note}</p>
      ) : null}
    </div>
  );
}

async function readReply(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * The saved row from a checklist PATCH reply: the row itself (200, an array of
 * saved rows), "failed" when the reply lists it as failed (207), or null when
 * the reply doesn't say (the request's own value then stands).
 */
function savedRowFromReply(reply: unknown, itemId: string): Partial<TaskChecklistItem> | "failed" | null {
  const isRow = (value: unknown): value is Partial<TaskChecklistItem> =>
    Boolean(value) && typeof value === "object" && (value as { id?: unknown }).id === itemId;
  if (Array.isArray(reply)) return reply.find(isRow) ?? null;
  if (reply && typeof reply === "object") {
    const { updated, failed } = reply as { updated?: unknown; failed?: unknown };
    if (Array.isArray(failed) && failed.some(isRow)) return "failed";
    if (Array.isArray(updated)) return updated.find(isRow) ?? null;
  }
  return null;
}
