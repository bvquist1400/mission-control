"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { ProjectTemplateCatalogModal } from "@/components/projects/ProjectTemplateCatalogModal";

interface ImplementationOption {
  id: string;
  name: string;
}

interface ApiImplementation {
  id: string;
  name: string;
}

interface ProjectTemplatesPageProps {
  initialMode?: "browse" | "create" | "edit";
  initialTemplateId?: string;
}

export function ProjectTemplatesPage({
  initialMode = "browse",
  initialTemplateId,
}: ProjectTemplatesPageProps) {

  const [implementations, setImplementations] = useState<ImplementationOption[]>([]);

  useEffect(() => {
    let active = true;

    fetch("/api/applications", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          return [] as ApiImplementation[];
        }
        return response.json() as Promise<ApiImplementation[]>;
      })
      .then((rows) => {
        if (!active) return;
        setImplementations(rows.map((row) => ({ id: row.id, name: row.name })));
      })
      .catch(() => {
        if (!active) return;
        setImplementations([]);
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Project Templates"
        description="Author reusable templates for recurring delivery work and instantiate projects from consistent structures."
      />

      <ProjectTemplateCatalogModal
        open
        onClose={() => {}}
        implementations={implementations}
        layout="page"
        initialMode={initialMode}
        initialTemplateId={initialTemplateId}
      />
    </div>
  );
}
