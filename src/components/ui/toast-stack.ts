/** Older toasts are dropped past this so the stack never covers the page. */
export const MAX_VISIBLE_TOASTS = 3;

export interface StackedToast {
  id: number;
  /** 0 = stays until closed (the cascade toast: its moves and Undo must not vanish). */
  duration: number;
  key?: string;
}

/**
 * The toast stack after `record` is shown (pure, so it is tested without React):
 * a toast with the same key replaces the one on screen in place; otherwise it is
 * added and the OLDEST ordinary toasts are dropped past MAX_VISIBLE_TOASTS. A
 * toast that stays until closed (duration 0) is never pushed out by others; only
 * closing it, or a newer one with its key, removes it.
 */
export function nextToastStack<T extends StackedToast>(current: T[], record: T, max = MAX_VISIBLE_TOASTS): T[] {
  if (record.key) {
    const index = current.findIndex((item) => item.key === record.key);
    if (index >= 0) {
      const next = [...current];
      next[index] = record;
      return next;
    }
  }
  const next = [...current, record];
  while (next.length > max) {
    const oldest = next.findIndex((item) => item.duration !== 0 && item !== record);
    if (oldest < 0) break;
    next.splice(oldest, 1);
  }
  return next;
}
