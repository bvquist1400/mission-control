"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { craftProjectHref, craftProjectOptionLabel, type CraftProjectOption } from "@/lib/craft";

/** The URL is the state: choosing a project is a client navigation to /craft/<id>, so back, forward and reload work. */
export function switchCraftProject(router: { push: (href: string) => void }, currentId: string, nextId: string) {
  if (!nextId || nextId === currentId) return null;
  const href = craftProjectHref(nextId);
  router.push(href);
  return href;
}

/**
 * The project title is the trigger. A native select sits over it (invisible), so phones get their own picker and
 * keyboards and screen readers get a real combobox: arrows move, Escape closes, focus stays on the title.
 */
export function CraftProjectSwitcher({ currentId, currentName, projects }: { currentId: string; currentName: string; projects: CraftProjectOption[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The shown project is always an option, even if the list was read a moment before it existed.
  const options = projects.some((project) => project.id === currentId) ? projects : [{ id: currentId, name: currentName, craft: "", progress: null }, ...projects];
  // The caret stays with the last word, so a wrapped title never leaves it alone on a line.
  // A very long last word may still wrap (no overflow at 375px), so only short ones are kept whole.
  const trimmed = currentName.trimEnd(), space = trimmed.lastIndexOf(" ");
  const cut = trimmed.length - space - 1 <= 24 ? space : trimmed.length;
  const head = trimmed.slice(0, cut + 1), tail = trimmed.slice(cut + 1);
  return (
    <div className="craft-switch" data-pending={pending ? "true" : undefined}>
      <h2>{head}<span className="craft-switch-tail">{tail}<span className="craft-switch-caret" aria-hidden="true">▾</span></span></h2>
      <select aria-label="Switch craft project" value={currentId} aria-busy={pending || undefined}
        onChange={(event) => { const nextId = event.target.value; startTransition(() => { switchCraftProject(router, currentId, nextId); }); }}>
        {options.map((project) => (
          <option key={project.id} value={project.id}>{craftProjectOptionLabel(project)}{project.id === currentId ? " (current)" : ""}</option>
        ))}
      </select>
    </div>
  );
}
