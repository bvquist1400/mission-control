"use client";
import { badgeClasses } from "@/components/ui/Badge";

interface TaskTagChipsProps {
  tags: string[];
  onRemove?: (tag: string) => void;
  className?: string;
}

export function TaskTagChips({ tags, onRemove, className = "" }: TaskTagChipsProps) {
  if (tags.length === 0) {
    return null;
  }

  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`.trim()}>
      {tags.map((tag) => (
        <span
          key={tag}
          className={badgeClasses({ size: "sm" })}
        >
          <span>{tag}</span>
          {onRemove ? (
            <button
              type="button"
              onClick={() => onRemove(tag)}
              className="rounded-full px-1 text-xs leading-none text-muted-foreground transition hover:bg-panel hover:text-foreground"
              aria-label={`Remove tag ${tag}`}
            >
              x
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}
