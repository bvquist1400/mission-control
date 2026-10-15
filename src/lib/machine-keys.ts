import { secureCompare } from '@/lib/secure-compare';

/**
 * The three machine keys (X-Mission-Control-Key), read from the environment and
 * trimmed. Kept free of Next/Supabase imports so every route that checks a key
 * itself (route-auth, legacy MCP, recurring generation) can share the collision
 * rule below.
 */
export interface MachineApiKeys {
  legacy?: string | null;
  actions?: string | null;
  famcal?: string | null;
}

export function readMachineApiKeys(env: NodeJS.ProcessEnv = process.env): MachineApiKeys {
  return {
    legacy: env.MISSION_CONTROL_API_KEY?.trim() || null,
    actions: env.MISSION_CONTROL_ACTIONS_API_KEY?.trim() || null,
    famcal: env.MISSION_CONTROL_FAMCAL_API_KEY?.trim() || null,
  };
}

/**
 * Env var names whose value equals MISSION_CONTROL_FAMCAL_API_KEY (after trimming).
 * Empty when the FamCal key is unset or has its own value, which is the only
 * supported setup.
 */
export function famcalKeyCollisions(keys: MachineApiKeys): string[] {
  if (!keys.famcal) {
    return [];
  }
  const collisions: string[] = [];
  if (keys.legacy && secureCompare(keys.famcal, keys.legacy)) {
    collisions.push('MISSION_CONTROL_API_KEY');
  }
  if (keys.actions && secureCompare(keys.famcal, keys.actions)) {
    collisions.push('MISSION_CONTROL_ACTIONS_API_KEY');
  }
  return collisions;
}

/**
 * Fail closed on a reused value: when the FamCal key has the same value as the
 * legacy or actions key, nobody presenting that value can be told apart, so the
 * value is refused for every caller (legacy MCP included) rather than resolved
 * to the broader key. Logs the env var names (never values) once per refusal.
 */
export function isRefusedCollidingMachineKey(
  providedApiKey: string | null | undefined,
  keys: MachineApiKeys = readMachineApiKeys()
): boolean {
  const provided = providedApiKey?.trim();
  if (!provided || !keys.famcal || !secureCompare(provided, keys.famcal)) {
    return false;
  }
  const collisions = famcalKeyCollisions(keys);
  if (collisions.length === 0) {
    return false;
  }
  console.error(
    `Machine key refused: MISSION_CONTROL_FAMCAL_API_KEY has the same value as ${collisions.join(' and ')}. `
    + 'That value is rejected for every caller until the FamCal key gets its own value.'
  );
  return true;
}
