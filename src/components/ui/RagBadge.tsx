import type { RagStatus } from "@/types/database";

interface RagBadgeProps {
  status: RagStatus;
}

const badgeStyles: Record<RagStatus, string> = {
  Green: "border-green-500/30 bg-green-500/15 text-green-400",
  Yellow: "border-yellow-500/30 bg-yellow-500/15 text-yellow-400",
  Red: "border-red-500/30 bg-red-500/15 text-red-400",
};

const dotStyles: Record<RagStatus, string> = {
  Green: "bg-green-500",
  Yellow: "bg-yellow-500",
  Red: "bg-red-500",
};

export function RagBadge({ status }: RagBadgeProps) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-semibold ${badgeStyles[status]}`}>
      <span className={`h-2 w-2 rounded-full ${dotStyles[status]}`} />
      {status}
    </span>
  );
}
