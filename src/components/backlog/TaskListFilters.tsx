"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import type { ImplementationSummary, SprintWithImplementation } from "@/types/database";
import type { ListProject } from "@/components/backlog/BacklogList";
import {
  BUILT_IN_VIEWS,
  DUE_LABELS,
  SORT_LABELS,
  STATUS_LABELS,
  TASK_STATUS_ORDER,
  activeFilterCount,
  activeViewId,
  addSavedView,
  filtersForView,
  pickedAfterTap,
  readSavedViews,
  removeSavedView,
  writeSavedViews,
  type DueFilterValue,
  type SavedView,
  type SortValue,
  type StatusFilterValue,
  type TaskListFilters,
} from "@/lib/tasks-list";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function newViewId(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

/** One labelled cell of the filter row: the label, the current value, a native menu (the phone's own picker). */
function FilterSelect({
  label,
  value,
  onChange,
  children,
  active,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  active: boolean;
}) {
  return (
    <label className="tl-f" data-active={active || undefined}>
      <span className="tl-f-label">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
    </label>
  );
}

interface FilterBarProps {
  filters: TaskListFilters;
  onChange: (next: TaskListFilters) => void;
  onClear: () => void;
  implementations: ImplementationSummary[];
  projects: ListProject[];
  sprints: SprintWithImplementation[];
  ownerLabels: string[];
  /** Tasks a view's query matches (in the current scope), for the counts on the view chips. */
  countFor: (query: string) => number;
}

/**
 * The one filter row (status, app, project, sprint, owner, due, review and a
 * search) and the saved views under it (mockup "Saved"). Every change goes
 * straight into the URL. Where the list is narrow (a phone, or the task panel
 * open beside it) the menus fold into a "Filters" sheet behind one button.
 */
export function TaskListFilterBar({ filters, onChange, onClear, implementations, projects, sprints, ownerLabels, countFor }: FilterBarProps) {
  const [search, setSearch] = useState(filters.q);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetId = useId();
  const sheetButtonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const latestFilters = useRef(filters);
  useEffect(() => {
    latestFilters.current = filters;
  }, [filters]);

  // The search box follows the URL (Back, a view) …
  const [seenQ, setSeenQ] = useState(filters.q);
  if (seenQ !== filters.q) {
    setSeenQ(filters.q);
    setSearch(filters.q);
  }
  // … and writes it a moment after typing stops.
  useEffect(() => {
    if (search.trim() === latestFilters.current.q) return;
    const timer = window.setTimeout(() => onChange({ ...latestFilters.current, q: search.replace(/\s+/g, " ").trim().slice(0, 200) }), 250);
    return () => window.clearTimeout(timer);
  }, [search, onChange]);

  // The sheet closes on Esc (focus back on its button) and on a click outside.
  useEffect(() => {
    if (!sheetOpen) return;
    sheetRef.current?.querySelector<HTMLElement>("select, input, button")?.focus({ preventScroll: true });
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setSheetOpen(false);
      sheetButtonRef.current?.focus({ preventScroll: true });
    }
    function onPointer(event: PointerEvent) {
      const target = event.target as Node | null;
      if (target && (sheetRef.current?.contains(target) || sheetButtonRef.current?.contains(target))) return;
      setSheetOpen(false);
    }
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [sheetOpen]);

  const set = <K extends keyof TaskListFilters>(key: K, value: TaskListFilters[K]) => onChange({ ...filters, [key]: value });
  const projectOptions = useMemo(() => {
    const list = filters.app && filters.app !== "none" ? projects.filter((project) => project.implementation_id === filters.app || project.id === filters.project) : projects;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [projects, filters.app, filters.project]);
  const count = activeFilterCount(filters);
  const ownerKnown = !filters.owner || filters.owner === "me" || filters.owner === "agent" || filters.owner === "none" || ownerLabels.some((label) => `agent:${label}`.toLowerCase() === filters.owner?.toLowerCase());

  const menus = (
    <>
      <FilterSelect label="Status" value={filters.status} active={filters.status !== "open"} onChange={(value) => set("status", value as StatusFilterValue)}>
        <option value="open">Open</option>
        {TASK_STATUS_ORDER.map((status) => (
          <option key={status} value={status}>
            {STATUS_LABELS[status]}
          </option>
        ))}
        <option value="all">All (with done)</option>
      </FilterSelect>
      <FilterSelect label="App" value={filters.app ?? ""} active={Boolean(filters.app)} onChange={(value) => onChange({ ...filters, app: value || null, project: value && filters.project && filters.project !== "none" && !projects.some((p) => p.id === filters.project && p.implementation_id === value) ? null : filters.project })}>
        <option value="">All</option>
        <option value="none">No app</option>
        {implementations.map((implementation) => (
          <option key={implementation.id} value={implementation.id}>
            {implementation.name}
          </option>
        ))}
        {filters.app && filters.app !== "none" && !implementations.some((item) => item.id === filters.app) ? <option value={filters.app}>An app not listed</option> : null}
      </FilterSelect>
      <FilterSelect label="Project" value={filters.project ?? ""} active={Boolean(filters.project)} onChange={(value) => set("project", value || null)}>
        <option value="">Any</option>
        <option value="none">No project</option>
        {projectOptions.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
        {filters.project && filters.project !== "none" && !projects.some((item) => item.id === filters.project) ? <option value={filters.project}>A project not listed</option> : null}
      </FilterSelect>
      <FilterSelect label="Sprint" value={filters.sprint ?? ""} active={Boolean(filters.sprint)} onChange={(value) => set("sprint", value || null)}>
        <option value="">Any</option>
        <option value="none">No sprint</option>
        {sprints.map((sprint) => (
          <option key={sprint.id} value={sprint.id}>
            {sprint.name}
          </option>
        ))}
        {filters.sprint && filters.sprint !== "none" && !sprints.some((item) => item.id === filters.sprint) ? <option value={filters.sprint}>A sprint not listed</option> : null}
      </FilterSelect>
      <FilterSelect label="Owner" value={filters.owner ?? ""} active={Boolean(filters.owner)} onChange={(value) => set("owner", value || null)}>
        <option value="">Anyone</option>
        <option value="me">You</option>
        <option value="agent">Any named agent</option>
        {ownerLabels.map((label) => (
          <option key={label} value={`agent:${label}`}>
            Agent: {label}
          </option>
        ))}
        <option value="none">No one named</option>
        {!ownerKnown && filters.owner ? <option value={filters.owner}>Agent: {filters.owner.slice(6)}</option> : null}
      </FilterSelect>
      <FilterSelect label="Due" value={filters.due ?? ""} active={Boolean(filters.due)} onChange={(value) => set("due", (value || null) as DueFilterValue | null)}>
        <option value="">Any</option>
        {(Object.keys(DUE_LABELS) as DueFilterValue[]).map((due) => (
          <option key={due} value={due}>
            {DUE_LABELS[due]}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect label="Review" value={filters.review ?? ""} active={Boolean(filters.review)} onChange={(value) => set("review", (value || null) as TaskListFilters["review"])}>
        <option value="">Any</option>
        <option value="needs_review">Needs review</option>
        <option value="ready">Reviewed</option>
      </FilterSelect>
    </>
  );

  return (
    <div className="tl-filters">
      <div className="tl-frow" role="group" aria-label="Filter tasks">
        <div className="tl-fmenus">{menus}</div>
        <button
          ref={sheetButtonRef}
          type="button"
          className="tl-fbtn"
          aria-expanded={sheetOpen}
          aria-controls={sheetOpen ? sheetId : undefined}
          onClick={() => setSheetOpen((open) => !open)}
        >
          Filters{count ? ` · ${count}` : ""}
          <span aria-hidden="true"> ▾</span>
        </button>
        <label className="tl-search">
          <span className="sr-only">Filter this list</span>
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6}>
            <circle cx="8.5" cy="8.5" r="5" />
            <path d="M12.5 12.5 17 17" />
          </svg>
          <input type="search" value={search} placeholder="Filter this list" onChange={(event) => setSearch(event.target.value)} />
        </label>
        {count > 0 || filters.q ? (
          <button type="button" className="tl-clear" onClick={onClear}>
            Clear
          </button>
        ) : null}
      </div>
      {sheetOpen ? (
        <div ref={sheetRef} id={sheetId} className="tl-sheet" role="dialog" aria-modal="false" aria-label="Filters">
          <div className="tl-sheet-head">
            <h2>Filters</h2>
            <Button variant="secondary" size="sm" onClick={() => setSheetOpen(false)}>
              Done
            </Button>
          </div>
          <div className="tl-sheet-menus">{menus}</div>
          {count > 0 ? (
            <Button variant="ghost" size="sm" onClick={onClear}>
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : null}
      <SavedViews filters={filters} onChange={onChange} countFor={countFor} />
    </div>
  );
}

/**
 * Saved views: the built-in ones, then the user's own (kept on this device in
 * localStorage, like the panel width is kept in a cookie; no database table).
 * The active one is marigold. "Save view" names the current filters.
 */
function SavedViews({ filters, onChange, countFor }: { filters: TaskListFilters; onChange: (next: TaskListFilters) => void; countFor: (query: string) => number }) {
  const [userViews, setUserViews] = useState<SavedView[]>([]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);

  // Read after the first paint (the server has no localStorage), and when another tab changes them.
  useEffect(() => {
    const read = () => setUserViews(readSavedViews(storage()));
    read();
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === "baseline_task_views") read();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (naming) nameRef.current?.focus();
  }, [naming]);

  // The view tapped last: it stays lit while the filters are still that view, even when a
  // built-in view has the same filters (Brent 11/6: "only the original one lights up").
  const [pickedId, setPickedId] = useState<string | null>(null);
  const all = [...BUILT_IN_VIEWS, ...userViews];
  const active = activeViewId(filters, all, pickedId);

  function save() {
    const result = addSavedView(userViews, name, filters, newViewId);
    if (!result.ok) {
      setMessage(result.error);
      return;
    }
    const stored = writeSavedViews(storage(), result.views);
    setUserViews(result.views);
    // The view just saved is the current filters: it is the one lit now.
    setPickedId(result.view.id);
    setNaming(false);
    setName("");
    setMessage(stored ? null : "Saved for now, but this browser won't keep it (private window or storage off).");
    saveButtonRef.current?.focus();
  }

  function remove(view: SavedView) {
    const next = removeSavedView(userViews, view.id);
    writeSavedViews(storage(), next);
    setUserViews(next);
    setMessage(`Removed “${view.name}”.`);
  }

  return (
    <div className="tl-views">
      <span className="tl-views-label">Saved</span>
      <ul className="tl-views-list">
        {all.map((view) => {
          const isActive = view.id === active;
          return (
            <li key={view.id} className="tl-view" data-active={isActive || undefined}>
              <button
                type="button"
                aria-pressed={isActive}
                onClick={() => {
                  setPickedId(pickedAfterTap(view, filters, active));
                  onChange(filtersForView(view, filters, active));
                }}
              >
                {view.name} <span className="tl-view-n">{countFor(view.query)}</span>
              </button>
              {view.builtIn ? null : (
                <button type="button" className="tl-view-x" aria-label={`Remove the view “${view.name}”`} onClick={() => remove(view)}>
                  ×
                </button>
              )}
            </li>
          );
        })}
        <li>
          {naming ? (
            <form
              className="tl-view-form"
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setNaming(false);
                  setMessage(null);
                  saveButtonRef.current?.focus();
                }
              }}
            >
              <label className="sr-only" htmlFor="tl-view-name">
                View name
              </label>
              <input id="tl-view-name" ref={nameRef} value={name} maxLength={32} placeholder="Name this view" onChange={(event) => setName(event.target.value)} />
              <Button type="submit" variant="primary" size="xs">
                Save
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setNaming(false);
                  setMessage(null);
                }}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <button ref={saveButtonRef} type="button" className="tl-view-add" onClick={() => setNaming(true)}>
              + Save view
            </button>
          )}
        </li>
      </ul>
      <label className="tl-sort">
        <span>Sort</span>
        <select value={filters.sort} onChange={(event) => onChange({ ...filters, sort: event.target.value as SortValue })}>
          {(Object.keys(SORT_LABELS) as SortValue[]).map((sort) => (
            <option key={sort} value={sort}>
              {SORT_LABELS[sort]}
            </option>
          ))}
        </select>
      </label>
      {message ? (
        <p className="tl-views-msg" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
