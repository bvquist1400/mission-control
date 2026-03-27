import type { TaskWithImplementation } from "@/types/database";

interface RelatedImplementation {
  id: string;
  name: string;
  phase?: string | null;
  rag?: string | null;
}

interface RelatedProject {
  id: string;
  name: string;
  stage?: string | null;
  rag?: string | null;
}

interface RelatedSprint {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  theme?: string | null;
}

interface RelatedSection {
  id: string;
  project_id: string;
  name: string;
  sort_order: number;
  created_at: string;
}

type MaybeRelation<T> = T | T[] | null | undefined;

export const TASK_WITH_RELATIONS_SELECT =
  "*, implementation:implementations(id, name, phase, rag), project:projects(id, name, stage, rag), sprint:sprints(id, name, start_date, end_date, theme), section:project_sections(id, project_id, name, sort_order, created_at)";

function getSingleRelation<T>(value: MaybeRelation<T>): T | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

export function normalizeTaskWithRelations<T extends Record<string, unknown>>(row: T): TaskWithImplementation {
  const section = getSingleRelation(row.section as MaybeRelation<RelatedSection>);
  const implementation = getSingleRelation(row.implementation as MaybeRelation<RelatedImplementation>);
  const project = getSingleRelation(row.project as MaybeRelation<RelatedProject>);
  const sprint = getSingleRelation(row.sprint as MaybeRelation<RelatedSprint>);

  const { section: _section, ...rest } = row;

  return {
    ...(rest as unknown as TaskWithImplementation),
    implementation: implementation as TaskWithImplementation["implementation"],
    project: project as TaskWithImplementation["project"],
    sprint: sprint as TaskWithImplementation["sprint"],
    section_name: section?.name ?? null,
  };
}

export function normalizeTaskWithRelationsList(rows: Array<Record<string, unknown>>): TaskWithImplementation[] {
  return rows.map((row) => normalizeTaskWithRelations(row));
}
