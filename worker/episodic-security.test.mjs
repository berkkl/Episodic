import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temp = await mkdtemp(join(process.cwd(), '.test-episodic-'));
const files = ['episodic', 'episodic-quota', 'episodic-body', 'episodic-friends', 'episodic-ai'];
await build({ entryPoints: files.map(x => `worker/${x}.ts`), outdir: temp, bundle: true, platform: 'node', format: 'esm', packages: 'external', outExtension: { '.js': '.mjs' } });
after(() => rm(temp, { recursive: true, force: true }));
const [{ handleEpisodic }, { EpisodicQuota, reserveAsk }, { readBody, BodyTooLarge }, { publicView }, { handleAsk }] = await Promise.all(files.map(x => import(pathToFileURL(join(temp, `${x}.mjs`)))));

function store() {
  const data = new Map(); let queue = Promise.resolve();
  return { get: async key => structuredClone(data.get(key)), put: async (key, value) => { data.set(key, structuredClone(value)); }, transaction(fn) {
    const next = queue.then(() => fn(this)); queue = next.catch(() => {}); return next;
  } };
}
const req = user => new Request('https://quota.internal/reserve', { method: 'POST', body: JSON.stringify({ user }) });

// The storage mock serializes transactions, matching Durable Object storage guarantees.
test('concurrent requests from one user reserve only one paid call', async () => {
  const storage = store(), q = new EpisodicQuota({ storage });
  const responses = await Promise.all(Array.from({ length: 40 }, () => q.fetch(req('tester'))));
  assert.equal(responses.filter(r => r.status === 200).length, 1);
  assert.equal((await storage.get('counter')).total, 1);
});
test('reserved JavaScript property names cannot bypass the per-user reservation', async () => {
  const q = new EpisodicQuota({ storage: store() });
  assert.equal((await q.fetch(req('__proto__'))).status, 200);
  assert.equal((await q.fetch(req('__proto__'))).status, 429);
});

test('global burst and daily ceilings hold across users', async () => {
  const storage = store(), q = new EpisodicQuota({ storage });
  const responses = await Promise.all(Array.from({ length: 40 }, (_, i) => q.fetch(req(`user_${i}`))));
  assert.equal(responses.filter(r => r.status === 200).length, 20);
  const c = await storage.get('counter'); c.total = 300; c.burst = 0; await storage.put('counter', c);
  assert.equal((await q.fetch(req('fresh_user'))).status, 429);
});
test('per-user daily ceiling and UTC reset are independent of global capacity', async () => {
  const storage = store(), q = new EpisodicQuota({ storage });
  const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
  await storage.put('counter', { day, total: 100, minute: 0, burst: 0, users: { 'u:tester': { used: 100, last: 0 } } });
  assert.equal((await q.fetch(req('tester'))).status, 429);
  await storage.put('counter', { day: '2000-01-01', total: 300, minute: 0, burst: 20, users: { 'u:tester': { used: 100, last: 0 } } });
  assert.equal((await q.fetch(req('tester'))).status, 200);
});
test('quota outages fail closed', async () => {
  assert.equal((await reserveAsk(undefined, 'tester')).status, 503);
  assert.equal((await reserveAsk({ idFromName() { throw Error('offline'); } }, 'tester')).status, 503);
});
test('streaming body cap measures bytes and cannot be bypassed by omitting the length header', async () => {
  await assert.rejects(readBody(new Request('https://example.test', { method: 'POST', body: 'é'.repeat(5) }), 8), BodyTooLarge);
  assert.equal(await readBody(new Request('https://example.test', { method: 'POST', body: 'test' }), 4), 'test');
});
test('unauthenticated callers cannot invoke AI or read private data', async () => {
  for (const [path, method] of [['ask','POST'], ['data','GET'], ['friends','GET'], ['profile','GET'], ['feed','GET'], ['where','GET']]) {
    const request = new Request(`https://example.test/api/episodic/${path}`, { method, headers: { Origin: 'https://example.test' } });
    const response = await handleEpisodic(request, {}, `/api/episodic/${path}`);
    assert.equal(response.status, 401);
  }
});
test('write origin must match scheme, host and port exactly', async () => {
  for (const origin of ['https://other.test', 'http://example.test', 'https://example.test:8443', 'http://localhost']) {
    const r = await handleEpisodic(new Request('https://example.test/api/episodic/ask', { method: 'POST', headers: { Origin: origin } }), {}, '/api/episodic/ask');
    assert.equal(r.status, 403);
  }
});
test('friend views exclude private shows, notes, chat history and raw watch records', () => {
  const view = publicView({ shows: { hidden: { private: true, name: 'Private' }, visible: { name: 'Visible', progress: { secret: 1 }, eps: { raw: { w: '2026-01-01' }, rated: { r: 4, c: 'Shared comment' } } } }, diary: [{ showId: 'hidden' }, { showId: 'visible', private: true }, { showId: 'visible', review: 'Shared' }], chats: ['private prompt'] });
  assert.deepEqual(Object.keys(view.shows), ['visible']);
  assert.equal(view.shows.visible.progress, undefined);
  assert.deepEqual(Object.keys(view.shows.visible.eps), ['rated']);
  assert.equal(view.diary.length, 1);
  assert.equal(view.chats, undefined);
});
test('AI input and failed quota reservation never reach the provider', async (t) => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('must not call provider'); });
  const env = { OPENROUTER_API_KEY: 'test-placeholder' };
  const oversize = await handleAsk(new Request('https://example.test', { method: 'POST', body: 'x'.repeat(33_000) }), env, 'tester');
  assert.equal(oversize.status, 413);
  const unavailable = await handleAsk(new Request('https://example.test', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'A series please' }] }) }), env, 'tester');
  assert.equal(unavailable.status, 503);
  assert.equal(calls, 0);
});
test('production deployment binds and exports the quota object', async () => {
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  assert.ok(config.durable_objects.bindings.some(b => b.name === 'EPISODIC_QUOTA' && b.class_name === 'EpisodicQuota'));
  assert.ok(config.migrations.some(m => m.new_sqlite_classes?.includes('EpisodicQuota')));
  assert.ok((await readFile('worker/index.ts', 'utf8')).includes('export { EpisodicQuota }'));
});
