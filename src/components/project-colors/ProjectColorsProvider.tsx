"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { ColorOverrides } from "@/lib/project-colors";
import type { ProjectColorCatalog } from "@/lib/project-colors-queries";
import { ProjectColorEditor } from "@/components/project-colors/ProjectColorEditor";

/**
 * Project colours on the client (redesign S2). The root layout reads the colour
 * list on the server and hands it here, so every project square paints with the
 * right colour from the first frame. The "Edit colours" editor lives here too:
 * while it is open its picks are drafts that every square on the page shows at
 * once (live preview); Done saves them, Esc / × drops them.
 */

export interface ProjectColorsContextValue {
  /** False before 069 is live (or signed out): squares show defaults and are not buttons. */
  available: boolean;
  catalog: ProjectColorCatalog;
  /** Stored colours by id with the editor's unsaved drafts on top. */
  overrides: ColorOverrides;
  openEditor: (focusId?: string | null) => void;
}

const EMPTY_OVERRIDES: ColorOverrides = new Map();

const ProjectColorsContext = createContext<ProjectColorsContextValue>({
  available: false,
  catalog: { available: false, apps: [], projects: [] },
  overrides: EMPTY_OVERRIDES,
  openEditor: () => {},
});

export function useProjectColors(): ProjectColorsContextValue {
  return useContext(ProjectColorsContext);
}

export function savedColorsOf(catalog: ProjectColorCatalog): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const app of catalog.apps) map.set(app.id, app.color);
  for (const project of catalog.projects) map.set(project.id, project.color);
  return map;
}

export function ProjectColorsProvider({ initialCatalog, children }: { initialCatalog: ProjectColorCatalog; children: ReactNode }) {
  const [catalog, setCatalog] = useState<ProjectColorCatalog>(initialCatalog);
  // A server refresh (router.refresh after a create or rename) brings a newer list: take it.
  const [seen, setSeen] = useState(initialCatalog);
  if (seen !== initialCatalog) {
    setSeen(initialCatalog);
    setCatalog(initialCatalog);
  }
  const [drafts, setDrafts] = useState<Map<string, string | null>>(() => new Map());
  const [editor, setEditor] = useState<{ open: boolean; focusId: string | null }>({ open: false, focusId: null });

  const overrides = useMemo<ColorOverrides>(() => {
    const merged = savedColorsOf(catalog);
    for (const [id, color] of drafts) merged.set(id, color);
    return merged;
  }, [catalog, drafts]);

  const openEditor = useCallback((focusId?: string | null) => {
    setEditor({ open: true, focusId: focusId ?? null });
  }, []);

  const closeEditor = useCallback(() => {
    setDrafts(new Map());
    setEditor({ open: false, focusId: null });
  }, []);

  const value = useMemo<ProjectColorsContextValue>(
    () => ({ available: catalog.available, catalog, overrides, openEditor }),
    [catalog, overrides, openEditor]
  );

  return (
    <ProjectColorsContext.Provider value={value}>
      {children}
      {editor.open ? (
        <ProjectColorEditor
          catalog={catalog}
          focusId={editor.focusId}
          drafts={drafts}
          setDrafts={setDrafts}
          onCatalog={setCatalog}
          onClose={closeEditor}
        />
      ) : null}
    </ProjectColorsContext.Provider>
  );
}
