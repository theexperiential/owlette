/**
 * POST /api/legal/dmca
 *
 * Public endpoint receiving DMCA § 512(c)(3) notices (wave 0.2).
 * The companion form at `/legal/dmca` is the operator-recommended path;
 * notices arriving by email / postal mail are entered manually by the
 * designated agent and land in the same `dmca_notices` collection.
 *
 * Writes via firebase-admin so firestore.rules doesn't need a new block
 * (the collection is server-only — clients can't read or write it
 * directly, only through this endpoint).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import {
  rateLimitVerdict,
  validateNotice,
  type DmcaNoticeInput,
} from '@/lib/dmcaLogic';
import {
  problem,
  problemValidation,
  ProblemType,
  problemRateLimited,
  problemFromError,
} from '@/lib/apiErrors';

interface NoticeDoc extends DmcaNoticeInput {
  status: 'pending_review' | 'elements_incomplete';
  elementsComplete: boolean;
  sourceIp: string;
  submittedAt: FirebaseFirestore.FieldValue;
  userAgent: string;
}

export async function POST(request: NextRequest) {
  try {
    const db = getAdminDb();
    const body = (await request.json().catch(() => null)) as
      | Partial<DmcaNoticeInput>
      | null;

    if (!body || typeof body !== 'object') {
      return problemValidation('request body must be a JSON object');
    }

    const validation = validateNotice(body);

    // Element-incompleteness isn't a REJECTION — we still record the
    // notice for audit but flag it so the designated agent contacts
    // the complainant for the missing fields (per SOP 24-hour rule).
    // The shape check below guards against malformed submissions.
    const complainantEmail =
      typeof body.complainant?.email === 'string'
        ? body.complainant.email.trim().toLowerCase()
        : '';

    if (!complainantEmail) {
      return problem({
        type: ProblemType.ValidationFailed,
        title: 'validation failed',
        status: 400,
        detail:
          'complainant email is required even for incomplete notices so we ' +
          'can request the missing information. filing anonymously is not ' +
          'possible.',
        errors: { 'complainant.email': ['required'] },
      });
    }

    // rate-limit per (email, ip) to keep the review queue functional
    // against a flood. firestore count() via admin SDK to tally recent
    // submissions in the same hour.
    const sourceIp = sanitiseIp(request.headers.get('x-forwarded-for'));
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const col = db.collection('dmca_notices');
    const [emailHits, ipHits] = await Promise.all([
      col
        .where('complainant.email', '==', complainantEmail)
        .where('submittedAt', '>=', oneHourAgo)
        .count()
        .get(),
      col
        .where('sourceIp', '==', sourceIp)
        .where('submittedAt', '>=', oneHourAgo)
        .count()
        .get(),
    ]);

    const rate = rateLimitVerdict({
      emailCount: emailHits.data().count,
      ipCount: ipHits.data().count,
    });
    if (!rate.allowed) {
      return problemRateLimited(
        60 * 60,
        rate.reason === 'email_rate'
          ? 'too many notices from this email in the last hour. ' +
              'batch your notices or contact our designated agent directly.'
          : 'too many notices from this source in the last hour. ' +
              'if this is a legitimate batch submission, contact our ' +
              'designated agent directly.',
      );
    }

    const noticeDoc: NoticeDoc = {
      signature: String(body.signature ?? '').trim(),
      copyrightedWork: String(body.copyrightedWork ?? '').trim(),
      identifiedMaterial: String(body.identifiedMaterial ?? '').trim(),
      complainant: {
        name: String(body.complainant?.name ?? '').trim(),
        email: complainantEmail,
        ...(body.complainant?.phone
          ? { phone: String(body.complainant.phone).trim() }
          : {}),
        address: String(body.complainant?.address ?? '').trim(),
      },
      goodFaithBelief: body.goodFaithBelief === true,
      accuracyAndPerjuryAttestation:
        body.accuracyAndPerjuryAttestation === true,
      elementsComplete: validation.elementsComplete,
      status: validation.elementsComplete
        ? 'pending_review'
        : 'elements_incomplete',
      sourceIp,
      submittedAt: FieldValue.serverTimestamp(),
      userAgent: (request.headers.get('user-agent') ?? '').slice(0, 512),
    };

    const ref = await col.add(noticeDoc);
    return NextResponse.json(
      {
        id: ref.id,
        status: noticeDoc.status,
        elementsComplete: validation.elementsComplete,
        missing: validation.missing,
        acknowledged: true,
        // 48-hour takedown clock starts from here per SOP
        responseSla: {
          acknowledgement: 'within 4 business hours',
          takedownDecision: validation.elementsComplete
            ? 'within 48 hours'
            : 'pending missing-elements follow-up',
        },
      },
      { status: 202 },
    );
  } catch (err) {
    return problemFromError(err, 'legal/dmca');
  }
}

/** Extract the first hop of `x-forwarded-for` and clamp to IPv4/IPv6 shape. */
function sanitiseIp(header: string | null): string {
  if (!header) return 'unknown';
  const first = header.split(',')[0].trim();
  // Loose character allowlist — we're not parsing the IP, just pinning
  // it so the firestore equality query is deterministic.
  if (!/^[0-9a-fA-F.:]+$/.test(first)) return 'unknown';
  return first.slice(0, 64);
}
