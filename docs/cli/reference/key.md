---
hide:
  - navigation
---

# key management

API key management is dashboard-only. The CLI does not register a `key` command group.

Use the dashboard to create, inspect, rotate, or revoke `owk_*` keys. The CLI can then use one of those keys through `owlette auth login`, `OWLETTE_TOKEN`, or the active profile's credential store.

For local credential state, use:

```bash
owlette auth login
owlette auth logout
owlette whoami
```

See [auth](auth.md), [whoami](whoami.md), and the [overview](../overview.md) for config precedence and credential storage details.
