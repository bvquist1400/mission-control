import type { ElementType, HTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "@/lib/cn";

export type CardPadding = "none" | "sm" | "md" | "lg";

const PADDING: Record<CardPadding, string> = {
  none: "",
  sm: "p-4",
  md: "p-5",
  lg: "p-6",
};

export function cardClasses({
  padding = "md",
  className,
}: { padding?: CardPadding; className?: string } = {}): string {
  return cn(
    "rounded-card border border-stroke bg-panel shadow-sm",
    PADDING[padding],
    className
  );
}

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Defaults to `article`, matching the convention in CLAUDE.md. */
  as?: ElementType;
  padding?: CardPadding;
  /** Layout utilities only (margin, width, grid placement) — see `cn`. */
  className?: string;
  children?: ReactNode;
  ref?: Ref<HTMLElement>;
}

export function Card({
  as: Component = "article",
  padding = "md",
  className,
  children,
  ...props
}: CardProps) {
  return (
    <Component className={cardClasses({ padding, className })} {...props}>
      {children}
    </Component>
  );
}

/** Dashed placeholder used wherever a list or board section has nothing to show. */
export function EmptyCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-stroke bg-panel px-6 py-16 text-center text-sm text-muted-foreground",
        className
      )}
    >
      {children}
    </div>
  );
}

/** Loading placeholder that matches Card's footprint so nothing shifts on load. */
export function CardSkeleton({
  padding = "md",
  className,
}: {
  padding?: CardPadding;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded-card border border-stroke bg-panel",
        PADDING[padding],
        className
      )}
    />
  );
}
