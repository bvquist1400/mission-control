export interface CalendarEvent {
  id: string;
  title: string;
  start_at: string | null;
  end_at: string | null;
  location: string | null;
  start_raw: string | null;
  end_raw: string | null;
  source_tag: string;
}

export interface CalendarSharingLinks {
  ical_url: string | null;
  browse_url: string | null;
}

const EVENT_CONTAINER_TAGS = ["event", "appointment", "entry", "item", "row", "vevent", "calendaritem", "meeting"];
const TITLE_TAGS = ["summary", "subject", "title", "name"];
const START_TAGS = ["dtstart", "start", "starttime", "start_date", "begin", "from", "startdate"];
const END_TAGS = ["dtend", "end", "endtime", "end_date", "to", "enddate"];
const LOCATION_TAGS = ["location", "where", "room"];

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(value: string): string {
  return decodeXmlEntities(value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim());
}

function findFirstTagText(block: string, tags: string[]): string | null {
  for (const tag of tags) {
    const matcher = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
    const match = block.match(matcher);
    if (match?.[1]) {
      const cleaned = stripTags(match[1]);
      if (cleaned) {
        return cleaned;
      }
    }
  }

  return null;
}

function extractBlocks(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const blocks: string[] = [];
  let match: RegExpExecArray | null;

  match = regex.exec(xml);
  while (match) {
    blocks.push(match[0]);
    match = regex.exec(xml);
  }

  return blocks;
}

function findAnyTagText(source: string, tags: string[]): string | null {
  for (const tag of tags) {
    const matcher = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
    const match = source.match(matcher);
    if (match?.[1]) {
      const cleaned = stripTags(match[1]);
      if (cleaned) {
        return cleaned;
      }
    }
  }

  return null;
}

function normalizeDateTime(raw: string | null): string | null {
  if (!raw) {
    return null;
  }

  const value = raw.trim();
  if (!value) {
    return null;
  }

  // Common compact form: YYYYMMDDTHHMMSSZ
  if (/^\d{8}T\d{6}Z$/i.test(value)) {
    const parsed = Date.parse(
      `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`
    );
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }

  // Common compact form: YYYYMMDDTHHMMSS
  if (/^\d{8}T\d{6}$/i.test(value)) {
    const parsed = Date.parse(
      `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}`
    );
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }

  // Date-only form: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = Date.parse(`${value}T00:00:00`);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

function normalizeIcsDateTime(raw: string | null): string | null {
  if (!raw) {
    return null;
  }

  const value = raw.trim();
  if (!value) {
    return null;
  }

  // YYYYMMDD
  if (/^\d{8}$/.test(value)) {
    const parsed = Date.parse(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00`);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }

  // YYYYMMDDTHHMMSSZ
  if (/^\d{8}T\d{6}Z$/i.test(value)) {
    const parsed = Date.parse(
      `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`
    );
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }

  // YYYYMMDDTHHMMSS
  if (/^\d{8}T\d{6}$/i.test(value)) {
    const parsed = Date.parse(
      `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}`
    );
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function parseCalendarXml(xml: string): CalendarEvent[] {
  for (const containerTag of EVENT_CONTAINER_TAGS) {
    const blocks = extractBlocks(xml, containerTag);
    if (blocks.length === 0) {
      continue;
    }

    const events = blocks
      .map((block, index) => {
        const title = findFirstTagText(block, TITLE_TAGS) ?? `Untitled Event ${index + 1}`;
        const startRaw = findFirstTagText(block, START_TAGS);
        const endRaw = findFirstTagText(block, END_TAGS);
        const location = findFirstTagText(block, LOCATION_TAGS);

        const startAt = normalizeDateTime(startRaw);
        const endAt = normalizeDateTime(endRaw);

        return {
          id: `${containerTag}-${index}-${title}-${startRaw ?? "no-start"}`,
          title,
          start_at: startAt,
          end_at: endAt,
          location,
          start_raw: startRaw,
          end_raw: endRaw,
          source_tag: containerTag,
        } satisfies CalendarEvent;
      })
      .filter((event) => event.title || event.start_at || event.start_raw);

    return events.sort((a, b) => {
      const aTime = a.start_at ? Date.parse(a.start_at) : Number.POSITIVE_INFINITY;
      const bTime = b.start_at ? Date.parse(b.start_at) : Number.POSITIVE_INFINITY;
      return aTime - bTime;
    });
  }

  return [];
}

function findIcsField(block: string, name: string): string | null {
  const matcher = new RegExp(`^${name}(?:;[^:\\r\\n]+)?:([^\\r\\n]+)$`, "mi");
  const match = block.match(matcher);
  return match?.[1]?.trim() ?? null;
}

export function parseIcsEvents(ics: string): CalendarEvent[] {
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");
  const eventRegex = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/g;
  const events: CalendarEvent[] = [];
  let match: RegExpExecArray | null;
  let index = 0;

  match = eventRegex.exec(unfolded);
  while (match) {
    const block = match[1];
    const title = findIcsField(block, "SUMMARY") ?? `Untitled Event ${index + 1}`;
    const startRaw = findIcsField(block, "DTSTART");
    const endRaw = findIcsField(block, "DTEND");
    const location = findIcsField(block, "LOCATION");
    const uid = findIcsField(block, "UID");

    events.push({
      id: uid ?? `vevent-${index}-${title}-${startRaw ?? "no-start"}`,
      title,
      start_at: normalizeIcsDateTime(startRaw),
      end_at: normalizeIcsDateTime(endRaw),
      location,
      start_raw: startRaw,
      end_raw: endRaw,
      source_tag: "vevent",
    });

    index += 1;
    match = eventRegex.exec(unfolded);
  }

  return events.sort((a, b) => {
    const aTime = a.start_at ? Date.parse(a.start_at) : Number.POSITIVE_INFINITY;
    const bTime = b.start_at ? Date.parse(b.start_at) : Number.POSITIVE_INFINITY;
    return aTime - bTime;
  });
}

export function extractSharingLinks(xml: string): CalendarSharingLinks {
  const icalUrl = findAnyTagText(xml, ["ICalUrl", "icalurl", "ical_url"]);
  const browseUrl = findAnyTagText(xml, ["BrowseUrl", "browseurl", "browse_url"]);

  return {
    ical_url: icalUrl,
    browse_url: browseUrl,
  };
}

export function filterUpcomingEvents(events: CalendarEvent[], daysAhead: number): CalendarEvent[] {
  const now = Date.now();
  const cutoff = now + daysAhead * 24 * 60 * 60 * 1000;

  return events.filter((event) => {
    if (!event.start_at) {
      return false;
    }
    const start = Date.parse(event.start_at);
    if (Number.isNaN(start)) {
      return false;
    }
    return start >= now && start <= cutoff;
  });
}
