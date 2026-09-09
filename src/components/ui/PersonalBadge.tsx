export function PersonalBadge({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-xs font-semibold text-violet-300 ${className}`}
    >
      Personal
    </span>
  );
}
