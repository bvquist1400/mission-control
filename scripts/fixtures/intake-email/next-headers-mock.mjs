// Test double for "next/headers", used only by src/lib/supabase/server.ts in
// scripts/test-intake-email.mjs: a request with no cookies (no browser session).
export async function cookies() {
  return { getAll: () => [], set: () => {} };
}
export async function headers() {
  return new Headers();
}
