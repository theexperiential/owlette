'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function TermsPage() {
  const lastUpdated = 'December 30, 2025';
  const router = useRouter();

  return (
    <div className="min-h-screen bg-background py-12 px-4">
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
          <h1 className="text-3xl font-bold text-white mb-2">Terms of Service</h1>
          <p className="text-muted-foreground text-sm mb-8">Last updated: {lastUpdated}</p>

          <div className="space-y-8 text-muted-foreground">
            <section>
              <h2 className="text-xl font-semibold text-white mb-4">1. Acceptance of Terms</h2>
              <p>
                By accessing or using Owlette (&quot;the Service&quot;), operated by The Experiential Company, LLC
                (&quot;TEC,&quot; &quot;we,&quot; &quot;our,&quot; or &quot;us&quot;), you agree to be bound by these Terms of Service
                (&quot;Terms&quot;). If you do not agree to these Terms, you may not use the Service.
              </p>
              <p className="mt-4">
                We reserve the right to modify these Terms at any time. We will notify you of
                significant changes by posting a notice on the Service or sending you an email.
                Your continued use of the Service after such modifications constitutes your
                acceptance of the updated Terms.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">2. Description of Service</h2>
              <p>
                Owlette is a cloud-connected process management and remote deployment system
                designed for managing Windows applications across multiple machines. The Service
                includes:
              </p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>A web-based dashboard for monitoring and control</li>
                <li>A Windows agent that runs on managed machines</li>
                <li>Remote process management capabilities</li>
                <li>Software deployment and distribution features</li>
                <li>Real-time monitoring and alerting</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">3. Account Responsibilities</h2>
              <p>
                You are responsible for:
              </p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>Maintaining the confidentiality of your account credentials</li>
                <li>All activities that occur under your account</li>
                <li>Ensuring that your use complies with applicable laws</li>
                <li>Keeping your contact information up to date</li>
                <li>Enabling and maintaining two-factor authentication</li>
              </ul>
              <p className="mt-4">
                You must notify us immediately of any unauthorized use of your account or any
                other breach of security.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">4. Acceptable Use</h2>
              <p>You agree NOT to use the Service to:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>Monitor or manage machines without proper authorization</li>
                <li>Deploy malicious software or malware</li>
                <li>Violate any applicable laws or regulations</li>
                <li>Interfere with or disrupt the Service or servers</li>
                <li>Attempt to gain unauthorized access to any systems</li>
                <li>Collect or harvest user data without consent</li>
                <li>Use the Service for any illegal or fraudulent purpose</li>
                <li>Resell or redistribute the Service without authorization</li>
              </ul>
              <p className="mt-4">
                We reserve the right to suspend or terminate accounts that violate these terms.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">5. Intellectual Property</h2>
              <p>
                The Owlette software is released under the GNU General Public License v3.0 (GPL-3.0).
                You may use, modify, and distribute the software in accordance with that license.
              </p>
              <p className="mt-4">
                The Owlette name, logo, and branding are trademarks of TEC and may not be used
                without our express written permission.
              </p>
              <p className="mt-4">
                You retain ownership of any data you upload or create using the Service. By using
                the Service, you grant us a license to store, process, and transmit your data
                solely for the purpose of providing the Service.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">6. Disclaimer of Warranties</h2>
              <p className="uppercase font-medium">
                THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; WITHOUT WARRANTIES
                OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED
                WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
              </p>
              <p className="mt-4">
                We do not warrant that:
              </p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>The Service will be uninterrupted or error-free</li>
                <li>Defects will be corrected</li>
                <li>The Service is free of viruses or other harmful components</li>
                <li>The results from using the Service will meet your requirements</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">7. Limitation of Liability</h2>
              <p className="uppercase font-medium">
                TO THE MAXIMUM EXTENT PERMITTED BY LAW, TEC SHALL NOT BE LIABLE FOR ANY INDIRECT,
                INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS
                OR REVENUES, WHETHER INCURRED DIRECTLY OR INDIRECTLY, OR ANY LOSS OF DATA, USE,
                GOODWILL, OR OTHER INTANGIBLE LOSSES RESULTING FROM:
              </p>
              <ul className="list-disc pl-6 mt-4 space-y-1">
                <li>Your use or inability to use the Service</li>
                <li>Any unauthorized access to or use of our servers</li>
                <li>Any interruption or cessation of transmission to or from the Service</li>
                <li>Any bugs, viruses, or similar issues transmitted through the Service</li>
                <li>Any errors or omissions in any content</li>
              </ul>
              <p className="mt-4">
                In no event shall our total liability exceed the amount you paid us, if any,
                for the use of the Service during the twelve (12) months prior to the claim.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">8. Indemnification</h2>
              <p>
                You agree to indemnify, defend, and hold harmless TEC and its officers, directors,
                employees, and agents from and against any claims, liabilities, damages, losses,
                and expenses, including reasonable attorneys&apos; fees, arising out of or in any way
                connected with:
              </p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>Your access to or use of the Service</li>
                <li>Your violation of these Terms</li>
                <li>Your violation of any third-party rights</li>
                <li>Your violation of any applicable laws or regulations</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">9. Termination</h2>
              <p>
                We may suspend or terminate your access to the Service at any time, with or
                without cause, and with or without notice. Upon termination:
              </p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>Your right to use the Service will immediately cease</li>
                <li>You must stop using the Owlette agent on all machines</li>
                <li>We may delete your account and associated data</li>
              </ul>
              <p className="mt-4">
                You may terminate your account at any time by contacting us or using the
                account deletion feature in the dashboard.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">10. Governing Law</h2>
              <p>
                These Terms shall be governed by and construed in accordance with the laws of
                the State of California, United States, without regard to its conflict of law
                provisions.
              </p>
              <p className="mt-4">
                Any legal action or proceeding arising out of or relating to these Terms or the
                Service shall be brought exclusively in the federal or state courts located in
                California, and you consent to the personal jurisdiction of such courts.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">11. Dispute Resolution</h2>
              <p>
                Before filing a claim against TEC, you agree to try to resolve the dispute
                informally by contacting us at{' '}
                <a href="mailto:support@owlette.app" className="text-accent-cyan hover:text-accent-cyan">
                  support@owlette.app
                </a>
                . We will try to resolve the dispute informally by contacting you via email.
                If a dispute is not resolved within 30 days of submission, you or TEC may
                bring a formal proceeding.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">12. Severability</h2>
              <p>
                If any provision of these Terms is held to be invalid or unenforceable, such
                provision shall be struck and the remaining provisions shall be enforced to
                the fullest extent under law.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">13. Entire Agreement</h2>
              <p>
                These Terms, together with our Privacy Policy, constitute the entire agreement
                between you and TEC regarding the Service and supersede all prior agreements
                and understandings.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white mb-4">14. Contact Us</h2>
              <p>
                If you have any questions about these Terms, please contact us at:
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
            <Link href="/privacy" className="text-muted-foreground hover:text-muted-foreground">
              Privacy Policy
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
