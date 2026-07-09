/**
 * Shared request-body validators for API routes.
 */

export interface TimestampValidationResult {
  ok: boolean;
  value: string | null;
  error: string | null;
}

/**
 * Normalize an optional timestamp field from a request body.
 * - undefined/null/empty string → null (field cleared or absent)
 * - parseable date string → trimmed string, ok
 * - anything else → error message for a 400 response
 */
export function validateOptionalTimestamp(value: unknown, fieldName: string): TimestampValidationResult {
  if (value === undefined || value === null) {
    return { ok: true, value: null, error: null };
  }

  if (typeof value !== 'string') {
    return { ok: false, value: null, error: `${fieldName} must be an ISO 8601 timestamp string or null` };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null, error: null };
  }

  if (Number.isNaN(Date.parse(trimmed))) {
    return { ok: false, value: null, error: `${fieldName} must be a parseable ISO 8601 timestamp` };
  }

  return { ok: true, value: trimmed, error: null };
}
