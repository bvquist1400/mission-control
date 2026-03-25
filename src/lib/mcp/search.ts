import type { SupabaseClient } from '@supabase/supabase-js';
import {
  decodeCalendarEventIdentity,
  encodeCalendarEventIdentity,
} from '../calendar-event-identity';

export interface MissionControlSearchResult {
  id: string;
  title: string;
  text: string;
  url: string;
  metadata?: Record<string, unknown>;
}

type SearchEntityKind =
  | 'task'
  | 'application'
  | 'project'
  | 'sprint'
  | 'stakeholder'
  | 'commitment'
  | 'email'
  | 'calendar';

interface SearchCandidate extends MissionControlSearchResult {
  score: number;
  updatedAt?: string | null;
}

const CALENDAR_INTENT_TERMS = new Set([
  'meeting',
  'meetings',
  'calendar',
  'calendars',
  'event',
  'events',
  'call',
  'calls',
  'appointment',
  'appointments',
]);

const CALENDAR_SEARCH_KEYWORDS = 'meeting meetings calendar calendars event events call calls appointment appointments';

function normalizeSearchText(value: string | null | undefined): string {
  return (value || '')
    .toLowerCase()
    .replace(/[%(),]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getSearchTerms(query: string): string[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return [];
  }

  const uniqueTerms = new Set<string>([normalizedQuery]);
  for (const term of normalizedQuery.split(' ')) {
    if (term.length >= 2) {
      uniqueTerms.add(term);
    }
  }

  return [...uniqueTerms].slice(0, 6);
}

function getSearchTermsExcluding(query: string, ignoredTerms: ReadonlySet<string>): string[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return [];
  }

  const filteredTokens = normalizedQuery
    .split(' ')
    .filter((term) => term.length >= 2 && !ignoredTerms.has(term));

  if (filteredTokens.length === 0) {
    return [];
  }

  const uniqueTerms = new Set<string>([filteredTokens.join(' ')]);
  for (const term of filteredTokens) {
    uniqueTerms.add(term);
  }

  return [...uniqueTerms].slice(0, 6);
}

function buildIlikeOrFilterFromTerms(columns: string[], terms: string[]): string {
  return terms
    .flatMap((term) => columns.map((column) => `${column}.ilike.%${term}%`))
    .join(',');
}

function buildIlikeOrFilter(columns: string[], query: string): string {
  return buildIlikeOrFilterFromTerms(columns, getSearchTerms(query));
}

function tokenizeFieldText(value: string | null | undefined): string[] {
  return normalizeSearchText(value)
    .split(/[^a-z0-9@._-]+/)
    .filter(Boolean);
}

function hasPrefixTokenMatch(value: string, term: string): boolean {
  return tokenizeFieldText(value).some((token) => token.startsWith(term));
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function truncateText(value: string | null | undefined, maxLength = 500): string {
  const normalized = (value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function joinText(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => (part || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function scoreText(query: string, fields: Array<string | null | undefined>, updatedAt?: string | null): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return 0;
  }

  const normalizedFields = fields
    .map((field) => normalizeSearchText(field))
    .filter(Boolean);

  if (normalizedFields.length === 0) {
    return 0;
  }

  let score = 0;
  for (const [index, normalizedField] of normalizedFields.entries()) {
    if (!normalizedField) {
      continue;
    }

    if (normalizedField === normalizedQuery) {
      score = Math.max(score, 180 - index * 12);
    } else if (normalizedField.startsWith(normalizedQuery)) {
      score = Math.max(score, 150 - index * 10);
    } else if (normalizedField.includes(normalizedQuery)) {
      score = Math.max(score, 120 - index * 8);
    }
  }

  const tokenTerms = getSearchTerms(query).filter((term) => term !== normalizedQuery);
  let matchedTerms = 0;

  for (const term of tokenTerms) {
    let termMatched = false;

    for (const [index, normalizedField] of normalizedFields.entries()) {
      if (!normalizedField.includes(term)) {
        continue;
      }

      score += hasPrefixTokenMatch(normalizedField, term)
        ? Math.max(10, 30 - index * 2)
        : Math.max(6, 18 - index * 2);
      termMatched = true;
      break;
    }

    if (termMatched) {
      matchedTerms += 1;
    }
  }

  if (tokenTerms.length > 1) {
    if (matchedTerms === tokenTerms.length) {
      score += 40;
    } else if (matchedTerms > 0) {
      score += matchedTerms * 6;
    }
  }

  if (updatedAt) {
    const timestamp = new Date(updatedAt).getTime();
    if (Number.isFinite(timestamp)) {
      const ageHours = Math.max(0, (Date.now() - timestamp) / (1000 * 60 * 60));
      score += Math.max(0, 20 - Math.floor(ageHours / 24));
    }
  }

  return score;
}

function buildCanonicalUrl(baseUrl: string, kind: SearchEntityKind, id: string): string {
  return `${trimTrailingSlash(baseUrl)}/r/${kind}/${encodeURIComponent(id)}`;
}

function readNestedName(value: unknown): string | null {
  if (!value) {
    return null;
  }

  if (Array.isArray(value)) {
    const first = value[0] as { name?: unknown } | undefined;
    return typeof first?.name === 'string' ? first.name : null;
  }

  const candidate = value as { name?: unknown };
  return typeof candidate.name === 'string' ? candidate.name : null;
}

function buildRecordId(entity: Exclude<SearchEntityKind, 'email' | 'calendar'>, id: string): string {
  return `record:${entity}:${id}`;
}

export function encodeCalendarSearchId(key: {
  source: 'local' | 'ical' | 'graph';
  externalEventId: string;
  startAt: string;
}): string {
  return encodeCalendarEventIdentity(key);
}

export function decodeCalendarSearchId(input: string): {
  source: 'local' | 'ical' | 'graph';
  externalEventId: string;
  startAt: string;
} | null {
  return decodeCalendarEventIdentity(input);
}

export function isMissionControlSearchResult(value: unknown): value is MissionControlSearchResult {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as MissionControlSearchResult;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.text === 'string' &&
    typeof candidate.url === 'string'
  );
}

async function searchTasks(
  supabase: SupabaseClient,
  userId: string,
  query: string,
  canonicalBaseUrl: string
): Promise<SearchCandidate[]> {
  const { data, error } = await supabase
    .from('tasks')
    .select('id, title, description, waiting_on, pinned_excerpt, status, due_at, updated_at')
    .eq('user_id', userId)
    .or(buildIlikeOrFilter(['title', 'description', 'waiting_on', 'pinned_excerpt'], query))
    .order('updated_at', { ascending: false })
    .limit(10);

  if (error) {
    throw error;
  }

  return (data || []).map((task) => ({
    id: buildRecordId('task', task.id),
    title: task.title,
    text: truncateText(joinText([task.description, task.waiting_on, task.pinned_excerpt])),
    url: buildCanonicalUrl(canonicalBaseUrl, 'task', task.id),
    metadata: {
      entity: 'task',
      status: task.status,
      due_at: task.due_at,
    },
    score: scoreText(query, [task.title, task.description, task.waiting_on, task.pinned_excerpt], task.updated_at),
    updatedAt: task.updated_at,
  }));
}

async function searchApplications(
  supabase: SupabaseClient,
  userId: string,
  query: string,
  canonicalBaseUrl: string
): Promise<SearchCandidate[]> {
  const { data, error } = await supabase
    .from('implementations')
    .select('id, name, status_summary, next_milestone, updated_at')
    .eq('user_id', userId)
    .or(buildIlikeOrFilter(['name', 'status_summary', 'next_milestone'], query))
    .order('updated_at', { ascending: false })
    .limit(10);

  if (error) throw error;

  return (data || []).map((item) => ({
    id: buildRecordId('application', item.id),
    title: item.name,
    text: truncateText(joinText([item.status_summary, item.next_milestone])),
    url: buildCanonicalUrl(canonicalBaseUrl, 'application', item.id),
    metadata: { entity: 'application' },
    score: scoreText(query, [item.name, item.status_summary, item.next_milestone], item.updated_at),
    updatedAt: item.updated_at,
  }));
}

async function searchProjects(
  supabase: SupabaseClient,
  userId: string,
  query: string,
  canonicalBaseUrl: string
): Promise<SearchCandidate[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, description, status_summary, updated_at')
    .eq('user_id', userId)
    .or(buildIlikeOrFilter(['name', 'description', 'status_summary'], query))
    .order('updated_at', { ascending: false })
    .limit(10);

  if (error) throw error;

  return (data || []).map((item) => ({
    id: buildRecordId('project', item.id),
    title: item.name,
    text: truncateText(joinText([item.description, item.status_summary])),
    url: buildCanonicalUrl(canonicalBaseUrl, 'project', item.id),
    metadata: { entity: 'project' },
    score: scoreText(query, [item.name, item.description, item.status_summary], item.updated_at),
    updatedAt: item.updated_at,
  }));
}

async function searchSprints(
  supabase: SupabaseClient,
  userId: string,
  query: string,
  canonicalBaseUrl: string
): Promise<SearchCandidate[]> {
  const { data, error } = await supabase
    .from('sprints')
    .select('id, name, theme, start_date, end_date, created_at')
    .eq('user_id', userId)
    .or(buildIlikeOrFilter(['name', 'theme'], query))
    .order('start_date', { ascending: false })
    .limit(10);

  if (error) throw error;

  return (data || []).map((item) => ({
    id: buildRecordId('sprint', item.id),
    title: item.name,
    text: truncateText(joinText([item.theme, `Sprint window: ${item.start_date} to ${item.end_date}`])),
    url: buildCanonicalUrl(canonicalBaseUrl, 'sprint', item.id),
    metadata: {
      entity: 'sprint',
      start_date: item.start_date,
      end_date: item.end_date,
    },
    score: scoreText(query, [item.name, item.theme], item.created_at),
    updatedAt: item.created_at,
  }));
}

async function searchStakeholders(
  supabase: SupabaseClient,
  userId: string,
  query: string,
  canonicalBaseUrl: string
): Promise<SearchCandidate[]> {
  const { data, error } = await supabase
    .from('stakeholders')
    .select('id, name, email, role, organization, notes, updated_at')
    .eq('user_id', userId)
    .or(buildIlikeOrFilter(['name', 'email', 'organization', 'notes'], query))
    .order('updated_at', { ascending: false })
    .limit(10);

  if (error) throw error;

  return (data || []).map((item) => ({
    id: buildRecordId('stakeholder', item.id),
    title: item.name,
    text: truncateText(joinText([item.role, item.organization, item.email, item.notes])),
    url: buildCanonicalUrl(canonicalBaseUrl, 'stakeholder', item.id),
    metadata: { entity: 'stakeholder' },
    score: scoreText(query, [item.name, item.email, item.organization, item.notes], item.updated_at),
    updatedAt: item.updated_at,
  }));
}

async function searchCommitments(
  supabase: SupabaseClient,
  userId: string,
  query: string,
  canonicalBaseUrl: string
): Promise<SearchCandidate[]> {
  const { data, error } = await supabase
    .from('commitments')
    .select('id, title, notes, status, due_at, updated_at, stakeholder_id, stakeholder:stakeholders(name)')
    .eq('user_id', userId)
    .or(buildIlikeOrFilter(['title', 'notes'], query))
    .order('updated_at', { ascending: false })
    .limit(10);

  if (error) throw error;

  return (data || []).map((item) => ({
    id: buildRecordId('commitment', item.id),
    title: item.title,
    text: truncateText(joinText([item.notes, readNestedName(item.stakeholder) ? `Stakeholder: ${readNestedName(item.stakeholder)}` : null])),
    url: buildCanonicalUrl(canonicalBaseUrl, 'commitment', item.id),
    metadata: {
      entity: 'commitment',
      status: item.status,
      due_at: item.due_at,
      stakeholder_id: item.stakeholder_id,
      stakeholder_name: readNestedName(item.stakeholder),
    },
    score: scoreText(query, [item.title, item.notes, readNestedName(item.stakeholder)], item.updated_at),
    updatedAt: item.updated_at,
  }));
}

async function searchEmails(
  supabase: SupabaseClient,
  userId: string,
  query: string,
  canonicalBaseUrl: string
): Promise<SearchCandidate[]> {
  const { data, error } = await supabase
    .from('inbox_items')
    .select('id, subject, from_name, from_email, source, source_url, created_at, received_at, llm_extraction_json')
    .eq('user_id', userId)
    .or(buildIlikeOrFilter(['subject', 'from_name', 'from_email'], query))
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) throw error;

  return (data || []).map((item) => ({
    id: `email:${item.id}`,
    title: item.subject,
    text: truncateText(
      joinText([
        item.from_name ? `From: ${item.from_name}` : null,
        item.from_email ? `Email: ${item.from_email}` : null,
        typeof item.llm_extraction_json === 'object' ? JSON.stringify(item.llm_extraction_json) : null,
      ])
    ),
    url: buildCanonicalUrl(canonicalBaseUrl, 'email', item.id),
    metadata: {
      entity: 'email',
      source: item.source,
      source_url: item.source_url,
      received_at: item.received_at,
    },
    score: scoreText(
      query,
      [
        item.subject,
        item.from_name,
        item.from_email,
        typeof item.llm_extraction_json === 'object' ? JSON.stringify(item.llm_extraction_json) : null,
      ],
      item.created_at
    ),
    updatedAt: item.created_at,
  }));
}

async function searchCalendar(
  supabase: SupabaseClient,
  userId: string,
  query: string,
  canonicalBaseUrl: string
): Promise<SearchCandidate[]> {
  const calendarTerms = getSearchTermsExcluding(query, CALENDAR_INTENT_TERMS);
  const searchAllRecentEvents = calendarTerms.length === 0;

  const [eventsResult, contextResult] = await Promise.all([
    searchAllRecentEvents
      ? supabase
          .from('calendar_events')
          .select('source, external_event_id, start_at, end_at, title, body_scrubbed_preview, updated_at')
          .eq('user_id', userId)
          .order('start_at', { ascending: false })
          .limit(10)
      : supabase
          .from('calendar_events')
          .select('source, external_event_id, start_at, end_at, title, body_scrubbed_preview, updated_at')
          .eq('user_id', userId)
          .or(buildIlikeOrFilterFromTerms(['title', 'body_scrubbed_preview'], calendarTerms))
          .order('start_at', { ascending: false })
          .limit(10),
    searchAllRecentEvents
      ? supabase
          .from('calendar_event_context')
          .select('source, external_event_id, meeting_context, updated_at')
          .eq('user_id', userId)
          .order('updated_at', { ascending: false })
          .limit(10)
      : supabase
          .from('calendar_event_context')
          .select('source, external_event_id, meeting_context, updated_at')
          .eq('user_id', userId)
          .or(buildIlikeOrFilterFromTerms(['meeting_context'], calendarTerms))
          .order('updated_at', { ascending: false })
          .limit(10),
  ]);

  if (eventsResult.error) throw eventsResult.error;
  if (contextResult.error) throw contextResult.error;

  const eventMap = new Map<string, SearchCandidate>();
  for (const event of eventsResult.data || []) {
    const encodedId = encodeCalendarSearchId({
      source: event.source,
      externalEventId: event.external_event_id,
      startAt: event.start_at,
    });
    eventMap.set(`${event.source}:${event.external_event_id}:${event.start_at}`, {
      id: `calendar:${encodedId}`,
      title: event.title,
      text: truncateText(joinText([event.body_scrubbed_preview])),
      url: buildCanonicalUrl(canonicalBaseUrl, 'calendar', encodedId),
      metadata: {
        entity: 'calendar',
        source: event.source,
        start_at: event.start_at,
        end_at: event.end_at,
      },
      score: scoreText(
        query,
        [event.title, event.body_scrubbed_preview, CALENDAR_SEARCH_KEYWORDS],
        event.updated_at ?? event.start_at
      ),
      updatedAt: event.updated_at ?? event.start_at,
    });
  }

  for (const contextRow of contextResult.data || []) {
    const { data: event } = await supabase
      .from('calendar_events')
      .select('source, external_event_id, start_at, end_at, title, body_scrubbed_preview, updated_at')
      .eq('user_id', userId)
      .eq('source', contextRow.source)
      .eq('external_event_id', contextRow.external_event_id)
      .order('start_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!event) {
      continue;
    }

    const key = `${event.source}:${event.external_event_id}:${event.start_at}`;
    const existing = eventMap.get(key);
    const encodedId = encodeCalendarSearchId({
      source: event.source,
      externalEventId: event.external_event_id,
      startAt: event.start_at,
    });
    const meetingContextText = truncateText(joinText([event.body_scrubbed_preview, contextRow.meeting_context]));
    const score = scoreText(
      query,
      [event.title, event.body_scrubbed_preview, contextRow.meeting_context, CALENDAR_SEARCH_KEYWORDS],
      contextRow.updated_at ?? event.updated_at ?? event.start_at
    );

    eventMap.set(key, {
      id: `calendar:${encodedId}`,
      title: event.title,
      text: meetingContextText,
      url: buildCanonicalUrl(canonicalBaseUrl, 'calendar', encodedId),
      metadata: {
        entity: 'calendar',
        source: event.source,
        start_at: event.start_at,
        end_at: event.end_at,
      },
      score: existing ? Math.max(existing.score, score) : score,
      updatedAt: contextRow.updated_at ?? event.updated_at ?? event.start_at,
    });
  }

  return [...eventMap.values()];
}

export async function searchMissionControlData(
  supabase: SupabaseClient,
  userId: string,
  query: string,
  canonicalBaseUrl: string
): Promise<MissionControlSearchResult[]> {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return [];
  }

  const results = await Promise.all([
    searchTasks(supabase, userId, normalizedQuery, canonicalBaseUrl),
    searchApplications(supabase, userId, normalizedQuery, canonicalBaseUrl),
    searchProjects(supabase, userId, normalizedQuery, canonicalBaseUrl),
    searchSprints(supabase, userId, normalizedQuery, canonicalBaseUrl),
    searchStakeholders(supabase, userId, normalizedQuery, canonicalBaseUrl),
    searchCommitments(supabase, userId, normalizedQuery, canonicalBaseUrl),
    searchEmails(supabase, userId, normalizedQuery, canonicalBaseUrl),
    searchCalendar(supabase, userId, normalizedQuery, canonicalBaseUrl),
  ]);

  return results
    .flat()
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      const leftTime = left.updatedAt ? new Date(left.updatedAt).getTime() : 0;
      const rightTime = right.updatedAt ? new Date(right.updatedAt).getTime() : 0;
      return rightTime - leftTime;
    })
    .slice(0, 10)
    .map((item) => ({
      id: item.id,
      title: item.title,
      text: item.text,
      url: item.url,
      metadata: item.metadata,
    }));
}

async function fetchTask(
  supabase: SupabaseClient,
  userId: string,
  id: string,
  canonicalBaseUrl: string
): Promise<MissionControlSearchResult | null> {
  const { data } = await supabase
    .from('tasks')
    .select('id, title, description, waiting_on, pinned_excerpt, status, due_at')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (!data) return null;

  return {
    id: buildRecordId('task', data.id),
    title: data.title,
    text: joinText([
      data.description,
      data.waiting_on ? `Waiting on: ${data.waiting_on}` : null,
      data.pinned_excerpt ? `Pinned excerpt: ${data.pinned_excerpt}` : null,
    ]),
    url: buildCanonicalUrl(canonicalBaseUrl, 'task', data.id),
    metadata: {
      entity: 'task',
      status: data.status,
      due_at: data.due_at,
    },
  };
}

async function fetchApplication(
  supabase: SupabaseClient,
  userId: string,
  id: string,
  canonicalBaseUrl: string
): Promise<MissionControlSearchResult | null> {
  const { data } = await supabase
    .from('implementations')
    .select('id, name, status_summary, next_milestone, next_milestone_date, phase, rag')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (!data) return null;

  return {
    id: buildRecordId('application', data.id),
    title: data.name,
    text: joinText([
      data.status_summary,
      data.next_milestone ? `Next milestone: ${data.next_milestone}` : null,
      data.next_milestone_date ? `Target date: ${data.next_milestone_date}` : null,
    ]),
    url: buildCanonicalUrl(canonicalBaseUrl, 'application', data.id),
    metadata: {
      entity: 'application',
      phase: data.phase,
      rag: data.rag,
    },
  };
}

async function fetchProject(
  supabase: SupabaseClient,
  userId: string,
  id: string,
  canonicalBaseUrl: string
): Promise<MissionControlSearchResult | null> {
  const { data } = await supabase
    .from('projects')
    .select('id, name, description, status_summary, stage, rag, target_date')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (!data) return null;

  return {
    id: buildRecordId('project', data.id),
    title: data.name,
    text: joinText([
      data.description,
      data.status_summary,
      data.target_date ? `Target date: ${data.target_date}` : null,
    ]),
    url: buildCanonicalUrl(canonicalBaseUrl, 'project', data.id),
    metadata: {
      entity: 'project',
      stage: data.stage,
      rag: data.rag,
    },
  };
}

async function fetchSprint(
  supabase: SupabaseClient,
  userId: string,
  id: string,
  canonicalBaseUrl: string
): Promise<MissionControlSearchResult | null> {
  const { data } = await supabase
    .from('sprints')
    .select('id, name, theme, start_date, end_date')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (!data) return null;

  return {
    id: buildRecordId('sprint', data.id),
    title: data.name,
    text: joinText([
      data.theme,
      `Sprint window: ${data.start_date} to ${data.end_date}`,
    ]),
    url: buildCanonicalUrl(canonicalBaseUrl, 'sprint', data.id),
    metadata: {
      entity: 'sprint',
      start_date: data.start_date,
      end_date: data.end_date,
    },
  };
}

async function fetchStakeholder(
  supabase: SupabaseClient,
  userId: string,
  id: string,
  canonicalBaseUrl: string
): Promise<MissionControlSearchResult | null> {
  const { data } = await supabase
    .from('stakeholders')
    .select('id, name, email, role, organization, notes, context')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (!data) return null;

  return {
    id: buildRecordId('stakeholder', data.id),
    title: data.name,
    text: joinText([
      data.role ? `Role: ${data.role}` : null,
      data.organization ? `Organization: ${data.organization}` : null,
      data.email ? `Email: ${data.email}` : null,
      data.notes,
      typeof data.context === 'object' ? JSON.stringify(data.context) : null,
    ]),
    url: buildCanonicalUrl(canonicalBaseUrl, 'stakeholder', data.id),
    metadata: { entity: 'stakeholder' },
  };
}

async function fetchCommitment(
  supabase: SupabaseClient,
  userId: string,
  id: string,
  canonicalBaseUrl: string
): Promise<MissionControlSearchResult | null> {
  const { data } = await supabase
    .from('commitments')
    .select('id, title, notes, status, due_at, direction, stakeholder:stakeholders(id, name)')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (!data) return null;

  return {
    id: buildRecordId('commitment', data.id),
    title: data.title,
    text: joinText([
      data.notes,
      readNestedName(data.stakeholder) ? `Stakeholder: ${readNestedName(data.stakeholder)}` : null,
      data.direction ? `Direction: ${data.direction}` : null,
    ]),
    url: buildCanonicalUrl(canonicalBaseUrl, 'commitment', data.id),
    metadata: {
      entity: 'commitment',
      status: data.status,
      due_at: data.due_at,
    },
  };
}

async function fetchEmail(
  supabase: SupabaseClient,
  userId: string,
  id: string,
  canonicalBaseUrl: string
): Promise<MissionControlSearchResult | null> {
  const { data } = await supabase
    .from('inbox_items')
    .select('id, subject, from_name, from_email, source, source_url, llm_extraction_json, triage_state, received_at')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (!data) return null;

  return {
    id: `email:${data.id}`,
    title: data.subject,
    text: joinText([
      data.from_name ? `From: ${data.from_name}` : null,
      data.from_email ? `Email: ${data.from_email}` : null,
      data.received_at ? `Received: ${data.received_at}` : null,
      data.triage_state ? `Triage state: ${data.triage_state}` : null,
      typeof data.llm_extraction_json === 'object' ? JSON.stringify(data.llm_extraction_json, null, 2) : null,
    ]),
    url: buildCanonicalUrl(canonicalBaseUrl, 'email', data.id),
    metadata: {
      entity: 'email',
      source: data.source,
      source_url: data.source_url,
    },
  };
}

async function fetchCalendar(
  supabase: SupabaseClient,
  userId: string,
  encodedId: string,
  canonicalBaseUrl: string
): Promise<MissionControlSearchResult | null> {
  const decoded = decodeCalendarSearchId(encodedId);
  if (!decoded) {
    return null;
  }

  const { data: event } = await supabase
    .from('calendar_events')
    .select('source, external_event_id, start_at, end_at, title, body_scrubbed_preview')
    .eq('user_id', userId)
    .eq('source', decoded.source)
    .eq('external_event_id', decoded.externalEventId)
    .eq('start_at', decoded.startAt)
    .maybeSingle();

  if (!event) {
    return null;
  }

  const { data: context } = await supabase
    .from('calendar_event_context')
    .select('meeting_context')
    .eq('user_id', userId)
    .eq('source', decoded.source)
    .eq('external_event_id', decoded.externalEventId)
    .maybeSingle();

  return {
    id: `calendar:${encodedId}`,
    title: event.title,
    text: joinText([
      event.body_scrubbed_preview,
      context?.meeting_context ? `Meeting context: ${context.meeting_context}` : null,
    ]),
    url: buildCanonicalUrl(canonicalBaseUrl, 'calendar', encodedId),
    metadata: {
      entity: 'calendar',
      source: event.source,
      start_at: event.start_at,
      end_at: event.end_at,
    },
  };
}

export async function fetchMissionControlItemById(
  supabase: SupabaseClient,
  userId: string,
  typedId: string,
  canonicalBaseUrl: string
): Promise<MissionControlSearchResult | null> {
  if (typedId.startsWith('record:')) {
    const [, entity, id] = typedId.split(':');
    if (!entity || !id) {
      return null;
    }

    switch (entity) {
      case 'task':
        return fetchTask(supabase, userId, id, canonicalBaseUrl);
      case 'application':
        return fetchApplication(supabase, userId, id, canonicalBaseUrl);
      case 'project':
        return fetchProject(supabase, userId, id, canonicalBaseUrl);
      case 'sprint':
        return fetchSprint(supabase, userId, id, canonicalBaseUrl);
      case 'stakeholder':
        return fetchStakeholder(supabase, userId, id, canonicalBaseUrl);
      case 'commitment':
        return fetchCommitment(supabase, userId, id, canonicalBaseUrl);
      default:
        return null;
    }
  }

  if (typedId.startsWith('email:')) {
    return fetchEmail(supabase, userId, typedId.slice('email:'.length), canonicalBaseUrl);
  }

  if (typedId.startsWith('calendar:')) {
    return fetchCalendar(supabase, userId, typedId.slice('calendar:'.length), canonicalBaseUrl);
  }

  return null;
}

export function mapRouteKindToTypedId(kind: string, id: string): string | null {
  switch (kind) {
    case 'task':
    case 'application':
    case 'project':
    case 'sprint':
    case 'stakeholder':
    case 'commitment':
      return buildRecordId(kind, id);
    case 'email':
      return `email:${id}`;
    case 'calendar':
      return `calendar:${id}`;
    default:
      return null;
  }
}
