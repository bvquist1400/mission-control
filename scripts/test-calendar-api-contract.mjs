#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const URL_REGEX = /\bhttps?:\/\/\S+|\bwww\.[^\s]+/i;
const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

function loadLocalEnv() {
  const envPath = path.join(process.cwd(), '.env.local');
  let raw = '';

  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    return {};
  }

  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const equalIndex = trimmed.indexOf('=');
    if (equalIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, equalIndex).trim();
    const value = trimmed.slice(equalIndex + 1).trim().replace(/^"|"$/g, '');
    result[key] = value;
  }

  return result;
}

const LOCAL_ENV = loadLocalEnv();

function envValue(name, fallback = '') {
  if (process.env[name]) {
    return process.env[name];
  }

  return LOCAL_ENV[name] ?? fallback;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function buildRange() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    rangeStart: today,
    rangeEnd: addDays(today, 7),
  };
}

async function requestJson(url, init) {
  let response;

  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new Error(`Unable to reach ${url}. Start the app first (npm run dev). ${error instanceof Error ? error.message : ''}`.trim());
  }

  const text = await response.text();
  let json = null;

  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  return { response, json, raw: text };
}

function assertEventContract(event) {
  const allowed = new Set([
    'start_at',
    'end_at',
    'title',
    'with_display',
    'body_scrubbed_preview',
    'is_all_day',
    'external_event_id',
  ]);

  for (const key of Object.keys(event)) {
    assert.equal(allowed.has(key), true, `Unexpected event key returned: ${key}`);
  }

  assert.equal(typeof event.start_at, 'string');
  assert.equal(typeof event.end_at, 'string');
  assert.equal(typeof event.title, 'string');
  assert.equal(Array.isArray(event.with_display), true);
  assert.equal(typeof event.is_all_day, 'boolean');
  assert.equal(typeof event.external_event_id, 'string');

  if (event.body_scrubbed_preview !== null) {
    assert.equal(typeof event.body_scrubbed_preview, 'string');
    assert.equal(URL_REGEX.test(event.body_scrubbed_preview), false, 'Preview should not contain URLs');
    assert.equal(EMAIL_REGEX.test(event.body_scrubbed_preview), false, 'Preview should not contain emails');
  }

  assert.equal('body_scrubbed' in event, false, 'Raw scrubbed body must not be returned by /api/calendar');
  assert.equal('location' in event, false, 'Location must not be returned by /api/calendar');
}

async function createBearerToken() {
  const explicitToken = envValue('CALENDAR_TEST_BEARER_TOKEN');
  if (explicitToken) {
    return { token: explicitToken, cleanup: null };
  }

  const supabaseUrl = envValue('NEXT_PUBLIC_SUPABASE_URL');
  const supabaseAnonKey = envValue('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const serviceRoleKey = envValue('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    throw new Error('Missing Supabase keys. Set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.');
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const anon = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `calendar-contract-${nonce}@example.com`;
  const password = `TmpPass!${Math.random().toString(36).slice(2, 12)}A1`;

  const { data: createdUserData, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (createError || !createdUserData.user) {
    throw new Error(`Unable to create test user for API contract test: ${createError?.message ?? 'unknown error'}`);
  }

  const userId = createdUserData.user.id;

  const { data: sessionData, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  if (signInError || !sessionData.session?.access_token) {
    await admin.auth.admin.deleteUser(userId);
    throw new Error(`Unable to sign in test user for API contract test: ${signInError?.message ?? 'unknown error'}`);
  }

  return {
    token: sessionData.session.access_token,
    cleanup: async () => {
      await admin.auth.admin.deleteUser(userId);
    },
  };
}

async function main() {
  const baseUrl = envValue('CALENDAR_API_BASE_URL', 'http://localhost:3000').replace(/\/$/, '');
  const { rangeStart, rangeEnd } = buildRange();
  const endpoint = `${baseUrl}/api/calendar?rangeStart=${rangeStart}&rangeEnd=${rangeEnd}`;

  const unauth = await requestJson(endpoint);
  assert.equal(unauth.response.status, 401, `Expected 401 for unauthenticated request, got ${unauth.response.status}`);

  const authContext = await createBearerToken();

  try {
    const authed = await requestJson(endpoint, {
      headers: {
        Authorization: `Bearer ${authContext.token}`,
      },
    });

    assert.equal(authed.response.status, 200, `Expected 200 for authenticated request, got ${authed.response.status}`);
    assert.equal(authed.json && typeof authed.json === 'object', true, 'Expected JSON object response');

    const payload = authed.json;

    assert.equal(Array.isArray(payload.events), true, 'Expected events array');
    assert.equal(Array.isArray(payload.busyBlocks), true, 'Expected busyBlocks array');
    assert.equal(typeof payload.stats, 'object', 'Expected stats object');
    assert.equal(typeof payload.changesSince, 'object', 'Expected changesSince object');
    assert.equal(typeof payload.ingest, 'object', 'Expected ingest object');

    for (const event of payload.events) {
      assertEventContract(event);
    }

    for (const block of payload.busyBlocks) {
      assert.equal(typeof block.start_at, 'string');
      assert.equal(typeof block.end_at, 'string');
    }

    assert.equal(typeof payload.stats.busyMinutes, 'number');
    assert.equal(typeof payload.stats.blocks, 'number');
    assert.equal(typeof payload.stats.largestFocusBlockMinutes, 'number');

    assert.equal(Array.isArray(payload.changesSince.added), true);
    assert.equal(Array.isArray(payload.changesSince.removed), true);
    assert.equal(Array.isArray(payload.changesSince.changed), true);

    assert.equal(typeof payload.ingest.source, 'string');
    assert.equal(typeof payload.ingest.ingestedCount, 'number');
    assert.equal(typeof payload.ingest.warningCount, 'number');

    console.log('Calendar API contract test passed.');
  } finally {
    if (authContext.cleanup) {
      await authContext.cleanup();
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
});
