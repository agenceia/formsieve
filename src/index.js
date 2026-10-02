export { brevo, resend, postmark, DeliveryError } from './providers.js';
export { memoryStore } from './memory-store.js';

export class FormError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'FormError';
    this.code = code;
    this.status = status;
  }
}

/** Read bytes incrementally; Content-Length alone is not trustworthy. */
export async function readJson(request, maxBytes = 16384) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Invalid body limit');
  if (!request.body) throw new FormError('invalid_json');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new FormError('body_too_large', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new FormError('invalid_json'); }
}

export function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 &&
    /^[^\s@<>(),;:"\\\x00-\x1f\x7f]+@[^\s@<>(),;:"\\\x00-\x1f\x7f]+\.[^\s@<>(),;:"\\\x00-\x1f\x7f]+$/.test(value);
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function positive(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid ${name}`);
}
async function digest(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

/** Server-only. All configuration, especially recipients and provider, must be trusted. */
export function createFormHandler(options) {
  const {
    provider, store, allowedOrigins, fields, from, to, subject = 'New form submission',
    namespace = 'contact', getClientKey, verify, honeypot = 'website',
    maxBytes = 16384, maxLinks = 3, rateLimit = 5, rateWindowMs = 60000,
    duplicateTtlMs = 600000, validate,
  } = options;
  if (!provider || typeof provider.send !== 'function') throw new TypeError('Provider is required');
  if (!store || typeof store.consume !== 'function' || typeof store.claim !== 'function') throw new TypeError('Atomic store is required');
  if (typeof getClientKey !== 'function') throw new TypeError('Trusted client key resolver is required');
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.length || allowedOrigins.some(origin => {
    try { const url = new URL(origin); return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin; }
    catch { return true; }
  })) throw new TypeError('Exact HTTP(S) origins are required');
  if (!fields || !Object.keys(fields).length) throw new TypeError('Field schema is required');
  if (!isEmail(from) || !Array.isArray(to) || !to.length || to.some(email => !isEmail(email))) throw new TypeError('Valid fixed sender and recipients are required');
  if (typeof subject !== 'string' || !subject || subject.length > 200 || /[\r\n]/.test(subject)) throw new TypeError('Invalid subject');
  if (typeof namespace !== 'string' || !namespace || namespace.length > 100) throw new TypeError('Invalid namespace');
  for (const [key, rule] of Object.entries(fields)) {
    if (['__proto__', 'constructor', 'prototype', honeypot, 'verificationToken'].includes(key)) throw new TypeError('Reserved field');
    if (!rule || !['text', 'email'].includes(rule.type ?? 'text')) throw new TypeError('Invalid field type');
    positive(rule.maxLength ?? 2000, 'field limit');
  }
  for (const [name, value] of Object.entries({ maxBytes, rateLimit, rateWindowMs, duplicateTtlMs })) positive(value, name);
  if (!Number.isSafeInteger(maxLinks) || maxLinks < 0) throw new TypeError('Invalid link limit');
  const origins = new Set(allowedOrigins);
  return async function handle(request) {
    const origin = request.headers.get('origin');
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin' };
    if (origins.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
    const reply = (status, code, extra = {}) => new Response(JSON.stringify({ ok: status < 300, code }), { status, headers: { ...headers, ...extra } });
    try {
      if (!origins.has(origin)) return reply(403, 'origin_denied');
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
        ...headers, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',
      } });
      if (request.method !== 'POST') return reply(405, 'method_not_allowed', { Allow: 'POST, OPTIONS' });
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, 'json_required');
      const clientKey = await getClientKey(request);
      if (typeof clientKey !== 'string' || !clientKey || clientKey.length > 512) return reply(503, 'client_identity_unavailable');
      const key = `${namespace}:rate:${await digest(clientKey)}`;
      if (!await store.consume(key, rateLimit, rateWindowMs)) return reply(429, 'rate_limited', { 'Retry-After': String(Math.ceil(rateWindowMs / 1000)) });
      const body = await readJson(request, maxBytes);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, 'invalid_form');
      if (Object.hasOwn(body, honeypot) && (typeof body[honeypot] !== 'string' || body[honeypot].trim())) return reply(422, 'submission_rejected');
      const data = Object.create(null);
      for (const [key, rule] of Object.entries(fields)) {
        const raw = body[key];
        if (raw !== undefined && typeof raw !== 'string') return reply(400, 'invalid_form');
        const value = (raw ?? '').trim();
        if ((rule.required && !value) || value.length > (rule.maxLength ?? 2000) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return reply(400, 'invalid_form');
        if (value && rule.type === 'email' && !isEmail(value)) return reply(400, 'invalid_form');
        data[key] = value;
      }
      // Unknown fields are discarded, never forwarded into provider configuration.
      if ((Object.values(data).join('\n').match(/https?:\/\/|www\./gi) ?? []).length > maxLinks) return reply(422, 'submission_rejected');
      if (validate && await validate(data) !== true) return reply(400, 'invalid_form');
      if (verify && await verify({ token: body.verificationToken, request, data }) !== true) return reply(422, 'verification_failed');
      // Atomic claim BEFORE sending prevents concurrent identical deliveries. Kept on
      // ambiguous provider failures: retrying/failing over could send a second email.
      const fingerprint = await digest(JSON.stringify(Object.entries(data).sort(([a], [b]) => a.localeCompare(b))));
      if (!await store.claim(`${namespace}:duplicate:${fingerprint}`, duplicateTtlMs)) return reply(409, 'duplicate_submission');
      const text = Object.entries(data).map(([key, value]) => `${fields[key].label ?? key}: ${value}`).join('\n\n');
      const replyToKey = Object.keys(fields).find(key => fields[key].type === 'email' && data[key]);
      await provider.send({ from, to, subject, text, html: `<pre>${escapeHtml(text)}</pre>`, ...(replyToKey ? { replyTo: data[replyToKey] } : {}) });
      return reply(200, 'sent');
    } catch (error) {
      if (error instanceof FormError) return reply(error.status, error.code);
      if (error?.name === 'DeliveryError') return reply(502, 'delivery_failed');
      return reply(503, 'service_unavailable');
    }
  };
}
