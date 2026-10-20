"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/Button";
import { nextToastStack } from "@/components/ui/toast-stack";

export type ToastTone = "success" | "warning" | "danger" | "info";

export interface ToastAction {
  label: string;
  /** Awaited before the toast dismisses, so the button can show a pending state. */
  onClick: () => void | Promise<void>;
}

export interface ToastRenderApi {
  dismiss: () => void;
}

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  action?: ToastAction;
  /** Milliseconds before auto-dismiss. Pass 0 to require manual dismissal. */
  duration?: number;
  /**
   * Rich toast (cascade S2): renders its own card instead of the one-line
   * message (which still names it for screen readers). The card owns its tone,
   * buttons and dismiss button; the stack keeps placement and hover pause.
   */
  render?: (api: ToastRenderApi) => ReactNode;
  /** A toast with the same key replaces the one on screen (in place) instead of stacking. */
  key?: string;
}

interface ToastRecord {
  id: number;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
  duration: number;
  render?: (api: ToastRenderApi) => ReactNode;
  key?: string;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** Long enough to read the message and reach for Undo without rushing. */
const DURATION_WITH_ACTION = 9000;
const DURATION_DEFAULT = 5000;

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}

/** Canonical "have we hydrated yet" check — the portal needs a real document. */
const subscribeToNothing = () => () => {};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextIdRef = useRef(1);
  const mounted = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false
  );

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;

    const record: ToastRecord = {
      id,
      message: options.message,
      tone: options.tone ?? "info",
      action: options.action,
      duration:
        options.duration ?? (options.action ? DURATION_WITH_ACTION : DURATION_DEFAULT),
      render: options.render,
      key: options.key,
    };

    // Same key replaces in place; past the cap the oldest ordinary toast goes,
    // never one that stays until closed (the cascade toast with its Undo).
    setToasts((current) => nextToastStack(current, record));
    return id;
  }, []);

  const contextValue = useMemo<ToastContextValue>(
    () => ({ toast, dismiss }),
    [toast, dismiss]
  );

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      {mounted
        ? createPortal(
            <div
              // Sits above the tablet bottom nav bar, which occupies bottom-4 below lg.
              // z-[60]: above an open task window (Modal is z-50), so a toast from
              // a save in the editor (the cascade toast) is seen, not dimmed behind it.
              className="pointer-events-none fixed inset-x-4 bottom-24 z-[60] flex flex-col items-center gap-2 sm:items-end lg:bottom-6 lg:right-6 lg:left-auto lg:inset-x-auto"
              aria-live="polite"
              aria-atomic="false"
            >
              {toasts.map((item) => (
                <ToastItem key={item.id} toast={item} onDismiss={dismiss} />
              ))}
            </div>,
            document.body
          )
        : null}
    </ToastContext.Provider>
  );
}

export const TONE_STYLES: Record<ToastTone, string> = {
  success: "border-success-border",
  warning: "border-warning-border",
  danger: "border-danger-border",
  info: "border-stroke",
};

export const TONE_DOT: Record<ToastTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-muted-foreground",
};

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastRecord;
  onDismiss: (id: number) => void;
}) {
  const [paused, setPaused] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  // Time left when the countdown was last paused, so hovering doesn't restart it.
  const remainingRef = useRef(toast.duration);
  const startedAtRef = useRef(Date.now());
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // duration 0 means the toast stays until dismissed, and a pending action
    // must never be cut short by the timer.
    if (toast.duration === 0 || paused || actionPending) {
      return;
    }

    startedAtRef.current = Date.now();
    const timerId = window.setTimeout(() => {
      onDismiss(toast.id);
    }, remainingRef.current);

    return () => {
      window.clearTimeout(timerId);
      remainingRef.current = Math.max(
        0,
        remainingRef.current - (Date.now() - startedAtRef.current)
      );
    };
  }, [toast.duration, toast.id, paused, actionPending, onDismiss]);

  async function handleAction() {
    if (!toast.action || actionPending) {
      return;
    }

    setActionPending(true);
    try {
      await toast.action.onClick();
      onDismiss(toast.id);
    } finally {
      if (isMountedRef.current) {
        setActionPending(false);
      }
    }
  }

  if (toast.render) {
    return (
      <div
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocusCapture={() => setPaused(true)}
        onBlurCapture={() => setPaused(false)}
        className="pointer-events-auto w-full max-w-[27rem]"
      >
        {toast.render({ dismiss: () => onDismiss(toast.id) })}
      </div>
    );
  }

  return (
    <div
      role={toast.tone === "danger" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      className={`toast-enter pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border ${TONE_STYLES[toast.tone]} bg-panel px-4 py-3 shadow-lg`}
    >
      <span
        aria-hidden="true"
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE_DOT[toast.tone]}`}
      />
      <p className="min-w-0 flex-1 text-sm text-foreground">{toast.message}</p>
      {toast.action ? (
        <button
          type="button"
          onClick={handleAction}
          disabled={actionPending}
          className="shrink-0 rounded-lg border border-stroke px-2.5 py-1 text-xs font-semibold text-accent-text transition hover:bg-panel-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          {actionPending ? "…" : toast.action.label}
        </button>
      ) : null}
      <Button variant="ghost" size="icon" className="shrink-0"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification">
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" d="M6 6l12 12M6 18L18 6" />
        </svg>
      </Button>
    </div>
  );
}
