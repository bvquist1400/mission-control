"use client";

import { useEffect, useId, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import {
  PROJECT_COLOR_PATTERN,
  PROJECT_COLOR_PRESETS,
  THEME_BACKGROUNDS,
  checkColorForEditor,
  colorPairCss,
  formatRatio,
  normalizeHex,
  resolveSquare,
  type ColorPair,
} from "@/lib/project-colors";
import type { ProjectColorCatalog } from "@/lib/project-colors-queries";
import { savedColorsOf } from "@/components/project-colors/ProjectColorsProvider";

/**
 * "Edit colours" (redesign S2; mockup d2-schemes.html, last frame). Every
 * application and project with its square and hex; the selected row opens the
 * 12 presets, a custom hex field, the contrast check against the paper of BOTH
 * themes and a preview in both. Picks are drafts that every square on the page
 * shows straight away; Done saves them (PATCH /api/applications/[id] and
 * /api/projects/[id]); Esc or × closes without saving. Reset puts the selected
 * row back to its default. Yellow is never offered (kept for "needs you").
 *
 * It is a non-modal panel on the right (desktop) so the board stays visible
 * behind it, and a full-screen sheet on a phone.
 */

interface Row {
  kind: "app" | "project";
  id: string;
  name: string;
  /** For a project: its application's name, if it has one. */
  appName: string | null;
  saved: string | null;
  draft: string | null | undefined;
  /** What its square shows now (draft included). */
  pair: ColorPair;
  /** Where that colour comes from. */
  source: "own" | "app" | "default";
}

/** Text and ink of each theme, for the preview cards (the page's own tokens can't show the other theme). */
const PREVIEW_THEMES = [
  { key: "light", label: "Light", sheet: THEME_BACKGROUNDS.light.sheet, paper: THEME_BACKGROUNDS.light.paper, ink: "#2F3520", ink3: "#767B69", rule: "rgba(47,53,32,.26)" },
  { key: "dark", label: "Dark", sheet: THEME_BACKGROUNDS.dark.sheet, paper: THEME_BACKGROUNDS.dark.paper, ink: "#ECEADF", ink3: "#93947F", rule: "rgba(236,234,223,.25)" },
] as const;

export function ProjectColorEditor({
  catalog,
  focusId,
  drafts,
  setDrafts,
  onCatalog,
  onClose,
}: {
  catalog: ProjectColorCatalog;
  focusId: string | null;
  drafts: Map<string, string | null>;
  setDrafts: Dispatch<SetStateAction<Map<string, string | null>>>;
  onCatalog: (next: ProjectColorCatalog) => void;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(focusId);
  const [custom, setCustom] = useState("");
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh list when it opens (a project made since the page loaded); drafts stay.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/project-colors", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((next: ProjectColorCatalog | null) => {
        if (!cancelled && next && Array.isArray(next.apps) && Array.isArray(next.projects)) onCatalog(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus moves into the panel and comes back to what opened it.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Scroll the row a square opened into view.
  useEffect(() => {
    if (!focusId) return;
    panelRef.current?.querySelector(`[data-colour-row="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focusId]);

  const saved = useMemo(() => savedColorsOf(catalog), [catalog]);
  const overrides = useMemo(() => {
    const merged = new Map(saved);
    for (const [id, color] of drafts) merged.set(id, color);
    return merged;
  }, [saved, drafts]);

  const rows = useMemo(() => {
    const appsById = new Map(catalog.apps.map((app) => [app.id, app]));
    const apps: Row[] = catalog.apps.map((app) => {
      const square = resolveSquare({ app }, overrides)!;
      return {
        kind: "app",
        id: app.id,
        name: app.name,
        appName: null,
        saved: app.color,
        draft: drafts.get(app.id),
        pair: square,
        source: square.source === "app" ? "own" : "default",
      };
    });
    const projects: Row[] = catalog.projects.map((project) => {
      const app = project.implementation_id ? appsById.get(project.implementation_id) ?? null : null;
      const square = resolveSquare({ app, project }, overrides)!;
      return {
        kind: "project",
        id: project.id,
        name: project.name,
        appName: app?.name ?? null,
        saved: project.color,
        draft: drafts.get(project.id),
        pair: square,
        source: square.source === "project" ? "own" : square.source === "app" ? "app" : "default",
      };
    });
    return { apps, projects };
  }, [catalog, drafts, overrides]);

  const needle = filter.trim().toLowerCase();
  const visible = (list: Row[]) => (needle ? list.filter((row) => row.name.toLowerCase().includes(needle)) : list);
  const allRows = [...rows.apps, ...rows.projects];
  const selected = allRows.find((row) => row.id === selectedId) ?? null;
  const changed = [...drafts.entries()].filter(([id, color]) => (saved.get(id) ?? null) !== color);

  function select(row: Row) {
    if (selectedId === row.id) {
      setSelectedId(null);
      return;
    }
    setSelectedId(row.id);
    setCustom(row.draft !== undefined ? row.draft ?? "" : row.saved ?? "");
    setError(null);
  }

  function pick(id: string, color: string | null) {
    setDrafts((current) => {
      const next = new Map(current);
      next.set(id, color);
      return next;
    });
    setError(null);
  }

  function onCustomChange(value: string) {
    setCustom(value);
    if (!selected) return;
    const typed = value.trim().startsWith("#") ? value.trim() : `#${value.trim()}`;
    if (PROJECT_COLOR_PATTERN.test(typed) && checkColorForEditor(typed).ok) pick(selected.id, normalizeHex(typed));
  }

  async function save() {
    if (changed.length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    const kinds = new Map(allRows.map((row) => [row.id, row.kind]));
    const failures: string[] = [];
    const done = new Map<string, string | null>();
    for (const [id, color] of changed) {
      const kind = kinds.get(id);
      if (!kind) continue;
      try {
        const response = await fetch(kind === "app" ? `/api/applications/${id}` : `/api/projects/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ color }),
        });
        const body = (await response.json().catch(() => null)) as { color?: string | null; error?: string } | null;
        if (!response.ok) {
          failures.push(`${allRows.find((row) => row.id === id)?.name ?? "A row"}: ${body?.error ?? "couldn't save"}`);
          continue;
        }
        done.set(id, body && "color" in body ? body.color ?? null : color);
      } catch {
        failures.push(`${allRows.find((row) => row.id === id)?.name ?? "A row"}: couldn't reach Baseline`);
      }
    }
    if (done.size > 0) {
      onCatalog({
        ...catalog,
        apps: catalog.apps.map((app) => (done.has(app.id) ? { ...app, color: done.get(app.id) ?? null } : app)),
        projects: catalog.projects.map((project) => (done.has(project.id) ? { ...project, color: done.get(project.id) ?? null } : project)),
      });
      setDrafts((current) => {
        const next = new Map(current);
        for (const id of done.keys()) next.delete(id);
        return next;
      });
    }
    setSaving(false);
    if (failures.length > 0) {
      setError(failures.join(" · "));
      return;
    }
    toast({ tone: "success", message: done.size === 1 ? "Colour saved." : `${done.size} colours saved.` });
    onClose();
  }

  const check = selected && custom.trim() ? checkColorForEditor(custom.trim().startsWith("#") ? custom.trim() : `#${custom.trim()}`) : null;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col border-foreground bg-panel pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-foreground lg:inset-auto lg:pb-0 lg:pt-0 lg:right-4 lg:top-[68px] lg:max-h-[calc(100vh-84px)] lg:w-[440px] lg:border-[1.5px] lg:shadow-lg"
    >
      <div className="flex items-start gap-3 border-b border-stroke px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="font-cond text-lg font-semibold leading-tight">Project colours</h2>
          <p className="mt-0.5 font-mono text-xs leading-snug text-muted-foreground">
            Saved on each app and project, so every screen and device shows the same colours. Your AI assistant can set them too.
          </p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Close without saving" onClick={onClose}>
          ×
        </Button>
      </div>

      {!catalog.available ? (
        <p className="border-b border-stroke bg-warning-soft px-4 py-2 text-sm text-warning">
          Colours can&apos;t be saved yet: the database update for them (069) isn&apos;t in. Squares show the default colours meanwhile.
        </p>
      ) : null}

      {allRows.length > 8 ? (
        <div className="border-b border-stroke px-4 py-2">
          <Input size="sm" type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Find an app or project" aria-label="Find an app or project" />
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {[
          { title: "Apps", list: visible(rows.apps) },
          { title: "Projects", list: visible(rows.projects) },
        ].map((group) =>
          group.list.length === 0 ? null : (
            <section key={group.title} aria-label={group.title}>
              <h3 className="bg-panel-muted px-4 py-1.5 font-mono text-xs font-semibold text-muted-foreground">{group.title}</h3>
              <ul>
                {group.list.map((row) => {
                  const open = row.id === selectedId;
                  const was = row.draft !== undefined && row.draft !== row.saved ? row.saved ?? "default" : null;
                  return (
                    <li key={row.id} data-colour-row={row.id} className={`border-b border-stroke ${open ? "bg-panel-muted" : ""}`}>
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => select(row)}
                        className="flex min-h-11 w-full items-center gap-2.5 px-4 py-2 text-left hover:bg-panel-muted"
                      >
                        <span aria-hidden="true" className="h-3.5 w-3.5 shrink-0" style={{ background: colorPairCss(row.pair) }} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-cond text-[15px] font-semibold">{row.name}</span>
                          <span className="block truncate font-mono text-xs text-muted-foreground">
                            {row.kind === "app" ? "app" : row.appName ? `project · ${row.appName}` : "project"}
                            {was ? ` · was ${was}` : ""}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                          {row.source === "own" ? row.pair.light : row.source === "app" ? "from app" : "default"}
                        </span>
                      </button>

                      {open ? (
                        <div className="space-y-3 px-4 pb-4 pt-1">
                          <div role="group" aria-label={`Colours for ${row.name}`} className="grid grid-cols-6 gap-1.5">
                            {PROJECT_COLOR_PRESETS.map((preset) => {
                              const chosen = (row.draft !== undefined ? row.draft : row.saved) === preset.light;
                              return (
                                <button
                                  key={preset.light}
                                  type="button"
                                  aria-pressed={chosen}
                                  aria-label={`${preset.label} ${preset.light}`}
                                  title={`${preset.label} ${preset.light}`}
                                  onClick={() => {
                                    pick(row.id, preset.light);
                                    setCustom(preset.light);
                                  }}
                                  className={`h-8 ${chosen ? "outline outline-2 outline-offset-2 outline-foreground" : "border border-stroke"}`}
                                  style={{ background: colorPairCss(preset) }}
                                />
                              );
                            })}
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <label htmlFor={`${titleId}-custom`} className="font-mono text-xs text-muted-foreground">Custom</label>
                            <Input
                              id={`${titleId}-custom`}
                              size="sm"
                              className="w-32 font-mono"
                              value={custom}
                              placeholder="#3B5BA5"
                              maxLength={7}
                              spellCheck={false}
                              autoComplete="off"
                              onChange={(event) => onCustomChange(event.target.value)}
                              aria-describedby={`${titleId}-check`}
                            />
                            <p id={`${titleId}-check`} className="min-w-0 flex-1 font-mono text-xs leading-snug" aria-live="polite">
                              <CheckLine check={check} />
                            </p>
                          </div>

                          <div className="flex flex-wrap items-stretch gap-2">
                            {PREVIEW_THEMES.map((theme) => (
                              <div key={theme.key} className="min-w-0 flex-1 p-2" style={{ background: theme.paper }}>
                                <p className="font-mono text-xs" style={{ color: theme.ink3 }}>{theme.label}</p>
                                <div className="mt-1 border px-2 py-1.5" style={{ background: theme.sheet, borderColor: theme.rule }}>
                                  <p className="truncate font-cond text-sm font-semibold" style={{ color: theme.ink }}>Sample task</p>
                                  <p className="mt-0.5 flex items-center gap-1.5 font-mono text-xs" style={{ color: theme.ink }}>
                                    <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0" style={{ background: theme.key === "light" ? row.pair.light : row.pair.dark }} />
                                    <span className="truncate">{row.name.replace(/^personal\s*[—–-]\s*/i, "")}</span>
                                  </p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          )
        )}
        {allRows.length === 0 ? <p className="px-4 py-6 text-sm text-muted-foreground">No apps or projects yet.</p> : null}
      </div>

      <div className="border-t border-stroke px-4 py-3">
        {error ? <p className="mb-2 text-sm text-danger" role="alert">{error}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 font-mono text-xs leading-snug text-muted-foreground">
            Yellow is kept for &ldquo;needs you&rdquo;, so it isn&apos;t offered.
            {changed.length > 0 ? ` ${changed.length} not saved yet.` : ""}
          </p>
          {selected ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={saving || (selected.draft === undefined ? selected.saved === null : selected.draft === null)}
              onClick={() => {
                pick(selected.id, null);
                setCustom("");
              }}
            >
              Reset {selected.name.replace(/^personal\s*[—–-]\s*/i, "").slice(0, 24)}
            </Button>
          ) : null}
          <Button variant="primary" size="sm" disabled={saving || (!catalog.available && changed.length > 0)} onClick={save}>
            {saving ? "Saving…" : "Done"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CheckLine({ check }: { check: ReturnType<typeof checkColorForEditor> | null }) {
  if (!check) return <span className="text-muted-foreground">Pick a colour or type a hex code.</span>;
  if (check.problem === "format") return <span className="text-muted-foreground">Type 6 hex digits, like #3B5BA5.</span>;
  if (check.problem === "needs_you") return <span className="text-danger">Yellow and gold are kept for &ldquo;needs you&rdquo;.</span>;
  const light = `Light ${formatRatio(check.light.ratio)}`;
  const dark = `Dark ${formatRatio(check.dark.ratio)}${check.dark.adjusted ? ` (shown as ${check.dark.color})` : ""}`;
  if (check.problem === "contrast") {
    return <span className="text-danger">Too pale for the light background ({formatRatio(check.light.ratio)}, needs 3:1).</span>;
  }
  return <span className="text-success">{light} ✓ · {dark} ✓ · not yellow ✓</span>;
}
