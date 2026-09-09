import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "danger" | "success" | "ghost" | "toggle";
export type ButtonSize = "icon" | "xs" | "sm" | "md" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-2 font-semibold transition disabled:cursor-not-allowed disabled:opacity-60";

/**
 * `toggle` is the segmented-control look: a row of buttons where exactly one is
 * selected (view switchers, tab strips, estimate pickers). Pass `active` to say
 * which one — the component also sets `aria-pressed` from it.
 */
const TOGGLE = {
  on: "rounded-lg bg-accent text-white",
  off: "rounded-lg text-muted-foreground hover:bg-panel-muted hover:text-foreground",
};

const VARIANTS: Record<Exclude<ButtonVariant, "toggle">, string> = {
  primary: "rounded-lg bg-accent text-white hover:opacity-90",
  secondary:
    "rounded-lg border border-stroke bg-panel text-muted-foreground hover:bg-panel-muted hover:text-foreground",
  danger:
    "rounded-lg border border-danger-border bg-danger-soft text-danger hover:bg-danger-soft-hover",
  success:
    "rounded-lg border border-success-border bg-success-soft text-success hover:bg-success-soft-hover",
  ghost: "rounded-lg text-muted-foreground hover:bg-panel-muted hover:text-foreground",
};

const SIZES: Record<ButtonSize, string> = {
  /** Square target for a bare glyph — no text, so no horizontal padding. */
  icon: "p-1.5",
  xs: "px-2 py-1 text-xs",
  sm: "px-3 py-1.5 text-xs",
  md: "px-3 py-2 text-sm",
  lg: "px-4 py-2 text-sm",
};

/**
 * Class string for the shared button look, for the cases that cannot be a
 * `<button>` — `next/link`, anchors, and label-wrapped file inputs.
 */
export function buttonClasses({
  variant = "secondary",
  size = "md",
  active = false,
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  active?: boolean;
  className?: string;
} = {}): string {
  const look = variant === "toggle" ? (active ? TOGGLE.on : TOGGLE.off) : VARIANTS[variant];
  return cn(BASE, look, SIZES[size], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Selected state for `variant="toggle"`; also drives `aria-pressed`. */
  active?: boolean;
  /** Layout utilities only (margin, width, flex placement) — see `cn`. */
  className?: string;
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "secondary",
  size = "md",
  active,
  className,
  type = "button",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      aria-pressed={variant === "toggle" ? Boolean(active) : undefined}
      className={buttonClasses({ variant, size, active, className })}
      {...props}
    >
      {children}
    </button>
  );
}
