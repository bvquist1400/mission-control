"use client";

import type { ReactNode } from "react";

interface NotesPanelShellProps {
  title: string;
  description: string;
  titleAs?: "h2" | "h3" | "h4";
  containerClassName: string;
  titleClassName: string;
  descriptionClassName?: string;
  contentSpacingClassName: string;
  listClassName: string;
  stateClassName: string;
  archivedCount: number;
  showArchived: boolean;
  onToggleArchived: () => void;
  onCreateNote: () => void;
  createNoteLabel?: string;
  error: string | null;
  loading: boolean;
  loadingState: ReactNode;
  visibleNoteCount: number;
  totalNoteCount: number;
  archivedOnlyMessage: string;
  archivedOnlyActionLabel?: string;
  emptyTitle: string;
  emptyDescription: string;
  emptyActionLabel?: string;
  children: ReactNode;
}

function panelButtonClass(emphasis = false): string {
  return [
    "rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-60",
    emphasis
      ? "bg-accent text-white hover:opacity-90"
      : "border border-stroke bg-panel text-muted-foreground hover:text-foreground",
  ].join(" ");
}

function joinClassNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function NotesPanelShell({
  title,
  description,
  titleAs = "h3",
  containerClassName,
  titleClassName,
  descriptionClassName = "mt-1 text-sm text-muted-foreground",
  contentSpacingClassName,
  listClassName,
  stateClassName,
  archivedCount,
  showArchived,
  onToggleArchived,
  onCreateNote,
  createNoteLabel = "New Note",
  error,
  loading,
  loadingState,
  visibleNoteCount,
  totalNoteCount,
  archivedOnlyMessage,
  archivedOnlyActionLabel = "Show archived notes",
  emptyTitle,
  emptyDescription,
  emptyActionLabel = "Create first note",
  children,
}: NotesPanelShellProps) {
  const HeadingTag = titleAs;

  return (
    <section className={containerClassName}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <HeadingTag className={titleClassName}>{title}</HeadingTag>
          <p className={descriptionClassName}>{description}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {archivedCount > 0 && (
            <button
              type="button"
              onClick={onToggleArchived}
              className={panelButtonClass()}
            >
              {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
            </button>
          )}
          <button
            type="button"
            onClick={onCreateNote}
            className={panelButtonClass(true)}
          >
            {createNoteLabel}
          </button>
        </div>
      </div>

      {error && (
        <p
          className={joinClassNames(
            contentSpacingClassName,
            "rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          )}
          role="alert"
        >
          {error}
        </p>
      )}

      {loading ? (
        loadingState
      ) : visibleNoteCount > 0 ? (
        <div className={joinClassNames(contentSpacingClassName, listClassName)}>{children}</div>
      ) : totalNoteCount > 0 ? (
        <div className={joinClassNames(contentSpacingClassName, stateClassName)}>
          <p className="text-sm text-foreground">{archivedOnlyMessage}</p>
          <button
            type="button"
            onClick={onToggleArchived}
            className="mt-3 rounded-lg border border-stroke bg-panel px-3 py-2 text-sm font-medium text-muted-foreground transition hover:text-foreground"
          >
            {archivedOnlyActionLabel}
          </button>
        </div>
      ) : (
        <div className={joinClassNames(contentSpacingClassName, stateClassName)}>
          <p className="text-sm font-medium text-foreground">{emptyTitle}</p>
          <p className="mt-1 text-sm text-muted-foreground">{emptyDescription}</p>
          <button
            type="button"
            onClick={onCreateNote}
            className="mt-3 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90"
          >
            {emptyActionLabel}
          </button>
        </div>
      )}
    </section>
  );
}
