import type {
  InputHTMLAttributes,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

export type FieldTone = "default" | "muted";
export type FieldSize = "xs" | "sm" | "md";

/**
 * No `focus:ring-*` here on purpose: the global `:focus-visible` outline in
 * globals.css supplies the visible focus state. The old per-field
 * `ring-accent/20` was a 20%-opacity ring in a colour that failed contrast at
 * full strength, so it read as no indicator at all.
 */
const BASE =
  "w-full rounded-lg border border-stroke text-foreground placeholder:text-muted-foreground outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-60";

const TONES: Record<FieldTone, string> = {
  default: "bg-panel",
  muted: "bg-panel-muted",
};

const SIZES: Record<FieldSize, string> = {
  xs: "px-2 py-1 text-sm",
  sm: "px-2.5 py-1.5 text-sm",
  md: "px-3 py-2 text-sm",
};

/**
 * Exported for the few call sites that share one class constant across many
 * fields. Prefer the `<Input>` / `<Textarea>` / `<Select>` components.
 */
export function fieldClasses({
  tone = "default",
  size = "md",
  className,
}: { tone?: FieldTone; size?: FieldSize; className?: string } = {}): string {
  return cn(BASE, TONES[tone], SIZES[size], className);
}

interface SharedFieldProps {
  tone?: FieldTone;
  size?: FieldSize;
  /** Layout utilities only (margin, width, grid placement) — see `cn`. */
  className?: string;
}

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size">,
    SharedFieldProps {
  ref?: Ref<HTMLInputElement>;
}

export function Input({ tone = "default", size = "md", className, ...props }: InputProps) {
  return <input className={fieldClasses({ tone, size, className })} {...props} />;
}

export interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement>,
    SharedFieldProps {
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({
  tone = "default",
  size = "md",
  className,
  ...props
}: TextareaProps) {
  return <textarea className={fieldClasses({ tone, size, className })} {...props} />;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size">,
    SharedFieldProps {
  ref?: Ref<HTMLSelectElement>;
}

export function Select({ tone = "default", size = "md", className, ...props }: SelectProps) {
  return <select className={fieldClasses({ tone, size, className })} {...props} />;
}
