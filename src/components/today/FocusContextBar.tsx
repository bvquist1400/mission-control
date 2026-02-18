"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type DirectiveScopeType = "implementation" | "stakeholder" | "task_type" | "query";
type DirectiveStrength = "nudge" | "strong" | "hard";

interface FocusDirective {
  id: string;
  created_at: string;
  created_by: string;
  is_active: boolean;
  text: string;
  scope_type: DirectiveScopeType;
  scope_id: string | null;
  scope_value: string | null;
  strength: DirectiveStrength;
  starts_at: string | null;
  ends_at: string | null;
  reason: string | null;
}

interface FocusGetResponse {
  active: FocusDirective | null;
  directives?: FocusDirective[];
  note?: string;
}

interface FocusClearResponse {
  cleared: number;
  note?: string;
}

interface FocusContextBarProps {
  onDirectiveChange?: (directiveId: string | null) => void;
}

interface FocusMutationResponse {
  active: FocusDirective | null;
  directive?: FocusDirective | null;
  note?: string;
}

interface ImplementationOption {
  id: string;
  name: string;
}

interface DirectiveDraft {
  text: string;
  scopeType: DirectiveScopeType;
  scopeId: string;
  scopeValue: string;
  strength: DirectiveStrength;
  reason: string;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
}

type LoadMode = "initial" | "refresh" | "silent";

const SCOPE_OPTIONS: Array<{ value: DirectiveScopeType; label: string }> = [
  { value: "implementation", label: "Application" },
  { value: "stakeholder", label: "Stakeholder" },
  { value: "task_type", label: "Task Type" },
  { value: "query", label: "Query" },
];

const STRENGTH_OPTIONS: Array<{ value: DirectiveStrength; label: string; hint: string }> = [
  { value: "nudge", label: "Nudge", hint: "Light preference boost" },
  { value: "strong", label: "Strong", hint: "Default, clear weighting" },
  { value: "hard", label: "Hard", hint: "Maximum bias to focus" },
];

function createInitialDraft(): DirectiveDraft {
  return {
    text: "",
    scopeType: "implementation",
    scopeId: "",
    scopeValue: "",
    strength: "strong",
    reason: "",
    startsAt: "",
    endsAt: "",
    isActive: true,
  };
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function toIsoFromDateTimeLocal(value: string): string | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString();
}

function toDateTimeLocal(isoValue: string | null): string {
  if (!isoValue) {
    return "";
  }

  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const tzOffsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - tzOffsetMs).toISOString().slice(0, 16);
}

function formatTimestamp(isoValue: string | null): string | null {
  if (!isoValue) {
    return null;
  }

  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatWindowLabel(directive: FocusDirective): string {
  const startsAt = formatTimestamp(directive.starts_at);
  const endsAt = formatTimestamp(directive.ends_at);

  if (!startsAt && !endsAt) {
    return "No active window";
  }

  if (startsAt && endsAt) {
    return `${startsAt} → ${endsAt}`;
  }

  if (startsAt) {
    return `Starts ${startsAt}`;
  }

  return `Ends ${endsAt}`;
}

function formatScopeLabel(directive: FocusDirective, implementationNames: Map<string, string>): string {
  switch (directive.scope_type) {
    case "implementation": {
      if (!directive.scope_id) {
        return "Application focus";
      }

      return implementationNames.get(directive.scope_id) ?? "Application focus";
    }
    case "stakeholder":
      return directive.scope_value ? `Stakeholder: ${directive.scope_value}` : "Stakeholder focus";
    case "task_type":
      return directive.scope_value ? `Task type: ${directive.scope_value}` : "Task type focus";
    case "query":
      return directive.scope_value ? `Query: ${directive.scope_value}` : "Query focus";
    default:
      return "Focus";
  }
}

function formatStrengthPill(strength: DirectiveStrength): string {
  switch (strength) {
    case "nudge":
      return "Nudge";
    case "strong":
      return "Strong";
    case "hard":
      return "Hard";
    default:
      return "Strong";
  }
}

async function fetchFocus(includeHistory: boolean): Promise<FocusGetResponse> {
  const params = includeHistory ? "?include_history=true" : "";
  const response = await fetch(`/api/focus${params}`, { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch focus directive");
  }

  return response.json();
}

async function createDirective(payload: Record<string, unknown>): Promise<FocusMutationResponse> {
  const response = await fetch("/api/focus", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  const data = (await response.json().catch(() => ({}))) as { error?: string } & FocusMutationResponse;
  if (!response.ok) {
    throw new Error(data.error ?? "Failed to create focus directive");
  }

  return data;
}

async function patchDirective(id: string, payload: Record<string, unknown>): Promise<FocusMutationResponse> {
  const response = await fetch(`/api/focus/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  const data = (await response.json().catch(() => ({}))) as { error?: string } & FocusMutationResponse;
  if (!response.ok) {
    throw new Error(data.error ?? "Failed to update focus directive");
  }

  return data;
}

async function clearFocus(): Promise<FocusClearResponse> {
  const response = await fetch("/api/focus/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to clear focus directive");
  }

  return response.json();
}

async function fetchImplementations(): Promise<ImplementationOption[]> {
  const response = await fetch("/api/applications", { cache: "no-store" });

  if (response.status === 401) {
    throw new Error("Authentication required. Sign in at /login.");
  }

  if (!response.ok) {
    throw new Error("Failed to fetch applications");
  }

  const data = (await response.json()) as Array<{ id?: string; name?: string }>;
  return data
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      name: typeof item.name === "string" ? item.name : "",
    }))
    .filter((item) => item.id.length > 0 && item.name.length > 0);
}

export function FocusContextBar({ onDirectiveChange }: FocusContextBarProps) {
  const [draft, setDraft] = useState<DirectiveDraft>(() => createInitialDraft());
  const [active, setActive] = useState<FocusDirective | null>(null);
  const [directives, setDirectives] = useState<FocusDirective[]>([]);
  const [implementations, setImplementations] = useState<ImplementationOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [mutatingDirectiveId, setMutatingDirectiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const latestOperationId = useRef(0);
  const implementationNameLookup = useMemo(
    () => new Map(implementations.map((item) => [item.id, item.name])),
    [implementations]
  );

  const loadFocusState = useCallback(
    async (mode: LoadMode) => {
      const operationId = ++latestOperationId.current;
      if (mode === "initial") {
        setLoading(true);
      }
      if (mode === "refresh") {
        setRefreshing(true);
      }
      setError(null);

      try {
        const [focusResult, implementationsResult] = await Promise.allSettled([
          fetchFocus(true),
          fetchImplementations(),
        ]);

        if (operationId !== latestOperationId.current) {
          return;
        }

        if (focusResult.status === "rejected") {
          throw focusResult.reason;
        }

        const focusData = focusResult.value;
        setActive(focusData.active ?? null);
        setDirectives(Array.isArray(focusData.directives) ? focusData.directives : []);
        setNote(focusData.note ?? null);
        onDirectiveChange?.(focusData.active?.id ?? null);

        if (implementationsResult.status === "fulfilled") {
          setImplementations(implementationsResult.value);
        }
      } catch (loadError) {
        if (operationId !== latestOperationId.current) {
          return;
        }
        setError(toErrorMessage(loadError, "Failed to load focus state"));
      } finally {
        if (operationId === latestOperationId.current) {
          if (mode === "initial") {
            setLoading(false);
          }
          if (mode === "refresh") {
            setRefreshing(false);
          }
        }
      }
    },
    [onDirectiveChange]
  );

  useEffect(() => {
    void loadFocusState("initial");
  }, [loadFocusState]);

  const handleRefresh = useCallback(async () => {
    await loadFocusState("refresh");
  }, [loadFocusState]);

  const handleClear = useCallback(async () => {
    setClearing(true);
    setError(null);

    try {
      const result = await clearFocus();
      setNote(result.note ?? null);
      await loadFocusState("silent");
    } catch (clearError) {
      setError(toErrorMessage(clearError, "Failed to clear focus"));
    } finally {
      setClearing(false);
    }
  }, [loadFocusState]);

  const handleCreateDirective = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError(null);

      const text = draft.text.trim();
      if (!text) {
        setError("Directive text is required");
        return;
      }

      if (draft.scopeType === "implementation" && !draft.scopeId) {
        setError("Select an application scope");
        return;
      }

      if (draft.scopeType !== "implementation" && draft.scopeValue.trim().length === 0) {
        setError("Scope value is required");
        return;
      }

      let startsAtIso: string | null = null;
      if (draft.startsAt) {
        startsAtIso = toIsoFromDateTimeLocal(draft.startsAt);
        if (!startsAtIso) {
          setError("Start time must be a valid date/time");
          return;
        }
      }

      let endsAtIso: string | null = null;
      if (draft.endsAt) {
        endsAtIso = toIsoFromDateTimeLocal(draft.endsAt);
        if (!endsAtIso) {
          setError("End time must be a valid date/time");
          return;
        }
      }

      if (startsAtIso && endsAtIso && Date.parse(endsAtIso) <= Date.parse(startsAtIso)) {
        setError("End time must be after start time");
        return;
      }

      const payload: Record<string, unknown> = {
        text,
        scope_type: draft.scopeType,
        strength: draft.strength,
        is_active: draft.isActive,
      };

      if (draft.scopeType === "implementation") {
        payload.scope_id = draft.scopeId;
      } else {
        payload.scope_value = draft.scopeValue.trim();
      }

      const reason = draft.reason.trim();
      if (reason.length > 0) {
        payload.reason = reason;
      }

      if (startsAtIso) {
        payload.starts_at = startsAtIso;
      }

      if (endsAtIso) {
        payload.ends_at = endsAtIso;
      }

      setCreating(true);
      setError(null);

      try {
        const response = await createDirective(payload);
        setNote(response.note ?? null);
        setDraft(createInitialDraft());
        await loadFocusState("silent");
      } catch (createError) {
        setError(toErrorMessage(createError, "Failed to create directive"));
      } finally {
        setCreating(false);
      }
    },
    [draft, loadFocusState]
  );

  const handleToggleDirective = useCallback(
    async (directive: FocusDirective, shouldActivate: boolean) => {
      setMutatingDirectiveId(directive.id);
      setError(null);

      try {
        await patchDirective(directive.id, shouldActivate ? { is_active: true, ends_at: null } : { is_active: false });
        await loadFocusState("silent");
      } catch (patchError) {
        setError(toErrorMessage(patchError, "Failed to update directive"));
      } finally {
        setMutatingDirectiveId(null);
      }
    },
    [loadFocusState]
  );

  const handleUseAsTemplate = useCallback((directive: FocusDirective) => {
    setDraft({
      text: directive.text,
      scopeType: directive.scope_type,
      scopeId: directive.scope_id ?? "",
      scopeValue: directive.scope_value ?? "",
      strength: directive.strength,
      reason: directive.reason ?? "",
      startsAt: toDateTimeLocal(directive.starts_at),
      endsAt: toDateTimeLocal(directive.ends_at),
      isActive: true,
    });
  }, []);

  const scopeLabel = draft.scopeType === "query" ? "Query text" : draft.scopeType === "task_type" ? "Task type" : "Value";

  return (
    <section className="rounded-card border border-stroke bg-panel p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Focus Directives</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Create and manage ranking directives used by plan generation (v1.2 UI).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={loading || refreshing || creating || clearing || Boolean(mutatingDirectiveId)}
            className="rounded-lg border border-stroke px-3 py-2 text-sm font-semibold text-foreground transition hover:bg-panel-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
          <button
            type="button"
            onClick={() => void handleClear()}
            disabled={loading || clearing || creating || !active}
            className="rounded-lg bg-panel-muted px-3 py-2 text-sm font-semibold text-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {clearing ? "Clearing..." : "Clear Focus"}
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="mt-4 space-y-3">
          {[1, 2].map((item) => (
            <div key={item} className="animate-pulse rounded-lg bg-panel-muted p-4">
              <div className="h-3 w-28 rounded bg-stroke" />
              <div className="mt-2 h-4 w-full rounded bg-stroke" />
              <div className="mt-2 h-3 w-3/4 rounded bg-stroke" />
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <article className={`rounded-lg border p-4 ${active ? "border-accent/40 bg-accent-soft/30" : "border-stroke bg-panel-muted"}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Active Focus</p>
                {active ? (
                  <>
                    <p className="mt-1 text-sm font-semibold text-foreground">{active.text}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatScopeLabel(active, implementationNameLookup)} · {formatStrengthPill(active.strength)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{formatWindowLabel(active)}</p>
                    {active.reason ? <p className="mt-1 text-xs text-muted-foreground">Reason: {active.reason}</p> : null}
                  </>
                ) : (
                  <p className="mt-1 text-sm text-muted-foreground">No active focus directive.</p>
                )}
              </div>
              {active ? (
                <button
                  type="button"
                  onClick={() => void handleToggleDirective(active, false)}
                  disabled={Boolean(mutatingDirectiveId)}
                  className="rounded-lg border border-stroke px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-panel-muted disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {mutatingDirectiveId === active.id ? "Updating..." : "Deactivate"}
                </button>
              ) : null}
            </div>
          </article>

          <div className="grid gap-4 xl:grid-cols-2">
            <form onSubmit={handleCreateDirective} className="rounded-lg border border-stroke bg-panel-muted p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-foreground">Create Directive</h3>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(createInitialDraft());
                    setError(null);
                  }}
                  disabled={creating}
                  className="text-xs text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Reset
                </button>
              </div>

              <div className="mt-3 space-y-3">
                <label className="block space-y-1">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Directive text</span>
                  <input
                    value={draft.text}
                    onChange={(event) => setDraft((current) => ({ ...current, text: event.target.value }))}
                    placeholder="Focus Acme migration today"
                    disabled={creating}
                    className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </label>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Scope</span>
                    <select
                      value={draft.scopeType}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          scopeType: event.target.value as DirectiveScopeType,
                          scopeId: event.target.value === "implementation" ? current.scopeId : "",
                          scopeValue: event.target.value === "implementation" ? "" : current.scopeValue,
                        }))
                      }
                      disabled={creating}
                      className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {SCOPE_OPTIONS.map((scope) => (
                        <option key={scope.value} value={scope.value}>
                          {scope.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Strength</span>
                    <select
                      value={draft.strength}
                      onChange={(event) => setDraft((current) => ({ ...current, strength: event.target.value as DirectiveStrength }))}
                      disabled={creating}
                      className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {STRENGTH_OPTIONS.map((strengthOption) => (
                        <option key={strengthOption.value} value={strengthOption.value}>
                          {strengthOption.label}
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-muted-foreground">
                      {STRENGTH_OPTIONS.find((option) => option.value === draft.strength)?.hint}
                    </p>
                  </label>
                </div>

                {draft.scopeType === "implementation" ? (
                  <label className="block space-y-1">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Application</span>
                    <select
                      value={draft.scopeId}
                      onChange={(event) => setDraft((current) => ({ ...current, scopeId: event.target.value }))}
                      disabled={creating}
                      className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <option value="">Select application</option>
                      {implementations.map((implementation) => (
                        <option key={implementation.id} value={implementation.id}>
                          {implementation.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label className="block space-y-1">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{scopeLabel}</span>
                    <input
                      value={draft.scopeValue}
                      onChange={(event) => setDraft((current) => ({ ...current, scopeValue: event.target.value }))}
                      placeholder={draft.scopeType === "stakeholder" ? "Nancy" : draft.scopeType === "task_type" ? "FollowUp" : "Contains keyword..."}
                      disabled={creating}
                      className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                )}

                <label className="block space-y-1">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reason (optional)</span>
                  <input
                    value={draft.reason}
                    onChange={(event) => setDraft((current) => ({ ...current, reason: event.target.value }))}
                    placeholder="Board prep this afternoon"
                    disabled={creating}
                    className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </label>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Starts at (optional)</span>
                    <input
                      type="datetime-local"
                      value={draft.startsAt}
                      onChange={(event) => setDraft((current) => ({ ...current, startsAt: event.target.value }))}
                      disabled={creating}
                      className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ends at (optional)</span>
                    <input
                      type="datetime-local"
                      value={draft.endsAt}
                      onChange={(event) => setDraft((current) => ({ ...current, endsAt: event.target.value }))}
                      disabled={creating}
                      className="w-full rounded-lg border border-stroke bg-panel px-2.5 py-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </label>
                </div>

                <label className="flex items-center gap-2 rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={draft.isActive}
                    onChange={(event) => setDraft((current) => ({ ...current, isActive: event.target.checked }))}
                    disabled={creating}
                    className="h-4 w-4 accent-accent"
                  />
                  Set as active immediately
                </label>
              </div>

              <div className="mt-4 flex justify-end">
                <button
                  type="submit"
                  disabled={creating || loading || clearing}
                  className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {creating ? "Saving..." : "Create Directive"}
                </button>
              </div>
            </form>

            <article className="rounded-lg border border-stroke bg-panel-muted p-4">
              <h3 className="text-sm font-semibold text-foreground">Recent Directives</h3>
              {directives.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">No directives yet.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {directives.map((directive) => {
                    const isActiveDirective = active?.id === directive.id;
                    const isUpdating = mutatingDirectiveId === directive.id;
                    return (
                      <li
                        key={directive.id}
                        className={`rounded-lg border p-3 ${
                          isActiveDirective ? "border-accent/40 bg-accent-soft/20" : "border-stroke bg-panel"
                        }`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">{directive.text}</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {formatScopeLabel(directive, implementationNameLookup)} · {formatStrengthPill(directive.strength)}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">{formatWindowLabel(directive)}</p>
                            {directive.reason ? <p className="mt-1 text-xs text-muted-foreground">Reason: {directive.reason}</p> : null}
                          </div>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                              isActiveDirective ? "bg-accent text-white" : "bg-panel-muted text-muted-foreground"
                            }`}
                          >
                            {isActiveDirective ? "Active" : "Inactive"}
                          </span>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void handleToggleDirective(directive, !isActiveDirective)}
                            disabled={Boolean(mutatingDirectiveId)}
                            className="rounded-lg border border-stroke px-2.5 py-1 text-xs font-semibold text-foreground transition hover:bg-panel-muted disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {isUpdating ? "Updating..." : isActiveDirective ? "Deactivate" : "Activate"}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleUseAsTemplate(directive)}
                            disabled={creating}
                            className="rounded-lg border border-stroke px-2.5 py-1 text-xs font-semibold text-foreground transition hover:bg-panel-muted disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Use as template
                          </button>
                          <span className="text-[11px] text-muted-foreground">
                            Created {formatTimestamp(directive.created_at) ?? "unknown"}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </article>
          </div>
        </div>
      )}

      {note ? <p className="mt-3 text-xs text-muted-foreground">{note}</p> : null}
    </section>
  );
}
