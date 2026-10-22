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
