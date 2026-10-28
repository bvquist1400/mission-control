/**
 * Validation for the two hand-kept lists on the Launch page (Reddit posts and
 * the launch timeline). Explicit allowlists: any other field in the body is a
 * 400, never silently written. Times typed on the page are New York time
 * ("YYYY-MM-DDTHH:MM"); a full ISO timestamp with a zone is accepted too.
 */

import { etLocalToIso } from './dates';
import type { LaunchMilestoneKind } from './types';

export const REDDIT_FIELDS = ['label', 'subreddit', 'posted_at', 'views', 'upvotes', 'comments'] as const;
export const MILESTONE_FIELDS = ['happened_at', 'label', 'kind'] as const;
export const MILESTONE_KINDS: LaunchMilestoneKind[] = ['Release', 'Tracking', 'Users', 'Marketing', 'Feedback', 'Other'];

const SUBREDDIT = /^r\/[A-Za-z0-9_]{2,21}$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const EARLIEST = Date.parse('2024-01-01T00:00:00Z');

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function fail<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}

function readText(value: unknown, field: string, max: number): ParseResult<string> {
  if (typeof value !== 'string') {
    return fail(`${field} must be text`);
  }
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0 || cleaned.length > max) {
    return fail(`${field} must be 1–${max} characters`);
  }
  return { ok: true, value: cleaned };
}

function readTime(value: unknown, field: string, now: Date): ParseResult<string> {
  if (typeof value !== 'string') {
    return fail(`${field} must be a date and time`);
  }
  const trimmed = value.trim();
  const iso = ISO_WITH_ZONE.test(trimmed) ? new Date(trimmed) : null;
  const instant = iso && !Number.isNaN(iso.getTime()) ? iso.toISOString() : etLocalToIso(trimmed);
  if (!instant) {
    return fail(`${field} must be a date and time like 2026-10-26T09:23 (New York time)`);
  }
  const ms = Date.parse(instant);
  if (ms < EARLIEST || ms > now.getTime() + 366 * 86_400_000) {
    return fail(`${field} is out of range`);
  }
  return { ok: true, value: instant };
}

function readCount(value: unknown, field: string, allowNegative = false): ParseResult<number | null> {
  if (value === null || value === undefined || value === '') {
    return { ok: true, value: null };
  }
  const number = typeof value === 'string' && /^-?\d{1,9}$/.test(value.trim()) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number > 100_000_000 || number < (allowNegative ? -1_000_000 : 0)) {
    return fail(`${field} must be a whole number${allowNegative ? '' : ' of 0 or more'}`);
  }
  return { ok: true, value: number };
}

function unknownFields(body: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(body).filter((key) => !allowed.includes(key));
}

export interface RedditInput {
  label?: string;
  subreddit?: string;
  posted_at?: string;
  views?: number | null;
  upvotes?: number | null;
  comments?: number | null;
  stats_as_of?: string;
}

/** `partial` = PATCH (any subset, at least one); otherwise label, subreddit and posted_at are required. */
export function parseRedditInput(body: unknown, now: Date, partial: boolean): ParseResult<RedditInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail('Body must be an object');
  }
  const record = body as Record<string, unknown>;
  const extra = unknownFields(record, REDDIT_FIELDS);
  if (extra.length > 0) {
    return fail(`Unknown field: ${extra[0].slice(0, 40)}`);
  }
  const out: RedditInput = {};
  if (!partial || 'label' in record) {
    const label = readText(record.label, 'label', 200);
    if (!label.ok) return label;
    out.label = label.value;
  }
  if (!partial || 'subreddit' in record) {
    const raw = typeof record.subreddit === 'string' ? record.subreddit.trim() : '';
    const subreddit = raw.startsWith('r/') ? raw : `r/${raw}`;
    if (!SUBREDDIT.test(subreddit)) {
      return fail('subreddit must look like r/apps');
    }
    out.subreddit = subreddit;
  }
  if (!partial || 'posted_at' in record) {
    const posted = readTime(record.posted_at, 'posted_at', now);
    if (!posted.ok) return posted;
    out.posted_at = posted.value;
  }
  let statsChanged = false;
  for (const field of ['views', 'upvotes', 'comments'] as const) {
    if (field in record) {
      const count = readCount(record[field], field, field === 'upvotes');
      if (!count.ok) return count;
      out[field] = count.value;
      statsChanged = true;
    }
  }
  if (statsChanged) {
    out.stats_as_of = now.toISOString();
  }
  if (partial && Object.keys(out).length === 0) {
    return fail('Nothing to change');
  }
  return { ok: true, value: out };
}

export interface MilestoneInput {
  happened_at?: string;
  label?: string;
  kind?: LaunchMilestoneKind;
}

export function parseMilestoneInput(body: unknown, now: Date, partial: boolean): ParseResult<MilestoneInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail('Body must be an object');
  }
  const record = body as Record<string, unknown>;
  const extra = unknownFields(record, MILESTONE_FIELDS);
  if (extra.length > 0) {
    return fail(`Unknown field: ${extra[0].slice(0, 40)}`);
  }
  const out: MilestoneInput = {};
  if (!partial || 'happened_at' in record) {
    const when = readTime(record.happened_at, 'happened_at', now);
    if (!when.ok) return when;
    out.happened_at = when.value;
  }
  if (!partial || 'label' in record) {
    const label = readText(record.label, 'label', 200);
    if (!label.ok) return label;
    out.label = label.value;
  }
  if (!partial || 'kind' in record) {
    if (!MILESTONE_KINDS.includes(record.kind as LaunchMilestoneKind)) {
      return fail(`kind must be one of ${MILESTONE_KINDS.join(', ')}`);
    }
    out.kind = record.kind as LaunchMilestoneKind;
  }
  if (partial && Object.keys(out).length === 0) {
    return fail('Nothing to change');
  }
  return { ok: true, value: out };
}
