"use client";

import { PageHeader } from "@/components/layout/PageHeader";
import { FocusContextBar } from "@/components/today/FocusContextBar";

export default function FocusPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Focus Directives"
        description="Create and manage ranking directives used by the planner to prioritize your tasks."
      />
      <FocusContextBar />
    </div>
  );
}
