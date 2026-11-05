// The top bar's Work / Personal / All switch (redesign S1). Pure, so the bar and
// the tests share it.
//
// S1 does not add a new app-wide setting: the switch drives the scope each page
// already has, through that page's own URL parameter and default, so a link or
// bookmark keeps working exactly as before:
//   Today       /?mode=work|personal|all          (default work)
//   Portfolio   /portfolio?scope=work|personal|all (default personal)
// On any other page there is nothing to switch, so the bar leaves it out.

import { TASK_SCOPE_VALUES, normalizeTaskScope, type TaskScope } from "@/lib/personal-exclusion";

export const SCOPE_LABELS: Record<TaskScope, string> = {
  work: "Work",
  personal: "Personal",
  all: "All",
};

interface ScopedPage {
  path: string;
  param: string;
  fallback: TaskScope;
  label: string;
}

const SCOPED_PAGES: ScopedPage[] = [
  { path: "/", param: "mode", fallback: "work", label: "Show on Today" },
  { path: "/portfolio", param: "scope", fallback: "personal", label: "Show on Portfolio" },
];

export interface ScopeSwitchOption {
  value: TaskScope;
  label: string;
  href: string;
  active: boolean;
}

export interface ScopeSwitchView {
  label: string;
  current: TaskScope;
  options: ScopeSwitchOption[];
}

function firstValue(params: URLSearchParams, key: string): string | null {
  return params.getAll(key)[0] ?? null;
}

/**
 * The switch for this page, or null when the page has no scope. Other query
 * parameters are kept; the default scope is written without its parameter
 * (`/`, `/portfolio`), the others with it.
 */
export function scopeSwitchFor(pathname: string, search: URLSearchParams | string): ScopeSwitchView | null {
  const page = SCOPED_PAGES.find((candidate) => candidate.path === pathname);
  if (!page) return null;
  const params = typeof search === "string" ? new URLSearchParams(search) : new URLSearchParams(search.toString());
  const current = normalizeTaskScope(firstValue(params, page.param), page.fallback);

  const options = TASK_SCOPE_VALUES.map((value) => {
    const next = new URLSearchParams(params.toString());
    next.delete(page.param);
    if (value !== page.fallback) next.set(page.param, value);
    const query = next.toString();
    return {
      value,
      label: SCOPE_LABELS[value],
      href: query ? `${page.path}?${query}` : page.path,
      active: value === current,
    };
  });

  return { label: page.label, current, options };
}
