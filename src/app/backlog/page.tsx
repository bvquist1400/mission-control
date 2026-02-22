import { Suspense } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { BacklogList } from "@/components/backlog/BacklogList";

export default function BacklogPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Backlog"
        description="Primary task hub for filtering, editing, and creating work across all statuses."
      />

      <Suspense>
        <BacklogList />
      </Suspense>
    </div>
  );
}
