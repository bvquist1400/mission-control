"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { ProjectStageBadge } from "@/components/ui/ProjectStageBadge";
import { RagBadge } from "@/components/ui/RagBadge";
import {
  PROJECT_STAGE_VALUES,
  RAG_VALUES,
  TASK_STATUS_VALUES,
  TASK_TYPE_VALUES,
} from "@/lib/project-template-write";
import type { ProjectStage, RagStatus, TaskStatus, TaskType } from "@/types/database";

interface TemplateSummary {
  id: string;
  name: string;
  description: string | null;
  default_stage: ProjectStage;
  default_rag: RagStatus;
  default_status_summary: string;
  is_active: boolean;
  updated_at: string;
  section_count: number;
  task_count: number;
}

interface TemplateTask {
  id: string;
  template_section_id: string | null;
  title: string;
  description: string | null;
  task_type: TaskType;
  priority_score: number;
  status: TaskStatus;
  relative_due_days: number | null;
  needs_review: boolean;
  blocker: boolean;
  waiting_on: string | null;
  sort_order: number;
  checklist_items: string[];
}

interface TemplateSection {
  id: string;
  name: string;
  sort_order: number;
  tasks: TemplateTask[];
}

interface TemplateDetail {
  id: string;
  name: string;
  description: string | null;
  default_stage: ProjectStage;
  default_rag: RagStatus;
  default_status_summary: string;
  is_active: boolean;
  sections: TemplateSection[];
  unsectioned_tasks: TemplateTask[];
}

interface TemplatePreviewTask {
  id: string;
  section_name: string | null;
  title: string;
  status: TaskStatus;
  relative_due_days: number | null;
  resolved_due_date: string | null;
  checklist_items: string[];
}

interface TemplatePreviewResponse {
  template_id: string;
  kickoff_date: string;
  project: {
    name: string;
    description: string | null;
    stage: ProjectStage;
    rag: RagStatus;
    status_summary: string;
    implementation: { id: string; name: string } | null;
  };
  sections: Array<{ id: string; name: string; sort_order: number }>;
  tasks: TemplatePreviewTask[];
  summary: {
    section_count: number;
    task_count: number;
    checklist_item_count: number;
  };
}

interface TemplateInstantiateResponse {
  project_id: string;
  created_sections: number;
  created_tasks: number;
  created_checklist_items: number;
}

interface ImplementationOption {
  id: string;
  name: string;
}

interface ProjectTemplateCatalogModalProps {
  open: boolean;
  onClose: () => void;
  implementations: ImplementationOption[];
  defaultImplementationId?: string;
}

interface EditableTemplateSection {
  id?: string;
  client_key: string;
  name: string;
}

interface EditableTemplateTask {
  id?: string;
  title: string;
  description: string;
  section_key: string;
  task_type: TaskType;
  status: TaskStatus;
  priority_score: number;
  relative_due_days: string;
  needs_review: boolean;
  blocker: boolean;
  waiting_on: string;
  checklist_items_text: string;
}

interface TemplateEditorDraft {
  templateId: string | null;
  name: string;
  description: string;
  default_stage: ProjectStage;
  default_rag: RagStatus;
  default_status_summary: string;
  is_active: boolean;
  sections: EditableTemplateSection[];
  tasks: EditableTemplateTask[];
}

interface TemplateWriteResponse {
  template_id: string;
  section_count: number;
  task_count: number;
  checklist_item_count: number;
}

const taskStatusStyles: Record<TaskStatus, string> = {
  Backlog: "border-stroke text-muted-foreground",
  Planned: "border-cyan-500/30 text-cyan-300",
  "In Progress": "border-indigo-500/30 text-indigo-300",
  "Blocked/Waiting": "border-amber-500/35 text-amber-300",
  Parked: "border-zinc-500/40 text-zinc-400",
  Done: "border-emerald-500/35 text-emerald-300",
};

function getTodayIsoDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = `${now.getMonth() + 1}`.padStart(2, "0");
  const d = `${now.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDaysOffset(days: number | null): string {
  if (days === null) {
    return "No due offset";
  }
  if (days === 0) {
    return "Due on kickoff";
  }
  if (days > 0) {
    return `Due +${days}d`;
  }
  return `Due ${days}d`;
}

function formatResolvedDueDate(value: string | null): string {
  if (!value) {
    return "No due date";
  }
  return value;
}

function createClientKey(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

function moveItem<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= items.length) {
    return items;
  }
  const cloned = [...items];
  const [item] = cloned.splice(index, 1);
  cloned.splice(nextIndex, 0, item);
  return cloned;
}

function draftFromDetail(detail: TemplateDetail): TemplateEditorDraft {
  const sortedSections = [...detail.sections]
    .sort((a, b) => {
      if (a.sort_order !== b.sort_order) {
        return a.sort_order - b.sort_order;
      }
      return a.name.localeCompare(b.name);
    });

  const sections = sortedSections
    .map((section) => ({
      id: section.id,
      client_key: section.id,
      name: section.name,
    }));

  const sectionLookup = new Map<string, string>(sections.map((section) => [section.id ?? "", section.client_key]));
  const allTasks = [
    ...sortedSections.flatMap((section, sectionIndex) =>
      section.tasks.map((task) => ({ ...task, sectionId: section.id, sectionOrder: sectionIndex }))
    ),
    ...detail.unsectioned_tasks.map((task) => ({
      ...task,
      sectionId: null as string | null,
      sectionOrder: Number.MAX_SAFE_INTEGER,
    })),
  ].sort((a, b) => {
    if (a.sectionOrder !== b.sectionOrder) {
      return a.sectionOrder - b.sectionOrder;
    }
    if (a.sort_order !== b.sort_order) {
      return a.sort_order - b.sort_order;
    }
    return a.title.localeCompare(b.title);
  });

  const tasks: EditableTemplateTask[] = allTasks.map((task) => ({
    id: task.id,
    title: task.title,
    description: task.description ?? "",
    section_key: task.sectionId ? sectionLookup.get(task.sectionId) ?? "" : "",
    task_type: task.task_type,
    status: task.status,
    priority_score: task.priority_score,
    relative_due_days: task.relative_due_days === null ? "" : String(task.relative_due_days),
    needs_review: task.needs_review,
    blocker: task.blocker,
    waiting_on: task.waiting_on ?? "",
    checklist_items_text: (task.checklist_items ?? []).join("\n"),
  }));

  return {
    templateId: detail.id,
    name: detail.name,
    description: detail.description ?? "",
    default_stage: detail.default_stage,
    default_rag: detail.default_rag,
    default_status_summary: detail.default_status_summary,
    is_active: detail.is_active,
    sections,
    tasks,
  };
}

export function ProjectTemplateCatalogModal({
  open,
  onClose,
  implementations,
  defaultImplementationId,
}: ProjectTemplateCatalogModalProps) {
  const router = useRouter();

  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);

  const [detailsById, setDetailsById] = useState<Record<string, TemplateDetail>>({});
  const [detailErrorsById, setDetailErrorsById] = useState<Record<string, string>>({});

  const [kickoffDate, setKickoffDate] = useState(getTodayIsoDate());
  const [projectNameOverride, setProjectNameOverride] = useState("");
  const [implementationId, setImplementationId] = useState(defaultImplementationId ?? "");

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<TemplatePreviewResponse | null>(null);
  const [previewSignature, setPreviewSignature] = useState<string | null>(null);

  const [instantiateLoading, setInstantiateLoading] = useState(false);
  const [instantiateError, setInstantiateError] = useState<string | null>(null);

  const [editorMode, setEditorMode] = useState<"create" | "edit" | null>(null);
  const [editorDraft, setEditorDraft] = useState<TemplateEditorDraft | null>(null);
  const [templateSaveError, setTemplateSaveError] = useState<string | null>(null);
  const [templateSaving, setTemplateSaving] = useState(false);

  const resetPreviewState = useCallback(() => {
    setPreviewData(null);
    setPreviewError(null);
    setPreviewSignature(null);
    setInstantiateError(null);
  }, []);

  const loadTemplates = useCallback(async (preferredTemplateId?: string | null) => {
    setTemplatesError(null);
    setTemplates(null);

    try {
      const response = await fetch("/api/project-templates", { cache: "no-store" });
      if (response.status === 401) {
        throw new Error("Authentication required.");
      }
      if (!response.ok) {
        throw new Error("Failed to load project templates.");
      }

      const data = (await response.json()) as TemplateSummary[];
      setTemplates(data);

      if (data.length === 0) {
        setSelectedTemplateId(null);
        return;
      }

      setSelectedTemplateId((previous) => {
        const candidate = preferredTemplateId ?? previous;
        if (candidate && data.some((item) => item.id === candidate)) {
          return candidate;
        }
        const firstActive = data.find((item) => item.is_active);
        return firstActive?.id ?? data[0].id;
      });
    } catch (error) {
      setTemplatesError(error instanceof Error ? error.message : "Failed to load project templates.");
      setTemplates([]);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    void loadTemplates();
  }, [loadTemplates, open]);

  useEffect(() => {
    if (!open || !selectedTemplateId || detailsById[selectedTemplateId] || detailErrorsById[selectedTemplateId]) {
      return;
    }

    let active = true;

    fetch(`/api/project-templates/${selectedTemplateId}`, { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 404) {
          throw new Error("Template not found.");
        }
        if (!response.ok) {
          throw new Error("Failed to load template details.");
        }
        return response.json() as Promise<TemplateDetail>;
      })
      .then((data) => {
        if (!active) return;
        setDetailsById((current) => ({ ...current, [selectedTemplateId]: data }));
        setDetailErrorsById((current) => {
          const next = { ...current };
          delete next[selectedTemplateId];
          return next;
        });
      })
      .catch((error: Error) => {
        if (!active) return;
        setDetailErrorsById((current) => ({ ...current, [selectedTemplateId]: error.message }));
      });

    return () => {
      active = false;
    };
  }, [detailErrorsById, detailsById, open, selectedTemplateId]);

  const templatesLoading = open && templates === null && !templatesError;
  const detail = selectedTemplateId ? detailsById[selectedTemplateId] ?? null : null;
  const detailError = selectedTemplateId ? detailErrorsById[selectedTemplateId] ?? null : null;
  const detailLoading = Boolean(selectedTemplateId) && !detail && !detailError;

  const totalDetailTaskCount = useMemo(() => {
    if (!detail) {
      return 0;
    }
    const sectionCount = detail.sections.reduce((sum, section) => sum + section.tasks.length, 0);
    return sectionCount + detail.unsectioned_tasks.length;
  }, [detail]);

  const currentSignature = useMemo(
    () =>
      JSON.stringify({
        templateId: selectedTemplateId,
        kickoffDate,
        projectName: projectNameOverride.trim() || null,
        implementationId: implementationId || null,
      }),
    [selectedTemplateId, kickoffDate, projectNameOverride, implementationId]
  );

  const canCreate =
    Boolean(previewData) &&
    previewSignature === currentSignature &&
    !instantiateLoading &&
    editorMode === null;

  function startCreateTemplate() {
    setEditorMode("create");
    setTemplateSaveError(null);
    setEditorDraft({
      templateId: null,
      name: "",
      description: "",
      default_stage: "Planned",
      default_rag: "Green",
      default_status_summary: "",
      is_active: true,
      sections: [],
      tasks: [],
    });
  }

  function startEditTemplate() {
    if (!detail) {
      setTemplateSaveError("Select a template first.");
      return;
    }

    setEditorMode("edit");
    setTemplateSaveError(null);
    setEditorDraft(draftFromDetail(detail));
  }

  function cancelEditor() {
    setEditorMode(null);
    setEditorDraft(null);
    setTemplateSaveError(null);
  }

  async function handleSaveTemplate() {
    if (!editorDraft || templateSaving) {
      return;
    }

    setTemplateSaving(true);
    setTemplateSaveError(null);

    const sectionsPayload = editorDraft.sections.map((section, index) => ({
      id: section.id,
      client_key: section.client_key,
      name: section.name,
      sort_order: (index + 1) * 10,
    }));

    const tasksPayload = editorDraft.tasks.map((task, index) => {
      const relative = task.relative_due_days.trim();
      return {
        id: task.id,
        title: task.title,
        description: task.description,
        section_key: task.section_key || null,
        task_type: task.task_type,
        status: task.status || "Backlog",
        priority_score: Number.isFinite(task.priority_score) ? task.priority_score : 50,
        relative_due_days: relative.length > 0 ? Number(relative) : null,
        needs_review: task.needs_review,
        blocker: task.blocker,
        waiting_on: task.waiting_on,
        sort_order: (index + 1) * 10,
        checklist_items: task.checklist_items_text
          .split("\n")
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      };
    });

    const payload = {
      name: editorDraft.name,
      description: editorDraft.description,
      default_stage: editorDraft.default_stage,
      default_rag: editorDraft.default_rag,
      default_status_summary: editorDraft.default_status_summary,
      is_active: editorDraft.is_active,
      sections: sectionsPayload,
      tasks: tasksPayload,
    };

    try {
      const isEdit = editorMode === "edit" && editorDraft.templateId;
      const endpoint = isEdit ? `/api/project-templates/${editorDraft.templateId}` : "/api/project-templates";
      const method = isEdit ? "PUT" : "POST";

      const response = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const result = (await response.json().catch(() => null)) as
        | { error?: string }
        | TemplateWriteResponse
        | null;

      if (!response.ok) {
        throw new Error(result && "error" in result && result.error ? result.error : "Failed to save template");
      }

      const saved = result as TemplateWriteResponse;
      const templateId = saved.template_id;

      setDetailsById((current) => {
        const next = { ...current };
        delete next[templateId];
        return next;
      });
      setDetailErrorsById((current) => {
        const next = { ...current };
        delete next[templateId];
        return next;
      });

      await loadTemplates(templateId);
      setSelectedTemplateId(templateId);
      cancelEditor();
      resetPreviewState();
    } catch (error) {
      setTemplateSaveError(error instanceof Error ? error.message : "Failed to save template");
    } finally {
      setTemplateSaving(false);
    }
  }

  function updateDraftField<K extends keyof TemplateEditorDraft>(field: K, value: TemplateEditorDraft[K]) {
    setEditorDraft((current) => (current ? { ...current, [field]: value } : current));
  }

  function addSection() {
    setEditorDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        sections: [...current.sections, { client_key: createClientKey("section"), name: "" }],
      };
    });
  }

  function removeSection(index: number) {
    setEditorDraft((current) => {
      if (!current) return current;
      const section = current.sections[index];
      if (!section) return current;
      const sections = current.sections.filter((_, idx) => idx !== index);
      const tasks = current.tasks.map((task) =>
        task.section_key === section.client_key ? { ...task, section_key: "" } : task
      );
      return { ...current, sections, tasks };
    });
  }

  function moveSection(index: number, direction: -1 | 1) {
    setEditorDraft((current) => {
      if (!current) return current;
      return { ...current, sections: moveItem(current.sections, index, direction) };
    });
  }

  function updateSection(index: number, name: string) {
    setEditorDraft((current) => {
      if (!current) return current;
      const sections = current.sections.map((section, idx) => (idx === index ? { ...section, name } : section));
      return { ...current, sections };
    });
  }

  function addTask() {
    setEditorDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        tasks: [
          ...current.tasks,
          {
            title: "",
            description: "",
            section_key: "",
            task_type: "Task",
            status: "Backlog",
            priority_score: 50,
            relative_due_days: "",
            needs_review: false,
            blocker: false,
            waiting_on: "",
            checklist_items_text: "",
          },
        ],
      };
    });
  }

  function removeTask(index: number) {
    setEditorDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        tasks: current.tasks.filter((_, idx) => idx !== index),
      };
    });
  }

  function moveTask(index: number, direction: -1 | 1) {
    setEditorDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        tasks: moveItem(current.tasks, index, direction),
      };
    });
  }

  function updateTask(index: number, patch: Partial<EditableTemplateTask>) {
    setEditorDraft((current) => {
      if (!current) return current;
      const tasks = current.tasks.map((task, idx) => (idx === index ? { ...task, ...patch } : task));
      return { ...current, tasks };
    });
  }

  async function handlePreview() {
    if (!selectedTemplateId) {
      return;
    }

    setPreviewLoading(true);
    setPreviewError(null);
    setInstantiateError(null);

    try {
      const response = await fetch(`/api/project-templates/${selectedTemplateId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kickoff_date: kickoffDate,
          project_name: projectNameOverride.trim() || null,
          implementation_id: implementationId || null,
        }),
      });

      const payload = (await response.json().catch(() => null)) as { error?: string } | TemplatePreviewResponse | null;
      if (!response.ok) {
        throw new Error(payload && "error" in payload && payload.error ? payload.error : "Preview failed");
      }

      setPreviewData(payload as TemplatePreviewResponse);
      setPreviewSignature(currentSignature);
    } catch (error) {
      setPreviewData(null);
      setPreviewSignature(null);
      setPreviewError(error instanceof Error ? error.message : "Preview failed");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleInstantiate() {
    if (!selectedTemplateId || !canCreate) {
      return;
    }

    setInstantiateLoading(true);
    setInstantiateError(null);

    try {
      const response = await fetch(`/api/project-templates/${selectedTemplateId}/instantiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kickoff_date: kickoffDate,
          project_name: projectNameOverride.trim() || null,
          implementation_id: implementationId || null,
        }),
      });

      const payload = (await response.json().catch(() => null)) as { error?: string } | TemplateInstantiateResponse | null;
      if (!response.ok) {
        throw new Error(payload && "error" in payload && payload.error ? payload.error : "Failed to create project from template");
      }

      const created = payload as TemplateInstantiateResponse;
      onClose();
      router.push(`/projects/${created.project_id}`);
    } catch (error) {
      setInstantiateError(error instanceof Error ? error.message : "Failed to create project from template");
    } finally {
      setInstantiateLoading(false);
    }
  }

  function handleSelectTemplate(templateId: string) {
    setSelectedTemplateId(templateId);
    resetPreviewState();
    setTemplateSaveError(null);
  }

  function handleKickoffDateChange(value: string) {
    setKickoffDate(value);
    resetPreviewState();
  }

  function handleProjectNameChange(value: string) {
    setProjectNameOverride(value);
    resetPreviewState();
  }

  function handleImplementationChange(value: string) {
    setImplementationId(value);
    resetPreviewState();
  }

  return (
    <Modal open={open} onClose={onClose} title="Project templates" size="wide">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Start recurring work with a template, preview the generated project, then create it.
        </p>

        <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <div className="rounded-lg border border-stroke bg-panel-muted/30">
            <div className="border-b border-stroke px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Catalog</h3>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={startCreateTemplate}
                    className="rounded border border-stroke bg-panel px-2 py-1 text-[11px] font-semibold text-foreground hover:bg-panel-muted"
                  >
                    New Template
                  </button>
                  <button
                    type="button"
                    onClick={startEditTemplate}
                    disabled={!selectedTemplateId || detailLoading || Boolean(detailError)}
                    className="rounded border border-stroke bg-panel px-2 py-1 text-[11px] font-semibold text-foreground hover:bg-panel-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Edit Template
                  </button>
                </div>
              </div>
            </div>

            {templatesLoading ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">Loading templates...</p>
            ) : null}
            {!templatesLoading && templatesError ? (
              <p className="px-3 py-4 text-sm text-red-400">{templatesError}</p>
            ) : null}
            {!templatesLoading && !templatesError && templates && templates.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">No templates yet. Use New Template to create one.</p>
            ) : null}

            {!templatesLoading && !templatesError && templates && templates.length > 0 ? (
              <ul className="max-h-[62vh] space-y-1 overflow-y-auto p-2">
                {templates.map((template) => {
                  const isSelected = template.id === selectedTemplateId;
                  return (
                    <li key={template.id}>
                      <button
                        type="button"
                        onClick={() => handleSelectTemplate(template.id)}
                        className={`w-full rounded-md border px-3 py-2 text-left transition ${
                          isSelected
                            ? "border-accent/60 bg-accent/10"
                            : "border-transparent hover:border-stroke hover:bg-panel"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="line-clamp-2 text-sm font-semibold text-foreground">{template.name}</p>
                          {!template.is_active ? (
                            <span className="rounded border border-stroke px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                              Inactive
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {template.task_count} tasks in {template.section_count} sections
                        </p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>

          <div className="rounded-lg border border-stroke bg-panel">
            {editorMode && editorDraft ? (
              <div className="max-h-[62vh] space-y-4 overflow-y-auto p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-base font-semibold text-foreground">
                    {editorMode === "create" ? "New template" : "Edit template"}
                  </h3>
                  <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={editorDraft.is_active}
                      onChange={(event) => updateDraftField("is_active", event.target.checked)}
                      className="h-4 w-4 accent-accent"
                    />
                    Active
                  </label>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <label className="space-y-1 md:col-span-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Template name</span>
                    <input
                      type="text"
                      value={editorDraft.name}
                      onChange={(event) => updateDraftField("name", event.target.value)}
                      className="w-full rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                      placeholder="Template name"
                    />
                  </label>

                  <label className="space-y-1 md:col-span-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Description</span>
                    <textarea
                      value={editorDraft.description}
                      onChange={(event) => updateDraftField("description", event.target.value)}
                      rows={2}
                      className="w-full rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                    />
                  </label>

                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Default stage</span>
                    <select
                      value={editorDraft.default_stage}
                      onChange={(event) => updateDraftField("default_stage", event.target.value as ProjectStage)}
                      className="w-full rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                    >
                      {PROJECT_STAGE_VALUES.map((value) => (
                        <option key={value} value={value}>{value}</option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Default RAG</span>
                    <select
                      value={editorDraft.default_rag}
                      onChange={(event) => updateDraftField("default_rag", event.target.value as RagStatus)}
                      className="w-full rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                    >
                      {RAG_VALUES.map((value) => (
                        <option key={value} value={value}>{value}</option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1 md:col-span-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Default status summary</span>
                    <textarea
                      value={editorDraft.default_status_summary}
                      onChange={(event) => updateDraftField("default_status_summary", event.target.value)}
                      rows={2}
                      className="w-full rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                    />
                  </label>
                </div>

                <div className="space-y-2 rounded-md border border-stroke bg-panel-muted/20 p-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-foreground">Sections</h4>
                    <button
                      type="button"
                      onClick={addSection}
                      className="rounded border border-stroke bg-panel px-2 py-1 text-xs font-semibold text-foreground hover:bg-panel-muted"
                    >
                      Add section
                    </button>
                  </div>

                  {editorDraft.sections.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No sections yet. Tasks can stay unsectioned.</p>
                  ) : (
                    <div className="space-y-2">
                      {editorDraft.sections.map((section, index) => (
                        <div key={section.client_key} className="flex items-center gap-2">
                          <input
                            type="text"
                            value={section.name}
                            onChange={(event) => updateSection(index, event.target.value)}
                            placeholder="Section name"
                            className="flex-1 rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                          />
                          <button
                            type="button"
                            onClick={() => moveSection(index, -1)}
                            disabled={index === 0}
                            className="rounded border border-stroke px-2 py-1 text-xs text-foreground disabled:opacity-40"
                          >
                            Up
                          </button>
                          <button
                            type="button"
                            onClick={() => moveSection(index, 1)}
                            disabled={index === editorDraft.sections.length - 1}
                            className="rounded border border-stroke px-2 py-1 text-xs text-foreground disabled:opacity-40"
                          >
                            Down
                          </button>
                          <button
                            type="button"
                            onClick={() => removeSection(index)}
                            className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-300"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2 rounded-md border border-stroke bg-panel-muted/20 p-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-foreground">Tasks</h4>
                    <button
                      type="button"
                      onClick={addTask}
                      className="rounded border border-stroke bg-panel px-2 py-1 text-xs font-semibold text-foreground hover:bg-panel-muted"
                    >
                      Add task
                    </button>
                  </div>

                  {editorDraft.tasks.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No tasks yet.</p>
                  ) : (
                    <div className="space-y-3">
                      {editorDraft.tasks.map((task, index) => (
                        <div key={`${task.id ?? "new"}-${index}`} className="rounded-md border border-stroke bg-panel p-3">
                          <div className="grid gap-3 md:grid-cols-2">
                            <label className="space-y-1 md:col-span-2">
                              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Title</span>
                              <input
                                type="text"
                                value={task.title}
                                onChange={(event) => updateTask(index, { title: event.target.value })}
                                className="w-full rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                              />
                            </label>

                            <label className="space-y-1 md:col-span-2">
                              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Description</span>
                              <textarea
                                value={task.description}
                                onChange={(event) => updateTask(index, { description: event.target.value })}
                                rows={2}
                                className="w-full rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                              />
                            </label>

                            <label className="space-y-1">
                              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Section</span>
                              <select
                                value={task.section_key}
                                onChange={(event) => updateTask(index, { section_key: event.target.value })}
                                className="w-full rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                              >
                                <option value="">Unsectioned</option>
                                {editorDraft.sections.map((section) => (
                                  <option key={section.client_key} value={section.client_key}>
                                    {section.name || "(Untitled section)"}
                                  </option>
                                ))}
                              </select>
                            </label>

                            <label className="space-y-1">
                              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Task type</span>
                              <select
                                value={task.task_type}
                                onChange={(event) => updateTask(index, { task_type: event.target.value as TaskType })}
                                className="w-full rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                              >
                                {TASK_TYPE_VALUES.map((value) => (
                                  <option key={value} value={value}>{value}</option>
                                ))}
                              </select>
                            </label>

                            <label className="space-y-1">
                              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</span>
                              <select
                                value={task.status}
                                onChange={(event) => updateTask(index, { status: event.target.value as TaskStatus })}
                                className="w-full rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                              >
                                {TASK_STATUS_VALUES.map((value) => (
                                  <option key={value} value={value}>{value}</option>
                                ))}
                              </select>
                            </label>

                            <label className="space-y-1">
                              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Priority score</span>
                              <input
                                type="number"
                                min={0}
                                max={100}
                                value={task.priority_score}
                                onChange={(event) => {
                                  const parsed = Number(event.target.value);
                                  const safe = Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : 50;
                                  updateTask(index, { priority_score: safe });
                                }}
                                className="w-full rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                              />
                            </label>

                            <label className="space-y-1">
                              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Relative due days</span>
                              <input
                                type="number"
                                value={task.relative_due_days}
                                onChange={(event) => updateTask(index, { relative_due_days: event.target.value })}
                                placeholder="e.g. 7"
                                className="w-full rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                              />
                            </label>

                            <label className="space-y-1 md:col-span-2">
                              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Waiting on</span>
                              <input
                                type="text"
                                value={task.waiting_on}
                                onChange={(event) => updateTask(index, { waiting_on: event.target.value })}
                                className="w-full rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                              />
                            </label>

                            <label className="space-y-1 md:col-span-2">
                              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Checklist items (one per line)</span>
                              <textarea
                                value={task.checklist_items_text}
                                onChange={(event) => updateTask(index, { checklist_items_text: event.target.value })}
                                rows={3}
                                className="w-full rounded-lg border border-stroke bg-panel-muted px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                              />
                            </label>

                            <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                              <input
                                type="checkbox"
                                checked={task.needs_review}
                                onChange={(event) => updateTask(index, { needs_review: event.target.checked })}
                                className="h-4 w-4 accent-accent"
                              />
                              Needs review
                            </label>

                            <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                              <input
                                type="checkbox"
                                checked={task.blocker}
                                onChange={(event) => updateTask(index, { blocker: event.target.checked })}
                                className="h-4 w-4 accent-accent"
                              />
                              Blocker
                            </label>
                          </div>

                          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => moveTask(index, -1)}
                              disabled={index === 0}
                              className="rounded border border-stroke px-2 py-1 text-xs text-foreground disabled:opacity-40"
                            >
                              Move up
                            </button>
                            <button
                              type="button"
                              onClick={() => moveTask(index, 1)}
                              disabled={index === editorDraft.tasks.length - 1}
                              className="rounded border border-stroke px-2 py-1 text-xs text-foreground disabled:opacity-40"
                            >
                              Move down
                            </button>
                            <button
                              type="button"
                              onClick={() => removeTask(index)}
                              className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-300"
                            >
                              Remove task
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {templateSaveError ? <p className="text-sm text-red-400">{templateSaveError}</p> : null}

                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={cancelEditor}
                    className="rounded-lg border border-stroke bg-panel px-3 py-2 text-sm font-semibold text-foreground hover:bg-panel-muted"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSaveTemplate()}
                    disabled={templateSaving || !editorDraft.name.trim()}
                    className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {templateSaving ? "Saving..." : "Save template"}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {!selectedTemplateId && !templatesLoading && !templatesError ? (
                  <div className="p-4 text-sm text-muted-foreground">Choose a template to review and preview.</div>
                ) : null}
                {detailLoading ? (
                  <div className="p-4 text-sm text-muted-foreground">Loading template details...</div>
                ) : null}
                {!detailLoading && detailError ? <div className="p-4 text-sm text-red-400">{detailError}</div> : null}

                {!detailLoading && !detailError && detail ? (
                  <div className="max-h-[62vh] space-y-4 overflow-y-auto p-4">
                    <div className="space-y-3 rounded-md border border-stroke bg-panel-muted/30 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold text-foreground">{detail.name}</h3>
                        <ProjectStageBadge stage={detail.default_stage} />
                        <RagBadge status={detail.default_rag} />
                      </div>
                      {detail.description ? <p className="text-sm text-muted-foreground">{detail.description}</p> : null}
                      {detail.default_status_summary ? (
                        <p className="text-xs text-muted-foreground">Default status summary: {detail.default_status_summary}</p>
                      ) : null}
                      <p className="text-xs text-muted-foreground">{totalDetailTaskCount} template tasks</p>
                    </div>

                    <div className="grid gap-3 rounded-md border border-stroke bg-panel-muted/20 p-3 md:grid-cols-2">
                      <label className="space-y-1">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Kickoff date</span>
                        <input
                          type="date"
                          value={kickoffDate}
                          onChange={(event) => handleKickoffDateChange(event.target.value)}
                          className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                        />
                      </label>

                      <label className="space-y-1">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Application</span>
                        <select
                          value={implementationId}
                          onChange={(event) => handleImplementationChange(event.target.value)}
                          className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                        >
                          <option value="">No application</option>
                          {implementations.map((implementation) => (
                            <option key={implementation.id} value={implementation.id}>
                              {implementation.name}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="space-y-1 md:col-span-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Project name override (optional)
                        </span>
                        <input
                          type="text"
                          value={projectNameOverride}
                          onChange={(event) => handleProjectNameChange(event.target.value)}
                          placeholder={detail.name}
                          className="w-full rounded-lg border border-stroke bg-panel px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                        />
                      </label>

                      <div className="md:col-span-2 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handlePreview()}
                          disabled={previewLoading || instantiateLoading || !kickoffDate}
                          className="rounded-lg border border-stroke bg-panel px-3 py-2 text-sm font-semibold text-foreground hover:bg-panel-muted disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {previewLoading ? "Previewing..." : "Preview project"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleInstantiate()}
                          disabled={!canCreate}
                          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                          title={!canCreate ? "Run preview first (or refresh preview after edits)." : undefined}
                        >
                          {instantiateLoading ? "Creating..." : "Create project"}
                        </button>
                        <span className="text-xs text-muted-foreground">
                          Tasks are created in Backlog unless a template task status overrides it.
                        </span>
                      </div>

                      {previewError ? <p className="md:col-span-2 text-sm text-red-400">{previewError}</p> : null}
                      {instantiateError ? <p className="md:col-span-2 text-sm text-red-400">{instantiateError}</p> : null}
                    </div>

                    {previewData ? (
                      <div className="space-y-3 rounded-md border border-stroke bg-panel-muted/20 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h4 className="text-sm font-semibold text-foreground">Preview</h4>
                          <p className="text-xs text-muted-foreground">
                            {previewData.summary.task_count} tasks • {previewData.summary.section_count} sections •{" "}
                            {previewData.summary.checklist_item_count} checklist items
                          </p>
                        </div>

                        <div className="rounded-md border border-stroke bg-panel p-3 text-xs text-muted-foreground">
                          <p>
                            <span className="font-semibold text-foreground">Project:</span> {previewData.project.name}
                          </p>
                          <p>
                            <span className="font-semibold text-foreground">Kickoff:</span> {previewData.kickoff_date}
                          </p>
                          <p>
                            <span className="font-semibold text-foreground">Application:</span>{" "}
                            {previewData.project.implementation ? previewData.project.implementation.name : "No application"}
                          </p>
                        </div>

                        <ul className="space-y-2">
                          {previewData.tasks.map((task) => (
                            <li key={task.id} className="rounded-md border border-stroke bg-panel px-3 py-2">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-sm font-medium text-foreground">{task.title}</p>
                                <div className="flex items-center gap-1.5">
                                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${taskStatusStyles[task.status]}`}>
                                    {task.status}
                                  </span>
                                  <span className="rounded-full border border-stroke px-2 py-0.5 text-[11px] text-muted-foreground">
                                    {formatDaysOffset(task.relative_due_days)}
                                  </span>
                                  <span className="rounded-full border border-stroke px-2 py-0.5 text-[11px] text-muted-foreground">
                                    {formatResolvedDueDate(task.resolved_due_date)}
                                  </span>
                                </div>
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {task.section_name ? `Section: ${task.section_name}` : "Unsectioned"}
                                {task.checklist_items.length > 0 ? ` • ${task.checklist_items.length} checklist items` : ""}
                              </p>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
