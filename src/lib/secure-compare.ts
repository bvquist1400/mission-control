import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison for API keys and other secrets.
 * Hashes both sides first so inputs of different lengths can be compared
 * without leaking length information.
 */
export function secureCompare(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
    return false;
  }

  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}
