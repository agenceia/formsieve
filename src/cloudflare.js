import { createFormHandler, readJson } from './index.js';

/** Only trust these fields at Cloudflare's public ingress, never a generic Node proxy. */
export function cloudflareContext(request) {
  const cf = request.cf ?? {};
  return {
    ip: request.headers.get('CF-Connecting-IP'),
    country: typeof cf.country === 'string' ? cf.country : null,
    asn: typeof cf.asn === 'number' ? cf.asn : null,
    botScore: typeof cf.botManagement?.score === 'number' ? cf.botManagement.score : null,
    verifiedBot: cf.botManagement?.verifiedBot === true,
  };
}

export function turnstile({ secret, hostnames, action, fetch: transport = globalThis.fetch }) {
  if (typeof secret !== 'string' || !secret || !Array.isArray(hostnames) || !hostnames.length || hostnames.some(h => typeof h !== 'string' || !h) || typeof action !== 'string' || !action) throw new TypeError('Turnstile secret, hostnames and action are required');
  return async ({ token, request }) => {
    if (typeof token !== 'string' || !token || token.length > 2048) return false;
    try {
      const response = await transport('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, response: token, remoteip: cloudflareContext(request).ip ?? undefined }),
      });
      if (!response.ok) { await response.body?.cancel(); return false; }
      const data = await readJson(response, 16384);
      return data.success === true && hostnames.includes(data.hostname) && data.action === action;
    } catch { return false; }
  };
}

export function durableStore(binding) {
  if (!binding || typeof binding.getByName !== 'function') throw new TypeError('Durable Object binding is required');
  return {
    consume: (key, limit, windowMs) => binding.getByName(key).consume(limit, windowMs),
    claim: (key, ttlMs) => binding.getByName(key).consume(1, ttlMs),
  };
}

export function createWorkerHandler(options) {
  const { countries, blockedAsns = [], minBotScore, requireBotScore = false, verify, ...base } = options;
  if (countries !== undefined && (!Array.isArray(countries) || !countries.length || countries.some(c => !/^[A-Z]{2}$/.test(c)))) throw new TypeError('Countries must be uppercase ISO country codes');
  if (!Array.isArray(blockedAsns) || blockedAsns.some(n => !Number.isSafeInteger(n) || n < 1)) throw new TypeError('Invalid ASN list');
  if (minBotScore !== undefined && (!Number.isInteger(minBotScore) || minBotScore < 1 || minBotScore > 99)) throw new TypeError('Invalid bot score');
  if (typeof verify !== 'function') throw new TypeError('Worker verification is required; use turnstile()');
  return createFormHandler({
    ...base,
    getClientKey: request => cloudflareContext(request).ip,
    verify: async context => {
      const { country, asn, botScore } = cloudflareContext(context.request);
      if (countries && !countries.includes(country)) return false;
      if (blockedAsns.includes(asn)) return false;
      if (requireBotScore && botScore === null) return false;
      if (minBotScore !== undefined && botScore !== null && botScore < minBotScore) return false;
      return await verify(context) === true;
    },
  });
}
