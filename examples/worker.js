import { brevo, resend, postmark } from 'formsieve';
import { createWorkerHandler, durableStore, turnstile } from 'formsieve/cloudflare';
export { FormSieveStore } from 'formsieve/durable-object';

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/contact') return new Response('Not found', { status: 404 });
    try {
      const providers = { brevo, resend, postmark };
      const factory = providers[env.MAIL_PROVIDER];
      if (typeof factory !== 'function' || !Object.hasOwn(providers, env.MAIL_PROVIDER)) throw new Error('Invalid provider');
      const allowedOrigins = JSON.parse(env.ALLOWED_ORIGINS);
      return await createWorkerHandler({
        provider: factory({ apiKey: env.MAIL_API_KEY }),
        store: durableStore(env.FORMSIEVE_STORE),
        namespace: 'contact-v1',
        allowedOrigins,
        from: env.MAIL_FROM,
        to: [env.MAIL_TO],
        fields: {
          name: { required: true, maxLength: 100 },
          email: { type: 'email', required: true, maxLength: 254 },
          message: { required: true, maxLength: 4000 },
        },
        // Optional restrictions. Absent country/score is never invented.
        ...(env.ALLOWED_COUNTRIES ? { countries: JSON.parse(env.ALLOWED_COUNTRIES) } : {}),
        verify: turnstile({
          secret: env.TURNSTILE_SECRET,
          hostnames: allowedOrigins.map(origin => new URL(origin).hostname),
          action: 'contact',
        }),
      })(request);
    } catch {
      console.error(JSON.stringify({ event: 'formsieve_configuration_or_runtime_failure' }));
      return Response.json({ ok: false, code: 'service_unavailable' }, { status: 503 });
    }
  },
};
