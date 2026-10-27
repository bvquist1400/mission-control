/**
 * The one outbound HTTP path for launch-metrics sources.
 *
 * - Only https, only hosts the caller allowlists (exact match, no port, no
 *   userinfo); redirects are refused, so a token can't follow a 3xx elsewhere.
 * - A timeout on every call; a response body above `maxBytes` is refused.
 * - Failures are a `LaunchSourceError` carrying a short code only
 *   (`http_401`, `timeout`, `bad_json`, …). No response body, header, token or
 *   upstream error text ever reaches a log, the run log or the page.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Codes are `[a-z0-9_]{1,40}`; anything else is normalised to `error`. */
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export class LaunchSourceError extends Error {
  readonly code: string;

  constructor(code: string) {
    const safe = CODE_PATTERN.test(code) ? code : 'error';
    super(safe);
    this.name = 'LaunchSourceError';
    this.code = safe;
  }
}

/** The run-log code for any thrown value: our own code, else a generic one. */
export function errorCode(error: unknown): string {
  if (error instanceof LaunchSourceError) {
    return error.code;
  }
  return 'error';
}

export interface SafeRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  allowedHosts: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 2_000_000;

export function assertAllowedUrl(rawUrl: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new LaunchSourceError('bad_url');
  }
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.port !== ''
    || !allowedHosts.includes(url.hostname)
  ) {
    throw new LaunchSourceError('host_not_allowed');
  }
  return url;
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new LaunchSourceError('too_large');
  }
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new LaunchSourceError('too_large');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Sends the request and returns the parsed JSON body of a 2xx reply.
 * Non-2xx → `http_<status>`; network failure → `network`; timeout → `timeout`.
 */
export async function fetchJson(fetchImpl: FetchLike, request: SafeRequest): Promise<unknown> {
  const url = assertAllowedUrl(request.url, request.allowedHosts);
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: request.method ?? 'GET',
      headers: request.headers,
      body: request.body,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof LaunchSourceError) {
      throw error;
    }
    const name = (error as { name?: unknown } | null)?.name;
    throw new LaunchSourceError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new LaunchSourceError('redirect_refused');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
      ? response.status
      : 0;
    throw new LaunchSourceError(`http_${status}`);
  }

  let text: string;
  try {
    text = await readLimitedText(response, request.maxBytes ?? DEFAULT_MAX_BYTES);
  } catch (error) {
    if (error instanceof LaunchSourceError) {
      throw error;
    }
    const name = (error as { name?: unknown } | null)?.name;
    throw new LaunchSourceError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LaunchSourceError('bad_json');
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
