'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from 'sonner';

export default function TestEmailPage() {
  const [isSending, setIsSending] = useState(false);
  const [lastResult, setLastResult] = useState<any>(null);

  const sendTestEmail = async () => {
    setIsSending(true);
    setLastResult(null);

    try {
      const response = await fetch('/api/test-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const data = await response.json();

      if (response.ok && data.success) {
        toast.success('Test email sent successfully!', {
          description: `Email sent to ${data.to}`,
        });
        setLastResult({
          success: true,
          ...data,
        });
      } else {
        toast.error('Failed to send test email', {
          description: data.error || 'Unknown error',
        });
        setLastResult({
          success: false,
          error: data.error,
          details: data.details,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      toast.error('Failed to send test email', {
        description: errorMessage,
      });
      setLastResult({
        success: false,
        error: 'Request failed',
        details: errorMessage,
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="p-6 lg:p-10 max-w-screen-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Email Test</h1>
        <p className="text-muted-foreground mt-2">
          Test your Resend email configuration and verify email delivery
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Send Test Email</CardTitle>
          <CardDescription>
            Click the button below to send a test email to your configured admin email address.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            onClick={sendTestEmail}
            disabled={isSending}
            className="w-full sm:w-auto bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
          >
            {isSending ? 'Sending...' : 'Send Test Email'}
          </Button>

          {lastResult && (
            <div className={`p-4 rounded-lg border ${
              lastResult.success
                ? 'bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-900'
                : 'bg-red-50 border-red-200 dark:bg-red-950 dark:border-red-900'
            }`}>
              <h3 className={`font-semibold mb-2 ${
                lastResult.success ? 'text-green-900 dark:text-green-100' : 'text-red-900 dark:text-red-100'
              }`}>
                {lastResult.success ? 'Success!' : 'Error'}
              </h3>
              <div className="space-y-2 text-sm">
                {lastResult.success ? (
                  <>
                    <p><strong>Email ID:</strong> {lastResult.emailId}</p>
                    <p><strong>From:</strong> {lastResult.from}</p>
                    <p><strong>To:</strong> {lastResult.to}</p>
                    <p><strong>Environment:</strong> {lastResult.environment}</p>
                    <p><strong>Timestamp:</strong> {lastResult.timestamp}</p>
                    <p className="text-green-700 dark:text-green-300 mt-3">
                      Check your inbox at <strong>{lastResult.to}</strong> for the test email.
                    </p>
                  </>
                ) : (
                  <>
                    <p><strong>Error:</strong> {lastResult.error}</p>
                    {lastResult.details && (
                      <div className="mt-2">
                        <strong>Details:</strong>
                        <pre className="mt-1 p-2 bg-red-100 dark:bg-red-900 rounded text-xs overflow-x-auto">
                          {JSON.stringify(lastResult.details, null, 2)}
                        </pre>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          <div className="pt-4 border-t">
            <h4 className="font-semibold mb-2">Configuration Details</h4>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <dt className="font-medium text-muted-foreground">Environment:</dt>
                <dd className="mt-1">
                  {process.env.NODE_ENV === 'production' ? 'Production' : 'Development'}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-muted-foreground">API Key Status:</dt>
                <dd className="mt-1">
                  {process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ? '✓ Configured' : '✗ Not configured'}
                </dd>
              </div>
            </dl>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What happens when you click "Send Test Email"?</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>The test will:</p>
          <ol className="list-decimal list-inside space-y-1 ml-4">
            <li>Verify your Resend API key is configured</li>
            <li>Verify your admin email is configured</li>
            <li>Send a test email to your admin email address</li>
            <li>Display the result with detailed information</li>
          </ol>
          <p className="mt-4 text-muted-foreground">
            If successful, you should receive an email within a few seconds.
            Check your spam folder if you don't see it in your inbox.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
