// Test double for "@/lib/extraction", used only when the intake route imports it
// (wired in scripts/test-intake-email.mjs). It never calls a model: it records the
// call and returns whatever the test put in globalThis.__intakeTest.extract.
export const DEFAULT_ESTIMATES = { Task: 30, Ticket: 30, MeetingPrep: 60, FollowUp: 30, Admin: 15, Build: 90 };

export async function extractTaskMetadata(input) {
  const state = globalThis.__intakeTest;
  state.extractCalls.push(input);
  if (state.extractError) throw new Error(state.extractError);
  return state.extractResult;
}
