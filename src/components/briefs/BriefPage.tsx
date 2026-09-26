"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import {
  BRIEF_SECTIONS,
  CARD_REGISTRY,
  TaskLink,
  type ActRequest,
  type BriefCardContext,
  type DismissDraft,
} from "@/components/briefs/cards";
import { DayTile, HeroTile, NextTile, RecapBento, Sheet, TILE_REGISTRY } from "@/components/briefs/tiles";
import { dateHeading } from "@/components/briefs/format";
import type { BriefCounts, BriefItemRow, BriefMeetingRef, BriefTile, BriefView } from "@/lib/briefs/types";

type Override = { baseUpdatedAt: string; patch: Partial<BriefItemRow> };

interface ActResult {
  n: number;
  ok: boolean;
  state?: BriefItemRow["state"];
  task_id?: string;
  choice?: string;
  error?: string;
  conflict?: boolean;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);
}

function countOpen(items: BriefItemRow[]): BriefCounts {
  const open = items.filter((item) => item.state === "open");
  const fromMeetings = open.filter((item) => CARD_REGISTRY[item.kind].section === "meetings").length;
  return { total: items.length, open: open.length, from_meetings: fromMeetings, calls: open.length - fromMeetings };
}

export function BriefPage({ view }: { view: BriefView }) {
  const router = useRouter();
  const { toast } = useToast();
  const { brief, tasks } = view;
  const content = brief.content;

  const [filter, setFilter] = useState<string | null>(null);
  const [focusN, setFocusN] = useState<number | null>(null);
  const [sheetKey, setSheetKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<number, DismissDraft>>({});
  const [sources, setSources] = useState<Record<number, boolean>>({});
  const [pending, setPending] = useState<Record<number, boolean>>({});
  const [overrides, setOverrides] = useState<Record<number, Override>>({});

  // Show an action's result immediately; once router.refresh() brings the
  // server's row (a newer updated_at), the server copy wins.
  const items = useMemo(
    () =>
      view.items.map((item) => {
        const override = overrides[item.n];
        return override && override.baseUpdatedAt === item.updated_at ? { ...item, ...override.patch } : item;
      }),
    [view.items, overrides]
  );
  const counts = useMemo(() => countOpen(items), [items]);

  // One colour per meeting, in timeline order, then any meeting only an item cites.
  const meetingOrder = useMemo(() => {
    const ids: string[] = [];
    for (const meeting of content.meetings ?? []) if (meeting.id && !ids.includes(meeting.id)) ids.push(meeting.id);
    for (const item of items) for (const meeting of item.source.meetings) if (!ids.includes(meeting.id)) ids.push(meeting.id);
    return ids;
  }, [content.meetings, items]);
  const meetingColor = useCallback(
    (meetingId: string) => `var(--m-${(Math.max(0, meetingOrder.indexOf(meetingId)) % 6) + 1})`,
    [meetingOrder]
  );
  const meetingLabel = useCallback(
    (ref: BriefMeetingRef) => content.meetings?.find((meeting) => meeting.id === ref.id)?.short ?? ref.title,
    [content.meetings]
  );

  const openCounts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const item of items) {
      if (item.state !== "open") continue;
      for (const id of new Set(item.source.meetings.map((meeting) => meeting.id))) result[id] = (result[id] ?? 0) + 1;
    }
    return result;
  }, [items]);

  const meetingItems = items.filter(
    (item) =>
      CARD_REGISTRY[item.kind].section === "meetings" &&
      (!filter || item.source.meetings.some((meeting) => meeting.id === filter))
  );
  const callItems = filter ? [] : items.filter((item) => CARD_REGISTRY[item.kind].section === "calls");
  const groups = [...new Set(meetingItems.map((item) => item.payload.group ?? ""))];

  // J/K walk the open, visible items in page order.
  const navigable = [...meetingItems, ...callItems].filter((item) => item.state === "open").map((item) => item.n);

  const act = useCallback(
    async (request: ActRequest) => {
      const item = view.items.find((entry) => entry.n === request.n);
      if (!item) return;
      setPending((current) => ({ ...current, [request.n]: true }));
      try {
        const response = await fetch(`/api/briefs/${encodeURIComponent(brief.code)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actions: [request] }),
        });
        const body = (await response.json().catch(() => null)) as { results?: ActResult[]; error?: string } | null;
        const result = body?.results?.[0];
        if (!response.ok || !result || !result.ok) {
          toast({ message: result?.error ?? body?.error ?? "That didn't save. Try again.", tone: "danger" });
          // Lost a race (e.g. accepted in Claude meanwhile): show what actually happened.
          if (result?.conflict) router.refresh();
          return;
        }

        const patch: Partial<BriefItemRow> = { state: result.state ?? item.state, acted_at: new Date().toISOString() };
        if (result.task_id) patch.created_task_id = result.task_id;
        if (request.action === "pick") patch.choice = result.choice ?? request.choice ?? null;
        if (request.action === "dismiss") {
          patch.dismissed_reason = request.reason ?? null;
          patch.dismissed_note = request.note ?? null;
        }
        if (request.action === "undo") Object.assign(patch, { dismissed_reason: null, dismissed_note: null, choice: null });
        setOverrides((current) => ({ ...current, [request.n]: { baseUpdatedAt: item.updated_at, patch } }));
        setDrafts((current) => {
          const next = { ...current };
          delete next[request.n];
          return next;
        });
        router.refresh();
      } catch {
        toast({ message: "Couldn't reach Baseline. Nothing changed.", tone: "danger" });
      } finally {
        setPending((current) => ({ ...current, [request.n]: false }));
      }
    },
    [brief.code, router, toast, view.items]
  );

  const focusItem = useCallback((n: number) => {
    setFocusN(n);
    requestAnimationFrame(() => document.getElementById(`item-${n}`)?.focus({ preventScroll: false }));
  }, []);

  const startDismiss = useCallback((n: number) => {
    setDrafts((current) => ({ ...current, [n]: current[n] ?? { reason: null, note: "" } }));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (sheetKey || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "j" || key === "k") {
        if (!navigable.length) return;
        const index = focusN === null ? -1 : navigable.indexOf(focusN);
        const nextIndex = index < 0 ? 0 : Math.max(0, Math.min(navigable.length - 1, index + (key === "j" ? 1 : -1)));
        event.preventDefault();
        focusItem(navigable[nextIndex]);
        return;
      }
      if (focusN === null) return;
      const item = items.find((entry) => entry.n === focusN);
      if (!item || item.state !== "open" || CARD_REGISTRY[item.kind].keyboard !== "decide" || pending[item.n]) return;
      if (key === "a") {
        event.preventDefault();
        void act({ n: item.n, action: "accept" });
      } else if (key === "d") {
        event.preventDefault();
        startDismiss(item.n);
      } else if (key === "s") {
        event.preventDefault();
        setSources((current) => ({ ...current, [item.n]: !current[item.n] }));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [act, focusItem, focusN, items, navigable, pending, sheetKey, startDismiss]);

  const closeSheet = useCallback(() => setSheetKey(null), []);
  const toggleFilter = useCallback((meetingId: string) => setFilter((current) => (current === meetingId ? null : meetingId)), []);

  const cardContext = (item: BriefItemRow): BriefCardContext => ({
    tasks,
    meetingColor,
    meetingLabel,
    pending: Boolean(pending[item.n]),
    focused: focusN === item.n,
    draft: drafts[item.n] ?? null,
    showSource: Boolean(sources[item.n]),
    act: (request) => void act(request),
    startDismiss: () => startDismiss(item.n),
    cancelDismiss: () =>
      setDrafts((current) => {
        const next = { ...current };
        delete next[item.n];
        return next;
      }),
    setDraft: (draft) => setDrafts((current) => ({ ...current, [item.n]: draft })),
    toggleSource: () => setSources((current) => ({ ...current, [item.n]: !current[item.n] })),
    focus: () => setFocusN(item.n),
    openSheet: setSheetKey,
  });

  const renderItem = (item: BriefItemRow) => {
    const { Card } = CARD_REGISTRY[item.kind];
    return <Card key={item.id} item={item} ctx={cardContext(item)} />;
  };

  // Recap tiles are data. A brief without a narrative tile still shows its narrative.
  const recapTiles: BriefTile[] = useMemo(() => {
    const tiles = content.tiles ?? [];
    if (content.narrative && !tiles.some((tile) => tile.type === "narrative")) {
      return [
        {
          key: "summary",
          type: "narrative",
          label: "Summary",
          text: content.narrative,
          ...(content.first_moves?.length ? { list: content.first_moves, list_label: "First moves" } : {}),
        },
        ...tiles,
      ];
    }
    return tiles;
  }, [content.first_moves, content.narrative, content.tiles]);

  const heading = content.heading ?? dateHeading(brief.brief_date);
  const openMeetings = meetingItems.filter((item) => item.state === "open").length;
  const openCalls = callItems.filter((item) => item.state === "open").length;

  let sheet: { eyebrow: string; title: string; body: React.ReactNode } | null = null;
  if (sheetKey === "next" && content.next) {
    sheet = {
      eyebrow: content.next.label,
      title: "First moves",
      body: (
        <>
          {content.first_moves?.length ? (
            <ol className="moves">
              {content.first_moves.map((move, index) => (
                <li key={index}>{move}</li>
              ))}
            </ol>
          ) : null}
          {content.next.agenda.length ? (
            <>
              <p className="subh">On the calendar</p>
              <ul className="rows">
                {content.next.agenda.map((line, index) => (
                  <li key={index}>
                    <div className="r">
                      <span>{line.title}</span>
                      <span className="idlink">{line.time}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ),
    };
  } else if (sheetKey?.startsWith("tile:")) {
    const tile = recapTiles.find((entry) => `tile:${entry.key}` === sheetKey);
    if (tile) {
      const { Sheet: TileSheet } = TILE_REGISTRY[tile.type];
      sheet = {
        eyebrow: "Recap",
        title: tile.value !== undefined ? `${tile.label} · ${tile.value}` : tile.label,
        body: <TileSheet tile={tile} tasks={tasks} />,
      };
    }
  } else if (sheetKey?.startsWith("item:")) {
    const item = items.find((entry) => `item:${entry.n}` === sheetKey);
    if (item) {
      sheet = {
        eyebrow: `#${item.n} · ${item.payload.label ?? `${item.task_ids.length} tasks`}`,
        title: item.payload.title,
        body: (
          <ul className="rows">
            {item.task_ids.map((id) => (
              <li key={id}>
                <div className="r">
                  <span>{tasks[id]?.title ?? "Task not found"}</span>
                  <TaskLink id={id} />
                </div>
                {tasks[id] ? <span className="meta">{tasks[id].status}</span> : null}
              </li>
            ))}
          </ul>
        ),
      };
    }
  }

  return (
    <>
    <div className="page">
      <div className="topbar">
        <Link href="/">← Baseline</Link>
        <span className="mono">Or in Claude: review {brief.code}</span>
      </div>

      <div className="bento">
        <HeroTile code={brief.code} heading={heading} savedAt={brief.created_at} counts={counts} stats={content.stats} wide={!content.next} />
        {content.next ? (
          <NextTile next={content.next} items={items} movesCount={content.first_moves?.length ?? 0} onOpen={() => setSheetKey("next")} />
        ) : null}
        {content.meetings?.length ? (
          <DayTile
            meetings={content.meetings}
            savedAt={brief.created_at}
            filter={filter}
            onFilter={toggleFilter}
            meetingColor={meetingColor}
            openCounts={openCounts}
          />
        ) : null}
      </div>

      {meetingItems.length || filter ? (
        <section className="sec" aria-labelledby="sec-meetings">
          <div className="sec-h">
            <h2 id="sec-meetings">{BRIEF_SECTIONS.meetings.title}</h2>
            <span className="count">{openMeetings}</span>
            {BRIEF_SECTIONS.meetings.hint ? <span className="hint">{BRIEF_SECTIONS.meetings.hint}</span> : null}
          </div>
          {filter ? (
            <div className="filternote">
              Showing {content.meetings?.find((meeting) => meeting.id === filter)?.short ?? "one meeting"} only ·{" "}
              <button type="button" className="linkbtn" onClick={() => setFilter(null)}>
                Show all
              </button>
            </div>
          ) : null}
          <div className="list">
            {meetingItems.length ? (
              groups.map((group) => (
                <div key={group || "_"} className="list">
                  {group ? <div className="grp">{group}</div> : null}
                  {meetingItems.filter((item) => (item.payload.group ?? "") === group).map(renderItem)}
                </div>
              ))
            ) : (
              <p className="fine">No items from this meeting.</p>
            )}
          </div>
          <div className="kbdhint" aria-hidden="true">
            <span>
              <kbd>J</kbd> <kbd>K</kbd> move
            </span>
            <span>
              <kbd>A</kbd> accept
            </span>
            <span>
              <kbd>D</kbd> dismiss
            </span>
            <span>
              <kbd>S</kbd> note lines
            </span>
          </div>
        </section>
      ) : null}

      {callItems.length ? (
        <section className="sec" aria-labelledby="sec-calls">
          <div className="sec-h">
            <h2 id="sec-calls">{BRIEF_SECTIONS.calls.title}</h2>
            <span className="count">{openCalls}</span>
          </div>
          <div className="bento calls">{callItems.map(renderItem)}</div>
        </section>
      ) : null}

      {recapTiles.length ? (
        <section className="sec" aria-labelledby="sec-recap">
          <div className="sec-h">
            <h2 id="sec-recap">Recap</h2>
            <span className="hint">Tap a tile for details.</span>
          </div>
          <RecapBento tiles={recapTiles} onOpen={setSheetKey} />
        </section>
      ) : null}

      {content.footnote ? <p className="fine">{content.footnote}</p> : null}
    </div>

    {sheet ? (
      <Sheet eyebrow={sheet.eyebrow} title={sheet.title} onClose={closeSheet}>
        {sheet.body}
      </Sheet>
    ) : null}
    </>
  );
}
