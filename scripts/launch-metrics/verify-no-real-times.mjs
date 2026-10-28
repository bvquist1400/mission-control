#!/usr/bin/env node
// Proves no real launch event time (a sign-up, trial, feedback, Reddit post or
// release minute) or sign-up account id prefix from the hand-kept dashboard
// CSVs is in this repository. The repo is public; tests and fixtures must use
// synthetic times.
//
//   node scripts/launch-metrics/verify-no-real-times.mjs --dir <dashboard-data> [--base <ref>] [--head <ref>]
//
// It reads every *.csv in --dir, takes each "YYYY-MM-DD HH:MM" (New York time)
// and checks these renderings of it:
//   New York: YYYY-MM-DD HH:MM, YYYY-MM-DDTHH:MM, MM-DD HH:MM, "Oct 26 16:07", "Oct 06 16:07"
//   UTC:      YYYY-MM-DDTHH:MM, YYYY-MM-DD HH:MM, MM-DDTHH:MM
//   epoch:    milliseconds and seconds
// plus the first 8 hex characters of each signups.csv account, against
// `git grep` of <head> (default HEAD) and, with --base, `git log -p <base>..<head>`
// (diffs and commit messages). Matching ignores case.
//
// Tree hits are split into files this branch changed (base..head) and files
// unchanged since <base>; only the first count fails the check, because the
// second is already on main and was not written by this branch (a round test
// time can match a real minute by chance). It prints COUNTS, PATHS AND FORM
// KINDS ONLY, never a value, so its output is safe to paste into a handoff.
//
// Exit 0: no hits in this branch's files or commits. Exit 1: hits. Exit 2: bad arguments.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const dir = arg("--dir");
const base = arg("--base");
const head = arg("--head") ?? "HEAD";
if (!dir || !existsSync(dir)) {
  console.error("Usage: verify-no-real-times.mjs --dir <dashboard-data> [--base <ref>] [--head <ref>]");
  process.exit(2);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n) => String(n).padStart(2, "0");
const nyFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const nyParts = (instant) => {
  const parts = nyFormat.formatToParts(instant);
  return ["year", "month", "day", "hour", "minute"].map((type) => Number(parts.find((p) => p.type === type).value));
};
function nyToInstant(y, mo, d, h, mi) {
  for (const offset of [4, 5]) {
    const instant = new Date(Date.UTC(y, mo - 1, d, h + offset, mi));
    if (nyParts(instant).join() === [y, mo, d, h, mi].join()) return instant;
  }
  return null; // a wall time skipped by the spring-forward change
}

/** value -> kind; values are lower case. */
const forms = new Map();
const ids = new Set();
let times = 0;
for (const name of readdirSync(dir).filter((n) => n.endsWith(".csv"))) {
  const text = readFileSync(path.join(dir, name), "utf8");
  if (name === "signups.csv") {
    for (const [, run] of text.matchAll(/^"?([0-9a-f]{8,})/gim)) ids.add(run.slice(0, 8).toLowerCase());
  }
  for (const match of new Set(text.match(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/g) ?? [])) {
    const [y, mo, d, h, mi] = match.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/).slice(1).map(Number);
    const instant = nyToInstant(y, mo, d, h, mi);
    times += 1;
    const ny = `${pad(mo)}-${pad(d)}`;
    const hm = `${pad(h)}:${pad(mi)}`;
    forms.set(`${y}-${ny} ${hm}`, "new-york");
    forms.set(`${y}-${ny}t${hm}`, "new-york");
    forms.set(`${ny} ${hm}`, "new-york");
    forms.set(`${MONTHS[mo - 1]} ${d} ${hm}`, "new-york");
    forms.set(`${MONTHS[mo - 1]} ${pad(d)} ${hm}`, "new-york");
    if (!instant) continue;
    const iso = instant.toISOString().toLowerCase(); // yyyy-mm-ddthh:mm:ss.sssz
    forms.set(iso.slice(0, 16), "utc");
    forms.set(iso.slice(0, 16).replace("t", " "), "utc");
    forms.set(iso.slice(5, 16), "utc");
    forms.set(String(instant.getTime()), "epoch");
    forms.set(String(instant.getTime() / 1000), "epoch");
  }
}

const git = (...gitArgs) => execFileSync("git", gitArgs, { encoding: "utf8", maxBuffer: 1 << 30 });
const count = (text, values) => {
  let n = 0;
  for (const value of values) n += text.split(value).length - 1;
  return n;
};
const kindsIn = (text) => [...new Set([...forms].filter(([value]) => text.includes(value)).map(([, kind]) => kind))].sort().join("+");

console.log(`list: ${times} event times (${forms.size} renderings), ${ids.size} account id prefixes`);

const changed = new Set(base ? git("diff", "--name-only", base, head).split("\n").filter(Boolean) : []);
const tree = { branch: [0, 0], unchanged: [0, 0] };
const hitFiles = [];
for (const file of git("ls-tree", "-r", "--name-only", "-z", head).split("\0").filter(Boolean)) {
  let text;
  try {
    const buffer = execFileSync("git", ["cat-file", "blob", `${head}:${file}`], { maxBuffer: 1 << 30 });
    if (buffer.includes(0)) continue;
    text = buffer.toString("utf8").toLowerCase();
  } catch {
    continue; // submodule or unreadable
  }
  const hits = [count(text, forms.keys()), count(text, ids)];
  if (hits[0] + hits[1] === 0) continue;
  const bucket = !base || changed.has(file) ? tree.branch : tree.unchanged;
  bucket[0] += hits[0];
  bucket[1] += hits[1];
  hitFiles.push(`  ${file}: times ${hits[0]} (${kindsIn(text) || "-"}), id prefixes ${hits[1]}${base && !changed.has(file) ? " [unchanged since base]" : ""}`);
}
console.log(`tree ${head}, files this branch changed: times ${tree.branch[0]}, id prefixes ${tree.branch[1]}`);
if (base) console.log(`tree ${head}, files unchanged since ${base}: times ${tree.unchanged[0]}, id prefixes ${tree.unchanged[1]}`);
for (const line of hitFiles) console.log(line);

let total = tree.branch[0] + tree.branch[1];
if (base) {
  const log = git("log", "-p", "--format=%B", `${base}..${head}`).toLowerCase();
  const hits = [count(log, forms.keys()), count(log, ids)];
  total += hits[0] + hits[1];
  console.log(`commits ${base}..${head} (diffs and messages): times ${hits[0]}, id prefixes ${hits[1]}`);
}
console.log(total === 0 ? "PASS: none found in this branch" : `FAIL: ${total} hits (values not printed)`);
process.exit(total === 0 ? 0 : 1);
