"use client";

import { Modal } from "@/components/ui/Modal";
import { NAV_ITEMS } from "@/components/layout/nav-items";
import { TODAY_DAY_KEYS } from "@/lib/today/today-day";

/** `g` then a key. Every target is a top-bar or More item (nav-items.tsx). */
export const GO_TO_KEYS: Record<string, string> = {
  t: "/",
  b: "/backlog",
  o: "/portfolio",
  l: "/launch",
  a: "/applications",
  p: "/projects",
  c: "/calendar",
};

/** The task panel's keys (redesign S3; TaskPanel.tsx). They work while a task is open and no field has focus. */
export const TASK_PANEL_KEYS: Array<{ keys: string[]; label: string }> = [
  { keys: ["↑"], label: "Previous task in the list" },
  { keys: ["↓"], label: "Next task in the list" },
  { keys: ["Esc"], label: "Close the task" },
  { keys: ["["], label: "Panel narrower" },
  { keys: ["]"], label: "Panel wider" },
];

const LABEL_BY_HREF = new Map(NAV_ITEMS.map((item) => [item.href, item.label]));

function Key({ children }: { children: string }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded border border-stroke bg-panel-muted px-1.5 py-0.5 font-mono text-xs font-medium text-foreground">
      {children}
    </kbd>
  );
}

function Row({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="flex shrink-0 items-center gap-1">
        {keys.map((k, i) => (
          <span key={`${k}-${i}`} className="flex items-center gap-1">
            {i > 0 ? <span className="text-xs text-muted-foreground">then</span> : null}
            <Key>{k}</Key>
          </span>
        ))}
      </span>
    </div>
  );
}

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts">
      <div className="space-y-5">
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            General
          </h3>
          <div className="divide-y divide-stroke">
            <Row keys={["⌘/Ctrl", "K"]} label="Search everything" />
            <Row keys={["?"]} label="Show this list" />
            <Row keys={["Esc"]} label="Close a dialog" />
          </div>
        </section>

        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Task panel
          </h3>
          <div className="divide-y divide-stroke">
            {TASK_PANEL_KEYS.map((row) => (
              <Row key={row.label} keys={row.keys} label={row.label} />
            ))}
          </div>
        </section>

        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Today: a day as a list
          </h3>
          <div className="divide-y divide-stroke">
            {TODAY_DAY_KEYS.map((row) => (
              <Row key={row.label} keys={row.keys} label={row.label.replace(/^Day list: /, "")} />
            ))}
          </div>
        </section>

        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Go to
          </h3>
          <div className="divide-y divide-stroke">
            {Object.entries(GO_TO_KEYS).map(([key, href]) => (
              <Row key={key} keys={["G", key.toUpperCase()]} label={LABEL_BY_HREF.get(href) ?? href} />
            ))}
          </div>
        </section>

        <p className="text-xs leading-relaxed text-muted-foreground">
          Shortcuts are ignored while you are typing in a field. ⌘K works everywhere.
        </p>
      </div>
    </Modal>
  );
}
