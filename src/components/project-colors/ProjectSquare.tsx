"use client";

import type { MouseEvent } from "react";
import { colorPairCss, resolveSquare, type ColorEntity, type ProjectColorEntity, type ResolvedSquare } from "@/lib/project-colors";
import { useProjectColors, type ProjectColorsContextValue } from "@/components/project-colors/ProjectColorsProvider";

/**
 * The small project / application colour square (redesign S2; mockup d2/d3:
 * 10px, always next to a name, so colour is never the only signal). It follows
 * the light/dark choice through CSS `light-dark()`. Clicking it opens "Edit
 * colours" on the row that gives it its colour; it is a plain mark when the
 * colours aren't available or `editable` is false (e.g. inside another button).
 */

export interface ProjectSquareProps {
  app?: ColorEntity | null;
  project?: ProjectColorEntity | null;
  /** "sm" 10px (cards, rows), "md" 14px (page headers). */
  size?: "sm" | "md";
  editable?: boolean;
  className?: string;
}

const SIZE_CLASS = { sm: "h-2.5 w-2.5", md: "h-3.5 w-3.5" } as const;

/**
 * Fills in what a caller's row lacks from the colour list: a project's tags and
 * application (a Portfolio lane or a project row may pass only the project).
 */
export function resolveSquareFromCatalog(
  context: Pick<ProjectColorsContextValue, "catalog" | "overrides">,
  app: ColorEntity | null | undefined,
  project: ProjectColorEntity | null | undefined
): ResolvedSquare | null {
  const { catalog, overrides } = context;
  let fullProject = project ?? null;
  let fullApp = app ?? null;
  if (fullProject) {
    const known = catalog.projects.find((row) => row.id === fullProject!.id);
    if (known) {
      fullProject = { ...fullProject, name: fullProject.name || known.name, tags: fullProject.tags ?? known.tags };
      if (!fullApp && known.implementation_id) {
        const knownApp = catalog.apps.find((row) => row.id === known.implementation_id);
        if (knownApp) fullApp = { id: knownApp.id, name: knownApp.name };
      }
    }
  }
  if (fullApp && !fullApp.name) {
    const knownApp = catalog.apps.find((row) => row.id === fullApp!.id);
    if (knownApp) fullApp = { ...fullApp, name: knownApp.name };
  }
  // A row we can't name (not in the list yet) gets no square rather than a wrong one.
  if (fullProject && !fullProject.name) fullProject = null;
  if (fullApp && !fullApp.name) fullApp = null;
  return resolveSquare({ app: fullApp, project: fullProject }, overrides);
}

export function ProjectSquare({ app, project, size = "sm", editable = true, className = "" }: ProjectSquareProps) {
  const colors = useProjectColors();
  const { available, openEditor } = colors;
  const square = resolveSquareFromCatalog(colors, app, project);
  if (!square) return null;

  const swatch = (
    <span
      aria-hidden="true"
      data-project-square={square.owner.id}
      className={`inline-block shrink-0 ${SIZE_CLASS[size]}`}
      style={{ background: colorPairCss(square) }}
    />
  );

  if (!editable || !available) {
    return <span className={`inline-flex shrink-0 items-center ${className}`}>{swatch}</span>;
  }

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    // Squares sit on cards and rows that open something themselves.
    event.preventDefault();
    event.stopPropagation();
    openEditor(square.owner.id);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${square.owner.name} colour: edit colours`}
      title={`${square.owner.name}: edit colours`}
      // A 10px mark with a little slop around it so it can be hit with a pointer.
      className={`-m-1 inline-flex shrink-0 items-center justify-center p-1 hover:opacity-80 ${className}`}
    >
      {swatch}
    </button>
  );
}

/** The square plus a short name ("■ Baseline"), as on the mockup's cards and rows: the name of whoever gives it its colour. */
export function ProjectTag({
  app,
  project,
  editable = true,
  className = "",
}: {
  app?: ColorEntity | null;
  project?: ProjectColorEntity | null;
  editable?: boolean;
  className?: string;
}) {
  const square = resolveSquareFromCatalog(useProjectColors(), app, project);
  if (!square) return null;
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground ${className}`}>
      <ProjectSquare app={app} project={project} editable={editable} />
      <span className="truncate">{shortProjectName(square.owner.name)}</span>
    </span>
  );
}

/** A project name without the "Personal — " prefix (as the Portfolio lanes show it). */
export function shortProjectName(name: string): string {
  return name.replace(/^personal\s*[—–-]\s*/i, "") || name;
}
