import type { RagStatus } from "@/types/database";

interface RagBadgeProps {
  status: RagStatus;
}

const badgeStyles: Record<RagStatus, string> = {
  Green: "border-green-200 bg-green-50 text-green-700",
  Yellow: "border-yellow-200 bg-yellow-50 text-yellow-700",
  Red: "border-red-200 bg-red-50 text-red-700",
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
