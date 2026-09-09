"use client";

import { Modal } from "@/components/ui/Modal";
import { NAV_GROUPS } from "@/components/layout/nav-items";

export const GO_TO_KEYS: Record<string, string> = {
  t: "/",
  b: "/backlog",
  s: "/sprints",
  a: "/applications",
  p: "/projects",
  k: "/stakeholders",
  w: "/weekly-review",
  c: "/calendar",
};

const LABEL_BY_HREF = new Map(
  NAV_GROUPS.flatMap((group) => group.items).map((item) => [item.href, item.label])
);

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
            <Row keys={["["]} label="Collapse or expand the sidebar" />
            <Row keys={["?"]} label="Show this list" />
            <Row keys={["Esc"]} label="Close a dialog" />
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
