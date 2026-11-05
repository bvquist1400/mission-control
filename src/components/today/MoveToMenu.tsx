"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/Button";
import { DateField } from "@/components/ui/DateField";
import { pickedDateChoice, type MoveChoice, type MoveTaskInput } from "@/lib/today/today-board";

/**
 * "Move to…" on a Today card (redesign S4, no drag needed): a small pop-up
 * with today, tomorrow, the rest of the week, next Monday, Backlog (no date)
 * and Park (someday), plus a date box for any other day. Picking one calls
 * `onPick`; the board saves it through the same paths as the task panel (the
 * date cascade for a day, a status change for Backlog / Park).
 *
 * It is a non-modal dialog (role="dialog", aria-modal="false"), so the task
 * panel's Esc leaves it alone and Esc here closes only the menu, focus back on
 * the button. A fixed pop-up at z-index 50 (Modal's layer): cards and lane bars
 * clip their content, and it must never hide under the docked panel. On a
 * phone it is a bottom sheet.
 */
export function MoveToMenu({
  title,
  task,
  choices,
  onPick,
  disabled = false,
  size = "sm",
  compact = false,
}: {
  title: string;
  task: MoveTaskInput;
  choices: MoveChoice[];
  onPick: (choice: MoveChoice) => void;
  disabled?: boolean;
  size?: "xs" | "sm";
  /** Lane bars: the button says "Move…". */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState("");
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setPicked("");
    if (returnFocus) buttonRef.current?.focus({ preventScroll: true });
  }, []);

  // Place it under the button, kept clear of the docked task panel and the window edge.
  useLayoutEffect(() => {
    if (!open) return;
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const panel = document.querySelector(".tp-panel");
    const panelLeft = panel && window.innerWidth >= 1024 ? panel.getBoundingClientRect().left : window.innerWidth;
    const width = 264;
    const left = Math.max(8, Math.min(rect.left, panelLeft - width - 8));
    const menuHeight = menuRef.current?.offsetHeight ?? 360;
    const below = rect.bottom + 4;
    const top = below + menuHeight > window.innerHeight - 8 ? Math.max(64, rect.top - menuHeight - 4) : below;
    setPosition({ left, top });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const firstEnabled = menuRef.current?.querySelector<HTMLButtonElement>("button.tb-move-item:not(:disabled)");
    firstEnabled?.focus({ preventScroll: true });

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button.tb-move-item:not(:disabled)") ?? []);
        if (items.length === 0) return;
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (index === -1) return;
        event.preventDefault();
        event.stopPropagation();
        const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
        items[next].focus();
      }
    }
    function onPointer(event: PointerEvent) {
      const target = event.target as Node | null;
      if (target && (menuRef.current?.contains(target) || buttonRef.current?.contains(target))) return;
      close(false);
    }
    function onScroll(event: Event) {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      close(false);
    }
    // Capture, so the task panel's own key handler never sees an Esc or arrow meant for the menu.
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, close]);

  const pick = (choice: MoveChoice) => {
    if (choice.disabled) return;
    close(true);
    onPick(choice);
  };

  const pickedChoice = /^\d{4}-\d{2}-\d{2}$/.test(picked) ? pickedDateChoice(task, picked) : null;
  const dayChoices = choices.filter((choice) => choice.kind === "day");
  const undated = choices.filter((choice) => choice.kind !== "day");

  return (
    <>
      <Button
        ref={buttonRef}
        variant="secondary"
        size={size}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Move “${title}” to another day`}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <span aria-hidden="true">→</span> {compact ? "Move…" : "Move to…"}
      </Button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="dialog"
              aria-modal="false"
              aria-label={`Move “${title}” to`}
              className="tb-move"
              style={position ? { left: position.left, top: position.top } : { left: -9999, top: 0 }}
            >
              <h4>Move to…</h4>
              <ul>
                {dayChoices.map((choice) => (
                  <li key={choice.key}>
                    <button
                      type="button"
                      className="tb-move-item"
                      disabled={choice.disabled}
                      data-move-choice={choice.key}
                      aria-label={choice.reason ? `${choice.label}, ${choice.reason}` : undefined}
                      onClick={() => pick(choice)}
                    >
                      {choice.label}
                      {choice.reason || choice.hint ? <em>{choice.reason ?? choice.hint}</em> : null}
                    </button>
                  </li>
                ))}
                {undated.map((choice, index) => (
                  <li key={choice.key} className={index === 0 ? "tb-move-sep" : undefined}>
                    <button
                      type="button"
                      className="tb-move-item"
                      disabled={choice.disabled}
                      data-move-choice={choice.key}
                      onClick={() => pick(choice)}
                    >
                      {choice.label}
                      {choice.hint ? <em>{choice.hint}</em> : null}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="tb-move-pick">
                <DateField
                  label="Another day"
                  value={picked}
                  onChange={setPicked}
                  chips={false}
                  clearable={false}
                  readBack={false}
                />
                {pickedChoice?.reason ? <p data-tone="warn">That day is {pickedChoice.reason}.</p> : null}
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!pickedChoice || Boolean(pickedChoice.disabled)}
                  onClick={() => pickedChoice && pick(pickedChoice)}
                >
                  Move to {pickedChoice ? pickedChoice.label : "that day"}
                </Button>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
