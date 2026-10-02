import { isEmail, readJson } from './index.js';

export class DeliveryError extends Error {
  constructor(provider, status = 0) {
    // Do not include upstream response bodies, keys, recipients, or fetch errors.
    super(`${provider} delivery failed`);
    this.name = 'DeliveryError';
    this.provider = provider;
    this.status = status;
  }
}
function validate(message) {
  if (!message || !isEmail(message.from) || !Array.isArray(message.to) || !message.to.length || message.to.some(email => !isEmail(email)) || (message.replyTo !== undefined && !isEmail(message.replyTo))) throw new TypeError('Invalid mail addresses');
  if (typeof message.subject !== 'string' || !message.subject || message.subject.length > 200 || /[\r\n]/.test(message.subject)) throw new TypeError('Invalid mail subject');
  if ((!message.text && !message.html) || (message.text !== undefined && typeof message.text !== 'string') || (message.html !== undefined && typeof message.html !== 'string')) throw new TypeError('Invalid mail content');
}
function adapter(name, endpoint, authHeader, encode, decode, options) {
  const { apiKey, fetch: transport = globalThis.fetch, timeoutMs = 10000 } = options;
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) throw new TypeError('API key is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new TypeError('Invalid timeout');
  return {
    name,
    async send(message) {
      validate(message);
      try {
        const response = await transport(endpoint, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', [authHeader]: name === 'resend' ? `Bearer ${apiKey}` : apiKey },
          body: JSON.stringify(encode(message)),
        });
        if (!response.ok) { await response.body?.cancel(); throw new DeliveryError(name, response.status); }
        const data = await readJson(response, 65536);
        const id = decode(data);
        if (typeof id !== 'string' || !id) throw new DeliveryError(name, response.status);
        return { provider: name, id };
      } catch (error) {
        if (error instanceof DeliveryError) throw error;
        throw new DeliveryError(name);
      }
    },
  };
}
export function brevo(options) {
  return adapter('brevo', 'https://api.brevo.com/v3/smtp/email', 'api-key', m => ({
    sender: { email: m.from }, to: m.to.map(email => ({ email })), subject: m.subject,
    textContent: m.text, htmlContent: m.html,
    ...(m.replyTo ? { replyTo: { email: m.replyTo } } : {}),
    ...(options.sandbox ? { headers: { 'X-Sib-Sandbox': 'drop' } } : {}),
  }), d => d.messageId, options);
}
export function resend(options) {
  return adapter('resend', 'https://api.resend.com/emails', 'Authorization', m => ({
    from: m.from, to: m.to, subject: m.subject, text: m.text, html: m.html, reply_to: m.replyTo,
  }), d => d.id, options);
}
export function postmark(options) {
  return adapter('postmark', 'https://api.postmarkapp.com/email', 'X-Postmark-Server-Token', m => ({
    From: m.from, To: m.to.join(','), Subject: m.subject, TextBody: m.text, HtmlBody: m.html, ReplyTo: m.replyTo,
  }), d => d.ErrorCode === 0 ? d.MessageID : undefined, options);
}
