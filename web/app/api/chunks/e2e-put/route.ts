/**
 * E2E-only chunk sink — the local stand-in for an R2 presigned PUT.
 *
 * `presignPutChunk` returns this route under OWLETTE_E2E=1 (see
 * lib/r2Client.server.ts): a browser-driven roost upload PUTs its chunk bytes
 * here instead of at real R2, and presence is recorded as the
 * `siteChunks/{hash}` row that `hasChunk` reads in the same mode — the exact
 * shape `e2e/helpers/seed.ts:seedChunks` writes. Without this, the one
 * unstubbed seam in the chunk flow sent loopback-origin PUTs at the real dev
 * bucket, where CORS killed every one (found by the ep11 tutorial capture).
 *
 * Hard-gated: outside OWLETTE_E2E=1 this endpoint does not exist (404), so it
 * can never become an unauthenticated write path in a real deployment.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';

const HASH_RE = /^[0-9a-f]{64}$/;

export async function PUT(req: NextRequest): Promise<NextResponse> {
  if (process.env.OWLETTE_E2E !== '1') {
    return NextResponse.json({ title: 'not found' }, { status: 404 });
  }
  const siteId = req.nextUrl.searchParams.get('siteId') ?? '';
  const hash = req.nextUrl.searchParams.get('hash') ?? '';
  if (!siteId || !HASH_RE.test(hash)) {
    return NextResponse.json({ title: 'bad chunk address' }, { status: 400 });
  }
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength === 0) {
    return NextResponse.json({ title: 'empty chunk' }, { status: 400 });
  }
  await getAdminDb()
    .collection('siteChunks')
    .doc(hash)
    .set(
      {
        siteId,
        hash,
        size: bytes.byteLength,
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  return new NextResponse(null, { status: 200 });
}
