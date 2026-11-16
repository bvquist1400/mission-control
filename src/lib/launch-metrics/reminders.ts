/**
 * Reminders on the Launch page (Grocery 1.0.3; plan mm-103-reminders-plan.md
 * §3, mockup panel 5). Pure helpers over the counts the app-db sync stored.
 * Counts only: no ids, emails or names exist anywhere in this view. Every
 * number is `null` when it isn't stored ("not available yet"), never a
 * made-up 0; a stored 0 is a real 0.
 */

/** One reminder type ("Take it shopping" or "Share your list"). Event counts from the phones. */
export interface ReminderTypeView {
  /** Planned (counted once per planned reminder, not again on every re-plan). */
  planned: number | null;
  /** Not needed: the person opened the app first. */
  notNeeded: number | null;
  shown: number | null;
  tapped: number | null;
  /** Tapped or opened within 24 hours, then checked an item off (shop) or made an invite code (share). */
  acted: number | null;
  /** Shown, then 24 hours with no tap and no visit. */
  ignored: number | null;
}

export interface RemindersTotalsView {
  /** Event counts: the in-app card was shown / "Remind me" / "Not now". */
  askShown: number | null;
  askYes: number | null;
  askNotNow: number | null;
  /** Apple's dialog answer. */
  iosAllowed: number | null;
  iosDenied: number | null;
  /** Households with at least one yes. */
  householdsSaidYes: number | null;
  shop: ReminderTypeView;
  share: ReminderTypeView;
  /** The switch used in the app / iPhone notifications turned off after being allowed / the switch turned back on. */
  offInApp: number | null;
  offIos: number | null;
  onInApp: number | null;
  /** The invite card: shown, "Send invite" tapped, dismissed, a code made from it. */
  nudgeShown: number | null;
  nudgeSendTapped: number | null;
  nudgeDismissed: number | null;
  nudgeInviteMade: number | null;
  /** Households that saw the invite card or the share reminder, and how many of them got a 2nd member within 7 days. */
  invitePrompted: number | null;
  invitePromptedJoined7d: number | null;
  /** Households 7+ days old that used the app on 2+ different days in their first 7 (of those 7+ days old). */
  secondDay: number | null;
  secondDayEligible: number | null;
}

/** Every number in the view, flat (to ask whether anything is known). */
function allNumbers(view: RemindersTotalsView): Array<number | null> {
  const type = (t: ReminderTypeView) => [t.planned, t.notNeeded, t.shown, t.tapped, t.acted, t.ignored];
  return [
    view.askShown, view.askYes, view.askNotNow, view.iosAllowed, view.iosDenied, view.householdsSaidYes,
    ...type(view.shop), ...type(view.share),
    view.offInApp, view.offIos, view.onInApp,
    view.nudgeShown, view.nudgeSendTapped, view.nudgeDismissed, view.nudgeInviteMade,
    view.invitePrompted, view.invitePromptedJoined7d,
  ];
}

/** true when at least one reminder number is stored (the section shows numbers, not "not available yet"). */
export function hasReminders(view: RemindersTotalsView | null): boolean {
  return view !== null && allNumbers(view).some((value) => value !== null);
}

/** true when the second-day pair is stored (the line under "Still using it"). */
export function hasSecondDay(view: RemindersTotalsView | null): boolean {
  return view !== null && view.secondDay !== null && view.secondDayEligible !== null;
}

/** The two types added together; unknown when either is unknown (a half total would mislead). */
export function addCounts(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

export interface ReminderHeadline {
  shown: number | null;
  tapped: number | null;
  acted: number | null;
  turnedOff: number | null;
}

/** Both reminder types together, for the tiles. */
export function reminderHeadline(view: RemindersTotalsView): ReminderHeadline {
  return {
    shown: addCounts(view.shop.shown, view.share.shown),
    tapped: addCounts(view.shop.tapped, view.share.tapped),
    acted: addCounts(view.shop.acted, view.share.acted),
    turnedOff: addCounts(view.offInApp, view.offIos),
  };
}

/** true when nothing has been asked or planned yet (all stored, all 0): the app update isn't out or nobody has said yes. */
export function remindersNotStarted(view: RemindersTotalsView): boolean {
  return (
    view.askShown === 0 &&
    [view.shop, view.share].every((type) => (type.planned ?? 0) === 0 && (type.shown ?? 0) === 0)
  );
}
