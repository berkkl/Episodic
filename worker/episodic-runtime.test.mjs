import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('real Durable Object storage serializes concurrent paid reservations', async () => {
  const result = await build({ stdin: { contents: 'export { EpisodicQuota } from "./worker/episodic-quota.ts"; export default { fetch() { return new Response("test only"); } };', resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', write: false });
  const mf = new Miniflare({ modules: true, script: result.outputFiles[0].text, compatibilityDate: '2026-07-08', durableObjects: { EPISODIC_QUOTA: { className: 'EpisodicQuota', useSQLite: true } } });
  try {
    const ns = await mf.getDurableObjectNamespace('EPISODIC_QUOTA');
    const stub = ns.get(ns.idFromName('concurrency-test'));
    const responses = await Promise.all(Array.from({ length: 30 }, () => stub.fetch('https://quota.internal/reserve', { method: 'POST', body: JSON.stringify({ user: 'test_user' }) })));
    assert.equal(responses.filter(r => r.status === 200).length, 1);
    assert.equal(responses.filter(r => r.status === 429).length, 29);
  } finally { await mf.dispose(); }
});

test('real shared daily budget accepts only the final reservation across different users', async () => {
  const result = await build({ stdin: { contents: `
    import { EpisodicQuota as Quota } from "./worker/episodic-quota.ts";
    export class EpisodicQuota extends Quota {
      constructor(state) { super(state); this.testStorage = state.storage; }
      async fetch(request) {
        if (new URL(request.url).pathname === '/seed-test-counter') {
          await this.testStorage.put('counter', { day: new Date().toISOString().slice(0,10), total:99, minute:0, burst:0, users:{} });
          return new Response('seeded');
        }
        return super.fetch(request);
      }
    }
    export default { fetch() { return new Response('test only'); } };
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', write: false });
  const mf = new Miniflare({ modules: true, script: result.outputFiles[0].text, compatibilityDate: '2026-07-08', durableObjects: { EPISODIC_QUOTA: { className: 'EpisodicQuota', useSQLite: true } } });
  try {
    const ns = await mf.getDurableObjectNamespace('EPISODIC_QUOTA');
    const stub = ns.get(ns.idFromName('daily-test'));
    await stub.fetch('https://quota.internal/seed-test-counter');
    const responses = await Promise.all(Array.from({ length: 30 }, (_, i) => stub.fetch('https://quota.internal/reserve', { method: 'POST', body: JSON.stringify({ user: `person_${i}` }) })));
    assert.equal(responses.filter(r => r.status === 200).length, 1);
    const denied = responses.filter(r => r.status === 429);
    assert.equal(denied.length, 29);
    for (const response of denied) assert.equal((await response.json()).error, 'global_quota');
  } finally { await mf.dispose(); }
});
