import { PageHeader } from '@/components/layout/PageHeader';
import { PlannerCard } from '@/components/today/PlannerCard';

export default function PlannerPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Planner"
        description="Directive-aware recommendations for now, next, and exceptions."
      />
      <PlannerCard />
    </div>
  );
}
