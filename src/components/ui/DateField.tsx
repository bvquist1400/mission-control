"use client";

import { useId, type FocusEventHandler, type KeyboardEventHandler, type MouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { FieldSize, FieldTone } from "@/components/ui/Field";
import {
  DATE_CHIPS,
  chipDate,
  landsOnLabel,
  pickerValue,
  resolveDateFieldValue,
  withinLimits,
} from "@/components/utils/date-field";

/**
 * The one date box for Baseline (Baseline task afe37a69, slice S1): tap it and the
 * phone's own calendar opens (a native `<input type="date">`; on a Mac the click
 * opens the browser's calendar with `showPicker()`), with Today / Tomorrow / Next
 * week chips, Clear when the field is optional, and a "Lands on Fri, Oct 30"
 * read-back.
 *
 * `allowTyping` (the task editor) keeps a text box for the typing shortcuts
 * (t+7, 10/26, 2026-11-04) with a calendar button beside it; the caller resolves
 * what was typed. Without it the value is always "YYYY-MM-DD" or "".
 *
 * The field only hands back a day. Each screen keeps its own save rule (end of
 * the day for a due date, start of the day for a start date, …).
 */
export interface DateFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Spoken name of the field (the visible label may wrap it, but the chips would muddle that name). */
  label: string;
  allowTyping?: boolean;
  /** Today / Tomorrow / Next week (default on). */
  chips?: boolean;
  /** Offer Clear when there is a date (default on; turn off for a required date). */
  clearable?: boolean;
  /** Show "Lands on …" under the field (default on). Off when the caller writes its own line. */
  readBack?: boolean;
  /** Extra words after the read-back, or the whole line when `readBack` is off. */
  hint?: ReactNode;
  hintTone?: "muted" | "danger" | "warning";
  placeholder?: string;
  min?: string;
  max?: string;
  id?: string;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  size?: FieldSize;
  tone?: FieldTone;
  /** Layout only (margin, width, grid placement). */
  className?: string;
  onBlur?: FocusEventHandler<HTMLInputElement>;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
}

const SIZES: Record<FieldSize, string> = {
  xs: "px-2 py-1 text-sm",
  sm: "px-2.5 py-1.5 text-sm",
  md: "px-3 py-2 text-sm",
};

const TONES: Record<FieldTone, string> = {
  default: "bg-panel",
  muted: "bg-panel-muted",
};

const HINT_TONES = {
  muted: "text-muted-foreground",
  danger: "text-danger",
  warning: "text-warning",
} as const;

const CHIP =
  "rounded-full border border-stroke bg-panel-muted px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-accent-text disabled:cursor-not-allowed disabled:opacity-50";
const CLEAR_CHIP =
  "rounded-full border border-stroke bg-transparent px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-accent-text hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50";

function CalendarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="shrink-0">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

/**
 * The real date input sits invisibly over the field (16px text so an iPhone
 * doesn't zoom when it takes focus); the visible box shows the day in words.
 *
 * A mouse click on a date input only focuses it in Chrome; open the calendar too.
 * On a phone the tap opens the system picker by itself, so leave touch alone.
 */
function openPicker(event: MouseEvent<HTMLInputElement>) {
  const input = event.currentTarget;
  if (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches) return;
  if (typeof input.showPicker !== "function") return;
  try {
    input.showPicker();
  } catch {
    // Not allowed here (e.g. no user gesture): the browser's own behaviour stands.
  }
}

export function DateField({
  value,
  onChange,
  label,
  allowTyping = false,
  chips = true,
  clearable = true,
  readBack = true,
  hint,
  hintTone = "muted",
  placeholder,
  min,
  max,
  id,
  name,
  required,
  disabled = false,
  invalid = false,
  size = "sm",
  tone = "default",
  className,
  onBlur,
  onKeyDown,
}: DateFieldProps) {
  const generatedId = useId();
  const hintId = `${id ?? generatedId}-hint`;
  const resolved = resolveDateFieldValue(value, { allowTyping });
  const picked = pickerValue(value, { allowTyping });
  const landsOn = landsOnLabel(resolved.dateOnly);
  const border = invalid
    ? "border-danger-border focus-within:border-red-400"
    : "border-stroke focus-within:border-accent";
  const showReadBack = readBack && landsOn !== null && resolved.error === null;
  const hasHintLine = showReadBack || hint != null;

  const nativePicker = (
    <input
      type="date"
      aria-label={allowTyping ? `${label}: pick on the calendar` : label}
      aria-describedby={hasHintLine ? hintId : undefined}
      aria-invalid={invalid ? "true" : undefined}
      id={allowTyping ? undefined : id}
      name={allowTyping ? undefined : name}
      required={allowTyping ? undefined : required}
      value={picked}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      onClick={openPicker}
      onBlur={allowTyping ? undefined : onBlur}
      onKeyDown={allowTyping ? undefined : onKeyDown}
      className="absolute inset-0 h-full w-full cursor-pointer appearance-none text-base opacity-0 disabled:cursor-not-allowed"
    />
  );

  return (
    <div className={cn("space-y-1.5", className)}>
      {allowTyping ? (
        <div className="flex items-stretch gap-1.5">
          <input
            type="text"
            id={id}
            name={name}
            required={required}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
            disabled={disabled}
            placeholder={placeholder}
            aria-label={label}
            aria-describedby={hasHintLine ? hintId : undefined}
            aria-invalid={invalid ? "true" : "false"}
            autoComplete="off"
            className={cn(
              "min-w-0 flex-1 rounded-lg border text-foreground placeholder:text-muted-foreground transition disabled:cursor-not-allowed disabled:opacity-60",
              invalid ? "border-danger-border focus:border-red-400" : "border-stroke focus:border-accent",
              TONES[tone],
              SIZES[size],
            )}
          />
          <span
            className={cn(
              "relative inline-flex w-10 shrink-0 items-center justify-center rounded-lg border text-accent-text transition",
              "border-stroke focus-within:border-accent",
              TONES[tone],
              disabled && "opacity-60",
            )}
          >
            <CalendarIcon />
            {nativePicker}
          </span>
        </div>
      ) : (
        <div
          className={cn(
            "relative flex w-full items-center gap-2 rounded-lg border text-foreground transition",
            border,
            TONES[tone],
            SIZES[size],
            disabled && "opacity-60",
          )}
        >
          <span className={cn("min-w-0 flex-1 truncate", landsOn ? "text-foreground" : "text-muted-foreground")}>
            {landsOn ?? placeholder ?? "Pick a date"}
          </span>
          <span className="text-accent-text">
            <CalendarIcon />
          </span>
          {nativePicker}
        </div>
      )}

      {chips || (clearable && value) ? (
        <div className="flex flex-wrap gap-1.5">
          {chips
            ? DATE_CHIPS.map(({ chip, label: chipLabel }) => {
                const day = chipDate(chip);
                return (
                  <button
                    key={chip}
                    type="button"
                    className={CHIP}
                    disabled={disabled || !withinLimits(day, min, max)}
                    aria-label={`${label}: ${chipLabel}`}
                    onClick={() => onChange(day)}
                  >
                    {chipLabel}
                  </button>
                );
              })
            : null}
          {clearable && value ? (
            <button type="button" className={CLEAR_CHIP} disabled={disabled} aria-label={`${label}: clear`} onClick={() => onChange("")}>
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

      {hasHintLine ? (
        <p id={hintId} className={cn("text-xs", HINT_TONES[hintTone])} aria-live="polite">
          {showReadBack ? (
            <>
              Lands on <b className="font-semibold text-foreground">{landsOn}</b>.
            </>
          ) : null}
          {showReadBack && hint != null ? " " : null}
          {hint}
        </p>
      ) : null}
    </div>
  );
}
