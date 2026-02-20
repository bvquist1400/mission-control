"use client";

import Link from "next/link";

export interface StakeholderCardData {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  organization: string | null;
  open_commitments_count: number;
}

interface StakeholderCardProps {
  stakeholder: StakeholderCardData;
}

export function StakeholderCard({ stakeholder }: StakeholderCardProps) {
  return (
    <Link
      href={`/stakeholders/${stakeholder.id}`}
      className="block rounded-card border border-stroke bg-panel p-4 shadow-sm transition hover:border-accent/30 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground truncate">{stakeholder.name}</h3>
          {stakeholder.role && (
            <p className="mt-0.5 text-xs text-muted-foreground truncate">{stakeholder.role}</p>
          )}
          {stakeholder.organization && (
            <p className="mt-0.5 text-xs text-muted-foreground truncate">{stakeholder.organization}</p>
          )}
          {stakeholder.email && (
            <p className="mt-1 text-xs text-muted-foreground truncate">{stakeholder.email}</p>
          )}
        </div>
        {stakeholder.open_commitments_count > 0 && (
          <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
            {stakeholder.open_commitments_count} open
          </span>
        )}
      </div>
    </Link>
  );
}
