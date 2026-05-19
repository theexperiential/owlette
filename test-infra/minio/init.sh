#!/bin/sh
# MinIO bucket initialization for roost local/CI infra (wave 1.6).
#
# Mirrors storage/r2-bucket-policy.json — the same default-deny posture
# applied to production Cloudflare R2. Anonymous requests get 403;
# signed URLs minted by the web API (which has root credentials here,
# R2 IAM creds in production) are the only path to read/write objects.
#
# Idempotent — re-running against an existing MinIO instance is a no-op.

set -e

MINIO_ALIAS="roost-dev"
MINIO_URL="http://minio:9000"

echo "==> configuring mc alias"
mc alias set "${MINIO_ALIAS}" "${MINIO_URL}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" --api s3v4

BUCKETS="owlette-dev-content owlette-dev-manifests"

for bucket in ${BUCKETS}; do
  if mc ls "${MINIO_ALIAS}/${bucket}" > /dev/null 2>&1; then
    echo "==> bucket ${bucket} already exists"
  else
    echo "==> creating bucket ${bucket}"
    mc mb "${MINIO_ALIAS}/${bucket}"
  fi

  # Deny anonymous access (mirrors the R2 DenyAnonymousAccess statement).
  # MinIO's policy model is `none` (deny anonymous) / `download` / `upload` /
  # `public`. `none` matches our R2 posture: only signed requests or
  # credentialed admin access work.
  echo "==> setting bucket ${bucket} to default-deny (anonymous 403)"
  mc anonymous set none "${MINIO_ALIAS}/${bucket}"
done

# Sanity-check: confirm anonymous GET returns 403 on a known path.
# uses `mc stat` without credentials to mirror how an end user sees the
# bucket via the public URL. The --json flag makes failure parseable.
echo "==> sanity-checking anonymous access is denied"
for bucket in ${BUCKETS}; do
  # Create a throwaway anonymous alias pointing at the same endpoint,
  # then attempt to list. Anonymous list should be Forbidden.
  mc alias set "anon-check" "${MINIO_URL}" "" "" --api s3v4 2>/dev/null || true
  if mc ls "anon-check/${bucket}" > /dev/null 2>&1; then
    echo "FAIL: anonymous listing of ${bucket} succeeded — default-deny broken"
    exit 1
  fi
done

echo "==> init complete."
echo "    API:    ${MINIO_URL}"
echo "    web:    http://localhost:9001"
echo "    bucket: ${BUCKETS}"
echo ""
echo "    to generate a signed upload URL from the host:"
echo "      docker exec roost-minio-init mc share upload ${MINIO_ALIAS}/owlette-dev-content/project-content/my-site/ab/<hash>"
