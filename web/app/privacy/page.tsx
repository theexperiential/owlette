'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function PrivacyPage() {
  const lastUpdated = 'December 30, 2025';
  const router = useRouter();

  return (
    <div className="min-h-screen py-12 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="mb-8">
          <button
            onClick={() => router.back()}
            className="text-accent-cyan hover:text-accent-cyan text-sm cursor-pointer"
          >
            &larr; Back
          </button>
        </div>

        <article className="prose prose-invert prose-slate max-w-none">
          <h1 className="text-3xl font-bold text-white mb-2">Privacy Policy</h1>
          <p className="text-muted-foreground text-sm mb-8">Last updated: {lastUpdated}</p>

          <div className="space-y-8 text-muted-foreground">
            <section>
              <h2 className="text-xl font-semibold text-white mb-4">1. Introduction</h2>
              <p>
                The Experiential Company, LLC (&quot;TEC,&quot; &quot;we,&quot; &quot;our,&quot; or &quot;us&quot;) operates Owlette, a cloud-connected
                process management and remote deployment system. This Privacy Policy explains how we
                collect, use, disclose, and safeguard your information when you use our service.
              </p>
              <p className="mt-4">
                By using Owlette, you agree to the collection and use of information in accordance
                with this policy.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">2. Information We Collect</h2>

              <h3 className="text-lg font-medium text-white mt-6 mb-3">Account Information</h3>
              <p>When you create an account, we collect:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>Email address</li>
                <li>Name (first and last)</li>
                <li>Password (stored securely using industry-standard hashing)</li>
                <li>Two-factor authentication secrets (encrypted)</li>
              </ul>

              <h3 className="text-lg font-medium text-white mt-6 mb-3">Machine Data</h3>
              <p>When you install the Owlette agent on a machine, we collect:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>Machine hostname and unique identifiers</li>
                <li>Operating system information</li>
                <li>System metrics (CPU, memory, disk usage, GPU temperature)</li>
                <li>Process information (names, paths, running status)</li>
                <li>Agent heartbeat and online/offline status</li>
              </ul>

              <h3 className="text-lg font-medium text-white mt-6 mb-3">Usage Data</h3>
              <p>We automatically collect:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>Actions performed (process starts, stops, deployments)</li>
                <li>Event logs (errors, crashes, status changes)</li>
                <li>Timestamps of activities</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">3. How We Use Your Information</h2>
              <p>We use the collected information to:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>Provide and maintain the Owlette service</li>
                <li>Monitor machine health and process status</li>
                <li>Execute remote commands and deployments</li>
                <li>Send alerts and notifications</li>
                <li>Authenticate users and secure accounts</li>
                <li>Improve and optimize our service</li>
                <li>Respond to support requests</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">4. Data Storage and Security</h2>
              <p>
                Your data is stored using Google Firebase and Google Cloud Platform infrastructure.
                We implement industry-standard security measures including:
              </p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>Encryption in transit (TLS/HTTPS)</li>
                <li>Encryption at rest (AES-256)</li>
                <li>Secure authentication tokens with automatic expiration</li>
                <li>Machine-specific encryption keys for agent credentials</li>
                <li>Role-based access controls</li>
              </ul>
              <p className="mt-4">
                While we strive to protect your information, no method of transmission over the
                Internet is 100% secure. We cannot guarantee absolute security.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">5. Data Retention</h2>
              <p>We retain your data as follows:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li><strong>Account data:</strong> Until you delete your account</li>
                <li><strong>Machine metrics:</strong> Rolling 30-90 days (configurable)</li>
                <li><strong>Event logs:</strong> Up to 90 days by default</li>
                <li><strong>Process data:</strong> Until the machine is removed from your account</li>
              </ul>
              <p className="mt-4">
                You may request deletion of your data at any time by contacting us.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">6. Third-Party Services</h2>
              <p>We use the following third-party services to operate Owlette:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li><strong>Google Firebase:</strong> Authentication, database, and hosting</li>
                <li><strong>Google Cloud Platform:</strong> Infrastructure and storage</li>
              </ul>
              <p className="mt-4">
                These services have their own privacy policies governing how they handle your data.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">7. Your Rights</h2>
              <p>
                Depending on your location, you may have certain rights regarding your personal
                information:
              </p>

              <h3 className="text-lg font-medium text-white mt-6 mb-3">California Residents (CCPA)</h3>
              <p>You have the right to:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>Know what personal information is collected</li>
                <li>Request deletion of your personal information</li>
                <li>Opt-out of the sale of personal information (we do not sell your data)</li>
                <li>Non-discrimination for exercising your privacy rights</li>
              </ul>

              <h3 className="text-lg font-medium text-white mt-6 mb-3">All Users</h3>
              <p>You can:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>Access your account data through the dashboard</li>
                <li>Update or correct your information</li>
                <li>Delete your account and associated data</li>
                <li>Export your data upon request</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">8. Cookies and Tracking</h2>
              <p>
                Owlette uses cookies and similar technologies for authentication and session
                management. These are essential for the service to function and cannot be
                disabled while using Owlette.
              </p>
              <p className="mt-4">
                We use Firebase Authentication, which sets cookies to maintain your login session.
                We do not use tracking cookies for advertising purposes.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">9. Children&apos;s Privacy</h2>
              <p>
                Owlette is not intended for use by anyone under the age of 13. We do not knowingly
                collect personal information from children under 13. If you are a parent or guardian
                and believe your child has provided us with personal information, please contact us.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">10. Changes to This Policy</h2>
              <p>
                We may update this Privacy Policy from time to time. We will notify you of any
                changes by posting the new Privacy Policy on this page and updating the
                &quot;Last updated&quot; date.
              </p>
              <p className="mt-4">
                We encourage you to review this Privacy Policy periodically for any changes.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">11. Contact Us</h2>
              <p>
                If you have any questions about this Privacy Policy or our data practices,
                please contact us at:
              </p>
              <p className="mt-4">
                <strong>Email:</strong>{' '}
                <a href="mailto:support@owlette.app" className="text-accent-cyan hover:text-accent-cyan">
                  support@owlette.app
                </a>
              </p>
              <p className="mt-2">
                <strong>Company:</strong> The Experiential Company, LLC
              </p>
              <p className="mt-2">
                <strong>Location:</strong> California, USA
              </p>
            </section>
          </div>
        </article>

        <div className="mt-12 pt-8 border-t border-border text-center">
          <p className="text-muted-foreground text-sm">
            <Link href="/terms" className="text-muted-foreground hover:text-muted-foreground">
              Terms of Service
            </Link>
            {' '}&middot;{' '}
            <Link href="/dashboard" className="text-muted-foreground hover:text-muted-foreground">
              Dashboard
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
