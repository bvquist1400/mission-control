#!/usr/bin/env node

import assert from 'node:assert/strict';

const URL_REGEX = /\bhttps?:\/\/\S+|\bwww\.[^\s]+/gi;
const MAILTO_REGEX = /\bmailto:[^\s]+/gi;
const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_REGEX = /\+?\d[\d().\s-]{7,}\d/g;
const LONG_NUMERIC_ID_REGEX = /\b\d{6,}\b/g;

const JOIN_BLOCK_KEYWORDS = [
  'join microsoft teams meeting',
  'click here to join',
  'meeting id',
  'passcode',
  'dial-in',
  'conference id',
  'join teams meeting',
  'join zoom meeting',
  'one tap mobile',
  'call in',
];

function decodeHtmlEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function stripHtmlToText(value) {
  return decodeHtmlEntities(
    value
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ' ')
  );
}

function redactJoinBlocks(text) {
  const lines = text.split(/\r?\n/);
  const skip = new Set();

  lines.forEach((line, index) => {
    const lowered = line.toLowerCase();
    if (!JOIN_BLOCK_KEYWORDS.some((keyword) => lowered.includes(keyword))) {
      return;
    }

    for (let offset = -1; offset <= 2; offset += 1) {
      const target = index + offset;
      if (target >= 0 && target < lines.length) {
        skip.add(target);
      }
    }
  });

  return lines.filter((_, index) => !skip.has(index)).join('\n');
}

function sanitizeBody(input, maxChars = 4000) {
  const plain = stripHtmlToText(input)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';');

  const withoutJoinBlocks = redactJoinBlocks(plain);

  const scrubbed = withoutJoinBlocks
    .replace(URL_REGEX, ' ')
    .replace(MAILTO_REGEX, ' ')
    .replace(EMAIL_REGEX, ' ')
    .replace(PHONE_REGEX, ' ')
    .replace(LONG_NUMERIC_ID_REGEX, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return scrubbed.slice(0, maxChars).trimEnd();
}

const fixture = `<div>Quarterly planning with team</div>
<div>Join Microsoft Teams Meeting</div>
<div>Click here to join: https://teams.microsoft.com/l/meetup-join/abc</div>
<div>Meeting ID: 123456789</div>
<div>Passcode: 998877</div>
<div>Dial-in: +1 (609) 555-1200</div>
<div>Conference ID: 7654321</div>
<div>Owner: jane.doe@example.com</div>
<div>Backup link www.zoom.us/j/123456</div>
<div>Agenda:\n1. Review blockers\n2. Confirm rollout</div>`;

const sanitized = sanitizeBody(fixture, 120);

assert.equal(URL_REGEX.test(sanitized), false, 'URL should be removed');
assert.equal(EMAIL_REGEX.test(sanitized), false, 'Email should be removed');
assert.equal(MAILTO_REGEX.test(sanitized), false, 'mailto should be removed');
assert.equal(/meeting id|passcode|dial-in|conference id|join microsoft teams meeting/i.test(sanitized), false, 'Join block should be removed');
assert.equal(sanitized.length <= 120, true, 'Text should be truncated to max chars');
assert.equal(/Quarterly planning/i.test(sanitized), true, 'Expected contextual text to remain');

console.log('Calendar sanitizer fixture passed.');
