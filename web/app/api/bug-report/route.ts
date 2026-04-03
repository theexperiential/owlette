import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireSession, ApiAuthError } from '@/lib/apiAuth.server';
import { withRateLimit } from '@/lib/withRateLimit';
import { getResend, FROM_EMAIL, ENV_LABEL } from '@/lib/resendClient.server';
import { wrapEmailLayout, emailDataTable, emailTimestamp, EMAIL_COLORS } from '@/lib/emailTemplates.server';

/**
 * POST /api/bug-report
 *
 * User-authenticated endpoint for submitting bug reports and feature requests.
 * Writes to the top-level `bug_reports` Firestore collection and sends an
 * email notification to ADMIN_EMAIL.
 *
 * Request body:
 * - title: string (max 200 chars)
 * - category: 'bug' | 'feature_request' | 'other' | 'compliment' | 'rant'
 * - description: string (max 5000 chars)
 * - browserUA: string
 * - pageUrl: string
 */

const VALID_CATEGORIES = ['bug', 'feature_request', 'other', 'compliment', 'rant'] as const;

const CATEGORY_LABELS: Record<string, string> = {
  bug: 'something broke',
  feature_request: "wouldn't it be nice if...",
  other: "it's complicated",
  compliment: "actually, you're doing great",
  rant: 'i just need to vent',
};

const isProduction =
  process.env.NODE_ENV === 'production' &&
  !process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.includes('dev');

const ADMIN_EMAIL = isProduction
  ? process.env.ADMIN_EMAIL_PROD
  : process.env.ADMIN_EMAIL_DEV;

function buildBugReportEmail(
  category: string,
  title: string,
  description: string,
  userEmail: string,
  source: string,
  pageUrl: string,
): string {
  const categoryLabel = CATEGORY_LABELS[category] || category;
  const color = category === 'compliment' ? EMAIL_COLORS.cyan
    : category === 'rant' ? EMAIL_COLORS.amber
    : EMAIL_COLORS.blue;

  const content = `
    <h2 style="color:${color};margin:0 0 12px;font-size:18px;font-weight:700;text-transform:lowercase;">new feedback: ${categoryLabel}</h2>
    <p style="margin:0 0 20px;color:${EMAIL_COLORS.muted};">a user submitted feedback via the ${source} app.</p>
    ${emailDataTable([
      { label: 'title', value: title },
      { label: 'category', value: categoryLabel },
      { label: 'from', value: userEmail || 'unknown' },
      { label: 'page', value: pageUrl || 'n/a' },
      { label: 'time', value: emailTimestamp() },
      { label: 'environment', value: ENV_LABEL },
    ])}
    <div style="margin:20px 0 0;padding:16px;background:${EMAIL_COLORS.altRow};border-radius:8px;border:1px solid ${EMAIL_COLORS.border};">
      <p style="margin:0 0 8px;color:${EMAIL_COLORS.muted};font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">description</p>
      <p style="margin:0;color:${EMAIL_COLORS.text};font-size:14px;line-height:1.6;white-space:pre-wrap;">${description.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
    </div>
  `;
  return wrapEmailLayout(content, { preheader: `${categoryLabel}: ${title}` });
}

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      // Auth: try session first, then Bearer token (supports both web users and agents)
      let userId: string;
      try {
        userId = await requireSession(request);
      } catch {
        const authHeader = request.headers.get('authorization') || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        try {
          const decoded = await getAdminAuth().verifyIdToken(token);
          userId = decoded.uid;
        } catch {
          return NextResponse.json({ error: 'Unauthorized: Invalid token' }, { status: 401 });
        }
      }

      const body = await request.json();
      const { title, category, description, browserUA, pageUrl } = body;

      // Validate required fields
      if (!title || typeof title !== 'string' || title.trim().length === 0) {
        return NextResponse.json({ error: 'Title is required' }, { status: 400 });
      }
      if (title.trim().length > 200) {
        return NextResponse.json({ error: 'Title must be 200 characters or less' }, { status: 400 });
      }
      if (!category || !VALID_CATEGORIES.includes(category)) {
        return NextResponse.json(
          { error: `Category must be one of: ${VALID_CATEGORIES.join(', ')}` },
          { status: 400 }
        );
      }
      if (!description || typeof description !== 'string' || description.trim().length === 0) {
        return NextResponse.json({ error: 'Description is required' }, { status: 400 });
      }
      const maxDescLength = 50000; // allow long descriptions for agent log attachments
      if (description.trim().length > maxDescLength) {
        return NextResponse.json({ error: `Description must be ${maxDescLength} characters or less` }, { status: 400 });
      }

      // Detect source: agent submissions use "Owlette Agent" as browserUA
      const ua = typeof browserUA === 'string' ? browserUA.slice(0, 500) : '';
      const isAgent = ua.startsWith('Owlette Agent');
      const source = isAgent ? 'agent' : 'web';

      // Look up user email (agents don't have one — use browserUA as identifier)
      let userEmail = '';
      if (!isAgent) {
        try {
          const adminAuth = getAdminAuth();
          const userRecord = await adminAuth.getUser(userId);
          userEmail = userRecord.email || '';
        } catch {
          // Non-critical — proceed without email
        }
      }
      const fromLabel = userEmail || (isAgent ? ua : userId);

      const db = getAdminDb();
      const docRef = db.collection('bug_reports').doc();

      await docRef.set({
        source,
        category,
        title: title.trim(),
        description: description.trim(),
        status: 'new',
        createdAt: FieldValue.serverTimestamp(),
        userId,
        userEmail,
        browserUA: ua,
        pageUrl: typeof pageUrl === 'string' ? pageUrl.slice(0, 500) : '',
        appVersion: process.env.npm_package_version || '2.4.2',
      });

      console.log(`[bug-report] Submitted by ${fromLabel}: ${title.trim()}`);

      // Send email notification to admin (non-blocking)
      const resendClient = getResend();
      if (resendClient && ADMIN_EMAIL) {
        const categoryLabel = CATEGORY_LABELS[category] || category;
        resendClient.emails.send({
          from: FROM_EMAIL,
          to: ADMIN_EMAIL,
          subject: `[${ENV_LABEL}] feedback: ${categoryLabel} — ${title.trim()}`,
          html: buildBugReportEmail(
            category,
            title.trim(),
            description.trim(),
            fromLabel,
            source,
            typeof pageUrl === 'string' ? pageUrl : '',
          ),
        }).catch((err) => {
          console.error('[bug-report] Failed to send email notification:', err);
        });
      }

      return NextResponse.json({ success: true, id: docRef.id });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error('[bug-report] Unhandled error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  },
  { strategy: 'user', identifier: 'ip' }
);
