import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brevo, resend, postmark, DeliveryError } from '../src/index.js';
const mail = { from: 'forms@example.com', to: ['team@example.com'], subject: 'Test', text: 'Hello', html: '<p>Hello</p>', replyTo: 'jane@example.com' };
for (const [factory, response, header] of [[brevo, { messageId: '1' }, 'api-key'], [resend, { id: '1' }, 'Authorization'], [postmark, { ErrorCode: 0, MessageID: '1' }, 'X-Postmark-Server-Token']]) {
  test(`${factory.name} contract`, async () => {
    let captured;
    const provider = factory({ apiKey: 'test-secret', sandbox: true, fetch: async (url, init) => { captured = { url, init }; return Response.json(response); } });
    assert.equal((await provider.send(mail)).id, '1');
    assert.ok(captured.init.headers[header].includes('test-secret'));
    assert.equal(captured.init.redirect, 'error'); assert.ok(captured.init.signal);
    const body = JSON.parse(captured.init.body);
    if (factory === brevo) { assert.equal(body.headers['X-Sib-Sandbox'], 'drop'); assert.deepEqual(body.replyTo, { email: mail.replyTo }); }
    if (factory === resend) assert.equal(body.reply_to, mail.replyTo);
    if (factory === postmark) assert.equal(body.ReplyTo, mail.replyTo);
  });
  test(`${factory.name} hides upstream errors and does not retry`, async () => {
    let calls = 0;
    const provider = factory({ apiKey: 'test-secret', fetch: async () => { calls++; return new Response('secret and personal data', { status: 429 }); } });
    await assert.rejects(provider.send(mail), e => e instanceof DeliveryError && e.status === 429 && !e.message.includes('secret'));
    assert.equal(calls, 1);
  });
  test(`${factory.name} rejects malformed success and header injection`, async () => {
    const provider = factory({ apiKey: 'test-secret', fetch: async () => Response.json({}) });
    await assert.rejects(provider.send(mail), DeliveryError);
    await assert.rejects(provider.send({ ...mail, subject: 'x\r\nBcc: attacker@example.com' }), TypeError);
  });
}
test('transport errors never include credentials', async () => {
  const provider = brevo({ apiKey: 'secret', fetch: async () => { throw Error('secret'); } });
  await assert.rejects(provider.send(mail), e => !e.message.includes('secret'));
});
