// Offline tests for the Launch page "Reminders" section and the second-day
// line (Grocery 1.0.3 keys; plan mm-103-reminders-plan.md section 3):
// parsing the optional keys (present, missing, malformed), the as-of-day
// view, and the server-rendered page (present / not available / zero).
// Counts only. No network, no database.
//
//   npm run test:launch-metrics-reminders

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// TSX → JS for the page render (TypeScript's own transpiler; types are dropped), as in test-launch-metrics-apple.mjs.
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".tsx")) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      const output = ts.transpileModule(source, {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
        fileName: fileURLToPath(url),
      });
      return { format: "module", source: output.outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/launch-metrics/${name}`, import.meta.url), "utf8"));
const appDb = await import("../src/lib/launch-metrics/app-db.ts");
const pageData = await import("../src/lib/launch-metrics/page-data.ts");
const reminders = await import("../src/lib/launch-metrics/reminders.ts");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}`);
    console.log(String(error?.stack ?? error).split("\n").slice(0, 6).map((l) => `    ${l}`).join("\n"));
  }
}

const NOW = new Date("2026-11-02T21:00:00Z"); // 4 PM ET Mon 11/2 (the fixture's day)
const AS_OF = "2026-11-02";

// The key names exactly as the plan lists them (section 3, launch_metrics_summary() change).
const PLAN_TOTAL_KEYS = [
  "reminders_ask_shown", "reminders_ask_yes", "reminders_ask_not_now", "reminders_ios_allowed", "reminders_ios_denied",
  ...["shop", "share"].flatMap((type) => ["scheduled", "shown", "tapped", "acted", "ignored", "cancelled_opened"].map((suffix) => `reminders_${type}_${suffix}`)),
  "reminders_off_in_app", "reminders_off_ios", "reminders_on_in_app",
  "invite_nudge_shown", "invite_nudge_send_tapped", "invite_nudge_dismissed", "invite_nudge_invite_made",
  "invite_prompted_households", "invite_prompted_joined_7d", "reminders_households_said_yes",
  "second_day_households", "second_day_eligible",
];
const PLAN_DAILY_KEYS = ["reminders_shown", "reminders_acted"];

const withReminders = () => fixture("app-db-summary-reminders.json");
const plainActivity = () => fixture("app-db-summary-activity.json");

function viewFor(raw) {
  const summary = appDb.validateAppDbSummary(raw, NOW);
  const daily = appDb.appDbDailyRows(summary, AS_OF);
  const input = { daily, searchTop: null, runs: [], reddit: [], milestones: [], manualReads: [], tokenExpires: null };
  return { summary, daily, input, view: pageData.buildLaunchView(input, NOW) };
}

async function render(raw) {
  const { createElement: h } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
  const { LaunchPageBody } = await import("../src/components/launch/LaunchPage.tsx");
  const { ToastProvider } = await import("../src/components/ui/Toast.tsx");
  const router = { refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} };
  const { view, input } = viewFor(raw);
  const html = renderToStaticMarkup(h(AppRouterContext.Provider, { value: router }, h(ToastProvider, null, h(LaunchPageBody, { view, input, now: NOW }))));
  const start = html.indexOf('id="reminders-title"');
  const end = html.indexOf('id="signups-title"');
  const activityStart = html.indexOf('id="activity-title"');
  return { html, section: html.slice(start, end), activity: html.slice(activityStart, start), view };
}

const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const zeroed = (raw) => ({ ...raw, totals: { ...raw.totals, ...Object.fromEntries(PLAN_TOTAL_KEYS.map((key) => [key, 0])) } });

// ─── parsing ────────────────────────────────────────────────────────────

await test("parse: the key list is the plan's list, nothing more and nothing less", () => {
  assert.deepEqual([...appDb.APP_DB_REMINDER_TOTALS].sort(), [...PLAN_TOTAL_KEYS].sort());
  assert.deepEqual([...appDb.APP_DB_REMINDER_DAILY].sort(), [...PLAN_DAILY_KEYS].sort());
});

await test("parse: a reply with the reminder keys keeps every one, and stores them as counts (total_ rows + daily rows)", () => {
  const raw = withReminders();
  const { summary, daily } = viewFor(raw);
  for (const key of PLAN_TOTAL_KEYS) assert.equal(summary.totals[key], raw.totals[key], key);
  const stored = (metric, date = AS_OF) => daily.find((row) => row.metric_date === date && row.metric === metric)?.value;
  for (const key of PLAN_TOTAL_KEYS) assert.equal(stored(`total_${key}`), raw.totals[key], key);
  assert.equal(stored("reminders_shown", "2026-11-01"), 3);
  assert.equal(stored("reminders_acted", "2026-11-01"), 1);
  // Every stored name passes migration 065's CHECK on launch_metric_daily.metric, and every stored row is a number.
  for (const row of daily) {
    assert.match(row.metric, /^[a-z][a-z0-9_]{0,59}$/, row.metric);
    assert.equal(typeof row.value, "number");
  }
});

await test("parse: today's reply (no reminder keys) still validates and stores no reminder row", () => {
  const { summary, daily } = viewFor(plainActivity());
  for (const key of PLAN_TOTAL_KEYS) assert.equal(key in summary.totals, false, key);
  const names = new Set([...PLAN_TOTAL_KEYS.map((key) => `total_${key}`), ...PLAN_DAILY_KEYS]);
  assert.equal(daily.some((row) => names.has(row.metric)), false);
});

await test("parse: a malformed reminder number (or boolean) is dropped, never stored, and the rest of the reply (sign-ups too) still stands", () => {
  const base = withReminders();
  for (const bad of [-1, 1.5, 10_000_001, true, false]) {
    const raw = {
      ...base,
      totals: { ...base.totals, reminders_ask_shown: bad, reminders_shop_shown: bad, second_day_households: bad },
      daily: base.daily.map((day) => ({ ...day, reminders_shown: bad })),
    };
    const { summary } = viewFor(raw);
    const label = JSON.stringify(bad);
    for (const key of ["reminders_ask_shown", "reminders_shop_shown", "second_day_households"]) assert.equal(key in summary.totals, false, `${label} ${key}`);
    assert.equal(summary.totals.reminders_ask_yes, 9, label);
    assert.equal(summary.totals.real_users, 20, label);
    assert.equal(summary.totals.still_using_households, 11, label);
    assert.ok(summary.daily.every((day) => !("reminders_shown" in day)), label);
    assert.ok(summary.daily.every((day) => day.signups_real !== undefined), label);
  }
  // null means "not sent", the same as a missing key.
  const { summary } = viewFor({ ...base, totals: { ...base.totals, reminders_ask_shown: null } });
  assert.equal("reminders_ask_shown" in summary.totals, false);
});

await test("parse: counts only. Text, an array or an object under a reminder key refuses the whole reply, and so do ids, emails and names anywhere", () => {
  const base = withReminders();
  const refused = (raw, label) =>
    assert.throws(() => appDb.validateAppDbSummary(raw, NOW), (error) => error.name === "LaunchSourceError" && ["app_db_not_counts", "app_db_shape"].includes(error.code), label);
  for (const bad of ["6", "5ee0000e-0000-4000-8000-000000000000", "a@b.test", "Maple Street"]) {
    refused({ ...base, totals: { ...base.totals, reminders_ask_yes: bad } }, `total ${bad}`);
    refused({ ...base, totals: { ...base.totals, second_day_eligible: bad } }, `total ${bad}`);
    refused({ ...base, daily: [{ ...base.daily[3], reminders_shown: bad }] }, `daily ${bad}`);
  }
  // An array or object under a reminder key is refused like text (it could hold anything), even when it holds an email.
  for (const bad of [[1], [], {}, { n: 1 }, ["a@b.example"], { email: "a@b.example" }, [{ name: "Sam" }]]) {
    refused({ ...base, totals: { ...base.totals, reminders_ask_yes: bad } }, `total ${JSON.stringify(bad)}`);
    refused({ ...base, totals: { ...base.totals, second_day_households: bad } }, `total ${JSON.stringify(bad)}`);
    refused({ ...base, daily: [{ ...base.daily[3], reminders_shown: bad }] }, `daily ${JSON.stringify(bad)}`);
  }
  refused({ ...base, totals: { ...base.totals, email: 1 } }, "email key");
  refused({ ...base, totals: { ...base.totals, user_ids: [1] } }, "user_ids key");
  refused({ ...base, accounts: [] }, "accounts list");
  refused({ ...base, totals: { ...base.totals, reminders_unknown_text: "x" } }, "text under an unknown key");
  // A number under an unknown reminder-looking key is dropped, not stored.
  const { summary } = viewFor({ ...base, totals: { ...base.totals, reminders_ask_something_new: 4 } });
  assert.equal("reminders_ask_something_new" in summary.totals, false);
});

// ─── the as-of-day view ─────────────────────────────────────────────────

await test("view: every reminder number is read from the as-of day, and a real 0 stays 0", () => {
  const { view } = viewFor(withReminders());
  assert.deepEqual(view.totals.reminders, {
    askShown: 14, askYes: 9, askNotNow: 3, iosAllowed: 8, iosDenied: 1, householdsSaidYes: 7,
    shop: { planned: 31, notNeeded: 19, shown: 12, tapped: 3, acted: 2, ignored: 8 },
    share: { planned: 11, notNeeded: 4, shown: 7, tapped: 2, acted: 1, ignored: 4 },
    offInApp: 1, offIos: 1, onInApp: 0,
    nudgeShown: 10, nudgeSendTapped: 4, nudgeDismissed: 5, nudgeInviteMade: 4,
    invitePrompted: 13, invitePromptedJoined7d: 2, secondDay: 6, secondDayEligible: 12,
  });
  assert.equal(view.totals.reminders.onInApp, 0, "0 is a number, not unknown");
});

await test("view: with today's function every reminder number is unknown (null), never 0", () => {
  const { view } = viewFor(plainActivity());
  const flat = JSON.stringify(view.totals.reminders, (key, value) => (typeof value === "number" ? `<${value}>` : value));
  assert.ok(!/<\d/.test(flat), flat);
  assert.ok(flat.includes("null"));
  assert.equal(reminders.hasReminders(view.totals.reminders), false);
  assert.equal(reminders.hasSecondDay(view.totals.reminders), false);
});

await test("view: a reminder total from an older day than the sign-up totals is not shown (a function rolled back)", () => {
  const withKeys = appDb.validateAppDbSummary(withReminders(), NOW);
  const older = appDb.appDbDailyRows(withKeys, "2026-11-01").filter((row) => row.metric.startsWith("total_"));
  const plain = appDb.validateAppDbSummary(plainActivity(), NOW);
  const today = appDb.appDbDailyRows(plain, AS_OF);
  const input = { daily: [...older, ...today], searchTop: null, runs: [], reddit: [], milestones: [], manualReads: [], tokenExpires: null };
  const view = pageData.buildLaunchView(input, NOW);
  assert.equal(view.totals.asOfDate, AS_OF);
  assert.equal(reminders.hasReminders(view.totals.reminders), false);
});

await test("view: helpers add the two types only when both are known, and spot an all-zero (not started) state", () => {
  assert.equal(reminders.addCounts(3, 2), 5);
  assert.equal(reminders.addCounts(0, 0), 0);
  assert.equal(reminders.addCounts(3, null), null);
  assert.equal(reminders.addCounts(null, null), null);
  const { view } = viewFor(withReminders());
  assert.deepEqual(reminders.reminderHeadline(view.totals.reminders), { shown: 19, tapped: 5, acted: 3, turnedOff: 2 });
  assert.equal(reminders.remindersNotStarted(view.totals.reminders), false);
  const zero = viewFor(zeroed(withReminders())).view.totals.reminders;
  assert.equal(reminders.hasReminders(zero), true, "zeros are known numbers");
  assert.equal(reminders.remindersNotStarted(zero), true);
  const oneKnown = { ...zero, shop: { ...zero.shop, shown: null } };
  assert.equal(reminders.reminderHeadline(oneKnown).shown, null, "half a total would mislead");
});

// ─── the page ───────────────────────────────────────────────────────────

await test("page: present. The four tiles, the by-type table, the invite line and the second-day line read like the mockup", async () => {
  const { section, activity } = await render(withReminders());
  const words = text(section);
  assert.match(words, /Reminders/);
  assert.match(words, /Said yes to reminders 9 of 14 Apple's dialog: 8 allowed, 1 didn't\. 3 said "Not now"\. 7 households said yes\./);
  assert.match(words, /Reminders tapped 5 of 19 shown reminders were tapped/);
  assert.match(words, /Came back and used it 3 of 19 shown reminders were followed by checking items off or making an invite code within a day \(not whether it was sent\)/);
  assert.match(words, /made an invite code within a day \(share\)\. The app can't see whether the invite message was actually sent\./);
  assert.match(words, /Turned off 2 1 with the in-app switch, 1 in iPhone Settings\./);
  assert.match(words, /Reminder Planned Not needed \(opened first\) Shown Tapped Acted on Ignored/);
  assert.match(words, /Take it shopping 31 19 12 3 2 8/);
  assert.match(words, /Share your list 11 4 7 2 1 4/);
  assert.match(words, /10 shown → 4 tapped Send invite → 4 invite codes made → 2 of 13 households got a 2nd person within 7 days/);
  assert.match(text(activity), /Came back on a second day 6 of 12 since launch \(all sign-up weeks, not only since 1\.0\.3\): households 7\+ days old that used it on 2\+ different days in their first week/);
  assert.ok(!/Not available yet/.test(words), "nothing is missing in this reply");
  assert.ok(!/\d%/.test(words), "no percentage under 20 households or events");
  assert.ok(section.indexOf('id="reminders-title"') >= 0);
});

await test("page: the Reminders section sits right under Still using it", async () => {
  const { html } = await render(withReminders());
  const order = ["activity-title", "reminders-title", "signups-title"].map((id) => html.indexOf(`id="${id}"`));
  assert.ok(order.every((index) => index > 0) && order[0] < order[1] && order[1] < order[2], order.join());
});

await test("page: not available yet (today's function). A calm line, no zeros and no dashes pretending to be data", async () => {
  const { section, activity } = await render(plainActivity());
  const words = text(section);
  assert.match(words, /Reminders/);
  assert.match(words, /Not available yet\. These numbers start once the app's database update for them is live\./);
  assert.ok(!/Said yes|Take it shopping|Turned off/.test(words), "no tiles or table");
  const second = text(activity);
  assert.match(second, /Came back on a second day Not available yet/);
  assert.ok(!/Came back on a second day \d/.test(second));
  assert.ok(!/NaN|undefined|null/.test(section + activity));
});

await test("page: zero. Real zeros show as 0, an empty denominator shows a dash with a plain sentence, and a not-started note appears", async () => {
  const { section, activity } = await render(zeroed(withReminders()));
  const words = text(section);
  assert.match(words, /Nothing yet\. These start counting once the update is out and people say yes to reminders\./);
  assert.match(words, /Said yes to reminders – No one has been asked yet/);
  assert.match(words, /Reminders tapped – No reminder has been shown yet/);
  assert.match(words, /Turned off 0 0 with the in-app switch, 0 in iPhone Settings\./);
  assert.match(words, /Take it shopping 0 0 0 0 0 0/);
  assert.match(words, /0 shown → 0 tapped Send invite → 0 invite codes made → Nothing yet: no household has seen the invite card or the share reminder/);
  assert.ok(!/0 of 0/.test(words), "no '0 of 0'");
  assert.match(text(activity), /Came back on a second day No household is 7\+ days old yet/);
  assert.ok(!/NaN|Infinity|undefined|null|\d%/.test(section + activity));
});

await test("page: a percentage appears only from 20 asked / shown (and from 20 households for the second-day line)", async () => {
  const raw = withReminders();
  const big = { ...raw, totals: { ...raw.totals, reminders_ask_shown: 25, reminders_ask_yes: 10, reminders_shop_shown: 20, reminders_share_shown: 20, reminders_shop_tapped: 8, reminders_share_tapped: 2, second_day_eligible: 20, second_day_households: 5 } };
  const { section, activity } = await render(big);
  const words = text(section);
  assert.match(words, /Said yes to reminders 10 of 25 40% · /);
  assert.match(words, /Reminders tapped 10 of 40 25% · /);
  assert.match(text(activity), /Came back on a second day 5 of 20 \(25%\)/);
  const small = await render(raw);
  assert.ok(!/\d%/.test(text(small.section) + text(small.activity)));
});

await test("page: half a reply. A missing key shows a dash in its own cell only; one missing type blanks the combined tile, not the table", async () => {
  const raw = withReminders();
  const missing = new Set(["reminders_share_shown", "reminders_ask_not_now", "reminders_off_ios"]);
  const rest = Object.fromEntries(Object.entries(raw.totals).filter(([key]) => !missing.has(key)));
  const { section } = await render({ ...raw, totals: rest });
  const words = text(section);
  assert.match(words, /Reminders tapped – Not available yet/);
  assert.match(words, /Turned off – Not available yet/);
  assert.match(words, /Share your list 11 4 – 2 1 4/);
  assert.match(words, /Take it shopping 31 19 12 3 2 8/);
});

await test("page: counts only and no brand words. No id, email or name shape in the section, and the source never names the AI vendor", async () => {
  const { section, activity } = await render(withReminders());
  const both = text(section + activity); // the words on the page (class names like @min-[36rem] aren't content)
  assert.ok(!/@|[0-9a-f]{8}-[0-9a-f]{4}-/.test(both));
  assert.ok(!/claude|anthropic/i.test(section + activity));
  const source = readFileSync(new URL("../src/components/launch/LaunchPage.tsx", import.meta.url), "utf8") + readFileSync(new URL("../src/lib/launch-metrics/reminders.ts", import.meta.url), "utf8");
  assert.ok(!/claude|anthropic/i.test(source));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
