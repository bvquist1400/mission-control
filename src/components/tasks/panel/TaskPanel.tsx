"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useTaskPanel } from "@/components/tasks/panel/TaskPanelProvider";
import { TaskPanelBody } from "@/components/tasks/panel/TaskPanelBody";
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_DOCK_MIN_WINDOW,
  PANEL_MIN_WIDTH,
  clampPanelWidth,
  fullPageFromFor,
  fullPageHref,
  listOrder,
  neighbourTaskId,
  nudgePanelWidth,
  panelCookie,
  panelCssWidth,
  panelKeyAction,
  panelMaxWidth,
  widthFromPointer,
  type PanelScreen,
} from "@/lib/task-panel";
import "@/components/tasks/panel/task-panel.css";

/** The open task's cards and rows, in the order the page shows them, from the list it was opened in. */
function taskOrder(taskId: string, listRoot: Element | null): string[] {
  const scope = document.querySelector(".tp-reflow") ?? document.body;
  let root: Element | null = listRoot && document.contains(listRoot) ? listRoot : null;
  if (root && !root.querySelector(`[data-task-open="${taskId}"]`)) root = null;
  if (!root) {
    const card = scope.querySelector(`[data-task-open="${taskId}"]`);
    root = card?.closest("[data-task-list]") ?? scope;
  }
  // Hidden copies (the board's phone layout on a desktop, and the reverse) don't count. Under
  // the phone sheet the whole page is hidden, so it's shown for this one synchronous read (no paint).
  const page = document.querySelector<HTMLElement>(".tp-reflow");
  const pageHidden = page ? getComputedStyle(page).display === "none" : false;
  if (page && pageHidden) page.style.display = "block";
  const items = Array.from(root.querySelectorAll("[data-task-open]")).map((el) => ({
    id: el.getAttribute("data-task-open") ?? "",
    shown: el.getClientRects().length > 0,
  }));
  if (page && pageHidden) page.style.display = "";
  return listOrder(items, taskId);
}

/**
 * A modal (search, a confirm box, Break into tasks), the non-modal colour editor (aria-modal="false")
 * or a top-bar menu is open: its own Esc wins, so Esc closes only the top layer.
 */
function anyDialogOpen(): boolean {
  return Boolean(
    document.querySelector(
      '[role="dialog"][aria-modal="true"], [role="dialog"][aria-modal="false"], header [aria-expanded="true"]',
    ),
  );
}

export function TaskPanel({
  taskId,
  screen,
  initialWidth,
  onWidthSaved,
}: {
  taskId: string;
  screen: PanelScreen;
  initialWidth: number;
  onWidthSaved: (width: number) => void;
}) {
  const { openTask, closeTask, getOpenContext, openedHere } = useTaskPanel();
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const [width, setWidth] = useState(initialWidth);
  const [dragging, setDragging] = useState(false);
  // Opened by a click here: slide in and take focus. In the first HTML (a link, a reload): neither.
  const [animate] = useState(openedHere);
  const [order, setOrder] = useState<string[]>([]);
  const panelRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRootRef = useRef<Element | null>(null);
  const widthRef = useRef(width);
  const [maxWidth, setMaxWidth] = useState<number | undefined>(undefined);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  useEffect(() => {
    const read = () => setMaxWidth(panelMaxWidth(window.innerWidth));
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);

  const saveWidth = useCallback(
    (next: number) => {
      document.cookie = panelCookie(screen, next);
      onWidthSaved(next);
    },
    [screen, onWidthSaved]
  );

  // Which list the card was clicked in (↑ / ↓ stay in it) and what to give focus back to on close.
  // A panel opened by a link has neither: ↑ / ↓ use the first list showing the task.
  useEffect(() => {
    const context = getOpenContext();
    listRootRef.current = context.list;
    const opener = context.opener ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null);
    if (animate) headingRef.current?.focus({ preventScroll: true });
    const scrollY = context.scrollY;
    return () => {
      // Phone: the page was hidden under the sheet, so it lost its place; put it back first.
      if (window.matchMedia(`(max-width: ${PANEL_DOCK_MIN_WINDOW - 1}px)`).matches && scrollY > 0) {
        window.requestAnimationFrame(() => window.scrollTo(0, scrollY));
      }
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
    // Only when the panel opens and closes, not on each task.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The order for ↑ / ↓ (and the header arrows), re-read for each task.
  useEffect(() => {
    const read = () => setOrder(taskOrder(taskId, listRootRef.current));
    read();
    const timer = window.setTimeout(read, 400);
    return () => window.clearTimeout(timer);
  }, [taskId]);

  const move = useCallback(
    (direction: "up" | "down") => {
      const current = taskOrder(taskId, listRootRef.current);
      const next = neighbourTaskId(current, taskId, direction);
      if (!next) return;
      openTask(next);
      const card = document.querySelector(`.tp-reflow [data-task-open="${next}"]`);
      card?.scrollIntoView({ block: "nearest" });
    },
    [taskId, openTask]
  );

  // Esc closes; ↑ ↓ move; [ ] nudge the width. Never while a field has focus or a dialog is up.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = panelKeyAction(event, { dialogOpen: anyDialogOpen() });
      if (!action) {
        // Esc in one of the panel's own fields leaves the field first (a second Esc closes).
        if (event.key === "Escape" && !anyDialogOpen() && panelRef.current?.contains(document.activeElement)) {
          (document.activeElement as HTMLElement | null)?.blur();
          headingRef.current?.focus({ preventScroll: true });
        }
        return;
      }
      if (action === "close") {
        event.preventDefault();
        closeTask();
      } else if (action === "up" || action === "down") {
        event.preventDefault();
        move(action);
      } else {
        if (window.innerWidth < PANEL_DOCK_MIN_WINDOW) return;
        event.preventDefault();
        const next = nudgePanelWidth(widthRef.current, action === "wider" ? "]" : "[", window.innerWidth);
        setWidth(next);
        saveWidth(next);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeTask, move, saveWidth]);

  // The grip: drag to resize (live reflow), double-click resets, arrow keys when it has focus.
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const grip = event.currentTarget;
      grip.setPointerCapture(event.pointerId);
      setDragging(true);
      document.documentElement.classList.add("tp-resizing");
      let frame = 0;
      let latest = widthRef.current;
      const onMove = (moveEvent: PointerEvent) => {
        latest = widthFromPointer(moveEvent.clientX, window.innerWidth);
        if (!frame) {
          frame = window.requestAnimationFrame(() => {
            frame = 0;
            setWidth(latest);
          });
        }
      };
      const onUp = () => {
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onUp);
        if (frame) window.cancelAnimationFrame(frame);
        document.documentElement.classList.remove("tp-resizing");
        setDragging(false);
        setWidth(latest);
        saveWidth(latest);
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onUp);
    },
    [saveWidth]
  );

  const resetWidth = useCallback(() => {
    const next = clampPanelWidth(PANEL_DEFAULT_WIDTH[screen], window.innerWidth);
    setWidth(next);
    saveWidth(next);
  }, [screen, saveWidth]);

  const onGripKey = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      const next = nudgePanelWidth(widthRef.current, event.key === "ArrowLeft" ? "]" : "[", window.innerWidth);
      setWidth(next);
      saveWidth(next);
    },
    [saveWidth]
  );

  const index = order.indexOf(taskId);
  const prevId = index > 0 ? order[index - 1] : null;
  const nextId = index >= 0 && index < order.length - 1 ? order[index + 1] : null;
  const onFullPage = pathname === `/r/task/${taskId}`;
  // The full page's back link returns here (Today, Tasks, Portfolio, a project…; allow-list in task-panel.ts).
  const fullHref = fullPageHref(taskId, fullPageFromFor(pathname, searchParams?.toString() ?? ""));
  const css = panelCssWidth(width);

  return (
    <>
      {/* Server-rendered with the panel, so the page is already narrowed on the first paint (no jump). */}
      <style
        // The id is a validated uuid; the width a clamped number.
        dangerouslySetInnerHTML={{
          __html: `@media (min-width:${PANEL_DOCK_MIN_WINDOW}px){.tp-reflow{padding-right:${css}}}.tp-reflow [data-task-open="${taskId}"]{outline:2px solid var(--ink);outline-offset:1px}`,
        }}
      />
      <aside
        ref={panelRef}
        className="tp-panel"
        aria-label="Task"
        data-task-panel={taskId}
        data-screen={screen}
        data-dragging={dragging ? "" : undefined}
        data-enter={animate ? "" : undefined}
        style={{ width: css }}
      >
        <div
          className="tp-grip"
          role="separator"
          aria-orientation="vertical"
          aria-label="Panel width. Drag, or use the arrow keys; double-click resets."
          aria-valuemin={PANEL_MIN_WIDTH}
          aria-valuemax={maxWidth}
          aria-valuenow={width}
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          onPointerDown={onPointerDown}
          onDoubleClick={resetWidth}
          onKeyDown={onGripKey}
        >
          <i aria-hidden="true">
            <b />
            <b />
            <b />
            <b />
            <b />
            <b />
          </i>
          {dragging ? <span className="tp-wtip mono">{width} px</span> : null}
        </div>

        <div className="tp-top">
          <div className="tp-nav">
            <button type="button" className="tp-icon" onClick={() => move("up")} disabled={!prevId} aria-label="Previous task" title="Previous task (↑)">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4" /></svg>
            </button>
            <button type="button" className="tp-icon" onClick={() => move("down")} disabled={!nextId} aria-label="Next task" title="Next task (↓)">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
            </button>
          </div>
          {onFullPage ? null : (
            <Link href={fullHref} className="tp-full">
              Open full page
            </Link>
          )}
          <button type="button" className="tp-icon tp-close" onClick={closeTask} aria-label="Close the task (Esc)" title="Close (Esc)">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>

        <TaskPanelBody key={taskId} taskId={taskId} headingRef={headingRef} onClose={closeTask} />

        <div className="tp-keys mono" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> next task</span>
          <span><kbd>Esc</kbd> close</span>
          <span><kbd>[</kbd><kbd>]</kbd> panel width</span>
        </div>
      </aside>
    </>
  );
}
