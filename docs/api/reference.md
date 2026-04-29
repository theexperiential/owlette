# api reference

the interactive endpoint reference is rendered from the OpenAPI contract at:

- production: <https://owlette.app/docs/api>
- local dev: <http://localhost:3000/docs/api>
- raw json: `/api/openapi`
- source contract: [`web/openapi.yaml`](../../web/openapi.yaml)

the rendered reference includes every developer-preview public operation, request/response examples, operation-level authentication, and a scope note for API-key callers.

Use the shared convention pages for behavior that applies across operations:
[authentication](authentication.md), [pagination](pagination.md),
[idempotency](idempotency.md), [errors](errors.md), and
[rate limits](rate-limits.md).

run this before publishing API docs or changing public routes:

```powershell
cd web
npm.cmd run validate:api
```

the validator checks route/spec drift and verifies the rendered reference still has examples plus auth/scope notes for every operation.
