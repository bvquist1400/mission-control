import type { MissionControlSearchResult } from '@/lib/mcp/search';

export type BrowserSearchEntity =
  | 'task'
  | 'application'
  | 'project'
  | 'sprint'
  | 'stakeholder'
  | 'commitment'
  | 'email'
  | 'calendar';

export interface BrowserSearchResult {
  id: string;
  recordId: string | null;
  title: string;
  text: string;
  href: string;
  entity: BrowserSearchEntity;
  entityLabel: string;
  context: string | null;
}

const ENTITY_LABELS: Record<BrowserSearchEntity, string> = {
  task: 'Task',
  application: 'Application',
  project: 'Project',
  sprint: 'Sprint',
  stakeholder: 'Stakeholder',
  commitment: 'Commitment',
  email: 'Email',
  calendar: 'Meeting',
};

const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

const SHORT_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseRecordId(typedId: string): { entity: BrowserSearchEntity; rawId: string } | null {
  if (!typedId.startsWith('record:')) {
    return null;
  }

  const [, entity, rawId] = typedId.split(':');
  if (!entity || !rawId) {
    return null;
  }

  switch (entity) {
    case 'task':
    case 'application':
    case 'project':
    case 'sprint':
    case 'stakeholder':
    case 'commitment':
      return { entity, rawId };
    default:
      return null;
  }
}

function parseCalendarId(typedId: string): string | null {
  if (!typedId.startsWith('calendar:')) {
    return null;
  }

  const rawId = typedId.slice('calendar:'.length).trim();
  return rawId.length > 0 ? rawId : null;
}

function inferEntity(result: MissionControlSearchResult): BrowserSearchEntity {
  const metadataEntity = readString(result.metadata?.entity);
  if (
    metadataEntity === 'task' ||
    metadataEntity === 'application' ||
    metadataEntity === 'project' ||
    metadataEntity === 'sprint' ||
    metadataEntity === 'stakeholder' ||
    metadataEntity === 'commitment' ||
    metadataEntity === 'email' ||
    metadataEntity === 'calendar'
  ) {
    return metadataEntity;
  }

  const recordId = parseRecordId(result.id);
  if (recordId) {
    return recordId.entity;
  }

  if (result.id.startsWith('email:')) {
    return 'email';
  }

  return 'calendar';
}

function toRelativeHref(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

function formatShortDate(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : SHORT_DATE_FORMATTER.format(timestamp);
}

function formatShortDateTime(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : SHORT_DATE_TIME_FORMATTER.format(timestamp);
}

function buildTaskHref(result: MissionControlSearchResult, rawId: string | null): string {
  const status = readString(result.metadata?.status);
  if (!rawId || status === 'Done' || status === 'Parked') {
    return toRelativeHref(result.url);
  }

  return `/backlog?expand=${encodeURIComponent(rawId)}`;
}

function buildBrowserHref(result: MissionControlSearchResult, entity: BrowserSearchEntity): string {
  const recordId = parseRecordId(result.id);

  switch (entity) {
    case 'task':
      return buildTaskHref(result, recordId?.rawId ?? null);
    case 'application':
      return recordId ? `/applications/${encodeURIComponent(recordId.rawId)}` : toRelativeHref(result.url);
    case 'project':
      return recordId ? `/projects/${encodeURIComponent(recordId.rawId)}` : toRelativeHref(result.url);
    case 'sprint':
      return recordId ? `/sprints/${encodeURIComponent(recordId.rawId)}` : toRelativeHref(result.url);
    case 'stakeholder':
      return recordId ? `/stakeholders/${encodeURIComponent(recordId.rawId)}` : toRelativeHref(result.url);
    case 'commitment':
      return toRelativeHref(result.url);
    case 'email':
      return toRelativeHref(result.url);
    case 'calendar': {
      const calendarId = parseCalendarId(result.id);
      return calendarId ? `/calendar/events/${encodeURIComponent(calendarId)}` : toRelativeHref(result.url);
    }
  }
}

function buildContext(result: MissionControlSearchResult, entity: BrowserSearchEntity): string | null {
  const status = readString(result.metadata?.status);
  const dueAt = formatShortDate(readString(result.metadata?.due_at));
  const stakeholderName = readString(result.metadata?.stakeholder_name);
  const receivedAt = formatShortDateTime(readString(result.metadata?.received_at));
  const startAt = formatShortDateTime(readString(result.metadata?.start_at));
  const endAt = formatShortDateTime(readString(result.metadata?.end_at));
  const source = readString(result.metadata?.source);
  const sprintStart = formatShortDate(readString(result.metadata?.start_date));
  const sprintEnd = formatShortDate(readString(result.metadata?.end_date));

  const parts: string[] = [];

  switch (entity) {
    case 'task':
      if (status) parts.push(status);
      if (dueAt) parts.push(`Due ${dueAt}`);
      break;
    case 'sprint':
      if (sprintStart && sprintEnd) {
        parts.push(`${sprintStart} to ${sprintEnd}`);
      }
      break;
    case 'commitment':
      if (status) parts.push(status);
      if (stakeholderName) parts.push(stakeholderName);
      if (dueAt) parts.push(`Due ${dueAt}`);
      break;
    case 'email':
      if (source) parts.push(source);
      if (receivedAt) parts.push(receivedAt);
      break;
    case 'calendar':
      if (startAt && endAt) {
        parts.push(`${startAt} to ${endAt}`);
      } else if (startAt) {
        parts.push(startAt);
      }
      if (source) parts.push(source);
      break;
    default:
      break;
  }

  return parts.length > 0 ? parts.join(' • ') : null;
}

export function toBrowserSearchResult(result: MissionControlSearchResult): BrowserSearchResult {
  const entity = inferEntity(result);
  const recordId = parseRecordId(result.id);

  return {
    id: result.id,
    recordId: recordId?.rawId ?? null,
    title: result.title,
    text: result.text,
    href: buildBrowserHref(result, entity),
    entity,
    entityLabel: ENTITY_LABELS[entity],
    context: buildContext(result, entity),
  };
}
