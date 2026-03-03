import type { StakeholderContext } from '@/types/database';

export const DEFAULT_STAKEHOLDER_CONTEXT: StakeholderContext = {
  last_contacted_at: null,
  preferred_contact: null,
  current_priorities: null,
  notes: null,
};

function asTrimmedStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeStakeholderContext(value: unknown): StakeholderContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_STAKEHOLDER_CONTEXT };
  }

  const source = value as Record<string, unknown>;
  return {
    last_contacted_at: asTrimmedStringOrNull(source.last_contacted_at),
    preferred_contact: asTrimmedStringOrNull(source.preferred_contact),
    current_priorities: asTrimmedStringOrNull(source.current_priorities),
    notes: asTrimmedStringOrNull(source.notes),
  };
}

export function mergeStakeholderContext(current: unknown, updates: Record<string, unknown>): StakeholderContext {
  const base = normalizeStakeholderContext(current);
  const next = { ...base };

  if ('last_contacted_at' in updates) {
    next.last_contacted_at = asTrimmedStringOrNull(updates.last_contacted_at);
  }

  if ('preferred_contact' in updates) {
    next.preferred_contact = asTrimmedStringOrNull(updates.preferred_contact);
  }

  if ('current_priorities' in updates) {
    next.current_priorities = asTrimmedStringOrNull(updates.current_priorities);
  }

  if ('notes' in updates) {
    next.notes = asTrimmedStringOrNull(updates.notes);
  }

  return next;
}
