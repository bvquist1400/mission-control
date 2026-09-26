"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { buttonClasses } from "@/components/ui/Button";
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

export function BriefReadyButton({
  status,
  variant,
  className,
}: {
  status: TodayBriefStatus | null;
  variant: "rail" | "rail-collapsed" | "chrome";
  className?: string;
}) {
  const view = briefButtonView(status);
  if (!view) return null;
  const look = view.tone === "open" ? "primary" : "secondary";

  if (variant === "rail-collapsed") {
    return (
      <Link
        href={view.href}
        title={view.label}
        aria-label={view.label}
        className={`${buttonClasses({ variant: look, size: "icon" })} h-9 w-9 ${className ?? ""}`}
      >
        {view.tone === "open" ? (
          <span className="text-sm tabular-nums">{status?.open}</span>
        ) : (
          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m5 12.5 4.5 4.5L19 7" />
          </svg>
        )}
      </Link>
    );
  }

  return (
    <Link
      href={view.href}
      title={view.title}
      className={`${buttonClasses({ variant: look, size: variant === "rail" ? "md" : "sm" })} ${
        variant === "chrome" ? "h-9 shadow-sm" : "w-full justify-between"
      } ${className ?? ""}`}
    >
      <span className="flex items-center gap-2 tabular-nums">
        {view.tone === "open" ? <span aria-hidden="true" className="h-2 w-2 rounded-full bg-white" /> : null}
        {view.label}
      </span>
      {variant === "rail" ? <span aria-hidden="true">›</span> : null}
    </Link>
  );
}
