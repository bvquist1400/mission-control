import { PageHeader } from "@/components/layout/PageHeader";
import { SprintsList } from "@/components/sprints/SprintsList";

export default function SprintsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Sprints"
        description="Create week-level planning windows, review current scope, and jump straight into the filtered backlog."
      />

      <SprintsList />
    </div>
  );
}
