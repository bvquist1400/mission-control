import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { saveBrief, actOnBriefItems } from '../src/lib/briefs/service.ts';
import { parseSaveBriefInput, parseBriefActions } from '../src/lib/briefs/validate.ts';

const url = process.env.BRIEFS_TEST_SUPABASE_URL;
assert.ok(url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname));
delete process.env.BASELINE_TELEGRAM_BOT_TOKEN;
delete process.env.BASELINE_TELEGRAM_CHAT_ID;
const admin = createClient(url, process.env.BRIEFS_TEST_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const parse = (fn, value) => { const r = fn(value); assert.equal(r.ok, true, r.errors?.join('; ')); return r.value; };
const email = `briefs-r2-${randomUUID()}@example.test`;
const made = await admin.auth.admin.createUser({ email, password: randomUUID(), email_confirm: true });
if (made.error) throw made.error;
const userId = made.data.user.id;
try {
  const t = await admin.from('tasks').insert({ user_id: userId, title: 'Synthetic carry task', status: 'Backlog', task_type: 'Task' }).select('id').single();
  if (t.error) throw t.error;
  const s = await saveBrief(admin, userId, parse(parseSaveBriefInput, {
    date: '2026-09-25', items: [{ kind: 'carry_over', title: 'Synthetic carry', task_ids: [t.data.id] }],
  }), { appUrl: 'http://localhost:3000', notifier: { send: async () => {} } });
  let reached, release;
  const atWrite = new Promise(r => { reached = r; });
  const gate = new Promise(r => { release = r; });
  let fake;
  fake = new Proxy({}, { get(_, key) {
    if (key === 'then') return resolve => gate.then(() => resolve({ data: null, error: { message: 'synthetic task update failure' } }));
    return () => fake;
  } });
  const delayed = new Proxy(admin, { get(target, key) {
    if (key !== 'from') return target[key];
    return table => {
      const q = target.from(table);
      if (table !== 'tasks') return q;
      return new Proxy(q, { get(query, method) {
        if (method === 'update') return () => { reached(); return fake; };
        return query[method];
      } });
    };
  } });
  const action = parse(parseBriefActions, [{ n: 1, action: 'done' }]);
  const firstPending = actOnBriefItems(delayed, userId, s.code, action);
  await atWrite;
  const repeat = await actOnBriefItems(admin, userId, s.code, action);
  release();
  const first = await firstPending;
  assert.equal(first.results[0].ok, false);
  const row = await admin.from('brief_items').select('state').eq('brief_id', s.brief_id).single();
  const task = await admin.from('tasks').select('status').eq('id', t.data.id).single();
  assert.equal(row.data.state, 'open');
  assert.equal(task.data.status, 'Backlog');
  console.log('observed repeat:', repeat.results[0], 'first:', first.results[0], 'final:', row.data.state, task.data.status);
  assert.equal(repeat.results[0].ok, false, 'a repeat must not report success before its task write is durable');
} finally {
  await admin.auth.admin.deleteUser(userId);
}
