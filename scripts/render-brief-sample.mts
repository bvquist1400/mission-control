import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { buildDailyBriefDigest, type DailyBriefMode } from "@/lib/briefing/digest";
import { renderDailyBrief } from "@/lib/briefing/render";

const projectRoot = path.resolve(import.meta.dirname, "..");
const envPath = path.join(projectRoot, ".env.local");

function loadEnvFile(filePath: string): void {
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(envPath);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const userId = process.env.MISSION_CONTROL_USER_ID;

if (!supabaseUrl || !serviceRoleKey || !userId) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or MISSION_CONTROL_USER_ID in .env.local");
}

const modeArg = process.argv[2] ?? "morning";
const mode = (["morning", "midday", "eod", "auto"].includes(modeArg) ? modeArg : "morning") as DailyBriefMode;
const date = process.argv[3] ?? null;
const since = process.argv[4] ?? null;

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

const digest = await buildDailyBriefDigest({
  supabase,
  userId,
  mode,
  date,
  since,
});

const rendered = await renderDailyBrief(supabase, userId, digest);
const slug = `${rendered.mode}-${rendered.requestedDate}`;
const htmlPath = path.join("/tmp", `mission-control-brief-${slug}.html`);
const textPath = path.join("/tmp", `mission-control-brief-${slug}.txt`);
const jsonPath = path.join("/tmp", `mission-control-brief-${slug}.json`);

fs.writeFileSync(htmlPath, rendered.html, "utf8");
fs.writeFileSync(textPath, rendered.text, "utf8");
fs.writeFileSync(jsonPath, JSON.stringify(rendered, null, 2), "utf8");

console.log(JSON.stringify({
  mode: rendered.mode,
  requestedDate: rendered.requestedDate,
  subject: rendered.subject,
  preheader: rendered.preheader,
  htmlPath,
  textPath,
  jsonPath,
  counts: rendered.digest.counts,
  signals: rendered.digest.signals,
  llm: rendered.llm,
}, null, 2));
