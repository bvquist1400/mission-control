"use client";

import { useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { PlannerCard } from "@/components/today/PlannerCard";
import { TaskDetailModal } from "@/components/tasks/TaskDetailModal";
import type { TaskUpdatePayload, TaskWithImplementation } from "@/types/database";

export default function PlannerPage() {
  const [modalTask, setModalTask] = useState<TaskWithImplementation | null>(null);

  async function handleTaskClick(taskId: string) {
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { cache: "no-store" });
      if (res.ok) {
        const task = (await res.json()) as TaskWithImplementation;
        setModalTask(task);
      }
    } catch {
      // Fall back to backlog navigation if fetch fails
      window.location.href = `/backlog?expand=${taskId}`;
    }
  }

  function handleTaskUpdated(taskId: string, updates: TaskUpdatePayload) {
    setModalTask((prev) => (prev?.id === taskId ? { ...prev, ...updates } : prev));
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Planner"
        description="Directive-aware recommendations for now, next, and exceptions."
      />
      <PlannerCard onTaskClick={(id) => void handleTaskClick(id)} />
      <TaskDetailModal
        task={modalTask}
        allTasks={modalTask ? [modalTask] : []}
        commitments={[]}
        onClose={() => setModalTask(null)}
        onTaskUpdated={handleTaskUpdated}
      />
    </div>
  );
}
