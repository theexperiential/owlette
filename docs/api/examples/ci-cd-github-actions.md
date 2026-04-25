# ci/cd with github actions

a complete github actions workflow that builds a touchdesigner (or generic) artifact on every `v*.*.*` tag, chunks it, dedup-checks against the site's cas, uploads only the missing chunks, publishes a new version, deploys to the fleet, and waits for rollout completion — failing the ci job loudly if any machine fails. status is reported back as a github check run so the tag page shows green/red at a glance.

## secrets and variables

configure these in your repo's `settings → secrets and variables → actions`:

- `ROOST_TOKEN` (secret) — api key with `roost:<id>:write,deploy` scope. create via `POST /api/keys` or the dashboard.
- `ROOST_SITE_ID` (variable) — the site id hosting the roost (e.g. `kiosk-fleet-01`).
- `ROOST_ID` (variable) — the target roost id (e.g. `roost_lobby_td`).

## `.github/workflows/deploy.yml`

```yaml
name: deploy roost on tag

on:
  push:
    tags:
      - 'v*.*.*'

permissions:
  contents: read
  checks: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      ROOST_BASE: https://owlette.app
      ROOST_VERSION: '2026-04-22'
      ROOST_TOKEN: ${{ secrets.ROOST_TOKEN }}
      ROOST_SITE_ID: ${{ vars.ROOST_SITE_ID }}
      ROOST_ID: ${{ vars.ROOST_ID }}
      VERSION: ${{ github.ref_name }}
    steps:
      - uses: actions/checkout@v4

      - name: install tools
        run: sudo apt-get update && sudo apt-get install -y jq uuid-runtime

      - name: build artifact
        run: |
          # replace with your real build — touchdesigner export, zip, etc.
          mkdir -p build
          cp -r src/* build/
          echo "version=$VERSION" > build/VERSION

      - name: chunk artifact
        id: chunk
        run: |
          mkdir -p chunks
          # produces ./chunks.json of the shape:
          #   [{"path":"main.toe","abs":"build/main.toe","hash":"sha256:...","size":16384}, ...]
          node scripts/chunk.mjs ./build ./chunks > chunks.json
          echo "hashes=$(jq -c '[.[] | .hash] | unique' chunks.json)" >> "$GITHUB_OUTPUT"

      - name: open check run
        id: check
        run: |
          CHECK_ID=$(curl -fsS \
            -H "Authorization: token ${{ secrets.GITHUB_TOKEN }}" \
            -H "Accept: application/vnd.github+json" \
            "https://api.github.com/repos/${{ github.repository }}/check-runs" \
            -d "$(jq -nc --arg sha "$GITHUB_SHA" --arg name "roost deploy $VERSION" \
              '{name:$name, head_sha:$sha, status:"in_progress"}')" | jq -r '.id')
          echo "id=$CHECK_ID" >> "$GITHUB_OUTPUT"

      - name: dedup check
        id: dedup
        run: |
          MISSING=$(curl -fsS "$ROOST_BASE/api/chunks/check" \
            -H "Authorization: Bearer $ROOST_TOKEN" \
            -H "Roost-Version: $ROOST_VERSION" \
            -H "Content-Type: application/json" \
            -d "$(jq -nc --argjson h '${{ steps.chunk.outputs.hashes }}' \
              --arg s "$ROOST_SITE_ID" '{siteId:$s, hashes:$h}')" \
            | jq -c '.missing')
          echo "missing=$MISSING" >> "$GITHUB_OUTPUT"

      - name: upload missing chunks
        if: fromJSON(steps.dedup.outputs.missing)[0] != null
        run: |
          IDEM=$(uuidgen)
          URLS=$(curl -fsS "$ROOST_BASE/api/chunks/upload-urls" \
            -H "Authorization: Bearer $ROOST_TOKEN" \
            -H "Roost-Version: $ROOST_VERSION" \
            -H "Idempotency-Key: $IDEM" \
            -H "Content-Type: application/json" \
            -d "$(jq -nc --argjson h '${{ steps.dedup.outputs.missing }}' \
              --arg s "$ROOST_SITE_ID" '{siteId:$s, hashes:$h}')" \
            | jq -r '.urls')
          echo '${{ steps.dedup.outputs.missing }}' | jq -r '.[]' | while read -r H; do
            URL=$(echo "$URLS" | jq -r --arg h "$H" '.[$h]')
            ABS=$(jq -r --arg h "$H" '.[] | select(.hash==$h) | .abs' chunks.json | head -n1)
            curl -fsS -X PUT "$URL" \
              -H "Content-Type: application/octet-stream" \
              --data-binary "@$ABS"
          done

      - name: publish version
        id: publish
        run: |
          IDEM="${{ github.run_id }}-publish"
          # scripts/version.mjs builds the oci-shaped body and attaches
          # { description: "<git tag>" } so the release shows up in the history ui.
          VERSION_BODY=$(node scripts/version.mjs chunks.json "$ROOST_SITE_ID" "$VERSION")
          PUBLISH_RESP=$(curl -fsS "$ROOST_BASE/api/roosts/$ROOST_ID/versions" \
            -H "Authorization: Bearer $ROOST_TOKEN" \
            -H "Roost-Version: $ROOST_VERSION" \
            -H "Idempotency-Key: $IDEM" \
            -H "Content-Type: application/json" \
            -d "$VERSION_BODY")
          VERSION_ID=$(echo "$PUBLISH_RESP" | jq -r '.versionId')
          VERSION_NUMBER=$(echo "$PUBLISH_RESP" | jq -r '.versionNumber')
          echo "version_id=$VERSION_ID" >> "$GITHUB_OUTPUT"
          echo "version_number=$VERSION_NUMBER" >> "$GITHUB_OUTPUT"

      - name: trigger deploy
        id: deploy
        run: |
          IDEM="${{ github.run_id }}-deploy"
          ROLLOUT_ID=$(curl -fsS "$ROOST_BASE/api/roosts/$ROOST_ID/deploy" \
            -H "Authorization: Bearer $ROOST_TOKEN" \
            -H "Roost-Version: $ROOST_VERSION" \
            -H "Idempotency-Key: $IDEM" \
            -H "Content-Type: application/json" \
            -d "$(jq -nc --arg s "$ROOST_SITE_ID" \
                          --arg v "${{ steps.publish.outputs.version_id }}" \
              '{siteId:$s, versionId:$v, strategy:"canary-then-fleet"}')" \
            | jq -r '.rolloutId')
          echo "rollout_id=$ROLLOUT_ID" >> "$GITHUB_OUTPUT"

      - name: wait for rollout
        id: wait
        run: |
          DEADLINE=$(( $(date +%s) + 1800 ))
          while (( $(date +%s) < DEADLINE )); do
            RES=$(curl -fsS \
              -H "Authorization: Bearer $ROOST_TOKEN" \
              -H "Roost-Version: $ROOST_VERSION" \
              "$ROOST_BASE/api/roosts/$ROOST_ID/deployments/${{ steps.deploy.outputs.rollout_id }}")
            STATE=$(echo "$RES" | jq -r '.state')
            echo "state=$STATE"
            if [[ "$STATE" == "completed" || "$STATE" == "succeeded" || "$STATE" == "failed" ]]; then
              FAILED=$(echo "$RES" | jq -r '[.machines[] | select(.state=="failed")] | length')
              echo "final_state=$STATE" >> "$GITHUB_OUTPUT"
              echo "failed_count=$FAILED" >> "$GITHUB_OUTPUT"
              exit 0
            fi
            sleep 10
          done
          echo "final_state=timeout" >> "$GITHUB_OUTPUT"
          exit 1

      - name: close check run
        if: always()
        run: |
          CONCLUSION=$([[ "${{ steps.wait.outputs.final_state }}" == "completed" || "${{ steps.wait.outputs.final_state }}" == "succeeded" ]] \
            && [[ "${{ steps.wait.outputs.failed_count }}" == "0" ]] \
            && echo "success" || echo "failure")
          curl -fsS \
            -X PATCH \
            -H "Authorization: token ${{ secrets.GITHUB_TOKEN }}" \
            -H "Accept: application/vnd.github+json" \
            "https://api.github.com/repos/${{ github.repository }}/check-runs/${{ steps.check.outputs.id }}" \
            -d "$(jq -nc --arg c "$CONCLUSION" \
                         --arg s "${{ steps.wait.outputs.final_state }}" \
                         --arg f "${{ steps.wait.outputs.failed_count }}" \
                         --arg r "${{ steps.deploy.outputs.rollout_id }}" \
              '{status:"completed", conclusion:$c,
                output:{title:("rollout " + $s),
                        summary:("rollout " + $r + " ended in state `" + $s + "` with " + $f + " failed machine(s)")}}')"
          [[ "$CONCLUSION" == "success" ]] || exit 1
```

## what each step does

- **install tools** — jq for json parsing, uuidgen for idempotency keys. both are pre-installed on most runners; this just makes it explicit.
- **build artifact** — replace with your real build. the rest of the workflow assumes the final artifact lives under `./build/`.
- **chunk artifact** — splits the build tree into content-addressed chunks (sha-256 named). your `scripts/chunk.mjs` writes `chunks.json` mapping each file to its hash and absolute path so later steps can locate the bytes to upload.
- **open check run** — posts an in-progress github check to the tag's commit so `v*` release pages show rollout state inline.
- **dedup check** — calls `POST /api/chunks/check` with every hash. the server returns only the ones not already in r2 for this site. stable builds that don't touch binaries typically see `missing = []`.
- **upload missing chunks** — mints signed r2 put urls with `POST /api/chunks/upload-urls`, then pipes each file straight to r2 with `curl -X PUT`. data plane bypasses our servers entirely.
- **publish version** — `POST /api/roosts/{roostId}/versions` with the oci-shaped version body and a `description` set to the git tag. idempotency key is `<run_id>-publish` so re-running the job replays the same publish instead of creating a duplicate version row. the response returns `versionId` + `versionNumber`; the server mints the integer atomically.
- **trigger deploy** — `POST /api/roosts/{roostId}/deploy` with `strategy: "canary-then-fleet"`. returns a `rolloutId` we poll in the next step.
- **wait for rollout** — polls `GET /api/roosts/{roostId}/deployments/{rolloutId}` every 10s for up to 30 minutes. exits 0 on terminal state, 1 on timeout.
- **close check run** — patches the github check to `completed`/`success` or `completed`/`failure` based on whether the rollout finished cleanly. the last `exit 1` ensures the job itself also fails on rollout failure so downstream workflows (release-please, slack notifier, etc.) see red.

## rerun safety

every mutating call carries an `Idempotency-Key` derived from `${{ github.run_id }}`. re-running a failed job (e.g. transient 5xx during upload) replays the exact same requests against the 24h idempotency cache — no duplicate versions, no second rollout. publishing is also cas-protected: if someone else published between your chunk step and your publish step, you'll get a `412 precondition_failed` (code `version_stale`) and should fail the ci run to let the operator investigate.
