"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { TONE_DOT, TONE_STYLES, useToast } from "@/components/ui/Toast";
import { applyDateChange, undoDateChange } from "@/lib/date-cascade-client";
import {
  confirmModel,
  datesChangedBy,
  MODE_OPTIONS,
  toastForChange,
  toastForSaveFailure,
  toastForUndo,
  TOAST_MOVES_SHOWN,
  warnSentenceParts,
  type CascadeModeChoice,
  type CascadeToastAction,
  type CascadeToastModel,
  type TextPart,
} from "@/lib/date-cascade-view";
import { patchTaskWithReply, type TaskPatchCascadeOptions } from "@/lib/tasks-client";
import type { CascadeReply } from "@/lib/task-date-cascade";
import type { TaskUpdatePayload, TaskWithImplementation } from "@/types/database";

/**
 * Cascade due dates, S2 (Brent 10/19 "Move now + Undo"; 10/20 answers): every
 * due-date change from the task editor, the task grid's Due cell and the Week
 * board goes through `changeDueDate`. The date saves at once; then one toast
 * lists every task that moved (old → new) with Undo and "How far" (Same gap /
 * Only what collides / Just this task; a switch replaces the first move). The
 * toast stays until closed; a newer date change replaces it. More than 25 moves:
 * the server saves nothing and this asks first (Move all N / Just this task /
 * Cancel); the caller's optimistic change is rolled back meanwhile. Bulk date
 * sets don't come through here (they send cascade:false).
 */

export interface DateChangeRequest {
  taskId: string;
  /** The task's title (for the toast and the confirm box when nothing was saved). */
  title: string;
  /** Its due date before this change (for "its date is still …"). */
  previousDueAt: string | null;
  /** The caller shows refusals itself (an inline error): no failure toast, except where it can offer Try again. */
  quietErrors?: boolean;
  /** Must include due_at; may carry the editor's other changed fields (one PATCH). */
  updates: TaskUpdatePayload;
  onOptimistic?: () => void;
  onRollback?: () => void;
  /** The saved task (the PATCH reply without its cascade object). */
  onSaved?: (task: TaskWithImplementation) => void;
  /** Other tasks' (and, after Undo, this task's) due dates changed by a switch or Undo. */
  onDatesChanged?: (changes: Array<{ task_id: string; due_at: string | null }>) => void;
  /** Week board: the Monday on screen and how to show the next week. */
  week?: { weekStart: string; showNextWeek: () => void };
}

export interface DateChangeResult {
  ok: boolean;
  /** The person closed the "more than 25" box with Cancel: nothing was saved. */
  cancelled?: boolean;
  task?: TaskWithImplementation;
  error?: string;
}

interface DateCascadeApi {
  changeDueDate: (request: DateChangeRequest) => Promise<DateChangeResult>;
}

const DateCascadeContext = createContext<DateCascadeApi | null>(null);

/** The provider's API, or null where it isn't mounted (callers then PATCH as before). */
export function useDateCascade(): DateCascadeApi | null {
  return useContext(DateCascadeContext);
}

type ConfirmChoice = "all" | "only" | "cancel";

interface ConfirmRequest {
  rootTitle: string;
  cascade: CascadeReply;
  resolve: (choice: ConfirmChoice) => void;
}

const TOAST_KEY = "date-cascade";

export function DateCascadeProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { toast, dismiss } = useToast();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const toastIdRef = useRef<number | null>(null);
  // run() re-runs itself (confirm answers, Try again); the ref avoids a self-reference.
  const runRef = useRef<((request: DateChangeRequest, options?: TaskPatchCascadeOptions) => Promise<DateChangeResult>) | null>(null);

  const askToConfirm = useCallback(
    (rootTitle: string, cascade: CascadeReply) =>
      new Promise<ConfirmChoice>((resolve) => setConfirm({ rootTitle, cascade, resolve })),
    []
  );

  const showToast = useCallback(
    (session: ToastSession, model: CascadeToastModel) => {
      toastIdRef.current = toast({
        key: TOAST_KEY,
        message: model.title,
        tone: model.tone,
        duration: 0,
        render: ({ dismiss: close }) => <CascadeToastCard session={session} initial={model} onClose={close} />,
      });
    },
    [toast]
  );

  const run = useCallback(
    async (request: DateChangeRequest, options: TaskPatchCascadeOptions = {}): Promise<DateChangeResult> => {
      // A newer date change replaces the toast of the last one.
      if (toastIdRef.current !== null) {
        dismiss(toastIdRef.current);
        toastIdRef.current = null;
      }
      request.onOptimistic?.();
      const result = await patchTaskWithReply(request.taskId, request.updates, options);

      if (result.ok) {
        request.onSaved?.(result.task);
        const cascade = result.cascade;
        // The tasks that moved with it, so lists on screen (the grid) follow at once.
        if (cascade?.status === "moved" && cascade.moves.length > 0) {
          request.onDatesChanged?.(datesChangedBy({ cascade }));
        }
        router.refresh();
        if (cascade) {
          const choice: CascadeModeChoice = options.cascade === false ? "none" : cascade.mode;
          const session: ToastSession = {
            request,
            rootTitle: result.task.title,
            rootOld: cascade.root_old_due_at,
            rootNew: cascade.root_new_due_at,
            cascadeId: cascade.cascade_id,
            choice,
            waitingCount: cascade.status === "moved" ? cascade.moves.length : cascade.planned_moves,
            askToConfirm,
            rerun: (extra) => void runRef.current?.(request, extra),
            refresh: () => router.refresh(),
          };
          const model = toastForChange({ rootTitle: result.task.title, cascade, choice, origin: "patch", weekStart: request.week?.weekStart ?? null });
          if (model) showToast(session, model);
        }
        return { ok: true, task: result.task };
      }

      request.onRollback?.();
      const rootTitle = typeof request.updates.title === "string" && request.updates.title.trim() ? request.updates.title : request.title;
      if (result.status === 409 && result.cascade && (result.cascade.status === "needs_confirm" || result.cascade.status === "too_large")) {
        // Nothing was saved, including this task. Ask first.
        const choice = await askToConfirm(rootTitle, result.cascade);
        const again = runRef.current;
        if (choice === "all" && again) return again(request, { ...options, cascade_confirm: true });
        if (choice === "only" && again) return again(request, { ...options, cascade: false });
        return { ok: false, cancelled: true };
      }

      const session: ToastSession = {
        request,
        rootTitle,
        rootOld: null,
        rootNew: null,
        cascadeId: null,
        choice: "same_gap",
        waitingCount: 0,
        askToConfirm,
        rerun: (extra) => void runRef.current?.(request, extra),
        refresh: () => router.refresh(),
      };
      if (!request.quietErrors || result.status === 503) {
        showToast(session, toastForSaveFailure({ rootTitle, status: result.status, error: result.error, oldDueAt: request.previousDueAt }));
      }
      return { ok: false, error: result.error };
    },
    [askToConfirm, dismiss, router, showToast]
  );

  useEffect(() => {
    runRef.current = run;
  }, [run]);

  const api = useMemo<DateCascadeApi>(() => ({ changeDueDate: (request) => run(request) }), [run]);

  return (
    <DateCascadeContext.Provider value={api}>
      {children}
      <CascadeConfirmDialog
        request={confirm}
        onChoose={(choice) => {
          confirm?.resolve(choice);
          setConfirm(null);
        }}
      />
    </DateCascadeContext.Provider>
  );
}

// ── The toast card ───────────────────────────────────────────────────────

interface ToastSession {
  request: DateChangeRequest;
  rootTitle: string;
  rootOld: string | null;
  rootNew: string | null;
  cascadeId: string | null;
  choice: CascadeModeChoice;
  waitingCount: number;
  askToConfirm: (rootTitle: string, cascade: CascadeReply) => Promise<ConfirmChoice>;
  rerun: (options: TaskPatchCascadeOptions) => void;
  refresh: () => void;
}

function CascadeToastCard({ session, initial, onClose }: { session: ToastSession; initial: CascadeToastModel; onClose: () => void }) {
  const [model, setModel] = useState(initial);
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const stateRef = useRef({ cascadeId: session.cascadeId, choice: session.choice, waiting: session.waitingCount });

  const report = useCallback(
    (changes: Array<{ task_id: string; due_at: string | null }>) => {
      if (changes.length > 0) session.request.onDatesChanged?.(changes);
      session.refresh();
    },
    [session]
  );

  /** A 409 "stale": this toast's id was already undone or replaced elsewhere; follow the change's current one. */
  function adoptCurrentIdentity(result: { status: number; reason?: string | null; currentCascadeId?: string | null }) {
    if (result.status !== 409 || result.reason !== "stale") return;
    stateRef.current = { ...stateRef.current, cascadeId: result.currentCascadeId ?? null };
    session.refresh();
  }

  async function switchTo(choice: CascadeModeChoice, options: { confirm?: boolean; again?: boolean } = {}) {
    // Picking the choice already shown does nothing (Try again re-runs it on purpose).
    if (pending || (choice === stateRef.current.choice && !options.again && !options.confirm)) return;
    setPending(true);
    const result = await applyDateChange(session.request.taskId, {
      cascade_id: stateRef.current.cascadeId,
      mode: choice,
      from_due_at: session.rootOld,
      to_due_at: session.rootNew,
      ...(options.confirm ? { confirm: true } : {}),
    });
    if (!result.ok) {
      if (result.status === 409 && result.cascade && (result.cascade.status === "needs_confirm" || result.cascade.status === "too_large")) {
        setPending(false);
        const answer = await session.askToConfirm(session.rootTitle, result.cascade);
        if (answer === "all") return switchTo(choice, { confirm: true });
        if (answer === "only") return switchTo("none", { again: true });
        return;
      }
      adoptCurrentIdentity(result);
      setModel((current) => ({ ...current, error: result.error }));
      setPending(false);
      return;
    }
    const reply = result.reply;
    stateRef.current = {
      // The reply's id is the change's current identity, null included (after "Just
      // this task" nothing else is moved): never the id it replaced (fix round 1).
      cascadeId: reply.cascade.cascade_id,
      choice,
      waiting: reply.cascade.status === "moved" && reply.cascade.moves.length > 0 ? reply.cascade.moves.length : stateRef.current.waiting,
    };
    const next = toastForChange({
      rootTitle: session.rootTitle,
      cascade: reply.cascade,
      choice,
      origin: "switch",
      waitingCount: stateRef.current.waiting,
      weekStart: session.request.week?.weekStart ?? null,
    });
    if (next) setModel(next);
    setExpanded(false);
    setPending(false);
    report(datesChangedBy({ cascade: reply.cascade, restored: reply.replaced?.restored }));
  }

  async function undo() {
    if (pending) return;
    setPending(true);
    const result = await undoDateChange(session.request.taskId, {
      cascade_id: stateRef.current.cascadeId,
      from_due_at: session.rootOld,
      to_due_at: session.rootNew,
    });
    if (!result.ok) {
      adoptCurrentIdentity(result);
      setModel((current) => ({ ...current, error: result.error }));
      setPending(false);
      return;
    }
    setModel(toastForUndo({ rootTitle: session.rootTitle, reply: result.reply }));
    setExpanded(false);
    setPending(false);
    report(datesChangedBy({
      restored: result.reply.cascade?.restored,
      root: result.reply.root.restored ? { task_id: session.request.taskId, due_at: result.reply.root.due_at } : null,
    }));
  }

  function act(action: CascadeToastAction) {
    if (action === "undo") return void undo();
    if (action === "retry") return void switchTo(stateRef.current.choice === "none" ? "same_gap" : stateRef.current.choice, { again: true });
    if (action === "retry_patch") {
      onClose();
      return session.rerun({});
    }
    if (action === "only_this") {
      onClose();
      return session.rerun({ cascade: false });
    }
  }

  const shown = expanded ? model.moves : model.moves.slice(0, TOAST_MOVES_SHOWN);
  const rest = model.moves.length - shown.length;

  return (
    <div
      role={model.tone === "danger" ? "alert" : "status"}
      className={`toast-enter flex w-full flex-col gap-2.5 rounded-xl border ${TONE_STYLES[model.tone]} bg-panel py-3 pl-4 pr-3.5 text-sm text-foreground shadow-lg`}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE_DOT[model.tone]}`} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{model.title}</p>
          {model.sub ? <p className="mt-0.5 text-xs text-muted-foreground"><Parts parts={model.sub} /></p> : null}
        </div>
        {model.primary ? (
          <button
            type="button"
            onClick={() => act(model.primary!.action)}
            disabled={pending}
            className="shrink-0 rounded-lg border border-stroke px-2.5 py-1 text-xs font-semibold text-accent-text transition hover:bg-panel-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "…" : model.primary.label}
          </button>
        ) : null}
        <Button variant="ghost" size="icon" className="shrink-0" onClick={onClose} aria-label="Dismiss notification">
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" d="M6 6l12 12M6 18L18 6" />
          </svg>
        </Button>
      </div>

      <div className={`flex flex-col gap-2.5 ${pending ? "pointer-events-none opacity-60" : ""}`}>
        {shown.length > 0 ? (
          <ul className="ml-5 grid gap-1.5 border-t border-stroke pt-2 text-xs" aria-label="Tasks that moved">
            {shown.map((move) => (
              <li key={move.task_id} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3">
                <span className="truncate text-foreground" title={move.title}>{move.title}</span>
                <span className="whitespace-nowrap font-mono tabular-nums text-muted-foreground">
                  {move.from} → <span className="text-foreground">{move.to}</span>
                </span>
              </li>
            ))}
            {rest > 0 ? (
              <li>
                <button type="button" onClick={() => setExpanded(true)} className="text-xs font-semibold text-accent-text">
                  +{rest} more
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}

        {model.left ? <p className="ml-5 text-xs text-muted-foreground">{model.left}</p> : null}

        {model.warn.map((warn) => (
          <div key={warn.name} className="ml-5 grid gap-1.5 rounded-lg border border-warning-border bg-warning-soft px-2.5 py-2 text-xs text-foreground">
            <div>
              <strong className="font-semibold text-warning">Past the target date.</strong>{" "}
              {(() => {
                const parts = warnSentenceParts(warn);
                return <>{parts.lead}<b className="font-semibold">{parts.name}</b>{parts.tail}</>;
              })()}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span>{warn.name}</span>
              <RagChip status={warn.ragBefore} />
              {warn.ragBefore === warn.ragAfter ? (
                <span className="text-muted-foreground">already {warn.ragAfter}, no change</span>
              ) : (
                <>
                  <span className="text-muted-foreground" aria-label="to">→</span>
                  <RagChip status={warn.ragAfter} />
                </>
              )}
              <span className="text-muted-foreground">The target date itself was not changed.</span>
            </div>
          </div>
        ))}

        {model.modes ? (
          <div className="ml-5 flex flex-wrap items-center gap-1.5" role="group" aria-label="How far the other tasks move">
            <span className="mr-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">How far</span>
            <span className="inline-flex flex-wrap gap-0.5 rounded-lg border border-stroke bg-background p-0.5">
              {MODE_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  variant="toggle"
                  size="xs"
                  active={option.value === model.modes}
                  title={option.hint}
                  onClick={() => void switchTo(option.value)}
                  disabled={pending}
                >
                  {option.label}
                </Button>
              ))}
            </span>
          </div>
        ) : null}

        {model.secondary ? (
          <p className="ml-5 text-xs">
            <button type="button" onClick={() => act(model.secondary!.action)} className="font-semibold text-accent-text">
              {model.secondary.label}
            </button>
          </p>
        ) : null}

        {model.nextWeek && session.request.week ? (
          <p className="ml-5 text-xs">
            <button type="button" onClick={() => session.request.week?.showNextWeek()} className="font-semibold text-accent-text">
              Show next week → (the {model.nextWeek} moved {model.nextWeek === 1 ? "task is" : "tasks are"} there now)
            </button>
          </p>
        ) : null}

        {model.error ? <p role="alert" className="ml-5 text-xs text-danger">{model.error}</p> : null}
      </div>
    </div>
  );
}

function Parts({ parts }: { parts: TextPart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.mono ? (
          <span key={index} className="font-mono tabular-nums text-foreground">{part.text}</span>
        ) : (
          <span key={index}>{part.text}</span>
        )
      )}
    </>
  );
}

const RAG_CHIP: Record<string, string> = {
  Green: "border-green-500/30 bg-green-500/15 text-green-400",
  Yellow: "border-yellow-500/30 bg-yellow-500/15 text-yellow-400",
  Red: "border-red-500/30 bg-red-500/15 text-red-400",
};

function RagChip({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold ${RAG_CHIP[status] ?? RAG_CHIP.Green}`}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

// ── The "more than 25" confirm box ───────────────────────────────────────

const CONFIRM_ROWS_SHOWN = 8;

function CascadeConfirmDialog({ request, onChoose }: { request: ConfirmRequest | null; onChoose: (choice: ConfirmChoice) => void }) {
  const [expanded, setExpanded] = useState(false);
  const model = request ? confirmModel({ rootTitle: request.rootTitle, cascade: request.cascade }) : null;
  const rows = model ? (expanded ? model.rows : model.rows.slice(0, CONFIRM_ROWS_SHOWN)) : [];
  const rest = model ? model.rows.length - rows.length : 0;
  const choose = (choice: ConfirmChoice) => {
    setExpanded(false);
    onChoose(choice);
  };

  return (
    <Modal open={Boolean(request)} onClose={() => choose("cancel")} title={model?.title}>
      {model ? (
        <div className="grid gap-3 text-sm">
          <p><Parts parts={model.lead} /></p>
          {model.notice ? (
            <div className="rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-sm">
              <b className="font-semibold text-warning">Past the target date.</b> {model.notice}
            </div>
          ) : null}
          {model.rows.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-stroke bg-background">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-stroke bg-panel-muted px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <span>Task</span>
                <span>Moves from → to</span>
              </div>
              <ul className="max-h-60 overflow-y-auto">
                {rows.map((row) => (
                  <li key={row.task_id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-stroke px-3 py-2 last:border-b-0">
                    <span className="truncate" title={row.title}>{row.title}</span>
                    <span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
                      {row.from} → <span className="text-foreground">{row.to}</span>
                    </span>
                  </li>
                ))}
              </ul>
              {model.rows.length > CONFIRM_ROWS_SHOWN ? (
                <button
                  type="button"
                  onClick={() => setExpanded((value) => !value)}
                  className="w-full border-t border-stroke bg-panel px-3 py-2 text-left text-xs font-semibold text-accent-text"
                >
                  {expanded ? "Show fewer" : `+${rest} more`}
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="-mx-5 -mb-4 mt-1 flex flex-wrap justify-end gap-2 border-t border-stroke px-5 py-3">
            <Button variant="ghost" size="md" onClick={() => choose("cancel")}>Cancel</Button>
            <Button variant="secondary" size="md" onClick={() => choose("only")}>Just this task</Button>
            {model.canMoveAll ? (
              <Button variant="primary" size="md" onClick={() => choose("all")}>{model.moveAllLabel}</Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
