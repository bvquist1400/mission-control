"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/", label: "Today", hint: "Daily operating view" },
  { href: "/backlog", label: "Backlog", hint: "All tasks with filters and edits" },
  { href: "/triage", label: "Triage", hint: "Assign, estimate, schedule" },
  { href: "/applications", label: "Applications", hint: "Portfolio health and updates" },
  { href: "/focus", label: "Focus", hint: "Planner directives" },
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

  return (
    <>
      <nav className="fixed inset-x-4 bottom-4 z-20 rounded-xl border border-stroke bg-panel/95 p-2 shadow-lg backdrop-blur lg:hidden">
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
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Mission Control</h1>
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
