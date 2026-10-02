import { brevo } from '../src/index.js';
// Sandbox is mandatory here. No message can be delivered by this script.
const apiKey = process.argv.includes('--stdin')
  ? (await import('node:fs')).readFileSync(0, 'utf8').trim()
  : process.env.BREVO_API_KEY;
if (!apiKey) { console.error('Set BREVO_API_KEY in the environment.'); process.exit(1); }
try {
  await brevo({ apiKey, sandbox: true }).send({
    from: 'forms@example.com', to: ['sandbox@example.com'],
    subject: 'FormSieve sandbox integration test', text: 'Sandbox validation only. No delivery.',
  });
  console.log('Brevo sandbox accepted the request; no email delivered.');
} catch (error) {
  console.error(JSON.stringify({ result: 'failed', provider: 'brevo', status: error.status ?? 0 }));
  process.exitCode = 1;
}
