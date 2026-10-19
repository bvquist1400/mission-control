// Test double for "@supabase/supabase-js", used only when the intake route imports it
// (wired in scripts/test-intake-email.mjs). createClient hands back the fake service
// client the test prepared and records the arguments.
export class SupabaseClient {}

export function createClient(url, key, options) {
  const state = globalThis.__intakeTest;
  state.createClientCalls.push({ url, key, options });
  return state.serviceDb;
}
