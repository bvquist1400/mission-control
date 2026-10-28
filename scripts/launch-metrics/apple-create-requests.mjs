#!/usr/bin/env node
// One-time App Store Connect setup for the Menu & Market launch dashboard.
//
// Creates the app's ONGOING analytics report request (and a ONE_TIME_SNAPSHOT
// for history) when they don't exist yet. Run by Brent from his own Terminal
// with a temporary Admin team key; see docs/runbooks/launch-metrics-apple-setup.md.
//
// Safety rules (pinned by scripts/test-launch-metrics-apple-setup.mjs):
// - Dry run unless --go is given: a dry run makes no network calls at all.
// - The key, the signed token, response bodies and response headers are never
//   printed, logged, copied or written anywhere. Output is limited to request
//   ids, access types, created/already existed and the stopped flag; errors are
//   the HTTP status plus Apple's error `code` only.
// - Refuses a key file inside any git repository, a key file that anyone but
//   the owner can read or write, and a non-numeric app id.
// - The token is only ever sent to https://api.appstoreconnect.apple.com and
//   redirects are refused, so it can't be forwarded elsewhere.
// - Fails closed: a listed request it can't read for certain, or a list that
//   isn't provably complete (odd paging links, a count that doesn't match
//   Apple's total, the same id twice), stops the run before any POST.
// - After a POST whose outcome is unknown (timeout, network error, HTTP 5xx,
//   unreadable reply) it stops, says Apple may or may not have created it, and
//   says NOT to run --go again: a fresh list can't prove an earlier create has
//   finished, so a re-run could ask for a second one. Nothing else is sent in
//   that run. --check lists what exists without ever sending a POST.
//
// Plain Node >= 20, no dependencies.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const APPLE_API_ORIGIN = 'https://api.appstoreconnect.apple.com';
export const MAX_TOKEN_LIFETIME_SECONDS = 15 * 60; // Apple rejects > 20 minutes
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_KEY_FILE_BYTES = 16 * 1024;
const MAX_LIST_PAGES = 10;

const ACCESS_TYPES = ['ONGOING', 'ONE_TIME_SNAPSHOT'];
const APP_ID_PATTERN = /^[0-9]{1,20}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9]{8,20}$/;
const ISSUER_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const APPLE_ERROR_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const NETWORK_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,40}$/;

const EXIT_OK = 0;
const EXIT_APPLE = 1;
const EXIT_REFUSED = 2;

const USAGE = [
  'Usage:',
  '  node scripts/launch-metrics/apple-create-requests.mjs \\',
  '    --key <path to AuthKey_XXXX.p8> --key-id <Key ID> --issuer <Issuer ID> --app-id <numeric Apple ID> [--go | --check]',
  '',
  'Without --go (or with --dry-run) it only checks the key file and says what it would do; nothing is sent.',
  'With --check it only lists the app\'s report requests (read-only); it never creates anything.',
];

class Refusal extends Error {}

class AppleCallError extends Error {
  constructor(step, { status = null, code = null, network = false, networkCode = null, shape = false, incomplete = false } = {}) {
    super('apple call failed');
    this.step = step;
    this.status = status;
    this.code = code;
    this.network = network;
    this.networkCode = networkCode;
    this.shape = shape;
    // The list was readable but provably not the whole list.
    this.incomplete = incomplete;
    // Set when the failing call was a POST whose outcome at Apple is unknown.
    this.mayHaveCreated = false;
  }
}

// ---------------------------------------------------------------- arguments

const VALUE_FLAGS = new Map([
  ['--key', 'key'],
  ['--key-id', 'keyId'],
  ['--issuer', 'issuer'],
  ['--app-id', 'appId'],
]);
const BOOLEAN_FLAGS = new Map([
  ['--go', 'go'],
  ['--dry-run', 'dryRun'],
  ['--check', 'check'],
  ['--help', 'help'],
  ['-h', 'help'],
]);

function parseArgs(argv) {
  const options = { go: false, dryRun: false, check: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUE_FLAGS.has(name)) {
      let value;
      if (eq > 0) {
        value = arg.slice(eq + 1);
      } else {
        value = argv[index + 1];
        index += 1;
        if (value === undefined || value.startsWith('--')) throw new Refusal(`${name} needs a value.`);
      }
      const key = VALUE_FLAGS.get(name);
      if (options[key] !== undefined) throw new Refusal(`${name} was given twice.`);
      options[key] = value;
    } else if (BOOLEAN_FLAGS.has(name) && eq < 0) {
      options[BOOLEAN_FLAGS.get(name)] = true;
    } else {
      // Never echo the argument: it could be a pasted key or token.
      throw new Refusal('Unknown argument. Run with --help to see the options.');
    }
  }
  return options;
}

function validateOptions(options) {
  if ([options.go, options.dryRun, options.check].filter(Boolean).length > 1) {
    throw new Refusal('Use only one of --go, --check and --dry-run.');
  }
  for (const [flag, key] of VALUE_FLAGS) {
    if (options[key] === undefined || options[key] === '') {
      // An empty --app-id is still reported as a non-numeric app id below.
      if (key !== 'appId' || options[key] === undefined) throw new Refusal(`${flag} is required.`);
    }
  }
  if (!APP_ID_PATTERN.test(options.appId)) {
    throw new Refusal('--app-id must be the app\'s numeric Apple ID (App Store Connect > App Information > Apple ID).');
  }
  if (!KEY_ID_PATTERN.test(options.keyId)) {
    throw new Refusal('--key-id must be the key\'s ID as shown in App Store Connect (letters and digits only).');
  }
  if (!ISSUER_PATTERN.test(options.issuer)) {
    throw new Refusal('--issuer must be the Issuer ID shown above the keys list (a UUID).');
  }
}

// ---------------------------------------------------------------- key file

function findGitRepository(startDir) {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export function loadPrivateKey(keyPath) {
  let realPath;
  try {
    realPath = fs.realpathSync(path.resolve(keyPath));
  } catch {
    throw new Refusal('The key file was not found.');
  }
  const stat = fs.statSync(realPath);
  if (!stat.isFile()) throw new Refusal('The key path is not a regular file.');
  if (findGitRepository(path.dirname(realPath))) {
    throw new Refusal('The key file is inside a git repository. Move it outside every code folder (for example ~/Downloads) and try again.');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Refusal('Other users on this Mac can read or change the key file. Run: chmod 600 <the key file>, then try again.');
  }
  if (stat.size === 0 || stat.size > MAX_KEY_FILE_BYTES) {
    throw new Refusal('The key file is not an App Store Connect .p8 key (wrong size).');
  }
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({ key: fs.readFileSync(realPath), format: 'pem' });
  } catch {
    throw new Refusal('The key file is not a readable App Store Connect .p8 key.');
  }
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Refusal('The key file is not an App Store Connect .p8 key (expected an EC P-256 key).');
  }
  return privateKey;
}

// ---------------------------------------------------------------- JWT

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function createAppleJwt({ privateKey, keyId, issuerId, nowMs = Date.now() }) {
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = { iss: issuerId, iat, exp: iat + MAX_TOKEN_LIFETIME_SECONDS, aud: 'appstoreconnect-v1' };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${signature.toString('base64url')}`;
}

// ---------------------------------------------------------------- Apple calls

function assertAppleUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.origin === APPLE_API_ORIGIN && parsed.protocol === 'https:' && !parsed.username && !parsed.password;
}

async function appleRequest(fetchImpl, { step, method, url, token, body }) {
  if (!assertAppleUrl(url)) throw new AppleCallError(step, { shape: true });
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // A fetch timeout rejects with a DOMException whose `code` is a number, so
    // its name has to be checked before any code.
    const candidate = error?.name === 'TimeoutError' ? 'TIMEOUT' : (error?.cause?.code ?? error?.code ?? null);
    const networkCode = typeof candidate === 'string' && NETWORK_CODE_PATTERN.test(candidate) ? candidate : null;
    throw new AppleCallError(step, { network: true, networkCode });
  }
  let parsed = null;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const rawCode = Array.isArray(parsed?.errors) ? parsed.errors[0]?.code : null;
    const code = typeof rawCode === 'string' && APPLE_ERROR_CODE_PATTERN.test(rawCode) ? rawCode : null;
    throw new AppleCallError(step, { status: response.status, code });
  }
  if (parsed === null || typeof parsed !== 'object') throw new AppleCallError(step, { shape: true });
  return { status: response.status, json: parsed };
}

// Reads one report request. Anything the script can't read for certain is a
// shape error, never a guess: a listed request with no attributes, no
// accessType or an accessType other than ONGOING / ONE_TIME_SNAPSHOT stops the
// run before any POST (treating it as "nothing there" would ask Apple for
// duplicates). `requested` is set only for the reply to our own POST, which may
// leave the attributes out (the access type is then the one we asked for) but
// must not name a different one.
function readRequestItem(item, step, { requested = null } = {}) {
  const shapeError = () => new AppleCallError(step, { shape: true });
  if (!item || typeof item !== 'object' || Array.isArray(item) || item.type !== 'analyticsReportRequests') throw shapeError();
  if (typeof item.id !== 'string' || !REQUEST_ID_PATTERN.test(item.id)) throw shapeError();
  const { attributes } = item;
  const hasAttributes = attributes !== null && typeof attributes === 'object' && !Array.isArray(attributes);
  if (!hasAttributes && !(requested && attributes === undefined)) throw shapeError();
  const rawAccessType = hasAttributes ? attributes.accessType : undefined;
  let accessType;
  if (ACCESS_TYPES.includes(rawAccessType)) accessType = rawAccessType;
  else if (requested && rawAccessType === undefined) accessType = requested;
  else throw shapeError();
  if (requested && accessType !== requested) throw shapeError();
  const rawStopped = hasAttributes ? attributes.stoppedDueToInactivity : undefined;
  if (rawStopped !== undefined && rawStopped !== null && typeof rawStopped !== 'boolean') throw shapeError();
  return { id: item.id, accessType, stopped: rawStopped === true };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Apple's advertised total for the whole list (`meta.paging.total`), or
// undefined when the page doesn't give one. A `meta` or `paging` that isn't an
// object, or a total that isn't a whole number >= 0, is a shape error.
function readPagingTotal(json, step) {
  const shapeError = () => new AppleCallError(step, { shape: true });
  if (json.meta === undefined) return undefined;
  if (!isPlainObject(json.meta)) throw shapeError();
  if (json.meta.paging === undefined) return undefined;
  if (!isPlainObject(json.meta.paging)) throw shapeError();
  const { total } = json.meta.paging;
  if (total === undefined) return undefined;
  if (!Number.isSafeInteger(total) || total < 0) throw shapeError();
  return total;
}

// Lists every report request of the app. The result is only returned when it
// is provably the whole list, because "not in the list" is what authorizes a
// POST: `links`, when present, must be an object; `links.next`, when present
// and not null, must be a string on Apple's host; every id appears once; and
// when Apple states a total, the number of ids read must equal it (every page
// that states one must state the same). Anything else stops before any POST.
async function listReportRequests(fetchImpl, { appId, token }) {
  const step = 'listing report requests';
  const shapeError = () => new AppleCallError(step, { shape: true });
  const params = new URLSearchParams({
    'fields[analyticsReportRequests]': 'accessType,stoppedDueToInactivity',
    limit: '200',
  });
  let url = `${APPLE_API_ORIGIN}/v1/apps/${appId}/analyticsReportRequests?${params}`;
  const items = [];
  const seenIds = new Set();
  let advertisedTotal;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const { json } = await appleRequest(fetchImpl, { step, method: 'GET', url, token });
    if (!Array.isArray(json.data)) throw shapeError();
    for (const raw of json.data) {
      const item = readRequestItem(raw, step);
      if (seenIds.has(item.id)) throw shapeError();
      seenIds.add(item.id);
      items.push(item);
    }
    const total = readPagingTotal(json, step);
    if (total !== undefined) {
      if (advertisedTotal !== undefined && advertisedTotal !== total) throw shapeError();
      advertisedTotal = total;
    }
    if (json.links !== undefined && !isPlainObject(json.links)) throw shapeError();
    const next = json.links?.next;
    if (next === undefined || next === null) {
      if (advertisedTotal !== undefined && advertisedTotal !== items.length) {
        throw new AppleCallError(step, { incomplete: true });
      }
      return items;
    }
    if (typeof next !== 'string' || !assertAppleUrl(next)) throw shapeError();
    url = next;
  }
  throw shapeError();
}

async function createReportRequest(fetchImpl, { appId, token, accessType }) {
  const step = `creating the ${accessType} request`;
  const body = {
    data: {
      type: 'analyticsReportRequests',
      attributes: { accessType },
      relationships: { app: { data: { type: 'apps', id: appId } } },
    },
  };
  try {
    const { json } = await appleRequest(fetchImpl, {
      step,
      method: 'POST',
      url: `${APPLE_API_ORIGIN}/v1/analyticsReportRequests`,
      token,
      body,
    });
    return readRequestItem(json.data, step, { requested: accessType });
  } catch (error) {
    // The POST may have reached Apple when the reply is odd or lost, or Apple
    // answered 5xx. A 4xx means Apple refused it.
    if (error instanceof AppleCallError && (error.shape || error.network || (error.status ?? 0) >= 500)) {
      error.mayHaveCreated = true;
    }
    throw error;
  }
}

// ---------------------------------------------------------------- output

function describe(request, outcome) {
  return `Request ${request.id}: ${request.accessType}, ${outcome}, stopped: ${request.stopped ? 'yes' : 'no'}`;
}

// Never advise a re-run here: a fresh list can't prove the earlier create has
// finished, so running --go again could ask Apple for a second one.
const MAY_HAVE_CREATED = 'Apple may or may not have created it; the script can\'t tell. Do NOT run it with --go again. Tell the PM what it printed; the PM will check what exists before anything else is sent.';

function describeError(error) {
  if (error instanceof AppleCallError) {
    const after = error.mayHaveCreated ? ` ${MAY_HAVE_CREATED}` : '';
    if (error.network) {
      const what = `Could not reach Apple while ${error.step} (network error${error.networkCode ? ` ${error.networkCode}` : ''}).`;
      return error.mayHaveCreated ? `${what} Stopped.${after}` : `${what} Nothing else was sent. Re-run when the connection is back.`;
    }
    if (error.incomplete) {
      return `Apple's list of report requests didn't add up while ${error.step} (the count it gave doesn't match the requests it returned). Stopped before creating anything. Tell the PM.`;
    }
    if (error.shape) {
      const what = `Apple's reply while ${error.step} was not in the expected shape.`;
      return error.mayHaveCreated ? `${what} Stopped there.${after}` : `${what} Stopped before creating anything.`;
    }
    return `Apple returned HTTP ${error.status}${error.code ? ` (code ${error.code})` : ''} while ${error.step}. Stopped.${after}`;
  }
  return `Unexpected error (${error?.name ?? 'Error'}). Stopped.`;
}

// ---------------------------------------------------------------- main flow

export async function run(argv, { fetch: fetchImpl = globalThis.fetch, stdout, stderr, now = () => Date.now() } = {}) {
  const out = stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const err = stderr ?? ((line) => process.stderr.write(`${line}\n`));

  let options;
  let privateKey;
  try {
    options = parseArgs(argv);
    if (options.help) {
      for (const line of USAGE) out(line);
      return EXIT_OK;
    }
    validateOptions(options);
    privateKey = loadPrivateKey(options.key);
  } catch (error) {
    if (error instanceof Refusal) {
      err(`Refused: ${error.message}`);
      return EXIT_REFUSED;
    }
    err(describeError(error));
    return EXIT_REFUSED;
  }

  const appId = options.appId;

  if (!options.go && !options.check) {
    // Prove the key can sign, locally. The token is discarded, never shown.
    createAppleJwt({ privateKey, keyId: options.keyId, issuerId: options.issuer, nowMs: now() });
    out('Dry run: no requests were sent to Apple. Add --go to do it for real.');
    out('Key file checks passed: outside any git repository, readable only by you, a valid .p8 key; a token was signed locally.');
    out('With --go this would:');
    out(`  1. GET  /v1/apps/${appId}/analyticsReportRequests  (list this app's report requests)`);
    out('  2. POST /v1/analyticsReportRequests  ONGOING, only if there is no ONGOING request that is still running');
    out('  3. POST /v1/analyticsReportRequests  ONE_TIME_SNAPSHOT, only if there is no snapshot request yet');
    return EXIT_OK;
  }

  const token = createAppleJwt({ privateKey, keyId: options.keyId, issuerId: options.issuer, nowMs: now() });

  if (options.check) {
    // Read-only: one list (with every completeness check), never a POST.
    try {
      const existing = await listReportRequests(fetchImpl, { appId, token });
      for (const request of existing) out(describe(request, 'exists'));
      out(`Check only: ${existing.length} report request${existing.length === 1 ? '' : 's'} listed. Nothing was created or changed.`);
      return EXIT_OK;
    } catch (error) {
      err(describeError(error));
      return EXIT_APPLE;
    }
  }

  try {
    // Every listed request has a known access type here: anything else already
    // stopped the run inside listReportRequests, before any POST.
    const existing = await listReportRequests(fetchImpl, { appId, token });
    for (const request of existing) out(describe(request, 'already existed'));

    const activeOngoing = existing.some((request) => request.accessType === 'ONGOING' && !request.stopped);
    if (!activeOngoing) {
      if (existing.some((request) => request.accessType === 'ONGOING' && request.stopped)) {
        out('The ONGOING request above was stopped due to inactivity; creating a new one.');
      }
      const created = await createReportRequest(fetchImpl, { appId, token, accessType: 'ONGOING' });
      out(describe(created, 'created'));
    }

    const hasSnapshot = existing.some((request) => request.accessType === 'ONE_TIME_SNAPSHOT');
    if (!hasSnapshot) {
      const created = await createReportRequest(fetchImpl, { appId, token, accessType: 'ONE_TIME_SNAPSHOT' });
      out(describe(created, 'created'));
    }

    out('Done. Apple usually needs 1-2 days before the first reports appear.');
    return EXIT_OK;
  } catch (error) {
    err(describeError(error));
    return EXIT_APPLE;
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`Unexpected error (${error?.name ?? 'Error'}). Stopped.\n`);
      process.exitCode = EXIT_APPLE;
    });
}
