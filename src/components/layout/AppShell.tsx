"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { TaskPanelProvider } from "@/components/tasks/panel/TaskPanelProvider";
import type { PanelWidths } from "@/lib/task-panel";

/**
 * Pages that keep their own full-width layout under the top bar: the v5 pages
 * (brief pages, the Portfolio and record pages). They draw their own column.
 */
const FULL_BLEED_PREFIXES = ["/briefs/", "/portfolio", "/r/"];

/** Signed-out pages: no top bar (its links would only bounce to sign-in). */
const BARE_PREFIXES = ["/login"];

/** Room under the content for the phone/tablet tab bar (56px + the home indicator). */
const TAB_BAR_ROOM = "pb-[calc(4.5rem+env(safe-area-inset-bottom))] lg:pb-0";

/**
 * `.tp-reflow` wraps the page under the top bar: while the task panel is open
 * on a desktop it gets right padding the width of the panel (set by the
 * panel's own server-rendered <style>), so the board or list narrows beside it.
 */
export function AppShell({
  topBar,
  panelWidths,
  children,
}: {
  topBar: ReactNode;
  /** The task panel's remembered widths, read from cookies by the root layout. */
  panelWidths: PanelWidths;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "";

  if (BARE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">{children}</main>;
  }

  if (FULL_BLEED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return (
      <TaskPanelProvider widths={panelWidths}>
        {topBar}
        <div className={`tp-reflow ${TAB_BAR_ROOM}`}>{children}</div>
      </TaskPanelProvider>
    );
  }

  return (
    <TaskPanelProvider widths={panelWidths}>
      {topBar}
      <div className="tp-reflow">
        <main className="mx-auto w-full max-w-[1680px] px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] pt-5 sm:px-6 lg:pb-10">{children}</main>
      </div>
    </TaskPanelProvider>
  );
}
