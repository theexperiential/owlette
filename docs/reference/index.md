# reference

Technical reference material for Owlette's public API, platform internals, data model, agent command channel, and Cortex tool surface.

## public API

- [API reference](../api/reference.md) - entrypoint for the rendered OpenAPI endpoint reference, request/response examples, and API-wide conventions.
- [API authentication](../api/authentication.md) - API-key formats, bearer authentication, scope handling, and caller identity checks for external integrations.

## platform internals

- [Authentication internals](authentication.md) - Firebase sessions, agent device-code pairing, passkeys, MFA, RBAC, and server auth helper boundaries.
- [Firestore data model](firestore-data-model.md) - collection hierarchy, document schemas, field meanings, indexes, and ownership patterns.
- [Agent commands](agent-commands.md) - command lifecycle, pending/completed document schemas, and command-specific payload fields accepted by the agent.
- [Cortex tools](cortex-tools.md) - available tools, approval tiers, execution location, parameters, and response shapes.

