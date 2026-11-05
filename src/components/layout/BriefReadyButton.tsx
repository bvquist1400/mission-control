"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { briefButtonView, type TodayBriefStatus } from "@/lib/briefs/button";

/**
 * Today's brief status. Starts from the server-rendered value (layout), follows
 * router.refresh(), and re-reads /api/briefs/today on each navigation, since
 * the root layout itself doesn't re-render on client navigation. No polling.
 */
export function useTodayBrief(initial: TodayBriefStatus | null): TodayBriefStatus | null {
  const pathname = usePathname();
  const [status, setStatus] = useState(initial);
  const [seenInitial, setSeenInitial] = useState(initial);
  if (initial !== seenInitial) {
    setSeenInitial(initial);
    setStatus(initial);
  }

  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    let cancelled = false;
    fetch("/api/briefs/today", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { status?: TodayBriefStatus | null } | null) => {
        if (!cancelled && body) setStatus(body.status ?? null);
      })
      .catch(() => {
        // Keep the last known state; the button is a convenience.
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return status;
}

/**
 * Today's brief in the top bar: marigold ("needs you") while items wait,
 * a quiet outline once everything is decided, nothing without a brief.
 * `compact` (phone bar) drops the words after the count.
 */
export function BriefReadyButton({
  status,
  variant,
  className,
}: {
  status: TodayBriefStatus | null;
  variant: "bar" | "compact";
  className?: string;
}) {
  const view = briefButtonView(status);
  if (!view) return null;
  const lit = view.tone === "open";
  const label =
    variant === "compact" && status
      ? lit
        ? `${status.code} · ${status.open}`
        : `${status.code} · done`
      : view.label;

  return (
    <Link
      href={view.href}
      title={view.title}
      aria-label={variant === "compact" ? view.title : undefined}
      className={`inline-flex h-[34px] shrink-0 items-center gap-2 whitespace-nowrap border px-3 font-mono text-[13px] font-semibold tabular-nums transition pointer-coarse:min-h-11 ${
        lit
          ? "border-hi bg-hi text-hi-ink hover:brightness-105"
          : "border-bar-ink-2 text-bar-ink-2 hover:text-bar-ink"
      } ${className ?? ""}`}
    >
      {lit ? <span aria-hidden="true" className="h-[7px] w-[7px] bg-hi-ink" /> : null}
      {label}
    </Link>
  );
}
