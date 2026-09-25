"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Routes that render full-bleed, without the sidebar rail or the main panel. */
const FULL_BLEED_PREFIXES = ["/briefs/"];

export function AppShell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const pathname = usePathname() ?? "";

  if (FULL_BLEED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return <>{children}</>;
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[2000px] gap-6 px-4 py-4 sm:px-6 lg:px-8">
      {sidebar}
      <main className="min-h-[calc(100vh-2rem)] min-w-0 flex-1 rounded-2xl border border-stroke bg-panel p-5 pb-24 shadow-sm sm:p-6 sm:pb-24 xl:p-7 xl:pb-8">
        {children}
      </main>
    </div>
  );
}
