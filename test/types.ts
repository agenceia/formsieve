import { brevo, createFormHandler, memoryStore } from 'formsieve';
import { createWorkerHandler, turnstile, durableStore } from 'formsieve/cloudflare';
const base = {
  provider: brevo({ apiKey: 'test', sandbox: true }), store: memoryStore(),
  allowedOrigins: ['https://example.com'], from: 'forms@example.com', to: ['team@example.com'],
  fields: { email: { type: 'email' as const, required: true } },
};
createFormHandler({ ...base, getClientKey: () => 'test' });
createWorkerHandler({ ...base, countries: ['DE'], verify: turnstile({ secret: 'test', hostnames: ['example.com'], action: 'contact' }) });
durableStore({ getByName: () => ({ consume: async () => true }) });
// @ts-expect-error verification is mandatory for Workers
createWorkerHandler(base);
// @ts-expect-error provider names are not email providers
createFormHandler({ ...base, provider: 'brevo', getClientKey: () => 'test' });
