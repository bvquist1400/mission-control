// What the brief page changes locally when an action comes back refused.
// Pure and browser-safe so it can be tested without rendering the page.

import type { BriefAction, BriefItemRow } from "@/lib/briefs/types";

/**
 * A refused Undo that will keep being refused (a task's date was changed after
 * the move, or no earlier dates were saved) must stop offering Undo: the tile
 * keeps its message toast and its task link, and loses the dead link. A conflict
 * (the item changed under us) or a failed request is not such a case: the page
 * refreshes or the user can try again.
 */
export function patchForRefusedAction(
  action: BriefAction,
  result: { ok: boolean; conflict?: boolean; undo_blocked?: boolean } | undefined
): Partial<BriefItemRow> | null {
  if (action === "undo" && result && !result.ok && !result.conflict && result.undo_blocked) {
    return { can_undo: false };
  }
  return null;
}
