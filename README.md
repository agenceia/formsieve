# FormSieve

An MIT-licensed, Cloudflare Workers-first library that protects browser forms before sending email through Brevo, Resend, Postmark, or your own adapter. Version 0.1.0; local source package, not yet published to npm.

```text
Browser form → Cloudflare Worker → email provider → fixed recipient
                   │
                   ├─ exact CORS allowlist + bounded JSON validation
                   ├─ shared rate limits + honeypot + link limit
                   ├─ optional country / ASN / bot-score rules
                   ├─ Turnstile verification (hostname + action)
                   └─ atomic duplicate reservation in Durable Objects
```

No runtime npm dependencies. Standard Fetch/Web Crypto APIs. Node 22+ for development. Cloudflare-specific exports are separate from the portable core.

## Run locally

```sh
npm ci
npm test
npm run test:workers
npm run check
npm run dev
```

The example handles `POST /contact`. Edit `wrangler.jsonc` with your sender, recipient, exact frontend origins, and optional `ALLOWED_COUNTRIES` (JSON array, e.g. `["DE","FR","CH"]`). Configure a Turnstile widget for the frontend hostnames. Copy `.dev.vars.example` to `.dev.vars` and fill in local secrets. Cloudflare IP/geolocation values can be absent locally; test country policies with the runtime tests, not fabricated production fallbacks.

Serve `examples/browser.html` from an allowed HTTP origin, replace its endpoint and public sitekey, and retain its `data-action` equivalent (`action: 'contact'`). It sends `{ name, email, message, website, verificationToken }`. The sitekey is public; email and Turnstile secrets are server-only. Always reset Turnstile after an attempt.

## Deploy

```sh
npx wrangler secret put MAIL_API_KEY
npx wrangler secret put TURNSTILE_SECRET
npx wrangler deploy
```

Set `MAIL_PROVIDER` to `brevo`, `resend`, or `postmark`; use a verified sender for that provider. The included SQLite-backed Durable Object migration is required. Keep one stable namespace per form; sharing a namespace shares rate limits and duplicate reservations. Deployment and public package publication are separate operator actions.

For another project, install the local library with `npm install ../formsieve`, or package it with `npm pack`. Copy and adapt `examples/worker.js` and the bindings/migration from `wrangler.jsonc`. No registry name availability is claimed.

## Worker API

```js
import { brevo } from 'formsieve';
import { createWorkerHandler, durableStore, turnstile } from 'formsieve/cloudflare';
export { FormSieveStore } from 'formsieve/durable-object';

export default {
  async fetch(request, env) {
    const handle = createWorkerHandler({
      provider: brevo({ apiKey: env.MAIL_API_KEY }),
      store: durableStore(env.FORMSIEVE_STORE),
      namespace: 'contact',
      allowedOrigins: ['https://example.com'],
      from: 'forms@example.com',
      to: ['team@example.com'],
      fields: {
        name: { required: true, maxLength: 100 },
        email: { type: 'email', required: true },
        message: { required: true, maxLength: 4000 },
      },
      verify: turnstile({ secret: env.TURNSTILE_SECRET, hostnames: ['example.com'], action: 'contact' }),
      // Optional: countries: ['DE', 'FR'], blockedAsns: [12345],
      // minBotScore: 30, requireBotScore: true,
    });
    return handle(request);
  },
};
```

`cloudflareContext(request)` exposes IP, country, ASN, bot score and verified-bot status. Country/ASN/score come from `request.cf`, never body fields or `CF-IPCountry`. IP comes from `CF-Connecting-IP`; use the Worker at Cloudflare's public ingress. Do not expose this trust policy on an arbitrary origin server or through an untrusted Worker that can alter visitor identity. Verified bots do not bypass form protection.

Bot Management score availability depends on Cloudflare configuration. `minBotScore` checks available scores; `requireBotScore: true` rejects missing scores. Country allowlists also reject missing country data. Location and network rules can reject VPNs, travellers and legitimate customers; disabled by default. They are policy signals, not proof of fraud.

## Core configuration

| Option | Default / contract |
| --- | --- |
| `provider` | Required `{ send(mail): Promise<{ provider, id }> }` |
| `store` | Required atomic `consume(key, limit, windowMs)` and `claim(key, ttlMs)` |
| `allowedOrigins` | Required exact origins, including scheme and port; no wildcard, null or missing origins |
| `fields` | Required field schema; `type: 'text' \| 'email'`, `required`, `maxLength`, `label` |
| `from`, `to` | Required fixed server-side email addresses |
| `subject` | `New form submission`; fixed, no header newlines |
| `namespace` | `contact`; use a distinct value per tenant/form |
| `rateLimit`, `rateWindowMs` | 5 attempts per client per 60,000 ms |
| `duplicateTtlMs` | 600,000 ms; identical normalized fields suppressed across clients |
| `maxBytes` | 16,384 streamed bytes, independent of Content-Length |
| `honeypot` | `website`; absent or empty accepted |
| `maxLinks` | 3 HTTP(S)/www occurrences in submitted fields |
| `validate(data)` | Optional domain validation; must return exactly `true` |
| `verify(context)` | Required by Worker API; must return exactly `true` |
| `getClientKey(request)` | Required by portable `createFormHandler`; Worker API supplies trusted IP |

Turnstile, rate limits, and server validation are the primary controls. CORS controls browser access; scripts can forge Origin. Honeypots and link counting are basic heuristics and do not guarantee spam detection. This is form protection, not incoming-mailbox spam filtering. Configure provider limits and Cloudflare WAF rules for distributed floods and cost controls; IP-based application limits alone do not stop botnets.

Unknown fields are discarded. The first populated email field becomes Reply-To. Message text is escaped before HTML rendering. Request bodies, mail content, recipients and provider error bodies are not logged by the library. Durable Objects store only counts/expiry; object names derive from SHA-256 fingerprints (pseudonymous, not anonymous). Alarms clean up expired counters. Form content is sent to the configured email provider and follows that provider's retention rules.

The supplied `memoryStore()` is for single-process development only. Use `durableStore()` for Workers. A custom store must implement atomic operations; eventually consistent KV is not sufficient. Durable Object TTLs are capped at one day.

## Delivery semantics

All adapters accept `{ from, to, subject, text?, html?, replyTo? }`; `{ apiKey, timeoutMs?, fetch? }` configures each adapter. Brevo also accepts `{ sandbox: true }`. Default timeout is 10 seconds; redirects are refused. Adapters never retry or fail over automatically.

A successful HTTP response means the provider accepted the message, not that it reached the inbox. Duplicate reservations are made before send and retained on failure: network timeout can mean the provider accepted the email. Retrying immediately or failing over could duplicate delivery. The response will be `409` until the reservation expires. This deliberately favours suppression over immediate retries; it is not an exactly-once guarantee. Provider webhooks and operator reconciliation can be added by the host application.

## Responses

All core responses are JSON `{ ok, code }`, with `Cache-Control: no-store`, `Vary: Origin`, and CORS only for approved origins. Preflight returns 204 without consuming quota.

| Status | Meaning |
| --- | --- |
| 200 | Provider accepted message |
| 400 | Invalid JSON/form/domain validation |
| 403 | Origin denied |
| 405 / 415 | Wrong method/content type |
| 409 | Duplicate or uncertain prior delivery |
| 413 | Body too large |
| 422 | Honeypot, content, geographic or verification rejection |
| 429 | Rate limited; `Retry-After` provided |
| 502 | Provider delivery failure |
| 503 | Missing client identity, storage failure, configuration or internal failure |

## Tests and extensions

`npm test`: core security and provider contracts with fake transports.
`npm run test:workers`: Durable Object concurrency, isolation, expiry and Worker behavior in workerd.
`npm run check`: public TypeScript API consumption.
`BREVO_API_KEY=... npm run test:brevo`: opt-in real Brevo sandbox request, no email delivery. Keep the key in your shell/secret manager, never source control. This test validates API acceptance, not inbox delivery. Other providers are contract-tested only.

Custom fraud, disposable-domain or reputation checks can be added with `validate`/`verify`; compose them with Turnstile. Explicitly choose retention, timeout and outage behavior for external services. Additional email providers implement the small `Provider` interface. Framework-independent `createFormHandler()` works wherever standard Request/Response and Web Crypto exist.

Primary references: [Brevo sandbox](https://developers.brevo.com/docs/using-sandbox-mode), [Resend send API](https://resend.com/docs/api-reference/emails/send-email), [Postmark send API](https://postmarkapp.com/developer/api/email-api), [Turnstile validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/), [Cloudflare request metadata](https://developers.cloudflare.com/workers/runtime-apis/request/).
