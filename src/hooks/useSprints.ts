"use client";

import { useEffect, useState } from "react";
import type { SprintWithImplementation } from "@/types/database";

interface UseSprintsResult {
  sprints: SprintWithImplementation[];
  loading: boolean;
  error: string | null;
}

export function useSprints(): UseSprintsResult {
  const [sprints, setSprints] = useState<SprintWithImplementation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadSprints() {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch("/api/sprints", { cache: "no-store" });

        if (response.status === 401) {
          throw new Error("Authentication required. Sign in at /login.");
        }

        if (!response.ok) {
          throw new Error("Failed to fetch sprints");
        }

        const data = (await response.json()) as SprintWithImplementation[];
        if (isMounted) {
          setSprints(Array.isArray(data) ? data : []);
        }
      } catch (loadError) {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : "Failed to fetch sprints");
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    void loadSprints();

    return () => {
      isMounted = false;
    };
  }, []);

  return { sprints, loading, error };
}
