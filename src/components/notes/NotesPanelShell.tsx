"use client";

import type { ReactNode } from "react";
import { Button, buttonClasses } from "@/components/ui/Button";

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
  return buttonClasses({ variant: emphasis ? "primary" : "secondary", size: "sm" });
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
            "rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger"
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
          <Button variant="secondary" className="mt-3" onClick={onToggleArchived}>
            {archivedOnlyActionLabel}
          </Button>
        </div>
      ) : (
        <div className={joinClassNames(contentSpacingClassName, stateClassName)}>
          <p className="text-sm font-medium text-foreground">{emptyTitle}</p>
          <p className="mt-1 text-sm text-muted-foreground">{emptyDescription}</p>
          <Button variant="primary" className="mt-3" onClick={onCreateNote}>
            {emptyActionLabel}
          </Button>
        </div>
      )}
    </section>
  );
}
