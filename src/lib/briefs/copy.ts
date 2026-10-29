/**
 * The fallback line under a brief's link, on the page and in the Telegram
 * notice. Product copy never names the AI product (Brent, 10/28): "your AI
 * assistant".
 */
export function assistantReviewLine(code: string): string {
  return `Or ask your AI assistant: review ${code}`;
}
