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
  /**
   * Also allow any host ending in one of these (each must start with a dot,
   * e.g. `.apple.com`). Only for downloads that carry no credentials.
   */
  allowedHostSuffixes?: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 2_000_000;

function hostAllowed(hostname: string, allowedHosts: readonly string[], suffixes: readonly string[]): boolean {
  if (allowedHosts.includes(hostname)) {
    return true;
  }
  return suffixes.some(
    (suffix) => suffix.startsWith('.') && suffix.length > 1 && hostname.endsWith(suffix) && hostname.length > suffix.length
  );
}

export function assertAllowedUrl(rawUrl: string, allowedHosts: readonly string[], allowedHostSuffixes: readonly string[] = []): URL {
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
    || !hostAllowed(url.hostname, allowedHosts, allowedHostSuffixes)
  ) {
    throw new LaunchSourceError('host_not_allowed');
  }
  return url;
}

async function readLimitedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new LaunchSourceError('too_large');
  }
  if (!response.body) {
    return new Uint8Array(0);
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
  return merged;
}

function transportCode(error: unknown): string {
  if (error instanceof LaunchSourceError) {
    return error.code;
  }
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
}

/**
 * Sends the request and returns the raw body of a 2xx reply (at most
 * `maxBytes`). Non-2xx → `http_<status>`; network failure → `network`;
 * timeout → `timeout`; 3xx → `redirect_refused`.
 */
export async function fetchBytes(fetchImpl: FetchLike, request: SafeRequest): Promise<Uint8Array> {
  const url = assertAllowedUrl(request.url, request.allowedHosts, request.allowedHostSuffixes ?? []);
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
    throw new LaunchSourceError(transportCode(error));
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

  try {
    return await readLimitedBytes(response, request.maxBytes ?? DEFAULT_MAX_BYTES);
  } catch (error) {
    throw new LaunchSourceError(transportCode(error));
  }
}

/**
 * Sends the request and returns the parsed JSON body of a 2xx reply.
 * Non-2xx → `http_<status>`; network failure → `network`; timeout → `timeout`.
 */
export async function fetchJson(fetchImpl: FetchLike, request: SafeRequest): Promise<unknown> {
  const bytes = await fetchBytes(fetchImpl, request);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new LaunchSourceError('bad_json');
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
