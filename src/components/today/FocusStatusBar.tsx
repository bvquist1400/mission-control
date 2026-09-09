"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { badgeClasses } from "@/components/ui/Badge";

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
  const lastDirectiveIdRef = useRef<string | null>(null);
  const onDirectiveChangeRef = useRef(onDirectiveChange);
  onDirectiveChangeRef.current = onDirectiveChange;

  useEffect(() => {
    async function loadFocus() {
      try {
        const response = await fetch("/api/focus", { cache: "no-store" });
        if (response.ok) {
          const data = await response.json();
          const nextActive = data.active ?? null;
          const nextDirectiveId = nextActive?.id ?? null;
          setActive(nextActive);
          if (lastDirectiveIdRef.current !== nextDirectiveId) {
            lastDirectiveIdRef.current = nextDirectiveId;
            onDirectiveChangeRef.current?.(nextDirectiveId);
          }
        }
      } catch {
        // Silently fail - focus is optional
      } finally {
        setLoading(false);
      }
    }
    loadFocus();
  }, []);

  // Render nothing unless a directive is actually set. Focus is driven by the
  // MCP tools (set_focus / clear_focus) rather than day-to-day UI, so an
  // always-present "No active focus" row is just a permanently empty shelf.
  if (loading || !active) {
    return null;
  }

  return (
    <div className="flex items-center justify-between rounded-lg border border-stroke bg-panel-muted px-4 py-2">
      <div className="flex items-center gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Focus</span>
        <span className="text-sm font-medium text-foreground">{active.text}</span>
        <span className={badgeClasses({ tone: "accent", size: "sm" })}>
          {active.strength}
        </span>
      </div>
      <Link
        href="/focus"
        className="text-xs font-medium text-accent-text hover:underline"
      >
        Manage
      </Link>
    </div>
  );
}
