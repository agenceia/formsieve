import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFormHandler, memoryStore, DeliveryError } from '../src/index.js';
const valid = { name: 'Jane', email: 'jane@example.com', message: 'Please call me.', website: '' };
export function setup(overrides = {}) {
  const sent = [];
  const handle = createFormHandler({
    provider: { send: async mail => { sent.push(mail); return { provider: 'test', id: '1' }; } },
    store: memoryStore(), allowedOrigins: ['https://example.com'], getClientKey: () => '192.0.2.1',
    from: 'forms@example.com', to: ['team@example.com'],
    fields: { name: { required: true, maxLength: 100 }, email: { type: 'email', required: true }, message: { required: true, maxLength: 4000 } },
    ...overrides,
  });
  return { handle, sent };
}
export function request(body = valid, headers = {}) {
  return new Request('https://worker.test/contact', { method: 'POST', headers: { origin: 'https://example.com', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
test('valid submission uses fixed recipients and escapes HTML', async () => {
  const { handle, sent } = setup();
  const r = await handle(request({ ...valid, name: '<img src=x>', to: ['attacker@example.com'] }));
  assert.equal(r.status, 200); assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['team@example.com']); assert.equal(sent[0].replyTo, valid.email);
  assert.match(sent[0].html, /&lt;img src=x&gt;/); assert.equal(r.headers.get('access-control-allow-origin'), 'https://example.com');
});
for (const origin of ['https://example.com.evil.test', 'null', '', 'http://example.com']) test(`reject origin ${origin}`, async () => {
  const { handle, sent } = setup(); const r = await handle(request(valid, { origin }));
  assert.equal(r.status, 403); assert.equal(r.headers.get('access-control-allow-origin'), null); assert.equal(sent.length, 0);
});
test('preflight is permitted without rate usage', async () => {
  const { handle } = setup({ store: { consume: () => { throw Error(); }, claim: () => { throw Error(); } } });
  const r = await handle(new Request('https://worker.test', { method: 'OPTIONS', headers: { origin: 'https://example.com' } }));
  assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
});
for (const body of [null, [], 5, { ...valid, name: {} }, { ...valid, email: 'x\r\n@example.com' }, { ...valid, name: '' }]) test(`reject malformed form ${JSON.stringify(body)}`, async () => {
  const { handle, sent } = setup(); assert.equal((await handle(request(body))).status, 400); assert.equal(sent.length, 0);
});
test('reject honeypot and link floods before sending', async () => {
  const { handle, sent } = setup();
  assert.equal((await handle(request({ ...valid, website: 'spam' }))).status, 422);
  assert.equal((await handle(request({ ...valid, message: 'https://a https://b https://c https://d' }))).status, 422);
  assert.equal(sent.length, 0);
});
test('byte limit works without Content-Length', async () => {
  const { handle } = setup({ maxBytes: 100 });
  assert.equal((await handle(request({ ...valid, message: 'ü'.repeat(100) }))).status, 413);
});
test('invalid JSON and content type', async () => {
  const { handle } = setup();
  assert.equal((await handle(request(valid, { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await handle(new Request('https://worker.test', { method: 'POST', headers: { origin: 'https://example.com', 'content-type': 'application/json' }, body: '{' }))).status, 400);
});
test('concurrent duplicates deliver once', async () => {
  const { handle, sent } = setup({ rateLimit: 50 });
  const results = await Promise.all(Array.from({ length: 20 }, () => handle(request())));
  assert.equal(results.filter(r => r.status === 200).length, 1); assert.equal(results.filter(r => r.status === 409).length, 19); assert.equal(sent.length, 1);
});
test('rate limit includes rejected attempts and returns Retry-After', async () => {
  const { handle, sent } = setup({ rateLimit: 1 });
  await handle(request({ ...valid, website: 'bot' })); const r = await handle(request());
  assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '60'); assert.equal(sent.length, 0);
});
test('store outages fail closed', async () => {
  const { handle, sent } = setup({ store: { consume: async () => { throw Error('secret'); }, claim: async () => true } });
  const r = await handle(request()); assert.equal(r.status, 503); assert.doesNotMatch(await r.text(), /secret/); assert.equal(sent.length, 0);
});
test('provider failure is sanitized and duplicate reservation retained', async () => {
  let calls = 0;
  const { handle } = setup({ provider: { send: async () => { calls++; throw new DeliveryError('test', 500); } } });
  assert.equal((await handle(request())).status, 502); assert.equal((await handle(request())).status, 409); assert.equal(calls, 1);
});
test('custom validation and verification block sends', async () => {
  for (const options of [{ validate: () => false }, { verify: () => false }, { verify: () => { throw Error(); } }]) {
    const { handle, sent } = setup(options); assert.ok((await handle(request())).status >= 400); assert.equal(sent.length, 0);
  }
});
test('memory expiry and capacity fail closed', async () => {
  let now = 0; const store = memoryStore({ now: () => now, maxEntries: 1 });
  assert.equal(await store.claim('a', 100), true); assert.equal(await store.claim('a', 100), false);
  await assert.rejects(store.claim('b', 100)); now = 101; assert.equal(await store.claim('b', 100), true);
});
test('configuration rejects open origin policy and bad sender', () => {
  assert.throws(() => setup({ allowedOrigins: ['*'] })); assert.throws(() => setup({ from: 'bad' }));
});
