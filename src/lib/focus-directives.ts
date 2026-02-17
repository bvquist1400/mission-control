export type DirectiveScopeType = 'implementation' | 'stakeholder' | 'task_type' | 'query';
export type DirectiveStrength = 'nudge' | 'strong' | 'hard';

export interface FocusDirectiveRow {
  id: string;
  created_at: string;
  created_by: string;
  is_active: boolean;
  text: string;
  scope_type: DirectiveScopeType;
  scope_id: string | null;
  scope_value: string | null;
  strength: DirectiveStrength;
  starts_at: string | null;
  ends_at: string | null;
  reason: string | null;
}

export const FOCUS_DIRECTIVE_SELECT =
  'id, created_at, created_by, is_active, text, scope_type, scope_id, scope_value, strength, starts_at, ends_at, reason';

export const VALID_DIRECTIVE_SCOPE_TYPES: DirectiveScopeType[] = [
  'implementation',
  'stakeholder',
  'task_type',
  'query',
];

export const VALID_DIRECTIVE_STRENGTHS: DirectiveStrength[] = ['nudge', 'strong', 'hard'];

export function isValidDirectiveScopeType(value: string): value is DirectiveScopeType {
  return VALID_DIRECTIVE_SCOPE_TYPES.includes(value as DirectiveScopeType);
}

export function isValidDirectiveStrength(value: string): value is DirectiveStrength {
  return VALID_DIRECTIVE_STRENGTHS.includes(value as DirectiveStrength);
}

export function asTrimmedStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseOptionalIsoTimestamp(
  value: unknown,
  fieldName: string
): { value: string | null | undefined; error: string | null } {
  if (value === undefined) {
    return { value: undefined, error: null };
  }

  if (value === null) {
    return { value: null, error: null };
  }

  if (typeof value !== 'string') {
    return { value: undefined, error: `${fieldName} must be an ISO timestamp string or null` };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { value: null, error: null };
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return { value: undefined, error: `${fieldName} must be a valid ISO timestamp` };
  }

  return { value: new Date(parsed).toISOString(), error: null };
}

export function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isDirectiveCurrentlyActive(
  directive: Pick<FocusDirectiveRow, 'is_active' | 'starts_at' | 'ends_at'>,
  nowMs: number
): boolean {
  if (!directive.is_active) {
    return false;
  }

  const startsAtMs = parseTimestampMs(directive.starts_at);
  const endsAtMs = parseTimestampMs(directive.ends_at);

  if (startsAtMs !== null && startsAtMs > nowMs) {
    return false;
  }

  if (endsAtMs !== null && endsAtMs <= nowMs) {
    return false;
  }

  return true;
}

export function isMissingRelationError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string; details?: string; hint?: string } | null;
  if (!candidate) {
    return false;
  }

  if (candidate.code === '42P01' || candidate.code === 'PGRST205') {
    return true;
  }

  const message = `${candidate.message ?? ''} ${candidate.details ?? ''} ${candidate.hint ?? ''}`.toLowerCase();
  return message.includes('does not exist') || message.includes('could not find the table');
}
