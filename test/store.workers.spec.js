import { env } from 'cloudflare:workers';
import { runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { test, expect } from 'vitest';
import { createWorkerHandler, durableStore } from '../src/cloudflare.js';

test('global atomic counter allows exactly five concurrent requests', async () => {
  const stub = env.FORMSIEVE_STORE.getByName(crypto.randomUUID());
  const results = await Promise.all(Array.from({ length: 30 }, () => stub.consume(5, 60000)));
  expect(results.filter(Boolean)).toHaveLength(5);
  await runInDurableObject(stub, async (_, state) => {
    expect((await state.storage.get('counter')).count).toBe(5);
    expect(await state.storage.getAlarm()).not.toBeNull();
  });
});
test('independent identities and duplicate claims', async () => {
  const store = durableStore(env.FORMSIEVE_STORE);
  const key = crypto.randomUUID();
  expect(await store.claim(key, 60000)).toBe(true);
  expect(await store.claim(key, 60000)).toBe(false);
  expect(await store.claim(crypto.randomUUID(), 60000)).toBe(true);
});
test('expiry alarm cleans persisted state', async () => {
  const stub = env.FORMSIEVE_STORE.getByName(crypto.randomUUID());
  await stub.consume(1, 60000);
  await runInDurableObject(stub, async (_, state) => {
    await state.storage.put('counter', { count: 1, expires: Date.now() - 1 });
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await runInDurableObject(stub, async (_, state) => expect(await state.storage.get('counter')).toBeUndefined());
  expect(await stub.consume(1, 60000)).toBe(true);
});
test('early alarms preserve current counter', async () => {
  const stub = env.FORMSIEVE_STORE.getByName(crypto.randomUUID());
  await stub.consume(1, 60000);
  await runDurableObjectAlarm(stub);
  expect(await stub.consume(1, 60000)).toBe(false);
});
test('Worker pipeline with real shared storage sends once across handler instances', async () => {
  let sends = 0;
  const namespace = crypto.randomUUID();
  const options = {
    namespace, provider: { send: async () => { sends++; return { provider: 'test', id: '1' }; } },
    store: durableStore(env.FORMSIEVE_STORE), allowedOrigins: ['https://example.com'],
    from: 'forms@example.com', to: ['team@example.com'], fields: { name: { required: true } },
    verify: async () => true, countries: ['DE'], rateLimit: 50,
  };
  const results = await Promise.all(Array.from({ length: 10 }, () => createWorkerHandler(options)(new Request('https://worker.test/contact', {
    method: 'POST', cf: { country: 'DE' }, headers: { origin: 'https://example.com', 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' }, body: JSON.stringify({ name: 'Jane' }),
  }))));
  expect(results.filter(r => r.status === 200)).toHaveLength(1);
  expect(results.filter(r => r.status === 409)).toHaveLength(9);
  expect(sends).toBe(1);
});
