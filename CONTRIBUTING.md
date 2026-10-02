# Contributing

Use Node 22+, run `npm ci`, then `npm test`, `npm run test:workers`, and `npm run check`.
Add behavior tests for security changes, and transport contract tests for provider adapters.
Never use real credentials or deliver live email in automated tests. Sandbox tests are opt-in.
Keep production dependencies small and justify external reputation services with their failure and privacy behavior.
