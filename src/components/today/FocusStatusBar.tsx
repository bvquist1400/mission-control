"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface FocusDirective {
  id: string;
  text: string;
  scope_type: string;
  scope_value: string | null;
  strength: string;
}

interface FocusStatusBarProps {
  onDirectiveChange?: (directiveId: string | null) => void;
}

export function FocusStatusBar({ onDirectiveChange }: FocusStatusBarProps) {
  const [active, setActive] = useState<FocusDirective | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadFocus() {
      try {
        const response = await fetch("/api/focus", { cache: "no-store" });
        if (response.ok) {
          const data = await response.json();
          setActive(data.active ?? null);
          onDirectiveChange?.(data.active?.id ?? null);
        }
      } catch {
        // Silently fail - focus is optional
      } finally {
        setLoading(false);
      }
    }
    loadFocus();
  }, [onDirectiveChange]);

  if (loading) {
    return null;
  }

  return (
    <div className="flex items-center justify-between rounded-lg border border-stroke bg-panel-muted px-4 py-2">
      <div className="flex items-center gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Focus</span>
        {active ? (
          <span className="text-sm font-medium text-foreground">{active.text}</span>
        ) : (
          <span className="text-sm text-muted-foreground">No active focus</span>
        )}
        {active && (
          <span className="rounded-full bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent">
            {active.strength}
          </span>
        )}
      </div>
      <Link
        href="/focus"
        className="text-xs font-medium text-accent hover:underline"
      >
        Manage
      </Link>
    </div>
  );
}
