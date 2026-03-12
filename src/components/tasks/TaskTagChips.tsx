"use client";

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
          className="inline-flex items-center gap-1 rounded-full border border-stroke bg-panel-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
        >
          <span>{tag}</span>
          {onRemove ? (
            <button
              type="button"
              onClick={() => onRemove(tag)}
              className="rounded-full px-1 text-[10px] leading-none text-muted-foreground transition hover:bg-panel hover:text-foreground"
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
