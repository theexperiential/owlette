#!/usr/bin/env bash
# Recovery verification harness. Compares each high-risk file against the
# clobber baseline (7a399fb) and reports recovery status.
# Not committed to git — lives in .claude/ alongside hook scripts.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

CLOBBER_REF=7a399fb

FILES=(
  functions/src/index.ts
  web/__tests__/lib/apiAuth.test.ts
  web/app/api/_shared.ts
  web/app/api/chunks/check/route.ts
  web/app/api/chunks/download-urls/route.ts
  web/app/api/chunks/upload-urls/route.ts
  web/app/api/keys/route.ts
  web/app/api/roosts/[roostId]/rollback/route.ts
  web/app/api/roosts/[roostId]/route.ts
  web/app/logs/page.tsx
  web/components/PageHeader.tsx
  web/components/charts/DisplayCanvas.tsx
  web/components/charts/DisplayLayoutPanel.tsx
  web/lib/apiAuth.server.ts
  web/lib/apiErrors.ts
  web/lib/r2Client.server.ts
  web/app/api/roosts/[roostId]/manifests/route.ts
  web/app/roost/page.tsx
  web/components/FolderDropzone.tsx
  web/components/ProjectDistributionDialog.tsx
)

head_sha=$(git rev-parse HEAD)

recovered=0
pending=0
sibling=0
head_only=0

for f in "${FILES[@]}"; do
  clobber=$(git rev-parse "$CLOBBER_REF:$f" 2>/dev/null || echo "")
  head=$(git rev-parse "HEAD:$f" 2>/dev/null || echo "")
  if [ ! -f "$f" ]; then
    echo "GONE                $f"
    continue
  fi
  disk=$(git hash-object "$f")
  if [ "$disk" = "$clobber" ]; then
    tag="PENDING"
    if [ -f "$f.recovered" ]; then
      tag="SIBLING"
      sibling=$((sibling + 1))
    else
      pending=$((pending + 1))
    fi
  elif [ "$disk" = "$head" ]; then
    tag="HEAD-ONLY"
    head_only=$((head_only + 1))
  else
    tag="RECOVERED"
    recovered=$((recovered + 1))
  fi
  printf "%-18s %s\n" "$tag" "$f"
done

echo "---"
echo "recovered=$recovered  sibling=$sibling  pending=$pending  head-only=$head_only"
echo "HEAD=$head_sha  clobber=$CLOBBER_REF"
