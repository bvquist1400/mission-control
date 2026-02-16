import { PageHeader } from "@/components/layout/PageHeader";
import { TriageList } from "@/components/triage/TriageList";

export default function TriagePage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Triage"
        description="Tasks that need assignment, estimate, or scheduling decisions before entering execution lanes."
      />

      <TriageList />
    </div>
  );
}
