# sdk workflow examples

Small executable SDK examples live in:

- `sdks/node/examples/*.ts`
- `sdks/python/examples/*.py`

They are designed to run against a dev or staging tenant with explicit env vars.
They do not read local credential files.

For launch-facing CI/CD examples, see [ci/cd with GitHub Actions](ci-cd-github-actions.md) and the [public launch assets](../launch-assets.md) checklist.

## dev fixture env

Use the same values for Node and Python examples:

```bash
export OWLETTE_API_URL=https://dev.owlette.app
export OWLETTE_TOKEN=owk_test_...
export OWLETTE_SITE_ID=site_...
export OWLETTE_MACHINE_ID=machine_...
export OWLETTE_ROOST_ID=rst_...
export BUILD_DIR=./dist
export OWLETTE_WEBHOOK_SECRET=whsec_...
```

Optional write gates:

```bash
export OWLETTE_DEPLOY=1
export OWLETTE_DISPATCH_COMMAND=1
```

Leave those unset for read-only inspection and existing-command polling.

## auth and inventory

Lists the caller identity, API version, visible sites, and machines for the
selected site.

```bash
npx tsx sdks/node/examples/auth-inventory.ts
python sdks/python/examples/auth_inventory.py
```

## roost push and deploy

Publishes `BUILD_DIR` to `OWLETTE_ROOST_ID`. Deployment is skipped unless
`OWLETTE_DEPLOY=1`.

```bash
npx tsx sdks/node/examples/run-roost-workflow.ts
python sdks/python/examples/run_roost_workflow.py
```

## command polling

Poll an existing command:

```bash
export OWLETTE_COMMAND_ID=cmd_...
npx tsx sdks/node/examples/command-poll.ts
python sdks/python/examples/command_poll.py
```

Dispatch and poll a new safe screenshot command:

```bash
export OWLETTE_DISPATCH_COMMAND=1
export OWLETTE_COMMAND_TYPE=capture_screenshot
npx tsx sdks/node/examples/command-poll.ts
python sdks/python/examples/command_poll.py
```

## webhook verification

Verify a real delivery by piping the raw body and signature:

```bash
cat body.json | OWLETTE_SIGNATURE='t=...,v1=...' npx tsx sdks/node/examples/webhook-verify.ts
cat body.json | OWLETTE_SIGNATURE='t=...,v1=...' python sdks/python/examples/webhook_verify.py
```

With no signature env var, both scripts sign the body with
`OWLETTE_WEBHOOK_SECRET` first and verify the generated fixture. That mode is
useful for CI syntax/import checks without a live webhook delivery.

## CI note

These examples are intentionally gated by env instead of running against a
shared live tenant by default. A CI job can validate the offline webhook fixture
without network access, and a dev/staging smoke job can run the full set by
providing the fixture env above.
