"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

export const REMOVE_KEEPS = "Your ticks, stitch counts and sittings stay.";

export type RemoveResult = { ok: true } | { ok: false; message: string };
export async function sendRemove(projectId: string, fetcher: typeof fetch = fetch): Promise<RemoveResult> {
  try {
    const res = await fetcher(`/api/craft/${projectId}`, { method: "DELETE" });
    if (res.ok || res.status === 404) return { ok: true };
    const reply = await res.json().catch(() => ({})) as { error?: string };
    return { ok: false, message: reply.error ?? "Remove didn't work. Try again." };
  } catch {
    return { ok: false, message: "Remove didn't reach the server. Check the connection and try again." };
  }
}

/** The craft screen's menu: a disclosure with one item, "Remove from craft screen", behind a confirm sheet. */
export function CraftScreenMenu({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    const onDown = (event: MouseEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, [open]);

  async function remove() {
    setState({ busy: true, error: null });
    const result = await sendRemove(projectId);
    if (result.ok) { window.location.assign(`/projects/${projectId}`); return; }
    setState({ busy: false, error: result.message });
  }
  const close = () => { if (!state.busy) { setConfirming(false); setState({ busy: false, error: null }); trigger.current?.focus(); } };

  return (
    <div className="craft-menu" ref={wrap}>
      <Button ref={trigger} variant="ghost" size="icon" aria-label="Craft screen menu" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((v) => !v)}>⋯</Button>
      <div id={menuId} className="craft-menu-panel" hidden={!open}>
        <button type="button" className="craft-menu-item" onClick={() => { setOpen(false); setConfirming(true); }}>Remove from craft screen</button>
      </div>
      <Modal open={confirming} onClose={close} title="Remove from craft screen?">
        <div className="craft-remove">
          <p>This takes <strong>{projectName}</strong> off the craft screen: its parts, round and row counts, and anything added there (notes, links, yarn).</p>
          <p><strong>{REMOVE_KEEPS}</strong> The checklist items stay on their tasks, and you can set it up again from the project page.</p>
          {state.error && <p className="craft-setup-error" role="alert">{state.error}</p>}
          <div className="craft-remove-actions">
            <Button variant="secondary" size="md" onClick={close} disabled={state.busy}>Cancel</Button>
            <Button variant="danger" size="md" onClick={remove} disabled={state.busy} aria-busy={state.busy || undefined}>{state.busy ? "Removing…" : "Remove"}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
