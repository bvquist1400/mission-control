import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type BadgeTone = "neutral" | "accent" | "danger" | "success" | "warning";

const TONES: Record<BadgeTone, string> = {
  neutral: "border-stroke bg-panel-muted text-muted-foreground",
  accent: "border-accent/30 bg-accent-soft text-accent-text",
  danger: "border-danger-border bg-danger-soft text-danger",
  success: "border-success-border bg-success-soft text-success",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-300",
};

export type BadgeSize = "sm" | "md";

const SIZES: Record<BadgeSize, string> = {
  sm: "px-2 py-0.5 text-xs",
  md: "px-2.5 py-1 text-xs",
};

export function badgeClasses({
  tone = "neutral",
  size = "md",
  className,
}: { tone?: BadgeTone; size?: BadgeSize; className?: string } = {}): string {
  return cn(
    "inline-flex items-center gap-1 rounded-full border font-medium",
    TONES[tone],
    SIZES[size],
    className
  );
}

export function Badge({
  tone = "neutral",
  size = "md",
  className,
  children,
}: {
  tone?: BadgeTone;
  size?: BadgeSize;
  /** Layout utilities only (margin, self-alignment) — see `cn`. */
  className?: string;
  children: ReactNode;
}) {
  return <span className={badgeClasses({ tone, size, className })}>{children}</span>;
}
