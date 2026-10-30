// The brief's "Recently unblocked" section (Baseline 2f6b39f2, S3; no migration).
// A row is an ordinary carry_over item with this group, so Move, the 064 snapshot
// and Undo work as they do for any carry-over. The server appends the rows on
// save (`saveBrief`), one for every task still showing the "Now unblocked" pill,
// on every brief until Brent acts (Brent 10/30: "carrying over until he acts", no
// time limit). Pure and browser-safe: the page uses the same words.

import { etDay, etTime } from "@/components/briefs/format";
import { etDateOfDueAt, todayInBriefTimeZone } from "@/lib/briefs/due";
import type { BriefItemInput, BriefItemRow } from "@/lib/briefs/types";
import { NOW_UNBLOCKED_LABEL, UNBLOCK_RETRY_MAX_ATTEMPTS } from "@/lib/task-unblocks";
import type { TaskStatus } from "@/types/database";

export const RECENTLY_UNBLOCKED_GROUP = "Recently unblocked";

/** What "keep" stores as the item's choice. */
export const KEEP_CHOICE = "keep";

/** How much of a blocker's title a row quotes. */
const BLOCKER_TITLE_MAX = 80;

/** One task showing the pill, as a brief row needs it. */
export interface UnblockPill {
  task_id: string;
  title: string;
  status: TaskStatus;
  due_at: string | null;
  unblocked_at: string;
  /** Titles of the items it waited on that a work brief may name. */
  waited_on: string[];
  /** Items it waited on that a work brief may not name (personal ones). */
  waited_on_hidden: number;
}

export function isUnblockedRow(item: Pick<BriefItemRow, "kind" | "payload">): boolean {
  return item.kind === "carry_over" && item.payload.group === RECENTLY_UNBLOCKED_GROUP;
}

function quoted(title: string): string {
  const trimmed = title.trim();
  return `"${trimmed.length > BLOCKER_TITLE_MAX ? `${trimmed.slice(0, BLOCKER_TITLE_MAX - 1).trimEnd()}…` : trimmed}"`;
}

function joinWithAnd(parts: string[]): string {
  if (parts.length < 2) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** `"A" and "B"`, `"A", "B" and 2 others`, `another task`; null when nothing is known. */
function waitedOnWords(pill: Pick<UnblockPill, "waited_on" | "waited_on_hidden">): string | null {
  const named = pill.waited_on.slice(0, 2).map(quoted);
  const others = pill.waited_on.length - named.length + pill.waited_on_hidden;
  if (named.length === 0) {
    if (others === 0) return null;
    return others === 1 ? "another task" : `${others} other tasks`;
  }
  return others === 0 ? joinWithAnd(named) : joinWithAnd([...named, others === 1 ? "1 other" : `${others} others`]);
}

function doneWhen(unblockedAt: string, today: string): string {
  const time = etTime(unblockedAt);
  return etDateOfDueAt(unblockedAt) === today ? time : `${etDay(unblockedAt)} ${time}`;
}

function dueWords(dueAt: string | null, today: string): string {
  const day = dueAt ? etDateOfDueAt(dueAt) : null;
  if (!day) return "No due date.";
  if (day === today) return "Now due today.";
  return day > today ? `Already due ${etDay(dueAt)}.` : `Was due ${etDay(dueAt)}.`;
}

/** The row's line: what it waited on, when that finished, where its date stands. */
export function unblockedWhy(pill: UnblockPill, now: Date = new Date()): string {
  const today = todayInBriefTimeZone(now);
  const when = doneWhen(pill.unblocked_at, today);
  const waited = waitedOnWords(pill);
  const lead = waited ? `Was waiting on ${waited} (done ${when}).` : `Everything it waited on is done (${when}).`;
  const held = pill.status === "Blocked/Waiting" ? " Still marked Waiting." : "";
  return `${lead}${held} ${dueWords(pill.due_at, today)}`;
}

/** The carry_over item for one pill. */
export function unblockedItem(pill: UnblockPill, now: Date = new Date()): BriefItemInput {
  return {
    kind: "carry_over",
    payload: {
      title: pill.title.slice(0, 500),
      why: unblockedWhy(pill, now),
      group: RECENTLY_UNBLOCKED_GROUP,
      label: NOW_UNBLOCKED_LABEL,
    },
    task_ids: [pill.task_id],
    source: { meetings: [] },
  };
}

/**
 * The routine's own items, squared with the pills: a carry_over for a task showing
 * the pill becomes that task's row (one task, one card), and the group can't be
 * claimed by anything else, because it is what offers Keep.
 */
export function squareItemsWithPills(items: BriefItemInput[], pills: UnblockPill[], now: Date = new Date()): BriefItemInput[] {
  const byTask = new Map(pills.map((pill) => [pill.task_id, pill] as const));
  return items.map((item) => {
    const pill = item.kind === "carry_over" ? byTask.get(item.task_ids[0]) : undefined;
    if (pill) {
      return { ...item, payload: { ...item.payload, why: unblockedWhy(pill, now), group: RECENTLY_UNBLOCKED_GROUP, label: NOW_UNBLOCKED_LABEL } };
    }
    if (item.payload.group !== RECENTLY_UNBLOCKED_GROUP) return item;
    const { group: _claimed, ...payload } = item.payload;
    void _claimed;
    return { ...item, payload };
  });
}

/** "Keep Wed 11/4", "Keep today", "Keep no date". */
export function keepLabel(dueAt: string | null | undefined, now: Date = new Date()): string {
  const day = dueAt ? etDateOfDueAt(dueAt) : null;
  if (!day) return "Keep no date";
  return day === todayInBriefTimeZone(now) ? "Keep today" : `Keep ${etDay(dueAt)}`;
}

/** The handled row: "Keeping Wed 11/4". */
export function keptText(dueAt: string | null | undefined, now: Date = new Date()): string {
  return keepLabel(dueAt, now).replace("Keep", "Keeping");
}

/** Keep leads only for a date still ahead (the mockup's second row); otherwise Today does. */
export function keepLeads(dueAt: string | null | undefined, now: Date = new Date()): boolean {
  const day = dueAt ? etDateOfDueAt(dueAt) : null;
  return day !== null && day > todayInBriefTimeZone(now);
}

/** The line for retries that gave up (shown only above zero). No titles: a count is all it has. */
export function stuckUnblocksText(count: number): string {
  const tasks = count === 1 ? "1 task" : `${count} tasks`;
  return `${tasks} may be out of date. Something ${count === 1 ? "it" : "they"} waited on changed, and Baseline still couldn't update ${count === 1 ? "it" : "them"} after ${UNBLOCK_RETRY_MAX_ATTEMPTS} tries. Ask your AI assistant to check.`;
}
