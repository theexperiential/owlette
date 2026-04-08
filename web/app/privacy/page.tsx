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
            &larr; back
          </button>
        </div>

        <article className="prose prose-invert prose-slate max-w-none">
          <h1 className="text-3xl font-bold text-white mb-2">privacy policy</h1>
          <p className="text-muted-foreground text-sm mb-8">last updated: {lastUpdated}</p>

          <div className="space-y-8 text-muted-foreground">
            <section>
              <h2 className="text-xl font-semibold text-white mb-4">1. introduction</h2>
              <p>
                The Experiential Company, LLC (&quot;TEC,&quot; &quot;we,&quot; &quot;our,&quot; or &quot;us&quot;) operates owlette, a cloud-connected
                process management and remote deployment system. this privacy policy explains how we
                collect, use, disclose, and safeguard your information when you use our service.
              </p>
              <p className="mt-4">
                by using owlette, you agree to the collection and use of information in accordance
                with this policy.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">2. information we collect</h2>

              <h3 className="text-lg font-medium text-white mt-6 mb-3">account information</h3>
              <p>when you create an account, we collect:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>email address</li>
                <li>name (first and last)</li>
                <li>password (stored securely using industry-standard hashing)</li>
                <li>two-factor authentication secrets (encrypted)</li>
              </ul>

              <h3 className="text-lg font-medium text-white mt-6 mb-3">machine data</h3>
              <p>when you install the owlette agent on a machine, we collect:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>machine hostname and unique identifiers</li>
                <li>operating system information</li>
                <li>system metrics (CPU, memory, disk usage, GPU temperature)</li>
                <li>process information (names, paths, running status)</li>
                <li>agent heartbeat and online/offline status</li>
              </ul>

              <h3 className="text-lg font-medium text-white mt-6 mb-3">usage data</h3>
              <p>we automatically collect:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>actions performed (process starts, stops, deployments)</li>
                <li>event logs (errors, crashes, status changes)</li>
                <li>timestamps of activities</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">3. how we use your information</h2>
              <p>we use the collected information to:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>provide and maintain the owlette service</li>
                <li>monitor machine health and process status</li>
                <li>execute remote commands and deployments</li>
                <li>send alerts and notifications</li>
                <li>authenticate users and secure accounts</li>
                <li>improve and optimize our service</li>
                <li>respond to support requests</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">4. data storage and security</h2>
              <p>
                your data is stored using Google Firebase and Google Cloud Platform infrastructure.
                we implement industry-standard security measures including:
              </p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>encryption in transit (TLS/HTTPS)</li>
                <li>encryption at rest (AES-256)</li>
                <li>secure authentication tokens with automatic expiration</li>
                <li>machine-specific encryption keys for agent credentials</li>
                <li>role-based access controls</li>
              </ul>
              <p className="mt-4">
                while we strive to protect your information, no method of transmission over the
                internet is 100% secure. we cannot guarantee absolute security.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">5. data retention</h2>
              <p>we retain your data as follows:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li><strong>account data:</strong> until you delete your account</li>
                <li><strong>machine metrics:</strong> rolling 30-90 days (configurable)</li>
                <li><strong>event logs:</strong> up to 90 days by default</li>
                <li><strong>process data:</strong> until the machine is removed from your account</li>
              </ul>
              <p className="mt-4">
                you may request deletion of your data at any time by contacting us.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">6. third-party services</h2>
              <p>we use the following third-party services to operate owlette:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li><strong>Google Firebase:</strong> authentication, database, and hosting</li>
                <li><strong>Google Cloud Platform:</strong> infrastructure and storage</li>
              </ul>
              <p className="mt-4">
                these services have their own privacy policies governing how they handle your data.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">7. your rights</h2>
              <p>
                depending on your location, you may have certain rights regarding your personal
                information:
              </p>

              <h3 className="text-lg font-medium text-white mt-6 mb-3">California residents (CCPA)</h3>
              <p>you have the right to:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>know what personal information is collected</li>
                <li>request deletion of your personal information</li>
                <li>opt-out of the sale of personal information (we do not sell your data)</li>
                <li>non-discrimination for exercising your privacy rights</li>
              </ul>

              <h3 className="text-lg font-medium text-white mt-6 mb-3">all users</h3>
              <p>you can:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>access your account data through the dashboard</li>
                <li>update or correct your information</li>
                <li>delete your account and associated data</li>
                <li>export your data upon request</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">8. cookies and tracking</h2>
              <p>
                owlette uses cookies and similar technologies for authentication and session
                management. these are essential for the service to function and cannot be
                disabled while using owlette.
              </p>
              <p className="mt-4">
                we use Firebase Authentication, which sets cookies to maintain your login session.
                we do not use tracking cookies for advertising purposes.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">9. children&apos;s privacy</h2>
              <p>
                owlette is not intended for use by anyone under the age of 13. we do not knowingly
                collect personal information from children under 13. if you are a parent or guardian
                and believe your child has provided us with personal information, please contact us.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">10. changes to this policy</h2>
              <p>
                we may update this privacy policy from time to time. we will notify you of any
                changes by posting the new privacy policy on this page and updating the
                &quot;last updated&quot; date.
              </p>
              <p className="mt-4">
                we encourage you to review this privacy policy periodically for any changes.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">11. contact us</h2>
              <p>
                if you have any questions about this privacy policy or our data practices,
                please contact us at:
              </p>
              <p className="mt-4">
                <strong>email:</strong>{' '}
                <a href="mailto:support@owlette.app" className="text-accent-cyan hover:text-accent-cyan">
                  support@owlette.app
                </a>
              </p>
              <p className="mt-2">
                <strong>company:</strong> The Experiential Company, LLC
              </p>
              <p className="mt-2">
                <strong>location:</strong> California, USA
              </p>
            </section>
          </div>
        </article>

        <div className="mt-12 pt-8 border-t border-border text-center">
          <p className="text-muted-foreground text-sm">
            <Link href="/terms" className="text-muted-foreground hover:text-muted-foreground">
              terms of service
            </Link>
            {' '}&middot;{' '}
            <Link href="/dashboard" className="text-muted-foreground hover:text-muted-foreground">
              dashboard
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
