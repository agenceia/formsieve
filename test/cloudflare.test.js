import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/index.js';
import { createWorkerHandler, turnstile, cloudflareContext } from '../src/cloudflare.js';
const request = () => new Request('https://worker.test/contact', { method: 'POST', headers: { origin: 'https://example.com', 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' }, body: JSON.stringify({ name: 'Jane', verificationToken: 'token' }) });
function handler(extra = {}) {
  return createWorkerHandler({ provider: { send: async () => ({ id: '1', provider: 'test' }) }, store: memoryStore(), from: 'forms@example.com', to: ['team@example.com'], allowedOrigins: ['https://example.com'], fields: { name: { required: true } }, verify: async () => true, ...extra });
}
test('country policy trusts request.cf, not spoofable country headers', async () => {
  const r = request(); r.headers.set('CF-IPCountry', 'DE');
  assert.equal((await handler({ countries: ['DE'] })(r)).status, 422);
  const valid = request(); Object.defineProperty(valid, 'cf', { value: { country: 'DE' } });
  assert.equal((await handler({ countries: ['DE'] })(valid)).status, 200);
});
test('ASN and low bot scores denied, missing score configurable', async () => {
  for (const [cf, policy] of [[{ asn: 123 }, { blockedAsns: [123] }], [{ botManagement: { score: 5 } }, { minBotScore: 30 }], [{}, { requireBotScore: true }]]) {
    const r = request(); Object.defineProperty(r, 'cf', { value: cf });
    assert.equal((await handler(policy)(r)).status, 422);
  }
  assert.equal((await handler({ minBotScore: 30 })(request())).status, 200);
});
test('no missing identity fallback', async () => {
  const r = request(); r.headers.delete('cf-connecting-ip');
  assert.equal((await handler()(r)).status, 503); assert.equal(cloudflareContext(r).country, null);
});
test('Turnstile binds token to action and hostname', async () => {
  for (const [payload, expected] of [[{ success: true, hostname: 'example.com', action: 'contact' }, true], [{ success: true, hostname: 'evil.test', action: 'contact' }, false], [{ success: true, hostname: 'example.com', action: 'login' }, false], [{ success: false }, false]]) {
    const verify = turnstile({ secret: 'test', hostnames: ['example.com'], action: 'contact', fetch: async () => Response.json(payload) });
    assert.equal(await verify({ token: 'token', request: request() }), expected);
  }
});
test('Turnstile fails closed on outage, oversized or missing tokens', async () => {
  const verify = turnstile({ secret: 'test', hostnames: ['example.com'], action: 'contact', fetch: async () => { throw Error(); } });
  for (const token of ['', null, 'a'.repeat(2049), 'token']) assert.equal(await verify({ token, request: request() }), false);
});
