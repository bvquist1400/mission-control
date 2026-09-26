import type { BriefContent, BriefCounts } from "@/lib/briefs/types";

// Baseline tells Brent a brief is ready with one Telegram message, sent by the
// server on the first save of the day (see saveBrief's notify claim).

export interface BriefNotifier {
  /** Resolves when delivered; rejects with a readable reason otherwise. */
  send(text: string): Promise<void>;
}

const TELEGRAM_TIMEOUT_MS = 8000;
const ERROR_MAX = 500;

/** "EOD-0925 is ready · 6 to decide · 19 done", the link, and the Claude fallback. */
export function buildBriefNotice(code: string, url: string, counts: BriefCounts, content: BriefContent): string {
  const done = content.stats?.find((stat) => stat.key === "done")?.value;
  const head = [`${code} is ready`, `${counts.open} to decide`, done !== undefined ? `${done} done` : null]
    .filter(Boolean)
    .join(" · ");
  return [head, url, `Or in Claude: review ${code}`].join("\n");
}

export function telegramNotifierFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch
): BriefNotifier {
  const token = env.BASELINE_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.BASELINE_TELEGRAM_CHAT_ID?.trim();

  // Never let the bot token reach an error message, a log or the database.
  const scrub = (message: string) => (token ? message.split(token).join("<token>") : message).slice(0, ERROR_MAX);

  return {
    async send(text) {
      if (!token || !chatId) {
        throw new Error("Telegram isn't configured: set BASELINE_TELEGRAM_BOT_TOKEN and BASELINE_TELEGRAM_CHAT_ID");
      }

      let response: Response;
      try {
        response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
          signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
        });
      } catch (error) {
        throw new Error(scrub(`Telegram unreachable: ${error instanceof Error ? error.message : String(error)}`));
      }

      const body = (await response.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
      if (!response.ok || body?.ok !== true) {
        throw new Error(scrub(`Telegram said ${response.status}: ${body?.description ?? response.statusText}`));
      }
    },
  };
}
