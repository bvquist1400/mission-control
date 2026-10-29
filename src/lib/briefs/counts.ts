import type { BriefCounts, BriefItemKind, BriefItemRow } from "@/lib/briefs/types";

type CountedItem = Pick<BriefItemRow, "kind" | "state"> & { source?: Partial<BriefItemRow["source"]> | null };

/** A proposal that cites the work digest and no meeting (fix round 1: it isn't "from meetings"). */
function isDigestOnly(item: CountedItem): boolean {
  const source = item.source;
  return Boolean(source?.work_digest) && !(Array.isArray(source?.meetings) && source.meetings.length > 0);
}

/**
 * The hero's numbers, shared by the save/act replies and the page: open
 * proposals split into "from meetings" (any meeting cited) and "from mail and
 * Teams" (`from_mail`: digest-only), the rest are calls. `from_mail` is left
 * out when it is 0, so a brief without digest proposals has the same counts
 * as before the work digest.
 */
export function countBriefItems(
  items: CountedItem[],
  isProposalKind: (kind: BriefItemKind) => boolean = (kind) => kind === "proposed_task"
): BriefCounts {
  const open = items.filter((item) => item.state === "open");
  const proposals = open.filter((item) => isProposalKind(item.kind));
  const fromMail = proposals.filter(isDigestOnly).length;
  const counts: BriefCounts = { total: items.length, open: open.length, from_meetings: proposals.length - fromMail, calls: open.length - proposals.length };
  if (fromMail) {
    // Key order: from_mail sits next to from_meetings.
    return { total: counts.total, open: counts.open, from_meetings: counts.from_meetings, from_mail: fromMail, calls: counts.calls };
  }
  return counts;
}
