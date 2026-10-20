/**
 * Drafts for inline grid cells that save on blur or Enter and drop the draft on
 * Escape (TaskGrid's Due and Estimate cells; cascade S2 fix round 1).
 *
 * Why not React state: the Escape handler calls `blur()`, and the browser runs
 * the blur handler synchronously, inside the same keydown event, before React
 * has applied a queued state update. A blur handler that reads the draft from
 * state therefore still sees the draft Escape meant to drop, and saves it. The
 * drafts live in this plain store instead: `cancel()` takes effect at once, so
 * the blur that follows finds nothing to save. `onChange` tells the component
 * to re-render (the shown value comes from the store).
 */

export interface DraftStore<V> {
  get(id: string): V | undefined;
  set(id: string, value: V): void;
  /** Drops the draft (Escape): the cell shows the saved value again. */
  cancel(id: string): void;
  /** Removes and returns the draft (the commit path); undefined when there is none. */
  take(id: string): V | undefined;
}

export function createDraftStore<V>(onChange: () => void = () => {}): DraftStore<V> {
  const drafts = new Map<string, V>();
  return {
    get: (id) => drafts.get(id),
    set(id, value) {
      drafts.set(id, value);
      onChange();
    },
    cancel(id) {
      if (drafts.delete(id)) onChange();
    },
    take(id) {
      if (!drafts.has(id)) return undefined;
      const value = drafts.get(id);
      drafts.delete(id);
      onChange();
      return value;
    },
  };
}

/** The bits of a keyboard event the cell handlers use (a real React event fits). */
export interface DraftKeyEvent {
  key: string;
  preventDefault(): void;
  currentTarget: { blur(): void };
}

export interface DraftCellHandlers {
  onChange(value: string): void;
  onBlur(): void;
  onKeyDown(event: DraftKeyEvent): void;
}

/**
 * The handlers for one cell. `commit(draft)` runs once per blur or Enter that
 * finds a draft (it decides whether the value changed); Escape drops the draft
 * first and then blurs, so the blur commits nothing. `enter` says whether Enter
 * commits directly ("commit") or by blurring ("blur").
 */
export function draftCellHandlers(input: {
  id: string;
  store: DraftStore<string>;
  commit: (draft: string) => void;
  enter?: "commit" | "blur";
}): DraftCellHandlers {
  const { id, store, commit } = input;
  const flush = () => {
    const draft = store.take(id);
    if (draft !== undefined) commit(draft);
  };
  return {
    onChange: (value) => store.set(id, value),
    onBlur: flush,
    onKeyDown(event) {
      if (event.key === "Enter") {
        event.preventDefault();
        if (input.enter === "blur") event.currentTarget.blur();
        else flush();
        return;
      }
      if (event.key === "Escape") {
        store.cancel(id);
        event.currentTarget.blur();
      }
    },
  };
}
