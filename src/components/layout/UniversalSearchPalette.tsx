"use client";

import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import type { BrowserSearchResult } from "@/lib/search/browser";

interface UniversalSearchPaletteProps {
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
}

interface SearchResponse {
  query?: string;
  results?: BrowserSearchResult[];
  error?: string;
}

function truncatePreview(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

export function UniversalSearchPalette({ onClose, onOpenTask }: UniversalSearchPaletteProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const requestSequenceRef = useRef(0);

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [results, setResults] = useState<BrowserSearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedQuery = useMemo(() => deferredQuery.trim(), [deferredQuery]);
  const selectedResult = results[selectedIndex] ?? null;

  const openResult = useCallback((result: BrowserSearchResult) => {
    if (result.entity === "task" && result.recordId) {
      onOpenTask(result.recordId);
      onClose();
      return;
    }

    router.push(result.href);
    onClose();
  }, [onClose, onOpenTask, router]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => inputRef.current?.focus(), 0);

    return () => {
      document.body.style.overflow = "";
      previousFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === "ArrowDown") {
        if (results.length === 0) {
          return;
        }

        event.preventDefault();
        setSelectedIndex((current) => (current + 1) % results.length);
        return;
      }

      if (event.key === "ArrowUp") {
        if (results.length === 0) {
          return;
        }

        event.preventDefault();
        setSelectedIndex((current) => (current - 1 + results.length) % results.length);
        return;
      }

      if (event.key === "Enter" && selectedResult) {
        event.preventDefault();
        openResult(selectedResult);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, openResult, results.length, selectedResult]);

  useEffect(() => {
    if (trimmedQuery.length < 2) {
      return;
    }

    const controller = new AbortController();
    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;

    const timeoutId = window.setTimeout(() => {
      void fetch(`/api/search?q=${encodeURIComponent(trimmedQuery)}`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          const payload = (await response.json().catch(() => null)) as SearchResponse | null;

          if (!response.ok) {
            throw new Error(payload?.error || "Search failed");
          }

          return payload;
        })
        .then((payload) => {
          if (controller.signal.aborted || requestSequenceRef.current !== requestId) {
            return;
          }

          startTransition(() => {
            setResults(payload?.results ?? []);
            setLoading(false);
          });
        })
        .catch((searchError) => {
          if (controller.signal.aborted || requestSequenceRef.current !== requestId) {
            return;
          }

          setResults([]);
          setLoading(false);
          setError(searchError instanceof Error ? searchError.message : "Search failed");
        });
    }, 120);

    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [trimmedQuery]);

  return createPortal(
    <div className="fixed inset-0 z-[70]">
      <button
        type="button"
        aria-label="Close search"
        className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
        onClick={onClose}
      />

      <div className="relative z-[71] flex min-h-screen justify-center px-4 pt-[10vh] pb-6">
        <section
          role="dialog"
          aria-modal="true"
          aria-label="Universal search"
          className="flex max-h-[78vh] w-full max-w-3xl flex-col overflow-hidden rounded-[1.35rem] border border-stroke bg-panel shadow-[0_30px_80px_rgba(0,0,0,0.4)]"
        >
          <div className="border-b border-stroke bg-[linear-gradient(180deg,rgba(196,30,58,0.12),rgba(196,30,58,0.02))] px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-stroke bg-panel-muted text-accent">
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35" />
                  <circle cx="11" cy="11" r="6.5" />
                </svg>
              </div>

              <div className="min-w-0 flex-1">
                <label htmlFor="universal-search-input" className="sr-only">
                  Search Mission Control
                </label>
                <input
                  id="universal-search-input"
                  ref={inputRef}
                  value={query}
                  onChange={(event) => {
                    const nextQuery = event.target.value;
                    const currentTrimmed = query.trim();
                    const nextTrimmed = nextQuery.trim();

                    setQuery(nextQuery);
                    setSelectedIndex(0);

                    if (nextTrimmed.length < 2) {
                      setResults([]);
                      setLoading(false);
                      setError(null);
                    } else if (nextTrimmed !== currentTrimmed) {
                      setLoading(true);
                      setError(null);
                    }
                  }}
                  placeholder="Search tasks, projects, stakeholders, meetings, email..."
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full bg-transparent text-lg font-medium text-foreground outline-none placeholder:text-muted-foreground"
                />
                <p className="mt-1 text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Universal search across your Mission Control records
                </p>
              </div>

              <div className="hidden rounded-lg border border-stroke bg-panel-muted px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground sm:block">
                Esc
              </div>
            </div>
          </div>

          <div className="min-h-[18rem] overflow-y-auto px-3 py-3">
            {trimmedQuery.length < 2 ? (
              <div className="flex h-full min-h-[18rem] flex-col items-center justify-center rounded-2xl border border-dashed border-stroke bg-panel-muted/35 px-6 text-center">
                <p className="text-base font-semibold text-foreground">Start typing to search everything.</p>
                <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                  Results include tasks, applications, projects, sprints, stakeholders, commitments, email, and meetings.
                </p>
                <p className="mt-4 text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Arrow keys to move. Enter to open. Esc to close.
                </p>
              </div>
            ) : loading ? (
              <div className="flex h-full min-h-[18rem] flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                <span>
                  Searching for <span className="font-mono text-foreground">&quot;{trimmedQuery}&quot;</span>
                </span>
              </div>
            ) : error ? (
              <div className="flex h-full min-h-[18rem] flex-col items-center justify-center rounded-2xl border border-red-500/30 bg-red-500/8 px-6 text-center">
                <p className="text-base font-semibold text-foreground">Search is unavailable.</p>
                <p className="mt-2 text-sm text-muted-foreground">{error}</p>
              </div>
            ) : results.length === 0 ? (
              <div className="flex h-full min-h-[18rem] flex-col items-center justify-center rounded-2xl border border-dashed border-stroke bg-panel-muted/35 px-6 text-center">
                <p className="text-base font-semibold text-foreground">
                  No matches for <span className="font-mono">&quot;{trimmedQuery}&quot;</span>.
                </p>
                <p className="mt-2 text-sm text-muted-foreground">Try a shorter phrase, a name, or a project keyword.</p>
              </div>
            ) : (
              <ul role="listbox" aria-label="Search results" className="space-y-2">
                {results.map((result, index) => {
                  const active = index === selectedIndex;

                  return (
                    <li key={result.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        onMouseEnter={() => setSelectedIndex(index)}
                        onClick={() => openResult(result)}
                        className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                          active
                            ? "border-accent/50 bg-accent-soft shadow-[0_10px_25px_rgba(196,30,58,0.12)]"
                            : "border-transparent bg-panel hover:border-stroke hover:bg-panel-muted"
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="text-sm font-semibold text-foreground">{result.title}</h3>
                              <span className="rounded-full border border-stroke bg-panel-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                                {result.entityLabel}
                              </span>
                            </div>
                            {result.context ? (
                              <p className="mt-1 text-xs font-medium text-accent">{result.context}</p>
                            ) : null}
                            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                              {truncatePreview(result.text || "Open record")}
                            </p>
                          </div>

                          <svg
                            className={`mt-1 h-4 w-4 shrink-0 transition ${active ? "text-accent" : "text-muted-foreground"}`}
                            viewBox="0 0 20 20"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.8}
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M7 5l5 5-5 5" />
                          </svg>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>,
    document.body
  );
}
