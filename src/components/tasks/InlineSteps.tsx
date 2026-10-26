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
 * optimistic and reported up (`onRowsChange`) so the fill moves at once; a
 * failed save puts the row back. Ticking the last step only lights up Done:
 * the task closes when Done is pressed (`onDone`), never on its own.
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

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/tasks/${taskId}/checklist`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("load");
        return (await response.json()) as TaskChecklistItem[];
      })
      .then((rows) => setItems(Array.isArray(rows) ? rows : []))
      .catch((loadError: unknown) => {
        if ((loadError as { name?: string }).name !== "AbortError") {
          setError("Couldn't load the steps.");
        }
      });
    return () => controller.abort();
  }, [taskId]);

  async function toggle(item: TaskChecklistItem) {
    if (!itemsRef.current) return;
    const nextDone = !item.is_done;
    const apply = (done: boolean) => {
      const next = (itemsRef.current ?? []).map((row) => (row.id === item.id ? { ...row, is_done: done } : row));
      setItems(next);
      onRowsChange(next.map((row) => ({ is_done: row.is_done, unit_count: row.unit_count })));
    };
    apply(nextDone);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${taskId}/checklist`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ id: item.id, is_done: nextDone }] }),
      });
      if (!response.ok) throw new Error("save");
      onSaved?.();
    } catch {
      apply(item.is_done);
      setError("Couldn't save that step. Try again.");
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
                  onChange={() => toggle(item)}
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
