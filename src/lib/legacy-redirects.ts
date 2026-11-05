/**
 * Where the pages removed in redesign slice S0 now send old links and bookmarks.
 * The page files under src/app/{focus,planner,llm,sprints,stakeholders,weekly-review}
 * are thin shims that call these; scripts/test-legacy-redirects.mjs checks the map
 * and that every shim is wired to it.
 *
 * Temporary (307) on purpose: later slices (S4 Today, S5 Tasks) may move the targets.
 */
export type LegacyRoute =
  | "focus"
  | "planner"
  | "llm"
  | "weekly-review"
  | "sprints"
  | "sprint-detail"
  | "stakeholders"
  | "stakeholder-detail";

/**
 * Next hands a dynamic segment over still percent-encoded, so decode once before
 * encoding again (otherwise `%26` would come out as `%2526`). A bad escape is kept as is.
 */
function encodeSegment(id: string): string {
  let raw = id;
  try {
    raw = decodeURIComponent(id);
  } catch {
    // keep the raw text
  }
  return encodeURIComponent(raw);
}

export function legacyRedirectTarget(route: LegacyRoute, id?: string): string {
  const encodedId = id === undefined ? "" : encodeSegment(id);

  switch (route) {
    case "focus":
    case "planner":
    case "llm":
    case "weekly-review":
      // Focus, Planner, AI Playbooks and Weekly Review no longer have a screen.
      return "/";
    case "sprints":
      return "/backlog";
    case "sprint-detail":
      // Sprint is a Backlog filter now.
      return encodedId ? `/backlog?sprint=${encodedId}` : "/backlog";
    case "stakeholders":
      return "/portfolio";
    case "stakeholder-detail":
      // The record page still shows the person and their commitments.
      return encodedId ? `/r/stakeholder/${encodedId}` : "/portfolio";
  }
}

/** Old path -> route key, for the redirect test and for anyone adding a shim. */
export const LEGACY_PATHS: Record<string, LegacyRoute> = {
  "/focus": "focus",
  "/planner": "planner",
  "/llm": "llm",
  "/weekly-review": "weekly-review",
  "/sprints": "sprints",
  "/stakeholders": "stakeholders",
};
