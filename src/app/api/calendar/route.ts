import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractSharingLinks, filterUpcomingEvents, parseCalendarXml, parseIcsEvents } from "@/lib/calendar";

const CALENDAR_RELATIVE_PATH = "data/calendar/work-calendar.xml";

export async function GET(request: NextRequest) {
  try {
    const filePath = path.join(process.cwd(), CALENDAR_RELATIVE_PATH);
    const { searchParams } = new URL(request.url);
    const daysAhead = Math.max(1, Math.min(90, Number.parseInt(searchParams.get("days") ?? "14", 10)));
    const includeAll = searchParams.get("all") === "true";

    let xml: string;
    try {
      xml = await readFile(filePath, "utf8");
    } catch {
      return NextResponse.json(
        {
          events: [],
          source_path: CALENDAR_RELATIVE_PATH,
          missing_file: true,
          message: `Calendar XML not found at ${CALENDAR_RELATIVE_PATH}.`,
        },
        { status: 200 }
      );
    }

    const parsedEvents = parseCalendarXml(xml);
    const sharingLinks = extractSharingLinks(xml);

    let source = "xml";
    let events = parsedEvents;
    let warning: string | null = null;

    if (events.length === 0 && sharingLinks.ical_url) {
      try {
        const icsResponse = await fetch(sharingLinks.ical_url, { cache: "no-store" });
        if (!icsResponse.ok) {
          throw new Error(`ICal fetch failed with status ${icsResponse.status}`);
        }

        const icsText = await icsResponse.text();
        events = parseIcsEvents(icsText);
        source = "ics";
      } catch {
        warning = "Unable to fetch calendar feed from ICalUrl in the sharing XML.";
      }
    }

    const filteredEvents = includeAll ? events : filterUpcomingEvents(events, daysAhead);

    return NextResponse.json({
      events: filteredEvents,
      source_path: CALENDAR_RELATIVE_PATH,
      total_events: events.length,
      displayed_events: filteredEvents.length,
      filtered_days_ahead: includeAll ? null : daysAhead,
      source,
      ical_url: sharingLinks.ical_url,
      browse_url: sharingLinks.browse_url,
      warning,
      missing_file: false,
    });
  } catch (error) {
    console.error("Error loading calendar XML:", error);
    return NextResponse.json({ error: "Failed to load calendar data" }, { status: 500 });
  }
}
