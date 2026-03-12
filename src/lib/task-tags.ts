export function normalizeTaskTag(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeTaskTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const nextTag = normalizeTaskTag(item);
    if (!nextTag || seen.has(nextTag)) {
      continue;
    }

    seen.add(nextTag);
    normalized.push(nextTag);
  }

  return normalized;
}

export function mergeTaskTags(currentTags: string[], rawValue: string): string[] {
  const nextTags = [...currentTags];
  const seen = new Set(currentTags);

  for (const fragment of rawValue.split(",")) {
    const nextTag = normalizeTaskTag(fragment);
    if (!nextTag || seen.has(nextTag)) {
      continue;
    }

    seen.add(nextTag);
    nextTags.push(nextTag);
  }

  return nextTags;
}
