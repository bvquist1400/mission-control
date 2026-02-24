"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const navItems = [
  { href: "/", label: "Today", hint: "Daily operating view" },
  { href: "/backlog", label: "Backlog", hint: "All tasks with filters and edits" },
  { href: "/triage", label: "Triage", hint: "Assign, estimate, schedule" },
  { href: "/applications", label: "Applications", hint: "Portfolio health and updates" },
  { href: "/projects", label: "Projects", hint: "Track work within applications" },
  { href: "/stakeholders", label: "Stakeholders", hint: "People and commitments" },
  { href: "/focus", label: "Focus", hint: "Planner directives" },
  { href: "/planner", label: "Planner", hint: "Plan generation and refresh" },
  { href: "/calendar", label: "Calendar", hint: "Imported schedule metadata" },
  { href: "/llm", label: "LLM", hint: "Model and cost evaluation" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === href;
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setMobileOpen((open) => !open)}
        aria-controls="mobile-sidebar"
        aria-expanded={mobileOpen}
        aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
        className="fixed left-4 top-4 z-40 rounded-lg border border-stroke bg-panel/95 p-2 text-foreground shadow-sm backdrop-blur md:hidden"
      >
        {mobileOpen ? (
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M6 18L18 6" />
          </svg>
        ) : (
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        )}
      </button>

      {mobileOpen ? (
        <>
          <button
            type="button"
            aria-label="Close navigation menu"
            onClick={() => setMobileOpen(false)}
            className="fixed inset-0 z-30 bg-black/35 md:hidden"
          />
          <aside
            id="mobile-sidebar"
            className="fixed inset-y-0 left-0 z-40 w-72 border-r border-stroke bg-panel p-5 shadow-lg md:hidden"
          >
            <div className="border-b border-stroke pb-5">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Brent&apos;s Hub</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Baseline</h1>
            </div>

            <nav className="mt-4 space-y-2">
              {navItems.map((item) => {
                const active = isActive(pathname, item.href);

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    className={`block rounded-xl border px-4 py-3 transition ${
                      active
                        ? "border-accent/30 bg-accent-soft text-accent"
                        : "border-transparent bg-transparent text-muted-foreground hover:border-stroke hover:bg-panel-muted hover:text-foreground"
                    }`}
                  >
                    <p className="text-sm font-semibold">{item.label}</p>
                    <p className="mt-1 text-xs leading-relaxed">{item.hint}</p>
                  </Link>
                );
              })}
            </nav>
          </aside>
        </>
      ) : null}

      <nav className="fixed inset-x-4 bottom-4 z-20 hidden rounded-xl border border-stroke bg-panel/95 p-2 shadow-lg backdrop-blur md:block lg:hidden">
        <ul className="grid gap-2" style={{ gridTemplateColumns: `repeat(${navItems.length}, minmax(0, 1fr))` }}>
          {navItems.map((item) => {
            const active = isActive(pathname, item.href);

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`block rounded-lg px-2 py-2 text-center text-xs font-semibold transition ${
                    active ? "bg-accent text-white" : "text-muted-foreground hover:bg-panel-muted hover:text-foreground"
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <aside className="hidden min-h-[calc(100vh-2rem)] w-72 shrink-0 rounded-2xl border border-stroke bg-panel p-5 shadow-sm lg:block">
        <div className="border-b border-stroke pb-5">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Brent&apos;s Hub</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Baseline</h1>
        </div>

        <nav className="mt-4 space-y-2">
          {navItems.map((item) => {
            const active = isActive(pathname, item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block rounded-xl border px-4 py-3 transition ${
                  active
                    ? "border-accent/30 bg-accent-soft text-accent"
                    : "border-transparent bg-transparent text-muted-foreground hover:border-stroke hover:bg-panel-muted hover:text-foreground"
                }`}
              >
                <p className="text-sm font-semibold">{item.label}</p>
                <p className="mt-1 text-xs leading-relaxed">{item.hint}</p>
              </Link>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
