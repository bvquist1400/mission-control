export type CalendarEventSource = 'local' | 'ical' | 'graph';

export interface CalendarEventIdentity {
  source: CalendarEventSource;
  externalEventId: string;
  startAt: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesToBinary(bytes: Uint8Array): string {
  let binary = '';

  for (let index = 0; index < bytes.length; index += 0x8000) {
    const chunk = bytes.subarray(index, index + 0x8000);
    binary += String.fromCharCode(...chunk);
  }

  return binary;
}

function binaryToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function encodeBase64(binary: string): string {
  if (typeof globalThis.btoa === 'function') {
    return globalThis.btoa(binary);
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(binary, 'binary').toString('base64');
  }

  throw new Error('No base64 encoder available');
}

function decodeBase64(input: string): string {
  if (typeof globalThis.atob === 'function') {
    return globalThis.atob(input);
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(input, 'base64').toString('binary');
  }

  throw new Error('No base64 decoder available');
}

function toBase64Url(value: string): string {
  const base64 = encodeBase64(bytesToBinary(textEncoder.encode(value)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return textDecoder.decode(binaryToBytes(decodeBase64(padded)));
}

export function encodeCalendarEventIdentity(identity: CalendarEventIdentity): string {
  return toBase64Url(`${identity.source}|${identity.externalEventId}|${identity.startAt}`);
}

export function decodeCalendarEventIdentity(input: string): CalendarEventIdentity | null {
  try {
    const decoded = fromBase64Url(input);
    const [source, externalEventId, startAt] = decoded.split('|');
    if (!source || !externalEventId || !startAt) {
      return null;
    }

    if (source !== 'local' && source !== 'ical' && source !== 'graph') {
      return null;
    }

    return {
      source,
      externalEventId,
      startAt,
    };
  } catch {
    return null;
  }
}

export function buildCalendarEntityId(identity: CalendarEventIdentity): string {
  return `calendar:${encodeCalendarEventIdentity(identity)}`;
}

export function parseCalendarEntityId(input: string): CalendarEventIdentity | null {
  if (!input.startsWith('calendar:')) {
    return null;
  }

  return decodeCalendarEventIdentity(input.slice('calendar:'.length));
}
